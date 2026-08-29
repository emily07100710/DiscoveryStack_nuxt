#!/usr/bin/env bash
set -euo pipefail

DS_REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DS_IMAGE_REFERENCE="${SYSTEM_FACTORY_BUILD_IMAGE:-discoverystack/frappe-system-factory:v1-local}"
DS_APP_HASH="$(python3 -c 'import hashlib,pathlib,sys; root=pathlib.Path(sys.argv[1]); h=hashlib.sha256(); files=sorted((p for p in root.rglob("*") if p.is_file() and p.suffix != ".pyc" and "__pycache__" not in p.parts),key=lambda p:str(p.relative_to(root))); [(h.update(str(p.relative_to(root)).encode()+b"\0"),h.update(p.read_bytes()),h.update(b"\0")) for p in files]; print(h.hexdigest())' "${DS_REPOSITORY_ROOT}/services/frappe/discovery_stack")"
DS_RECIPE_HASH="$(python3 -c 'import hashlib,pathlib,sys; root=pathlib.Path(sys.argv[1]); h=hashlib.sha256(); names=["Dockerfile.system-factory","build-immutable-image.sh"]; [(h.update(name.encode()+b"\0"),h.update((root/name).read_bytes()),h.update(b"\0")) for name in names]; print(h.hexdigest())' "${DS_REPOSITORY_ROOT}/infrastructure/frappe")"

docker build --pull=false \
  --file "${DS_REPOSITORY_ROOT}/infrastructure/frappe/Dockerfile.system-factory" \
  --build-arg "CUSTOM_APP_SHA256=${DS_APP_HASH}" \
  --build-arg "BUILD_RECIPE_FINGERPRINT=${DS_RECIPE_HASH}" \
  --tag "${DS_IMAGE_REFERENCE}" \
  "${DS_REPOSITORY_ROOT}"

docker run --rm \
  -e "EXPECTED_CUSTOM_APP_SHA256=${DS_APP_HASH}" \
  -e "EXPECTED_BUILD_RECIPE_FINGERPRINT=${DS_RECIPE_HASH}" \
  "${DS_IMAGE_REFERENCE}" python /opt/discoverystack/verify-runtime-authority.py

docker image inspect "${DS_IMAGE_REFERENCE}" --format '{{json .RepoDigests}} {{.Id}}'
