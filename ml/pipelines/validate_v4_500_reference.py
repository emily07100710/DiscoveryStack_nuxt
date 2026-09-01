from __future__ import annotations
import hashlib
import json
from collections import Counter
from pathlib import Path

BASE = Path('/home/ubuntu/private_training')
data_path = BASE / 'discoverystack-manifest-v4-500.jsonl'
manifest_path = BASE / 'manifest-v4-500.json'
rows_raw = [line.rstrip('\n') for line in data_path.read_text(encoding='utf-8').splitlines() if line.strip()]
rows = [json.loads(line) for line in rows_raw]
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
assert len(rows) == 500, len(rows)
assert len({int(r['id']) for r in rows}) == 500
assert hashlib.sha256('\n'.join(rows_raw).encode()).hexdigest() == manifest['datasetDigest']
assert {r['manifestHash'] for r in rows} == {manifest['manifestHash']}
assert Counter(r['split'] for r in rows) == Counter({'train':350, 'validation':75, 'test_legacy_v1':32, 'test_v2':43})
assert min(Counter(r['targets']['journeyStage'] for r in rows).values()) >= 80
required_tasks = {'journeyStage','searchIntents','contentTypes','audienceRoles','geoSignals','citationReadiness','technicalSeoSignals','frictionSignals','actionPriority'}
allowed_stages = {'discovery','understanding','response','progression','conversion'}
for i, row in enumerate(rows):
    assert isinstance(row['trainingText'], str) and row['trainingText'].strip(), i
    assert set(row['targets']) >= required_tasks, i
    assert row['targets']['journeyStage'] in allowed_stages, i
    assert row['reviewState'] in {'reviewed','needs_adjudication'}, i
    assert row['labelMethod'] in {'owner_approved_legacy','assistant_rule_candidate','human','human_amended'}, i
    assert row['taxonomyVersion'] == 'journey-v3', i
    assert row['featureContractVersion'] == 'features-v1', i
    assert row['governance']['rightsStatus'] == 'approved', i
    assert row['governance']['robotsChecked'] is True, i
    assert row['governance']['piiStatus'] in {'none_detected','masked'}, i
    assert row['governance']['dedupeStatus'] in {'unique','cluster_reviewed'}, i
    assert 1 <= int(row['labelConfidence']) <= 5, i
    assert row['stageEvidence'], i
print(json.dumps({'validated': True, 'rows': len(rows), 'manifestHash': manifest['manifestHash'], 'datasetDigest': manifest['datasetDigest'], 'splits': dict(Counter(r['split'] for r in rows)), 'stageCounts': dict(Counter(r['targets']['journeyStage'] for r in rows))}, ensure_ascii=False, indent=2))
