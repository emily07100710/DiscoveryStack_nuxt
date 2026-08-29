import hashlib
import json
import os
from pathlib import Path

ROOT = Path('/home/frappe/frappe-bench/apps')


def tree_hash(path):
    digest = hashlib.sha256()
    for item in sorted(path.rglob('*'), key=lambda value: str(value.relative_to(path))):
        if not item.is_file() or item.suffix == '.pyc' or '__pycache__' in item.parts or any(part.endswith('.egg-info') for part in item.parts):
            continue
        digest.update(str(item.relative_to(path)).encode() + b'\0')
        digest.update(item.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


authority = json.loads(Path('/opt/discoverystack/runtime-authority.json').read_text())
expected = {
    'frappeCommit': '5cba016e86b54b57f34a3864282b92300ef20fb0',
    'erpnextCommit': 'b24c9eba551905e256e336ff170a91a92d197a2f',
    'customAppSha256': os.environ['EXPECTED_CUSTOM_APP_SHA256'],
    'buildRecipeFingerprint': os.environ['EXPECTED_BUILD_RECIPE_FINGERPRINT'],
}
if any(authority.get(key) != value for key, value in expected.items()):
    raise SystemExit('runtime authority mismatch')
if (ROOT / 'frappe/.discoverystack-source-commit').read_text().strip() != expected['frappeCommit']:
    raise SystemExit('installed Frappe source commit mismatch')
if (ROOT / 'erpnext/.discoverystack-source-commit').read_text().strip() != expected['erpnextCommit']:
    raise SystemExit('installed ERPNext source commit mismatch')
if tree_hash(ROOT / 'discovery_stack') != expected['customAppSha256']:
    raise SystemExit('custom app content hash mismatch')
def installed_version(name):
    candidates = sorted(Path('/home/frappe/frappe-bench/env/lib').glob(f'python*/site-packages/{name}-*.dist-info/METADATA'))
    if len(candidates) != 1:
        raise SystemExit(f'installed metadata missing for {name}')
    for line in candidates[0].read_text().splitlines():
        if line.startswith('Version: '):
            return line.removeprefix('Version: ').strip()
    raise SystemExit(f'installed version missing for {name}')


installed_versions = {name: installed_version(name) for name in ('frappe', 'erpnext', 'discovery_stack')}
if installed_versions != {'frappe': '16.32.0', 'erpnext': '16.33.0', 'discovery_stack': '0.1.0'}:
    raise SystemExit('installed app version mismatch')
print(json.dumps({'ok': True, 'authority': authority, 'installedVersions': installed_versions}, sort_keys=True))
