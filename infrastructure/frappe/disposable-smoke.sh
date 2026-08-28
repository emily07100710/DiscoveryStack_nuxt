#!/usr/bin/env bash
set -euo pipefail

DS_SMOKE_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DS_SMOKE_COMPOSE_FILE="${DS_SMOKE_DIRECTORY}/compose.yaml"
DS_SMOKE_ENV_FILE="${DS_SMOKE_DIRECTORY}/.env.example"
DS_SMOKE_SITE="ds-smoke-v1.localhost"
DS_SMOKE_DB_PASSWORD="$(openssl rand -hex 24)"
DS_SMOKE_ADMIN_PASSWORD="$(openssl rand -hex 24)"
DS_SMOKE_APP_HASH="$(node -p 'require(process.argv[1]).customAppSha256' "${DS_SMOKE_DIRECTORY}/build-manifest.json")"
DS_SMOKE_RECIPE_HASH="$(node -p 'require(process.argv[1]).buildRecipeFingerprint' "${DS_SMOKE_DIRECTORY}/build-manifest.json")"
export FRAPPE_DB_ROOT_PASSWORD="${DS_SMOKE_DB_PASSWORD}"

ds_smoke_compose() {
  docker compose --env-file "${DS_SMOKE_ENV_FILE}" -f "${DS_SMOKE_COMPOSE_FILE}" "$@"
}

ds_smoke_cleanup() {
  ds_smoke_compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap ds_smoke_cleanup EXIT INT TERM

ds_smoke_compose config --quiet
docker image inspect "$(node -p 'require(process.argv[1]).builtImageReference' "${DS_SMOKE_DIRECTORY}/build-manifest.json")" >/dev/null
ds_smoke_compose up -d mariadb redis-cache redis-queue
ds_smoke_compose run --rm configurator

ds_smoke_compose run --rm --no-deps \
  -e FRAPPE_DB_ROOT_PASSWORD="${DS_SMOKE_DB_PASSWORD}" \
  -e FRAPPE_ADMIN_PASSWORD="${DS_SMOKE_ADMIN_PASSWORD}" \
  -e EXPECTED_CUSTOM_APP_SHA256="${DS_SMOKE_APP_HASH}" \
  -e EXPECTED_BUILD_RECIPE_FINGERPRINT="${DS_SMOKE_RECIPE_HASH}" \
  --entrypoint bash configurator -lc '
    python /opt/discoverystack/verify-runtime-authority.py
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
    bench --site ds-smoke-v1.localhost execute discovery_stack.tenant_operations.prepare_admin_invitation --kwargs '"'"'{"payload":{"ownerId":"owner:smoke","clientId":"client:smoke","systemTenantId":"tenant:smoke","compiledPlanFingerprint":"88b4a3c5ed9739a69ac6a7bf35a8598b78987614ace0eabcdc160220e5738d02","specFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimeAuthorityFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","idempotencyKey":"smoke-invite-0001"}}'"'"'
    bench --site ds-smoke-v1.localhost execute discovery_stack.tenant_operations.activate_admin_invitation --kwargs '"'"'{"payload":{"ownerId":"owner:smoke","clientId":"client:smoke","systemTenantId":"tenant:smoke","compiledPlanFingerprint":"88b4a3c5ed9739a69ac6a7bf35a8598b78987614ace0eabcdc160220e5738d02","specFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimeAuthorityFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","idempotencyKey":"smoke-activate-0001","invitationId":"smoke-invite-0001","principalEmail":"smoke-admin@example.invalid","principalEmailHash":"dd0aac4260132a813696999ecef1350378e2ae22911003d8187a4b4135a78e18","roleKey":"system_manager","password":"SmokePassword12345"}}'"'"'
    bench --site ds-smoke-v1.localhost execute discovery_stack.tenant_operations.activate_admin_invitation --kwargs '"'"'{"payload":{"ownerId":"owner:smoke","clientId":"client:smoke","systemTenantId":"tenant:smoke","compiledPlanFingerprint":"88b4a3c5ed9739a69ac6a7bf35a8598b78987614ace0eabcdc160220e5738d02","specFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimeAuthorityFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","idempotencyKey":"smoke-activate-0001","invitationId":"smoke-invite-0001","principalEmail":"smoke-admin@example.invalid","principalEmailHash":"dd0aac4260132a813696999ecef1350378e2ae22911003d8187a4b4135a78e18","roleKey":"system_manager","password":"SmokePassword12345"}}'"'"'
  '

printf '%s\n' 'FRAPPE_DISPOSABLE_SMOKE=PASS'
