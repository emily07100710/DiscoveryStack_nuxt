from __future__ import annotations

import argparse
import asyncio
import hashlib
import ipaddress
import json
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.async_api import Browser, Page, async_playwright

CONTRACT_VERSION = 'page-evidence-v1'
DEFAULT_OUTPUT = Path('page_evidence_runs')
CHROME_PATH = '/usr/bin/chromium'
LIGHTHOUSE_VERSION = '12.8.2'

SENSITIVE_RE = re.compile(
    r'\b(submit|send|buy|purchase|pay|checkout|order|book|booking|schedule|reserve|quote|contact|apply|register|sign\s*up|subscribe|login|log\s*in|donate|transfer|confirm|complete)\b',
    re.I,
)
SAFE_INTERACTION_RE = re.compile(r'\b(menu|faq|accordion|expand|collapse|show|hide|read\s*more|see\s*more|details|answer)\b', re.I)
CTA_RE = re.compile(
    r'\b(contact|consult|demo|get\s*started|start|learn\s*more|download|apply|book|schedule|buy|purchase|sign\s*up|register|subscribe|request|quote|try|join|discover|view|read\s*more)\b',
    re.I,
)
PRICE_RE = re.compile(r'(?:[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|jpy|dollars?|euros?|per\s+month|per\s+year)\b|\b(?:price|pricing|cost|fee|free|plan|subscription|quote|budget)\b)', re.I)
PROOF_RE = re.compile(r'\b(case\s+stud(?:y|ies)|testimonial|success\s+stor(?:y|ies)|customer|client|portfolio|result|outcome|proof|evidence|review|rating|original\s+research|measurement)\b', re.I)
TRUST_RE = re.compile(r'\b(trust|trusted|reliab(?:le|ility)|security|privacy|certif(?:ied|ication)|accredit(?:ed|ation)|official|partner|guarantee|warranty|credential|expertise|experience|review|rating|verified|iso\s*\d|soc\s*\d)\b', re.I)
PII_RE = re.compile(r'(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ()-]{7,}\d)', re.I)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def compact_text(value: str) -> str:
    return re.sub(r'\s+', ' ', value or '').strip()


def safe_locator(tag: str, index: int) -> str:
    return f'{tag}:visible-index-{index}'


def url_hash(url: str) -> str:
    return sha256_text(url.strip())


def validate_public_url(raw: Any) -> tuple[str | None, str | None]:
    if not isinstance(raw, str) or not raw.strip():
        return None, 'missing_url'
    url = raw.strip()
    parsed = urlparse(url)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
        return None, 'url_must_be_http_or_https'
    host = parsed.hostname
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)}
    except Exception:
        # DNS may be unavailable in a dry run; the browser will report a fetch failure.
        addresses = set()
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return None, 'private_or_non_public_host_blocked'
    return url, None


def extract_snippets(text: str, pattern: re.Pattern[str], max_items: int = 25) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for match in pattern.finditer(text):
        start = max(0, match.start() - 180)
        end = min(len(text), match.end() + 280)
        snippet = compact_text(text[start:end])
        if not snippet or snippet in seen:
            continue
        seen.add(snippet)
        items.append({
            'text': snippet,
            'locator': f'body.innerText:{start}:{end}',
            'evidenceType': 'text_span',
        })
        if len(items) >= max_items:
            break
    return items


def make_query_records(target: dict[str, Any], row_dir: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    private_query_payload: list[dict[str, Any]] = []
    for q in target.get('queryContexts') or []:
        if not isinstance(q, dict):
            continue
        query_id = str(q.get('queryId') or '')
        query_text = q.get('queryText')
        intent = q.get('intent')
        if not query_id or not isinstance(query_text, str) or not query_text.strip():
            records.append({'queryId': query_id or 'missing', 'queryHash': '', 'intent': intent if isinstance(intent, str) else None, 'status': 'invalid', 'relevanceEvidencePath': None})
            continue
        query_text = query_text.strip()
        q_hash = sha256_text(json.dumps({'queryText': query_text, 'intent': intent}, ensure_ascii=False, sort_keys=True))
        private_query_payload.append({'queryId': query_id, 'queryText': query_text, 'intent': intent, 'queryHash': q_hash})
        records.append({'queryId': query_id, 'queryHash': q_hash, 'intent': intent if isinstance(intent, str) else None, 'status': 'provided', 'relevanceEvidencePath': None})
    if private_query_payload:
        private_path = row_dir / 'private_query_contexts.json'
        private_path.write_text(json.dumps(private_query_payload, ensure_ascii=False, indent=2), encoding='utf-8')
    return records


def lighthouse_run(url: str, output_path: Path, preset: str) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    preset_args = ['--preset=desktop'] if preset == 'desktop' else []
    command = [
        'npx', '--yes', f'lighthouse@{LIGHTHOUSE_VERSION}', url,
        '--output=json', f'--output-path={output_path}',
        f'--chrome-path={CHROME_PATH}',
        '--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage',
        *preset_args, '--only-categories=performance', '--quiet',
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
    except Exception as exc:
        return {'status': 'failed', 'jsonPath': None, 'config': {'preset': preset, 'lighthouseVersion': LIGHTHOUSE_VERSION}, 'performanceScore': None, 'metrics': {}, 'error': type(exc).__name__}
    if not output_path.exists():
        return {'status': 'failed', 'jsonPath': None, 'config': {'preset': preset, 'lighthouseVersion': LIGHTHOUSE_VERSION}, 'performanceScore': None, 'metrics': {}, 'error': f'process_exit_{completed.returncode}'}
    try:
        report = json.loads(output_path.read_text(encoding='utf-8'))
        score = report.get('categories', {}).get('performance', {}).get('score')
        audits = report.get('audits', {})
        metric_ids = ['first-contentful-paint', 'largest-contentful-paint', 'speed-index', 'total-blocking-time', 'cumulative-layout-shift', 'interactive', 'server-response-time']
        metrics = {}
        for metric_id in metric_ids:
            audit = audits.get(metric_id, {})
            metrics[metric_id] = {'numericValue': audit.get('numericValue'), 'displayValue': audit.get('displayValue'), 'score': audit.get('score')}
        return {
            'status': 'complete',
            'jsonPath': str(output_path),
            'config': {'preset': preset, 'lighthouseVersion': LIGHTHOUSE_VERSION, 'returnCode': completed.returncode},
            'performanceScore': score * 100 if isinstance(score, (int, float)) else None,
            'metrics': metrics,
            'error': None if completed.returncode == 0 else f'process_exit_{completed.returncode}',
        }
    except Exception as exc:
        return {'status': 'failed', 'jsonPath': str(output_path), 'config': {'preset': preset, 'lighthouseVersion': LIGHTHOUSE_VERSION, 'returnCode': completed.returncode}, 'performanceScore': None, 'metrics': {}, 'error': type(exc).__name__}


async def dom_snapshot(page: Page) -> dict[str, Any]:
    return await page.evaluate(
        """() => {
          const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return !!(r.width || r.height) && s.visibility !== 'hidden' && s.display !== 'none'; };
          const clean = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '').replace(/\\s+/g, ' ').trim();
          const href = (el) => el.href || el.getAttribute('formaction') || null;
          const nodes = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')).filter(visible);
          const cta = nodes.map((el, index) => ({tag: el.tagName.toLowerCase(), text: clean(el).slice(0, 240), href: href(el), index})).filter(x => x.text || x.href).slice(0, 300);
          const forms = Array.from(document.forms).map((form, index) => ({
            index,
            fieldCount: form.querySelectorAll('input,select,textarea').length,
            submitControls: Array.from(form.querySelectorAll('button,input[type="submit"],input[type="button"]')).map(clean).filter(Boolean).slice(0, 30),
            action: form.getAttribute('action') || null,
            method: (form.getAttribute('method') || 'get').toLowerCase()
          }));
          const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).map(el => ({level: Number(el.tagName.slice(1)), text: clean(el).slice(0, 500)})).filter(x => x.text).slice(0, 120);
          return {
            title: document.title || null,
            metaDescription: document.querySelector('meta[name="description"]')?.content || null,
            headings,
            bodyText: document.body ? document.body.innerText : '',
            cta,
            forms,
            bodyScrollWidth: document.documentElement.scrollWidth,
            visibleInteractiveCount: nodes.length,
            cookieBannerDetected: /cookie|consent|privacy settings/i.test((document.body?.innerText || '').slice(0, 10000))
          };
        }"""
    )


async def safe_interactions(page: Page, viewport: str) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    actions.append({'viewport': viewport, 'action': 'inspect_visible_interactive_elements', 'outcome': 'completed_without_click', 'locator': None, 'timestamp': utc_now()})
    actions.append({'viewport': viewport, 'action': 'inspect_forms_without_input_or_submit', 'outcome': 'completed_without_mutation', 'locator': 'document.forms', 'timestamp': utc_now()})
    # Expand only clearly non-transactional disclosure controls. Never fill or submit a form.
    details = page.locator('details > summary')
    try:
        count = min(await details.count(), 12)
    except Exception:
        count = 0
    for index in range(count):
        try:
            label = compact_text(await details.nth(index).inner_text())
            if SENSITIVE_RE.search(label) or not SAFE_INTERACTION_RE.search(label):
                continue
            await details.nth(index).click(timeout=1500, no_wait_after=True)
            actions.append({'viewport': viewport, 'action': 'click_safe_disclosure', 'outcome': 'expanded', 'locator': safe_locator('details-summary', index), 'timestamp': utc_now()})
        except Exception as exc:
            actions.append({'viewport': viewport, 'action': 'click_safe_disclosure', 'outcome': f'not_completed_{type(exc).__name__}', 'locator': safe_locator('details-summary', index), 'timestamp': utc_now()})
    safe_buttons = page.locator('button,[role="button"]')
    try:
        count = min(await safe_buttons.count(), 20)
    except Exception:
        count = 0
    for index in range(count):
        try:
            label = compact_text(await safe_buttons.nth(index).inner_text())
            if not label or SENSITIVE_RE.search(label) or not SAFE_INTERACTION_RE.search(label):
                continue
            await safe_buttons.nth(index).click(timeout=1500, no_wait_after=True)
            actions.append({'viewport': viewport, 'action': 'click_safe_ui_control', 'outcome': 'completed_without_submit', 'locator': safe_locator('button', index), 'timestamp': utc_now()})
        except Exception as exc:
            actions.append({'viewport': viewport, 'action': 'click_safe_ui_control', 'outcome': f'not_completed_{type(exc).__name__}', 'locator': safe_locator('button', index), 'timestamp': utc_now()})
    try:
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
        actions.append({'viewport': viewport, 'action': 'scroll_to_page_end', 'outcome': 'completed', 'locator': 'window', 'timestamp': utc_now()})
    except Exception as exc:
        actions.append({'viewport': viewport, 'action': 'scroll_to_page_end', 'outcome': f'not_completed_{type(exc).__name__}', 'locator': 'window', 'timestamp': utc_now()})
    return actions


async def collect_viewport(browser: Browser, url: str, row_dir: Path, viewport: str, width: int, height: int, mobile: bool) -> dict[str, Any]:
    context_kwargs: dict[str, Any] = {
        'viewport': {'width': width, 'height': height},
        'device_scale_factor': 1,
        'java_script_enabled': True,
        'locale': 'en-US',
    }
    if mobile:
        context_kwargs.update({'is_mobile': True, 'has_touch': True, 'user_agent': 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36'})
    context = await browser.new_context(**context_kwargs)
    page = await context.new_page()
    console_errors: list[str] = []
    network_failures: list[str] = []
    page.on('console', lambda msg: console_errors.append(msg.type) if msg.type == 'error' else None)
    page.on('requestfailed', lambda req: network_failures.append(req.resource_type))
    response_status: int | None = None
    output: dict[str, Any]
    try:
        response = await page.goto(url, wait_until='commit', timeout=60000)
        response_status = response.status if response else None
        try:
            await page.wait_for_load_state('domcontentloaded', timeout=45000)
        except Exception:
            pass
        await page.wait_for_timeout(2000)
        data = await dom_snapshot(page)
        final_url = page.url
        final_valid, final_reason = validate_public_url(final_url)
        if final_valid is None:
            raise RuntimeError(final_reason or 'final_url_blocked')
        text = str(data.get('bodyText') or '')
        text_path = row_dir / f'page_text_{viewport}.txt'
        text_path.write_text(text, encoding='utf-8')
        screenshot_path = row_dir / f'screenshot_{viewport}.png'
        await page.screenshot(path=str(screenshot_path), full_page=True)
        actions = await safe_interactions(page, viewport)
        after_path = row_dir / f'screenshot_{viewport}_after_safe_interactions.png'
        await page.screenshot(path=str(after_path), full_page=True)
        body_scroll_width = data.get('bodyScrollWidth')
        horizontal_overflow = isinstance(body_scroll_width, int) and body_scroll_width > width + 2
        output = {
            'viewport': viewport,
            'screenshotPath': str(screenshot_path),
            'screenshotSha256': sha256_file(screenshot_path),
            'afterInteractionScreenshotPath': str(after_path),
            'afterInteractionScreenshotSha256': sha256_file(after_path),
            'viewportWidth': width,
            'bodyScrollWidth': body_scroll_width if isinstance(body_scroll_width, int) else None,
            'horizontalOverflow': horizontal_overflow if isinstance(body_scroll_width, int) else None,
            'visibleInteractiveCount': int(data.get('visibleInteractiveCount') or 0),
            'status': 'complete',
            'finalUrlHash': url_hash(final_url),
            'httpStatus': response_status,
            'title': data.get('title'),
            'metaDescription': data.get('metaDescription'),
            'headings': data.get('headings') or [],
            'fullTextPath': str(text_path),
            'textSha256': sha256_file(text_path),
            'ctaRaw': data.get('cta') or [],
            'formsRaw': data.get('forms') or [],
            'cookieBannerDetected': bool(data.get('cookieBannerDetected')),
            'consoleErrorCount': len(console_errors),
            'networkFailureCount': len(network_failures),
            'actions': actions,
            'finalUrlBlocked': False,
            'containsPii': bool(PII_RE.search(text)),
        }
    except Exception as exc:
        output = {
            'viewport': viewport,
            'screenshotPath': None,
            'screenshotSha256': None,
            'afterInteractionScreenshotPath': None,
            'afterInteractionScreenshotSha256': None,
            'viewportWidth': width,
            'bodyScrollWidth': None,
            'horizontalOverflow': None,
            'visibleInteractiveCount': 0,
            'status': 'failed',
            'finalUrlHash': url_hash(page.url) if page.url else None,
            'httpStatus': response_status,
            'title': None,
            'metaDescription': None,
            'headings': [],
            'fullTextPath': None,
            'textSha256': None,
            'ctaRaw': [],
            'formsRaw': [],
            'cookieBannerDetected': False,
            'consoleErrorCount': len(console_errors),
            'networkFailureCount': len(network_failures),
            'actions': [],
            'finalUrlBlocked': False,
            'containsPii': False,
            'error': type(exc).__name__,
        }
    await context.close()
    return output


def conversion_signals(viewport_data: dict[str, Any]) -> dict[str, Any]:
    body_path = viewport_data.get('fullTextPath')
    body = ''
    if body_path and Path(body_path).exists():
        body = Path(body_path).read_text(encoding='utf-8')
    cta = []
    for idx, item in enumerate(viewport_data.get('ctaRaw') or []):
        label = compact_text(str(item.get('text') or ''))
        href = item.get('href')
        if label and CTA_RE.search(label):
            cta.append({'text': label, 'element': item.get('tag') or 'unknown', 'visible': True, 'locator': safe_locator(str(item.get('tag') or 'interactive'), int(item.get('index', idx))), 'hrefHash': url_hash(href) if isinstance(href, str) and href else None})
    return {
        'cta': cta[:50],
        'pricing': extract_snippets(body, PRICE_RE),
        'proofOrCase': extract_snippets(body, PROOF_RE),
        'trust': extract_snippets(body, TRUST_RE),
    }


def forms_from_viewport(viewport_data: dict[str, Any]) -> list[dict[str, Any]]:
    forms = []
    for idx, form in enumerate(viewport_data.get('formsRaw') or []):
        forms.append({
            'locator': f'form:visible-index-{idx}',
            'fieldCount': int(form.get('fieldCount') or 0),
            'submitControls': [compact_text(str(x))[:160] for x in (form.get('submitControls') or [])],
            'stoppedBeforeSubmit': True,
        })
    return forms


def query_records_for_manifest(target: dict[str, Any], row_dir: Path) -> list[dict[str, Any]]:
    # Keep raw query text in a private sidecar, while the evidence manifest retains only hashes.
    return make_query_records(target, row_dir)


async def collect_target(browser: Browser, target: dict[str, Any], run_dir: Path, run_id: str, run_lighthouse: bool) -> dict[str, Any]:
    row_id = int(target.get('rowId'))
    row_dir = run_dir / f'row_{row_id}'
    row_dir.mkdir(parents=True, exist_ok=True)
    url, reason = validate_public_url(target.get('url'))
    query_records = query_records_for_manifest(target, row_dir)
    common_governance = {
        'privateOnly': True,
        'developmentOnly': True,
        'containsCredentials': False,
        'containsPii': False,
        'artifactExclusion': ['raw_html', 'raw_page_text', 'private_query_contexts', 'screenshots', 'browser_storage', 'cookies', 'credentials', 'OAuth', 'source_cards', 'unreviewed_annotation_evidence'],
    }
    if url is None:
        record = {
            'contractVersion': CONTRACT_VERSION,
            'rowId': row_id,
            'collectionRunId': run_id,
            'collectedAt': utc_now(),
            'collectionStatus': 'blocked_missing_url' if reason == 'missing_url' else 'blocked_policy',
            'target': {'url': None, 'urlHash': None, 'split': target.get('split'), 'pagePurpose': target.get('pagePurpose'), 'pagePurposeSource': 'user_supplied' if target.get('pagePurpose') else 'missing', 'queryContextIds': [x.get('queryId') for x in query_records]},
            'page': {'finalUrlHash': None, 'httpStatus': None, 'title': None, 'metaDescription': None, 'headings': [], 'fullTextPath': None, 'textSha256': None, 'pagePurposeSignals': [], 'cookieBannerDetected': False, 'consoleErrorCount': 0, 'networkFailureCount': 0},
            'conversionSignals': {'cta': [], 'pricing': [], 'proofOrCase': [], 'trust': []},
            'responsive': {'desktop': {'viewport': 'desktop', 'screenshotPath': None, 'screenshotSha256': None, 'viewportWidth': 1440, 'bodyScrollWidth': None, 'horizontalOverflow': None, 'visibleInteractiveCount': 0, 'status': 'blocked_missing_url'}, 'mobile': {'viewport': 'mobile', 'screenshotPath': None, 'screenshotSha256': None, 'viewportWidth': 390, 'bodyScrollWidth': None, 'horizontalOverflow': None, 'visibleInteractiveCount': 0, 'status': 'blocked_missing_url'}},
            'lighthouse': {'status': 'blocked_missing_url', 'jsonPath': None, 'config': None, 'performanceScore': None, 'metrics': {}, 'error': reason},
            'lighthouseMobile': {'status': 'blocked_missing_url', 'jsonPath': None, 'config': None, 'performanceScore': None, 'metrics': {}, 'error': reason},
            'interactionTrace': {'status': 'blocked_missing_url', 'actions': [], 'forms': [], 'stoppedBeforeSensitiveAction': True, 'unknownReasons': [reason or 'missing_url']},
            'queryContexts': query_records,
            'governance': common_governance,
        }
        (row_dir / 'evidence.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        return record

    desktop = await collect_viewport(browser, url, row_dir, 'desktop', 1440, 900, False)
    mobile = await collect_viewport(browser, url, row_dir, 'mobile', 390, 844, True)
    source_view = desktop if desktop.get('status') == 'complete' else mobile
    page_text_path = source_view.get('fullTextPath')
    page_text = Path(page_text_path).read_text(encoding='utf-8') if page_text_path and Path(page_text_path).exists() else ''
    title = source_view.get('title')
    meta_description = source_view.get('metaDescription')
    headings = source_view.get('headings') or []
    page_purpose_signals = []
    if title:
        page_purpose_signals.append({'source': 'document.title', 'text': compact_text(str(title))[:500]})
    if meta_description:
        page_purpose_signals.append({'source': 'meta.description', 'text': compact_text(str(meta_description))[:1000]})
    for heading in headings[:20]:
        page_purpose_signals.append({'source': f"h{heading.get('level')}", 'text': compact_text(str(heading.get('text') or ''))[:500]})
    page_purpose = target.get('pagePurpose') or (headings[0].get('text') if headings else None)
    page_purpose_source = 'user_supplied' if target.get('pagePurpose') else ('observed_heading' if headings else 'missing')
    signals = conversion_signals(source_view)
    interaction_actions = (desktop.get('actions') or []) + (mobile.get('actions') or [])
    forms = forms_from_viewport(source_view)
    contains_pii = bool(desktop.get('containsPii') or mobile.get('containsPii'))
    common_governance['containsPii'] = contains_pii
    lighthouse_desktop = {'status': 'not_run', 'jsonPath': None, 'config': None, 'performanceScore': None, 'metrics': {}, 'error': None}
    lighthouse_mobile = {'status': 'not_run', 'jsonPath': None, 'config': None, 'performanceScore': None, 'metrics': {}, 'error': None}
    if run_lighthouse and (desktop.get('status') == 'complete' or mobile.get('status') == 'complete'):
        lighthouse_desktop, lighthouse_mobile = await asyncio.gather(
            asyncio.to_thread(lighthouse_run, url, row_dir / 'lighthouse_desktop.json', 'desktop'),
            asyncio.to_thread(lighthouse_run, url, row_dir / 'lighthouse_mobile.json', 'mobile'),
        )
    complete_viewports = sum(x.get('status') == 'complete' for x in (desktop, mobile))
    collection_status = 'complete' if complete_viewports == 2 else ('partial' if complete_viewports else 'failed')
    record = {
        'contractVersion': CONTRACT_VERSION,
        'rowId': row_id,
        'collectionRunId': run_id,
        'collectedAt': utc_now(),
        'collectionStatus': collection_status,
        'target': {'url': url, 'urlHash': url_hash(url), 'split': target.get('split'), 'pagePurpose': page_purpose, 'pagePurposeSource': page_purpose_source, 'queryContextIds': [x.get('queryId') for x in query_records]},
        'page': {'finalUrlHash': source_view.get('finalUrlHash'), 'httpStatus': source_view.get('httpStatus'), 'title': title, 'metaDescription': meta_description, 'headings': headings, 'fullTextPath': page_text_path, 'textSha256': source_view.get('textSha256'), 'pagePurposeSignals': page_purpose_signals, 'cookieBannerDetected': bool(desktop.get('cookieBannerDetected') or mobile.get('cookieBannerDetected')), 'consoleErrorCount': int(desktop.get('consoleErrorCount', 0)) + int(mobile.get('consoleErrorCount', 0)), 'networkFailureCount': int(desktop.get('networkFailureCount', 0)) + int(mobile.get('networkFailureCount', 0))},
        'conversionSignals': signals,
        'responsive': {'desktop': {key: value for key, value in desktop.items() if key not in {'ctaRaw', 'formsRaw', 'actions', 'containsPii', 'finalUrlBlocked'}}, 'mobile': {key: value for key, value in mobile.items() if key not in {'ctaRaw', 'formsRaw', 'actions', 'containsPii', 'finalUrlBlocked'}}},
        'lighthouse': lighthouse_desktop,
        'lighthouseMobile': lighthouse_mobile,
        'interactionTrace': {'status': 'complete_non_destructive' if complete_viewports else 'failed', 'actions': interaction_actions, 'forms': forms, 'stoppedBeforeSensitiveAction': True, 'unknownReasons': ['no credentials or storage state used', 'no form field was filled', 'no submit, payment, booking, checkout, or account action was clicked']},
        'queryContexts': query_records,
        'governance': common_governance,
    }
    (row_dir / 'evidence.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    return record


async def main(args: argparse.Namespace) -> None:
    source = Path(args.targets)
    targets = [json.loads(line) for line in source.read_text(encoding='utf-8').splitlines() if line.strip()]
    if args.limit is not None:
        targets = targets[:args.limit]
    run_id = args.run_id or f'page-evidence-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}'
    run_dir = Path(args.output_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = run_dir / 'evidence_manifest.jsonl'
    summary = {'runId': run_id, 'targetsRequested': len(targets), 'complete': 0, 'partial': 0, 'blocked': 0, 'failed': 0, 'lighthouseRunsRequested': bool(not args.skip_lighthouse), 'privateOnly': True}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=not args.headed, executable_path=CHROME_PATH, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            with manifest_path.open('w', encoding='utf-8') as manifest:
                for index, target in enumerate(targets, start=1):
                    record = await collect_target(browser, target, run_dir, run_id, not args.skip_lighthouse)
                    manifest.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
                    manifest.flush()
                    status = record.get('collectionStatus')
                    if status == 'complete':
                        summary['complete'] += 1
                    elif status == 'partial':
                        summary['partial'] += 1
                    elif status in {'blocked_missing_url', 'blocked_policy'}:
                        summary['blocked'] += 1
                    else:
                        summary['failed'] += 1
                    print(json.dumps({'completed': index, 'total': len(targets), 'status': status}, ensure_ascii=False), flush=True)
                    if args.host_delay > 0 and index < len(targets):
                        await asyncio.sleep(args.host_delay)
        finally:
            await browser.close()
    (run_dir / 'run_summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Private Page Evidence Collector')
    parser.add_argument('--targets', required=True, help='Private JSONL with rowId, split, url, pagePurpose, queryContexts')
    parser.add_argument('--output-dir', default=str(DEFAULT_OUTPUT))
    parser.add_argument('--run-id', default=None)
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument('--host-delay', type=float, default=2.0)
    parser.add_argument('--skip-lighthouse', action='store_true')
    parser.add_argument('--headed', action='store_true')
    return parser.parse_args()


if __name__ == '__main__':
    try:
        asyncio.run(main(parse_args()))
    except KeyboardInterrupt:
        sys.exit(130)
