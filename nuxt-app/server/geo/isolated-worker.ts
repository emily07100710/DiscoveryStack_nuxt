import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { GeoDocumentInput, GeoRewriteAdapter, GeoRule } from './contracts'

export const AUTOGEO_WORKER_PROTOCOL_VERSION = 'autogeo-worker-protocol-v1'
export const AUTOGEO_WORKER_TIMEOUT_MS = 2_500
export const AUTOGEO_WORKER_MAX_INPUT_BYTES = 64_000
export const AUTOGEO_WORKER_MAX_OUTPUT_BYTES = 220_000

const CANONICAL_RULE_IDS = [
  'direct-answer-first',
  'semantic-sections',
  'entity-context',
  'evidence-boundary',
  'reader-action',
  'claim-safety',
  'heading-hierarchy',
  'faq-question-answer',
  'citation-readiness',
  'topic-cluster',
  'internal-linking',
  'canonical-signal',
  'structured-data-safety',
] as const

const WORKER_SOURCE = String.raw`'use strict';
const readline = require('node:readline');
const crypto = require('node:crypto');
const PROTOCOL = 'autogeo-worker-protocol-v1';
const MAX_TITLE = 180;
const MAX_CONTENT = 12000;
const MAX_RULES = 20;
const IDS = new Set(${JSON.stringify(CANONICAL_RULE_IDS)});
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => value.replace(/\\s+/g, ' ').trim();
const summaryOf = value => (value.split(/[。！？.!?]/u).map(part => part.trim()).find(Boolean) || value).slice(0, 280).trim();
const appendSection = (content, heading, body) => content.trim() + '\\n\\n## ' + heading + '\\n' + body.trim();
function transform(document, id, content) {
  const summary = summaryOf(document.content);
  const zh = document.language === 'zh-hant';
  switch (id) {
    case 'direct-answer-first': return zh ? '## 直接摘要\\n' + summary + '\\n\\n' + content : '## Direct answer\\n' + summary + '\\n\\n' + content;
    case 'semantic-sections': return appendSection(content, zh ? '詳細說明' : 'Detailed explanation', document.content);
    case 'entity-context': return appendSection(content, zh ? '主題與適用範圍' : 'Topic and scope', zh ? '本文聚焦於「' + document.title + '」，不推測未由原文支持的地點、產業或影響。' : 'This document focuses on “' + document.title + '”; it does not infer locations, industries, or outcomes unsupported by the source.');
    case 'evidence-boundary': return appendSection(content, zh ? '證據邊界' : 'Evidence boundary', zh ? '以下只保留原文與已核准 evidence 支持的內容；未提供的事實必須由 owner 補入並核對。' : 'Only source-supported and approved-evidence-supported content is retained; the owner must add and verify anything not supplied.');
    case 'reader-action': return appendSection(content, zh ? '建議下一步' : 'Suggested next step', zh ? '由 owner 補充可驗證 evidence、FAQ 與相關頁面連結，再人工檢查內容。' : 'The owner should add verifiable evidence, FAQs, and relevant page links, then review the content manually.');
    case 'claim-safety': return appendSection(content, zh ? '主張安全' : 'Claim safety', zh ? '不得新增未經 evidence 支持的成效或比較敘述，也不可虛構數據或背書。' : 'Do not add unsupported outcome or comparison statements, fabricated data, or endorsements.');
    case 'heading-hierarchy': return (zh ? '# ' : '# ') + document.title + '\\n\\n' + content;
    case 'faq-question-answer': return appendSection(content, zh ? '問題與回答' : 'Question and answer', zh ? '### 目前可以確認什麼？\\n' + summary + '\\n\\n### 仍需什麼核對？\\n請由 owner 依 evidence 檢查所有事實主張。' : '### What can be confirmed?\\n' + summary + '\\n\\n### What still needs review?\\nThe owner must check every factual claim against the evidence.');
    case 'citation-readiness': return appendSection(content, zh ? '引用準備' : 'Citation readiness', zh ? '請由 owner 補上來源、日期、作者或方法定位；分開標示事實、推論與建議。' : 'The owner should add source, date, author, or method locators and distinguish facts, inferences, and recommendations.');
    case 'topic-cluster': return appendSection(content, zh ? '有限主題延伸' : 'Bounded topic extension', zh ? '核心主題：' + document.title + '\\nSupporting opportunities：只規劃必要的 supporting article 與 FAQ，不無限制產文。' : 'Core topic: ' + document.title + '\\nSupporting opportunities: plan only necessary supporting articles and FAQs; do not generate without bounds.');
    case 'internal-linking': return appendSection(content, zh ? '內部連結規格' : 'Internal-link specification', zh ? '只可連結已由 owner 確認存在的相關頁面，並記錄連結目的與描述性 anchor；本 pass 不生成 URL。' : 'Link only to pages confirmed by the owner to exist, recording purpose and descriptive anchors; this pass does not generate URLs.');
    case 'canonical-signal': return appendSection(content, 'Canonical and language check', zh ? '由網站擁有者確認 canonical、語言與多語路徑；本 pass 不改寫網站設定或宣稱已部署。' : 'The site owner must confirm canonical, language, and multilingual paths; this pass does not change site configuration or claim deployment.');
    case 'structured-data-safety': return appendSection(content, 'Structured-data safety', zh ? '只有頁面實際支持時才規劃 schema；不得虛構評分、價格、評論、資格或 rich result eligibility。' : 'Plan schema only when the page supports it; do not fabricate ratings, prices, reviews, qualifications, or rich-result eligibility.');
    default: throw new Error('unknown_rule');
  }
}
function fail(code) {
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL, ok: false, code }));
  process.exitCode = 1;
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  raw += chunk;
  if (Buffer.byteLength(raw, 'utf8') > 64000) fail('input_too_large');
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (!input || input.protocol !== PROTOCOL || typeof input.sourceFingerprint !== 'string') return fail('invalid_protocol');
    const document = input.document;
    const ids = input.ruleIds;
    if (!document || typeof document.title !== 'string' || typeof document.content !== 'string' || !['en', 'zh-hant'].includes(document.language)) return fail('invalid_document');
    if (!document.title.trim() || document.title.length > MAX_TITLE || !document.content.trim() || document.content.length > MAX_CONTENT) return fail('invalid_document');
    if (!Array.isArray(ids) || ids.length > MAX_RULES || ids.some(id => typeof id !== 'string' || !IDS.has(id))) return fail('invalid_rules');
    const requestCanonical = JSON.stringify({ title: document.title, content: document.content, language: document.language, ruleIds: ids });
    if (sha256(requestCanonical) !== input.sourceFingerprint) return fail('fingerprint_mismatch');
    let body = document.content;
    for (const id of ids) body = transform(document, id, body);
    const result = { protocol: PROTOCOL, ok: true, sourceFingerprint: input.sourceFingerprint, optimizedTitle: document.title, optimizedContent: body, appliedRuleIds: ids };
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    fail(error && error.message === 'unknown_rule' ? 'invalid_rules' : 'worker_error');
  }
});`

// The worker source is self-contained and has no runtime dependency on
// repository files, provider credentials, or network access.
const WORKER_SCRIPT = WORKER_SOURCE
export const AUTOGEO_WORKER_SOURCE_SHA256 = createHash('sha256').update(WORKER_SCRIPT).digest('hex')

export function createAutoGeoIsolatedWorkerAdapter(): GeoRewriteAdapter {
  return {
    id: 'reference-rules-v1',
    version: `${AUTOGEO_WORKER_PROTOCOL_VERSION}@${AUTOGEO_WORKER_SOURCE_SHA256.slice(0, 12)}`,
    async rewrite(document, rules) {
      const result = await runAutoGeoReferenceWorker(document, rules)
      return {
        provider: 'reference-rules-v1',
        providerVersion: `${AUTOGEO_WORKER_PROTOCOL_VERSION}@${AUTOGEO_WORKER_SOURCE_SHA256.slice(0, 12)}`,
        optimizedTitle: result.optimizedTitle,
        optimizedContent: result.optimizedContent,
        appliedRuleIds: result.appliedRuleIds,
        safetyNotes: [
          '完整 AutoGEO 或 Qwen provider 本次未執行；這是 isolated deterministic reference fallback。',
          'worker 只執行 pinned selected-rule transformation，沒有 hidden network 或 model inference。',
          'provider unavailable 時此候選只能供 preview、development 或 manual inspection，不能在 governed_autopilot 自動發布。',
        ],
        provenance: {
          requestedProvider: 'autogeo-bailian-qwen',
          execution: 'reference-fallback',
          providerExecution: false,
          upstreamRepository: 'cxcscmu/AutoGEO',
          upstreamRevision: 'isolated-worker-reference-rules-v1',
          rewriteMethod: 'autogeo_api',
          ruleset: 'Researchy-GEO / Gemini default rules',
          model: 'qwen-plus',
          fallbackReason: 'autogeo-not-configured',
          ruleSource: 'discoverystack-autogeo-compatible',
          workerProtocolVersion: AUTOGEO_WORKER_PROTOCOL_VERSION,
          workerSourceSha256: result.workerSourceSha256,
        },
      }
    },
  }
}

export type AutoGeoWorkerResult = {
  optimizedTitle: string
  optimizedContent: string
  appliedRuleIds: string[]
  workerSourceSha256: string
}

export type AutoGeoWorkerErrorCode = 'invalid_input' | 'input_too_large' | 'timeout' | 'output_too_large' | 'process_error' | 'protocol_error' | 'integrity_error'

export class AutoGeoWorkerError extends Error {
  constructor(readonly code: AutoGeoWorkerErrorCode, message: string) {
    super(message)
    this.name = 'AutoGeoWorkerError'
  }
}

function requestFingerprint(document: Pick<GeoDocumentInput, 'title' | 'content' | 'language'>, rules: readonly GeoRule[]): string {
  return createHash('sha256').update(JSON.stringify({ title: document.title, content: document.content, language: document.language, ruleIds: rules.map(rule => rule.id) })).digest('hex')
}

function isCanonicalRuleIds(ids: unknown, expected: readonly string[]): ids is string[] {
  return Array.isArray(ids) && ids.length === expected.length && ids.every((id, index) => id === expected[index])
}

export function runAutoGeoReferenceWorker(input: GeoDocumentInput, rules: readonly GeoRule[], options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<AutoGeoWorkerResult> {
  if (!input.title.trim() || input.title.length > 180 || !input.content.trim() || input.content.length > 12_000 || !['en', 'zh-hant'].includes(input.language)) {
    return Promise.reject(new AutoGeoWorkerError('invalid_input', 'AutoGEO worker rejected the bounded document input.'))
  }
  if (rules.length > 20 || rules.some(rule => !CANONICAL_RULE_IDS.includes(rule.id as typeof CANONICAL_RULE_IDS[number]))) {
    return Promise.reject(new AutoGeoWorkerError('invalid_input', 'AutoGEO worker rejected a non-canonical rule selection.'))
  }
  const request = JSON.stringify({ protocol: AUTOGEO_WORKER_PROTOCOL_VERSION, sourceFingerprint: requestFingerprint(input, rules), document: { title: input.title, content: input.content, language: input.language }, ruleIds: rules.map(rule => rule.id) })
  if (Buffer.byteLength(request, 'utf8') > AUTOGEO_WORKER_MAX_INPUT_BYTES) return Promise.reject(new AutoGeoWorkerError('input_too_large', 'AutoGEO worker input exceeded the bounded byte limit.'))
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs || 0) > 0 && (options.timeoutMs || 0) <= 10_000 ? options.timeoutMs as number : AUTOGEO_WORKER_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(options.maxOutputBytes) && (options.maxOutputBytes || 0) > 0 && (options.maxOutputBytes || 0) <= 400_000 ? options.maxOutputBytes as number : AUTOGEO_WORKER_MAX_OUTPUT_BYTES

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', '-e', WORKER_SCRIPT], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '', NODE_NO_WARNINGS: '1' } })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error, result?: AutoGeoWorkerResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new AutoGeoWorkerError('process_error', 'AutoGEO worker exited without a result.'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new AutoGeoWorkerError('timeout', 'AutoGEO worker exceeded its bounded timeout.'))
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
        child.kill('SIGKILL')
        finish(new AutoGeoWorkerError('output_too_large', 'AutoGEO worker output exceeded the bounded byte limit.'))
      }
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
      if (Buffer.byteLength(stderr, 'utf8') > 8_000) stderr = stderr.slice(-8_000)
    })
    child.once('error', error => finish(new AutoGeoWorkerError('process_error', `AutoGEO worker process failed: ${error.message}`)))
    child.once('close', code => {
      if (settled) return
      let payload: unknown
      try { payload = JSON.parse(stdout) } catch { finish(new AutoGeoWorkerError('protocol_error', `AutoGEO worker returned invalid JSON${stderr ? `: ${stderr.replace(/[\r\n]+/g, ' ').slice(0, 240)}` : '.'}`)); return }
      if (!payload || typeof payload !== 'object' || (payload as { protocol?: unknown }).protocol !== AUTOGEO_WORKER_PROTOCOL_VERSION || !(payload as { ok?: unknown }).ok) {
        finish(new AutoGeoWorkerError('protocol_error', 'AutoGEO worker returned an invalid protocol response.'))
        return
      }
      const candidate = payload as { sourceFingerprint?: unknown; optimizedTitle?: unknown; optimizedContent?: unknown; appliedRuleIds?: unknown }
      const expectedFingerprint = requestFingerprint(input, rules)
      if (candidate.sourceFingerprint !== expectedFingerprint) {
        finish(new AutoGeoWorkerError('integrity_error', 'AutoGEO worker response integrity did not match the parent process.'))
        return
      }
      const expectedIds = rules.map(rule => rule.id)
      if (typeof candidate.optimizedTitle !== 'string' || typeof candidate.optimizedContent !== 'string' || !isCanonicalRuleIds(candidate.appliedRuleIds, expectedIds) || code !== 0) {
        finish(new AutoGeoWorkerError('protocol_error', 'AutoGEO worker response failed schema validation.'))
        return
      }
      finish(undefined, { optimizedTitle: candidate.optimizedTitle, optimizedContent: candidate.optimizedContent, appliedRuleIds: candidate.appliedRuleIds, workerSourceSha256: AUTOGEO_WORKER_SOURCE_SHA256 })
    })
    child.stdin.end(request)
  })
}
