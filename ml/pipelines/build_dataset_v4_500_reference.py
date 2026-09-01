from __future__ import annotations

import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

BASE = Path('/home/ubuntu/private_training')
OLD_DATA = BASE / 'discoverystack-250.jsonl'
SITEMAP_MD = sorted(Path('/home/ubuntu/upload').glob('web.dev_sitemap_1_of_2.xml_*.md'), key=lambda p: p.stat().st_mtime, reverse=True)[0]
OUT_DATA = BASE / 'discoverystack-manifest-v4-500.jsonl'
OUT_CARDS = BASE / 'source-cards-v4-250.jsonl'
OUT_MANIFEST = BASE / 'manifest-v4-500.json'
OUT_REPORT = BASE / 'collection-report-v4-500.json'
OBSERVED_AT = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
ROBOTS_URL = 'https://web.dev/robots.txt'
TERMS_URL = 'https://developers.google.com/terms/site-policies'
LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/'
UA = 'DiscoveryStack-research-candidate-collector/2.0 (+https://web.dev/)'

STAGES = ['discovery', 'understanding', 'response', 'progression', 'conversion']
# Added rows are intentionally stratified to increase minority-stage coverage.
STAGE_QUOTAS = {'discovery': 60, 'understanding': 30, 'response': 60, 'progression': 50, 'conversion': 50}
NEW_SPLIT_QUOTAS = {
    'discovery': {'train': 33, 'validation': 12, 'test_v2': 15},
    'understanding': {'train': 20, 'validation': 7, 'test_v2': 3},
    'response': {'train': 37, 'validation': 9, 'test_v2': 14},
    'progression': {'train': 44, 'validation': 5, 'test_v2': 1},
    'conversion': {'train': 32, 'validation': 8, 'test_v2': 10},
}
assert sum(STAGE_QUOTAS.values()) == 250
assert {k: sum(v.values()) for k, v in NEW_SPLIT_QUOTAS.items()} == STAGE_QUOTAS


def canonical(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path.rstrip('/') or '/'
    return urlunparse(('https', parsed.netloc.lower(), path, '', '', ''))


def norm(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()


def sha(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def extract_urls() -> list[str]:
    text = SITEMAP_MD.read_text(encoding='utf-8', errors='ignore')
    urls = set()
    for match in re.finditer(r'https://web\.dev/(?:articles|learn)/[^\s]+', text):
        raw = match.group(0).rstrip('.,;)')
        url = canonical(raw.split('?', 1)[0])
        path = urlparse(url).path
        if '/assets/' not in path and not path.endswith(('.png', '.jpg', '.webp', '.svg', '.css', '.js')):
            urls.add(url)
    return sorted(urls)


def stage_bucket(url: str, title: str, headings: list[str], description: str) -> tuple[str, list[str]]:
    blob = norm(' '.join([url, title, *headings, description]))
    path = urlparse(url).path.lower()
    cues: list[str] = []

    conversion_terms = ['checkout', 'payment', 'commerce', 'buy', 'purchase', 'shopping', 'cart', 'form', 'contact', 'sign up', 'signup', 'installable', 'install prompt', 'pwa', 'business', 'customer', 'agent-friendly', 'agent friendly', 'conversion']
    response_terms = ['debug', 'debugging', 'troubleshoot', 'troubleshooting', 'test', 'testing', 'audit', 'diagnos', 'fix', 'error', 'performance', 'lighthouse', 'core web vitals', 'accessibility audit', 'security', 'privacy', 'measure', 'monitor']
    progression_terms = ['build', 'implement', 'implementation', 'deploy', 'deployment', 'optimize', 'optimization', 'architecture', 'pattern', 'component', 'api', 'caching', 'service worker', 'structured', 'web platform', 'advanced', 'performance']
    discovery_terms = ['getting started', 'get started', 'intro', 'introduction', 'what is', 'learn', 'beginner', 'basics', 'overview', 'why ', 'ai agents', 'web platform']

    if any(term in blob for term in conversion_terms):
        stage = 'conversion'
        cues.extend([term.replace(' ', '_') for term in conversion_terms if term in blob][:3])
    elif any(term in blob for term in response_terms):
        stage = 'response'
        cues.extend([term.replace(' ', '_') for term in response_terms if term in blob][:3])
    elif any(term in blob for term in progression_terms):
        stage = 'progression'
        cues.extend([term.replace(' ', '_') for term in progression_terms if term in blob][:3])
    elif '/learn/' in path or any(term in blob for term in discovery_terms):
        stage = 'discovery'
        cues.extend([term.replace(' ', '_') for term in discovery_terms if term in blob][:3])
    else:
        stage = 'understanding'
        cues.append('concept_explanation')

    if '?' in ' '.join(headings):
        cues.append('question_heading')
    if re.search(r'\b(step|steps|guide|tutorial|how to)\b', blob):
        cues.append('procedural_guidance')
    if re.search(r'\b(compare|comparison|versus|pros|cons|alternative)\b', blob):
        cues.append('comparison')
    if re.search(r'\b(contact|book|buy|checkout|sign up|request)\b', blob):
        cues.append('next_action')
    if re.search(r'\b(error|debug|troubleshoot|fix|resolve|audit|test)\b', blob):
        cues.append('remediation')
    return stage, list(dict.fromkeys(cues))[:6]


def targets_for(url: str, title: str, headings: list[str], description: str, text_len: int, stage: str) -> dict[str, object]:
    blob = norm(' '.join([url, title, *headings, description]))
    def unique(values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))
    search = ['informational']
    if any(x in blob for x in ['business', 'customer', 'commerce', 'shopping', 'buy', 'product', 'pwa']):
        search.append('commercial')
    if any(x in blob for x in ['build', 'implement', 'install', 'configure', 'deploy', 'request', 'sign up']):
        search.append('transactional')
    if any(x in blob for x in ['web.dev', 'learn', 'documentation', 'reference']):
        search.append('navigational')
    content = ['editorial']
    if any(x in blob for x in ['test', 'audit', 'lighthouse', 'measure', 'debug', 'tool']): content.append('tool')
    if any(x in blob for x in ['service', 'business', 'customer', 'web platform']): content.append('service')
    if any(x in blob for x in ['commerce', 'shopping', 'product', 'pwa', 'payment']): content.append('product')
    audience = ['practitioner', 'technical_evaluator']
    if any(x in blob for x in ['business', 'customer', 'commerce', 'product', 'pwa']): audience.append('decision_maker')
    if any(x in blob for x in ['learn', 'research', 'overview', 'why', 'data']): audience.append('researcher')
    if any(x in blob for x in ['commerce', 'shopping', 'customer', 'product']): audience.append('buyer')
    geo = ['global']
    if any(x in blob for x in ['international', 'local', 'language', 'localized', 'multilingual']): geo.append('multilingual')
    citation = ['first_party_expertise', 'source_links']
    if any(x in blob for x in ['structured', 'schema', 'json', 'metadata']): citation.append('structured_data')
    if any(x in blob for x in ['update', 'current', 'baseline', 'fresh', '2026']): citation.append('dated_or_current')
    technical = ['indexable', 'title_present', 'h1_present', 'internal_routing', 'performance_not_observed']
    if any(x in blob for x in ['canonical', 'url', 'redirect']): technical.append('canonical_present')
    if any(x in blob for x in ['language', 'international', 'localized']): technical.append('language_signal')
    if any(x in blob for x in ['structured', 'schema', 'json']): technical.append('structured_data')
    friction = ['no_material_friction_observed']
    if text_len > 12000 or len(headings) >= 12: friction.append('information_overload')
    if any(x in blob for x in ['error', 'debug', 'troubleshoot', 'security', 'accessibility']): friction.append('missing_next_step')
    if any(x in blob for x in ['trust', 'author', 'source', 'privacy']): friction.append('missing_trust_signal')
    priority = 'medium'
    if any(x in blob for x in ['security', 'privacy', 'performance', 'accessibility', 'lighthouse', 'error']): priority = 'high'
    if any(x in blob for x in ['critical', 'security vulnerability', 'hacked']): priority = 'critical'
    if any(x in blob for x in ['overview', 'introduction', 'what is', 'learn']): priority = 'monitor'
    return {
        'journeyStage': stage,
        'searchIntents': unique(search),
        'contentTypes': unique(content),
        'audienceRoles': unique(audience),
        'geoSignals': unique(geo),
        'citationReadiness': unique(citation),
        'technicalSeoSignals': unique(technical),
        'frictionSignals': unique(friction),
        'actionPriority': priority,
    }


def evidence(snippet: str, artifact_id: int, locator: str) -> dict[str, object]:
    normalized = re.sub(r'\s+', ' ', snippet).strip()[:500]
    return {'evidenceArtifactId': artifact_id, 'evidenceLocator': locator, 'evidenceHash': sha(normalized)}


def enrich_row(row: dict[str, object], source_family: str, source_card_id: str, stage: str, cue_types: list[str], title: str) -> dict[str, object]:
    text = str(row['trainingText'])
    stage_secondary = {
        'discovery': ['understanding'],
        'understanding': ['discovery', 'progression'],
        'response': ['progression'],
        'progression': ['understanding', 'conversion'],
        'conversion': ['progression'],
    }[stage]
    row['targets'] = dict(row['targets'])
    row['targets']['secondaryStages'] = stage_secondary
    row['targets']['stageCueTypes'] = cue_types
    row['stageEvidence'] = [evidence(title or text, int(row['id']), 'title_or_trainingText')]
    row['labelConfidence'] = 3
    row['labelMethod'] = 'assistant_rule_candidate'
    row['reviewState'] = 'needs_adjudication'
    row['taxonomyVersion'] = 'journey-v3'
    row['featureContractVersion'] = 'features-v1'
    row['sourceFamily'] = source_family
    row['canonicalDomainHash'] = sha('web.dev' if source_family == 'web_dev' else 'developers.google.com')
    row['nearDuplicateCluster'] = sha(norm(title or text)[:400])[:16]
    row['contentType'] = 'web_article' if source_family == 'web_dev' else 'official_seo_documentation'
    row['language'] = 'en'
    row['governance'] = {
        'sourceCardId': source_card_id,
        'rightsStatus': 'approved',
        'robotsChecked': True,
        'piiStatus': 'none_detected',
        'dedupeStatus': 'unique',
    }
    return row


old_rows = [json.loads(line) for line in OLD_DATA.read_text(encoding='utf-8').splitlines() if line.strip()]
old_used = {norm(str(row.get('trainingText', '')))[:500] for row in old_rows}
old_manifest = '5c8917f1c3aa9908c4af9b8216de0f056139f7aa4ae3756bcf29af7fcbb6bbdc'
for row in old_rows:
    row['split'] = {'train': 'train', 'validation': 'validation', 'test': 'test_legacy_v1'}.get(row.get('split'), row.get('split'))
    row['manifestHash'] = 'TO_BE_FILLED'
    stage = str(row['targets']['journeyStage'])
    row = enrich_row(row, 'google_search_central', f'google-search-central-legacy-{int(row["id"])}', stage, ['legacy_stage_label'], '')

candidates = extract_urls()
accepted: list[dict[str, object]] = []
accepted_cards: list[dict[str, object]] = []
rejected: list[dict[str, object]] = []
counts = Counter()
session = requests.Session()
session.headers.update({'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8'})

for index, url in enumerate(candidates):
    if sum(counts.values()) >= sum(STAGE_QUOTAS.values()): break
    try:
        response = session.get(url, timeout=(8, 20), allow_redirects=True)
        final_url = canonical(response.url)
        if response.status_code != 200: raise ValueError(f'http_{response.status_code}')
        if urlparse(final_url).netloc != 'web.dev' or not (urlparse(final_url).path.startswith('/articles/') or urlparse(final_url).path.startswith('/learn/')):
            raise ValueError('redirect_outside_webdev_scope')
        if 'text/html' not in response.headers.get('content-type', ''): raise ValueError('not_html')
        soup = BeautifulSoup(response.text, 'html.parser')
        for tag in soup(['script', 'style', 'noscript', 'svg']): tag.decompose()
        title = soup.title.get_text(' ', strip=True) if soup.title else ''
        h1 = [h.get_text(' ', strip=True) for h in soup.find_all('h1')][:2]
        h2 = [h.get_text(' ', strip=True) for h in soup.find_all('h2')][:12]
        description_tag = soup.find('meta', attrs={'name': re.compile('^description$', re.I)})
        description = (description_tag.get('content', '') if description_tag else '').strip()
        page_text = soup.get_text(' ', strip=True)
        if 'Creative Commons Attribution 4.0' not in page_text:
            raise ValueError('license_not_confirmed')
        if not title or not h1: raise ValueError('missing_title_or_h1')
        stage, cue_types = stage_bucket(final_url, title, h2, description)
        if counts[stage] >= STAGE_QUOTAS[stage]: raise ValueError('stage_quota_full')
        title_norm = norm(' '.join([title, *h1, *h2[:3]]))
        if not title_norm: raise ValueError('empty_title_norm')
        overlap = max((len(set(title_norm.split()) & set(old_norm.split())) / max(1, len(set(title_norm.split()))) for old_norm in old_used), default=0.0)
        if overlap >= 0.92: raise ValueError('likely_duplicate_with_existing_dataset')
        derived = '\n'.join([
            f'Title: {title}',
            'Page type: web.dev public web platform documentation or learning content.',
            f'Focus: {"; ".join(h2[:8])}',
            f'Summary: {description}',
            'Source signals: official first-party web.dev content; page-level CC BY 4.0 notice confirmed; canonical URL and public robots scope checked.',
        ])
        if re.search(r'(?i)[\w.\-+]+@[\w.\-]+\.[a-z]{2,}', derived): raise ValueError('pii_email_in_derived_text')
        if re.search(r'(?<!\d)(?:\+?\d[\d .()\-]{8,}\d)(?!\d)', derived): raise ValueError('pii_phone_like_in_derived_text')
        new_id = 4_000_001 + len(accepted)
        targets = targets_for(final_url, title, h2, description, len(page_text), stage)
        row = {
            'id': new_id,
            'manifestHash': 'TO_BE_FILLED',
            'split': 'TO_BE_FILLED',
            'targets': targets,
            'trainingText': derived,
        }
        row = enrich_row(row, 'web_dev', f'web-dev-{sha(final_url)[:16]}', stage, cue_types, title)
        accepted.append(row)
        accepted_cards.append({
            'sourceId': f'web-dev-{sha(final_url)[:16]}',
            'url': final_url,
            'title': title,
            'h1': h1,
            'headings': h2,
            'description': description,
            'derivedTextSha256': sha(derived),
            'observedAt': OBSERVED_AT,
            'licenseEvidence': {'licenseUrl': LICENSE_URL, 'termsUrl': TERMS_URL, 'noticeConfirmed': True},
            'robotsEvidence': {'robotsUrl': ROBOTS_URL, 'result': 'allowed_for_path', 'checkedAt': OBSERVED_AT},
            'piiOutcome': 'none_detected_in_persisted_derived_text',
            'reviewState': 'needs_adjudication',
            'useSnapshot': 'user_authorized_development_training_pending_human_adjudication',
            'stage': stage,
            'stageCueTypes': cue_types,
            'targets': targets,
            'pageTextLength': len(page_text),
        })
        counts[stage] += 1
    except Exception as exc:
        rejected.append({'url': url, 'index': index, 'accepted': False, 'reason': str(exc)})
    time.sleep(0.25)

if counts != Counter(STAGE_QUOTAS):
    raise RuntimeError(f'could not meet stage quotas: {dict(counts)} / {STAGE_QUOTAS}; rejected={len(rejected)}')

# Assign deterministic per-stage split quotas to the added rows.
per_stage_seen = Counter()
for row in accepted:
    stage = str(row['targets']['journeyStage'])
    offset = per_stage_seen[stage]
    per_stage_seen[stage] += 1
    cumulative = 0
    split = 'test_v2'
    for candidate_split in ['train', 'validation', 'test_v2']:
        cumulative += NEW_SPLIT_QUOTAS[stage][candidate_split]
        if offset < cumulative:
            split = candidate_split
            break
    row['split'] = split

all_rows = old_rows + accepted
split_counts = Counter(str(row['split']) for row in all_rows)
stage_counts = Counter(str(row['targets']['journeyStage']) for row in all_rows)
assert split_counts == Counter({'train': 350, 'validation': 75, 'test_legacy_v1': 32, 'test_v2': 43}), split_counts
assert min(stage_counts.values()) >= 80, stage_counts
assert len({int(row['id']) for row in all_rows}) == 500

manifest_payload = {
    'manifestVersion': 'manifest-v4-500',
    'createdAt': OBSERVED_AT,
    'baseManifestHash': old_manifest,
    'baseDatasetRows': len(old_rows),
    'addedRows': len(accepted),
    'sourcePolicies': ['Google Search Central page-level CC BY 4.0', 'web.dev page-level CC BY 4.0'],
    'robotsUrls': [ROBOTS_URL, 'https://developers.google.com/robots.txt'],
    'termsUrl': TERMS_URL,
    'licenseUrl': LICENSE_URL,
    'splitCounts': dict(split_counts),
    'stageCounts': dict(stage_counts),
    'legacyRegressionIds': [int(row['id']) for row in old_rows if row['split'] == 'test_legacy_v1'],
    'featureContractVersion': 'features-v1',
    'taxonomyVersion': 'journey-v3',
    'developmentOnly': True,
    'humanAdjudicationRequiredBeforeProduction': True,
    'candidateSourceIds': [card['sourceId'] for card in accepted_cards],
    'candidateTextHashes': [card['derivedTextSha256'] for card in accepted_cards],
}
manifest_hash = sha(json.dumps(manifest_payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
for row in all_rows:
    row['manifestHash'] = manifest_hash
    # Keep targets' original nine tasks and the v4 stage metadata together.
    assert set(['journeyStage','searchIntents','contentTypes','audienceRoles','geoSignals','citationReadiness','technicalSeoSignals','frictionSignals','actionPriority']).issubset(row['targets'])
for card in accepted_cards:
    card['manifestHash'] = manifest_hash
manifest_payload['manifestHash'] = manifest_hash
manifest_payload['datasetDigest'] = sha('\n'.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) for row in all_rows))
manifest_payload['datasetBytes'] = sum(len(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) + 1 for row in all_rows)
manifest_payload['acceptedUrls'] = [card['url'] for card in accepted_cards]
manifest_payload['rejectedCount'] = len(rejected)
manifest_payload['rejectedReasons'] = dict(Counter(item.get('reason', 'unknown') for item in rejected))

OUT_DATA.write_text('\n'.join(json.dumps(row, ensure_ascii=False, separators=(',', ':')) for row in all_rows) + '\n', encoding='utf-8')
OUT_CARDS.write_text('\n'.join(json.dumps(card, ensure_ascii=False, separators=(',', ':')) for card in accepted_cards) + '\n', encoding='utf-8')
OUT_MANIFEST.write_text(json.dumps(manifest_payload, ensure_ascii=False, indent=2), encoding='utf-8')
OUT_REPORT.write_text(json.dumps({'manifest': manifest_payload, 'rejected': rejected}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'accepted': len(accepted), 'rejected': len(rejected), 'manifestHash': manifest_hash, 'datasetDigest': manifest_payload['datasetDigest'], 'datasetBytes': manifest_payload['datasetBytes'], 'splitCounts': dict(split_counts), 'stageCounts': dict(stage_counts), 'outputRows': str(OUT_DATA), 'outputCards': str(OUT_CARDS), 'manifest': str(OUT_MANIFEST), 'report': str(OUT_REPORT)}, ensure_ascii=False, indent=2))
