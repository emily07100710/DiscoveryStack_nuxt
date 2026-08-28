from __future__ import annotations

import json
import sys
from pathlib import Path

REQUIRED_TOP = {'contractVersion', 'rowId', 'collectionStatus', 'target', 'page', 'conversionSignals', 'responsive', 'lighthouse', 'lighthouseMobile', 'interactionTrace', 'queryContexts', 'governance'}
REQUIRED_PAGE = {'finalUrlHash', 'httpStatus', 'title', 'metaDescription', 'headings', 'fullTextPath', 'textSha256', 'cookieBannerDetected'}
REQUIRED_VIEW = {'viewport', 'screenshotPath', 'screenshotSha256', 'bodyScrollWidth', 'viewportWidth', 'horizontalOverflow', 'status'}
ALLOWED_COLLECTION = {'complete', 'partial', 'blocked_missing_url', 'blocked_policy', 'failed'}
ALLOWED_VIEW = {'complete', 'failed', 'blocked_missing_url'}
ALLOWED_LIGHTHOUSE = {'complete', 'failed', 'not_run', 'blocked_missing_url', 'runtime_unavailable'}


def fail(message: str) -> None:
    raise AssertionError(message)


def validate(record: dict) -> None:
    missing = REQUIRED_TOP - set(record)
    if missing:
        fail(f'missing top keys: {sorted(missing)}')
    if record['contractVersion'] != 'page-evidence-v1':
        fail('wrong contract version')
    if not isinstance(record['rowId'], int):
        fail('rowId must be integer')
    if record['collectionStatus'] not in ALLOWED_COLLECTION:
        fail('invalid collectionStatus')
    target = record['target']
    if not isinstance(target, dict) or not isinstance(target.get('split'), str):
        fail('target split missing')
    page = record['page']
    if not isinstance(page, dict) or not REQUIRED_PAGE.issubset(page):
        fail('page required fields missing')
    for key in ('desktop', 'mobile'):
        view = record['responsive'].get(key)
        if not isinstance(view, dict) or not REQUIRED_VIEW.issubset(view):
            fail(f'{key} viewport required fields missing')
        if view['status'] not in ALLOWED_VIEW:
            fail(f'{key} invalid status')
        if view['status'] == 'blocked_missing_url' and view['screenshotPath'] is not None:
            fail(f'{key} blocked viewport has screenshot')
    for key in ('lighthouse', 'lighthouseMobile'):
        lh = record[key]
        if not isinstance(lh, dict) or lh.get('status') not in ALLOWED_LIGHTHOUSE:
            fail(f'{key} invalid status')
    trace = record['interactionTrace']
    if trace.get('stoppedBeforeSensitiveAction') is not True:
        fail('sensitive action stop invariant violated')
    for form in trace.get('forms', []):
        if form.get('stoppedBeforeSubmit') is not True:
            fail('form submit invariant violated')
    gov = record['governance']
    if gov.get('privateOnly') is not True or gov.get('developmentOnly') is not True or gov.get('containsCredentials') is not False:
        fail('governance invariant violated')
    # URL hashes and sidecars may exist only for populated targets. No raw URL is permitted in the manifest.
    if record['collectionStatus'].startswith('blocked_'):
        if record['target'].get('url') is not None or record['target'].get('urlHash') is not None:
            fail('blocked target contains URL')
        if record['lighthouse'].get('status') != 'blocked_missing_url' or record['lighthouseMobile'].get('status') != 'blocked_missing_url':
            fail('blocked target lighthouse status mismatch')
        if record['interactionTrace'].get('status') != 'blocked_missing_url':
            fail('blocked target interaction status mismatch')


def main() -> None:
    path = Path(sys.argv[1])
    records = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    for record in records:
        validate(record)
    print(json.dumps({'records': len(records), 'valid': True, 'privateGovernanceChecked': True}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
