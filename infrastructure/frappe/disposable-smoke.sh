#!/usr/bin/env bash
set -euo pipefail

DS_SMOKE_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DS_SMOKE_COMPOSE_FILE="${DS_SMOKE_DIRECTORY}/compose.yaml"
DS_SMOKE_ENV_FILE="${DS_SMOKE_DIRECTORY}/.env.example"
DS_SMOKE_SITE="ds-smoke-v1.localhost"
DS_SMOKE_DB_PASSWORD="$(openssl rand -hex 24)"
DS_SMOKE_ADMIN_PASSWORD="$(openssl rand -hex 24)"
export FRAPPE_DB_ROOT_PASSWORD="${DS_SMOKE_DB_PASSWORD}"

ds_smoke_compose() {
  docker compose --env-file "${DS_SMOKE_ENV_FILE}" -f "${DS_SMOKE_COMPOSE_FILE}" "$@"
}

ds_smoke_cleanup() {
  ds_smoke_compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap ds_smoke_cleanup EXIT INT TERM

ds_smoke_compose config --quiet
ds_smoke_compose up -d mariadb redis-cache redis-queue
ds_smoke_compose run --rm configurator

ds_smoke_compose run --rm --no-deps \
  -e FRAPPE_DB_ROOT_PASSWORD="${DS_SMOKE_DB_PASSWORD}" \
  -e FRAPPE_ADMIN_PASSWORD="${DS_SMOKE_ADMIN_PASSWORD}" \
  --entrypoint bash configurator -lc '
    cp -R /workspace/discovery_stack apps/discovery_stack
    printf "frappe\nerpnext\ndiscovery_stack\n" > sites/apps.txt
    export PYTHONPATH=/home/frappe/frappe-bench/apps/discovery_stack
    bench new-site ds-smoke-v1.localhost \
      --db-root-password "$FRAPPE_DB_ROOT_PASSWORD" \
      --admin-password "$FRAPPE_ADMIN_PASSWORD" \
      --install-app erpnext --set-default
    bench --site ds-smoke-v1.localhost install-app discovery_stack
    bench --site ds-smoke-v1.localhost migrate
    bench --site ds-smoke-v1.localhost execute frappe.utils.fixtures.sync_fixtures --kwargs "{\"app\":\"discovery_stack\"}"
    bench --site ds-smoke-v1.localhost list-apps
    bench --site ds-smoke-v1.localhost execute discovery_stack.executor.apply_compiled_plan --kwargs '"'"'{"plan":{"schemaVersion":"compiled-system-plan-v1","compilerVersion":"system-spec-compiler-v1","specId":"spec-smoke-v1","specVersion":1,"specFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parentFingerprint":None,"tenantBinding":{"ownerId":"owner:smoke","clientId":"client:smoke","websiteId":"website:smoke","managedSiteId":None,"systemTenantId":"tenant:smoke","locale":"en","timezone":"UTC","currency":"USD"},"units":[],"canonicalSpecJson":"{}","planFingerprint":"88b4a3c5ed9739a69ac6a7bf35a8598b78987614ace0eabcdc160220e5738d02"}}'"'"'
    bench --site ds-smoke-v1.localhost execute discovery_stack.executor.apply_compiled_plan --kwargs '"'"'{"plan":{"schemaVersion":"compiled-system-plan-v1","compilerVersion":"system-spec-compiler-v1","specId":"spec-smoke-v1","specVersion":1,"specFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parentFingerprint":None,"tenantBinding":{"ownerId":"owner:smoke","clientId":"client:smoke","websiteId":"website:smoke","managedSiteId":None,"systemTenantId":"tenant:smoke","locale":"en","timezone":"UTC","currency":"USD"},"units":[],"canonicalSpecJson":"{}","planFingerprint":"88b4a3c5ed9739a69ac6a7bf35a8598b78987614ace0eabcdc160220e5738d02"}}'"'"'
    bench --site ds-smoke-v1.localhost execute discovery_stack.executor.health_snapshot --kwargs '"'"'{"system_tenant_id":"tenant:smoke"}'"'"'
  '

printf '%s\n' 'FRAPPE_DISPOSABLE_SMOKE=PASS'
