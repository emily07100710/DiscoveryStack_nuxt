import { createError } from 'h3'
import { AutoGeoConfigurationError, AutoGeoProviderError, AUTOGEO_UPSTREAM, createAutoGeoApiAdapter } from './autogeo-api'
import { AutoGeoBailianConfigurationError, AutoGeoBailianProviderError, createAutoGeoBailianQwenAdapter } from './autogeo-bailian-qwen'
import { GEO_WORKBENCH_VERSION, type GeoDocumentInput, type GeoFallbackReason, type GeoOptimizationResult, type GeoRequestedProvider, type GeoRewriteAdapter, type GeoRewriteCandidate, type GeoRule } from './contracts'
import { createAutoGeoIsolatedWorkerAdapter, AUTOGEO_WORKER_PROTOCOL_VERSION, AUTOGEO_WORKER_SOURCE_SHA256 } from './isolated-worker'
import { evaluateDocument } from './metrics'
import { assertSourceBoundRewrite, AutoGeoUnsafeOutputError } from './output-safety'
import { GEO_RULESET_VERSION, geoRules, resolveCanonicalGeoRules } from './rules'

const MAX_TITLE_LENGTH = 180
const MAX_CONTENT_LENGTH = 12000
const MAX_APPROVED_EVIDENCE_CONTEXT_LENGTH = 16000
const MAX_APPROVED_DIAGNOSIS_CONTEXT_LENGTH = 12000
const MAX_APPROVED_STRATEGY_CONTEXT_LENGTH = 16000
const MAX_BRIEF_ITEM_LENGTH = 500
const MAX_BRIEF_ITEMS = 20

function cleanBriefItems(value: readonly string[] | undefined): string[] {
  return Array.isArray(value) ? value.map(item => item.trim().slice(0, MAX_BRIEF_ITEM_LENGTH)).filter(Boolean).slice(0, MAX_BRIEF_ITEMS) : []
}

export function isUnsafeProviderRewrite(error: unknown): boolean {
  if (error instanceof AutoGeoUnsafeOutputError) return true
  if (!(error instanceof Error)) return false
  return error.name === 'AutoGeoUnsafeOutputError' || error.message.includes('unsupported commercial or customer-success claims')
}

function cleanInput(input: GeoDocumentInput): GeoDocumentInput {
  const title = input.title.trim().replace(/\s+/g, ' ')
  const content = input.content.trim()
  if (!title || title.length > MAX_TITLE_LENGTH) throw createError({ statusCode: 400, message: '標題必須介於 1 至 180 個字元。' })
  if (!content || content.length > MAX_CONTENT_LENGTH) throw createError({ statusCode: 400, message: '原文必須介於 1 至 12,000 個字元。' })
  if (input.language !== 'en' && input.language !== 'zh-hant') throw createError({ statusCode: 400, message: '不支援的語言。' })
  const approvedEvidenceContext = input.approvedEvidenceContext?.trim()
  if (approvedEvidenceContext && approvedEvidenceContext.length > MAX_APPROVED_EVIDENCE_CONTEXT_LENGTH) throw createError({ statusCode: 400, message: '已核准 evidence context 超過單次處理上限。' })
  const approvedDiagnosisContext = input.approvedDiagnosisContext?.trim()
  if (approvedDiagnosisContext && approvedDiagnosisContext.length > MAX_APPROVED_DIAGNOSIS_CONTEXT_LENGTH) throw createError({ statusCode: 400, message: '已核准 diagnosis context 超過單次處理上限。' })
  const approvedStrategyContext = input.approvedStrategyContext?.trim()
  if (approvedStrategyContext && approvedStrategyContext.length > MAX_APPROVED_STRATEGY_CONTEXT_LENGTH) throw createError({ statusCode: 400, message: '已核准 strategy context 超過單次處理上限。' })
  const approvedBriefGoals = cleanBriefItems(input.approvedBriefGoals)
  const approvedBriefConstraints = cleanBriefItems(input.approvedBriefConstraints)
  return { title, content, language: input.language, ...(approvedEvidenceContext ? { approvedEvidenceContext } : {}), ...(approvedDiagnosisContext ? { approvedDiagnosisContext } : {}), ...(approvedStrategyContext ? { approvedStrategyContext } : {}), ...(approvedBriefGoals.length ? { approvedBriefGoals } : {}), ...(approvedBriefConstraints.length ? { approvedBriefConstraints } : {}) }
}

function summaryOf(content: string) { return (content.split(/[。！？.!?]/u).map(part => part.trim()).find(Boolean) || content).slice(0, 280).trim() }

function appendSection(content: string, heading: string, body: string): string {
  return `${content.trim()}\n\n## ${heading}\n${body.trim()}`
}

function applyReferenceRuleTransform(document: GeoDocumentInput, rule: GeoRule, content: string): string {
  const summary = summaryOf(document.content)
  const zh = document.language === 'zh-hant'
  switch (rule.id) {
    case 'direct-answer-first':
      return zh ? `## 直接摘要\n${summary}\n\n${content}` : `## Direct answer\n${summary}\n\n${content}`
    case 'semantic-sections':
      return appendSection(content, zh ? '詳細說明' : 'Detailed explanation', document.content)
    case 'entity-context':
      return appendSection(content, zh ? '主題與適用範圍' : 'Topic and scope', zh ? `本文聚焦於「${document.title}」，不推測未由原文支持的地點、產業或成果。` : `This document focuses on “${document.title}”; it does not infer locations, industries, or outcomes unsupported by the source.`)
    case 'evidence-boundary':
      return appendSection(content, zh ? '證據邊界' : 'Evidence boundary', zh ? '以下只保留原文與已核准 evidence 支持的內容；未提供的事實必須由 owner 補入並核對。' : 'Only source-supported and approved-evidence-supported content is retained; the owner must add and verify anything not supplied.')
    case 'reader-action':
      return appendSection(content, zh ? '建議下一步' : 'Suggested next step', zh ? '由 owner 補充可驗證 evidence、FAQ 與相關頁面連結，再人工檢查內容。' : 'The owner should add verifiable evidence, FAQs, and relevant page links, then review the content manually.')
    case 'claim-safety':
      return appendSection(content, zh ? '主張安全' : 'Claim safety', zh ? '不得新增未經 evidence 支持的成效或比較敘述，也不可虛構數據或背書。' : 'Do not add unsupported outcome or comparison statements, fabricated data, or endorsements.')
    case 'heading-hierarchy':
      return zh ? `# ${document.title}\n\n${content}` : `# ${document.title}\n\n${content}`
    case 'faq-question-answer':
      return appendSection(content, zh ? '問題與回答' : 'Question and answer', zh ? `### 目前可以確認什麼？\n${summary}\n\n### 仍需什麼核對？\n請由 owner 依 evidence 檢查所有事實主張。` : `### What can be confirmed?\n${summary}\n\n### What still needs review?\nThe owner must check every factual claim against the evidence.`)
    case 'citation-readiness':
      return appendSection(content, zh ? '引用準備' : 'Citation readiness', zh ? '請由 owner 補上來源、日期、作者或方法定位；分開標示事實、推論與建議。' : 'The owner should add source, date, author, or method locators and distinguish facts, inferences, and recommendations.')
    case 'topic-cluster':
      return appendSection(content, zh ? '有限主題延伸' : 'Bounded topic extension', zh ? `核心主題：${document.title}\nSupporting opportunities：只規劃必要的 supporting article 與 FAQ，不無限制產文。` : `Core topic: ${document.title}\nSupporting opportunities: plan only necessary supporting articles and FAQs; do not generate without bounds.`)
    case 'internal-linking':
      return appendSection(content, zh ? '內部連結規格' : 'Internal-link specification', zh ? '只可連結已由 owner 確認存在的相關頁面，並記錄連結目的與描述性 anchor；本 pass 不生成 URL。' : 'Link only to pages confirmed by the owner to exist, recording purpose and descriptive anchors; this pass does not generate URLs.')
    case 'canonical-signal':
      return appendSection(content, 'Canonical and language check', zh ? '由網站擁有者確認 canonical、語言與多語路徑；本 pass 不改寫網站設定或宣稱已部署。' : 'The site owner must confirm canonical, language, and multilingual paths; this pass does not change site configuration or claim deployment.')
    case 'structured-data-safety':
      return appendSection(content, 'Structured-data safety', zh ? '只有頁面實際支持時才規劃 schema；不得虛構評分、價格、評論、資格或 rich result eligibility。' : 'Plan schema only when the page supports it; do not fabricate ratings, prices, reviews, qualifications, or rich-result eligibility.')
    default:
      throw createError({ statusCode: 422, message: `Reference rules do not support canonical rule ${rule.id}.` })
  }
}

function applyReferenceRuleTransforms(document: GeoDocumentInput, rules: readonly GeoRule[]): { title: string, body: string } {
  let body = document.content
  for (const rule of rules) body = applyReferenceRuleTransform(document, rule, body)
  return { title: document.title, body }
}

function referenceCandidate(document: GeoDocumentInput, rules: readonly GeoRule[], fallbackReason: GeoFallbackReason, requestedProvider: GeoRequestedProvider = 'autogeo-bailian-qwen', model = 'qwen-plus'): GeoRewriteCandidate {
  const transformed = applyReferenceRuleTransforms(document, rules)
  const optimizedTitle = document.language === 'zh-hant' ? `${transformed.title}｜重點與可驗證說明` : `${transformed.title} | Key points and verification notes`
  const optimizedContent = document.language === 'zh-hant'
    ? `# ${optimizedTitle}\n\n${transformed.body}\n\n## 驗證與補強\n本文未因格式調整而新增外部事實。上線前請由內容擁有者人工核對主張。`
    : `# ${optimizedTitle}\n\n${transformed.body}\n\n## Verification and reinforcement\nThis formatting pass does not add external facts. The content owner must review every claim before publication.`
  return {
    provider: 'reference-rules-v1', providerVersion: '1.0.0', optimizedTitle, optimizedContent, appliedRuleIds: rules.map(rule => rule.id),
    safetyNotes: ['完整 AutoGEO API 本次未執行；此為 reference-rules-v1 fallback，不可稱為 AutoGEO 生成結果。', '每個 applied rule 均由 server-side deterministic transformation 實際改變正文。', '不新增排名、流量、轉換或第三方引擎效果保證。', '外部來源、數據與產品主張必須由 owner 人工驗證。'],
    provenance: { requestedProvider, execution: 'reference-fallback', providerExecution: false, upstreamRepository: AUTOGEO_UPSTREAM.repository, upstreamRevision: AUTOGEO_UPSTREAM.revision, rewriteMethod: AUTOGEO_UPSTREAM.rewriteMethod, ruleset: AUTOGEO_UPSTREAM.ruleset, model, fallbackReason, ruleSource: 'discoverystack-autogeo-compatible' },
  }
}

const isolatedReferenceRulesAdapter = createAutoGeoIsolatedWorkerAdapter()

async function referenceFallback(document: GeoDocumentInput, rules: readonly GeoRule[], fallbackReason: GeoFallbackReason, requestedProvider: GeoRequestedProvider = 'autogeo-bailian-qwen', model: GeoRewriteCandidate['provenance']['model'] = 'qwen-plus'): Promise<GeoRewriteCandidate> {
  const candidate = await isolatedReferenceRulesAdapter.rewrite(document, rules)
  return {
    ...candidate,
    safetyNotes: [...candidate.safetyNotes, 'fallback provenance 由父程序保存；此候選不可進入 governed_autopilot production publication path。'],
    provenance: { ...candidate.provenance, requestedProvider, model, fallbackReason, providerExecution: false, workerProtocolVersion: AUTOGEO_WORKER_PROTOCOL_VERSION, workerSourceSha256: AUTOGEO_WORKER_SOURCE_SHA256 },
  }
}

export const referenceRulesAdapter: GeoRewriteAdapter = {
  ...isolatedReferenceRulesAdapter,
  async rewrite(document, rules) { return referenceFallback(document, rules, 'autogeo-not-configured') },
}

async function safeFallback(document: GeoDocumentInput, rules: readonly GeoRule[]): Promise<GeoRewriteCandidate> {
  const candidate = await referenceFallback(document, rules, 'provider-output-safety-rejected')
  candidate.safetyNotes.unshift('百鍊／AutoGEO provider 草稿加入原文未支持的商業主張，已由 server-side source-bound guard 拒絕。', '以下為 reference-rules-v1 fallback，供 owner 審閱；它不是 provider 成功產出，也不會自動發布。')
  return candidate
}

async function rewriteWithPreferredProvider(document: GeoDocumentInput, rules: readonly GeoRule[]): Promise<GeoRewriteCandidate> {
  let bailianFallbackReason: GeoFallbackReason
  try { return await createAutoGeoBailianQwenAdapter().rewrite(document, rules) }
  catch (error) {
    if (isUnsafeProviderRewrite(error)) return await safeFallback(document, rules)
    if (!(error instanceof AutoGeoBailianConfigurationError) && !(error instanceof AutoGeoBailianProviderError)) throw error
    bailianFallbackReason = error instanceof AutoGeoBailianConfigurationError && error.issue === 'invalid-endpoint' ? 'bailian-invalid-configuration' : error instanceof AutoGeoBailianConfigurationError ? 'bailian-not-configured' : 'bailian-provider-unavailable'
  }
  try { return await createAutoGeoApiAdapter().rewrite(document, rules) }
  catch (error) {
    if (isUnsafeProviderRewrite(error)) return await safeFallback(document, rules)
    if (!(error instanceof AutoGeoConfigurationError) && !(error instanceof AutoGeoProviderError)) throw error
    if (bailianFallbackReason !== 'bailian-not-configured') return referenceFallback(document, rules, bailianFallbackReason, 'autogeo-bailian-qwen')
    const fallbackReason: GeoFallbackReason = error instanceof AutoGeoConfigurationError ? 'bailian-not-configured' : 'autogeo-provider-unavailable'
    return referenceFallback(document, rules, fallbackReason, error instanceof AutoGeoConfigurationError ? 'autogeo-bailian-qwen' : 'autogeo-api', error instanceof AutoGeoConfigurationError ? 'qwen-plus' : AUTOGEO_UPSTREAM.model)
  }
}

export async function optimiseGeoDocument(input: GeoDocumentInput, adapter?: GeoRewriteAdapter, selectedRules?: readonly GeoRule[]): Promise<GeoOptimizationResult> {
  const document = cleanInput(input)
  const rules = selectedRules ? resolveCanonicalGeoRules(selectedRules.map(rule => rule.id)) : [...geoRules]
  const baseline = evaluateDocument(document)
  let candidate: GeoRewriteCandidate
  try { candidate = adapter ? await adapter.rewrite(document, rules) : await rewriteWithPreferredProvider(document, rules) }
  catch (error) { if (isUnsafeProviderRewrite(error)) candidate = await safeFallback(document, rules); else throw error }
  const expectedRuleIds = rules.map(rule => rule.id)
  if (candidate.appliedRuleIds.length !== expectedRuleIds.length || candidate.appliedRuleIds.some((ruleId, index) => ruleId !== expectedRuleIds[index])) {
    throw createError({ statusCode: 502, message: 'AutoGEO adapter returned a rule lineage mismatch.' })
  }
  assertSourceBoundRewrite(document, candidate.optimizedTitle, candidate.optimizedContent)
  const optimized = evaluateDocument({ title: candidate.optimizedTitle, content: candidate.optimizedContent, language: document.language }, { sourceContent: document.content })
  const comparison = baseline.metrics.map(metric => { const after = optimized.metrics.find(candidateMetric => candidateMetric.id === metric.id); return { ...metric, before: metric.score, after: after?.score || 0, delta: (after?.score || 0) - metric.score } })
  const changed = comparison.filter(metric => metric.delta > 0).map(metric => metric.label)
  return { version: GEO_WORKBENCH_VERSION, rulesetVersion: GEO_RULESET_VERSION, original: document, candidate, baseline, optimized, comparison, summary: changed.length ? `在相同 heuristic 下，${changed.join('、')} 的結構訊號提高；請人工驗證所有內容主張。` : '此版本沒有可量化的 heuristic 提升；請檢查內容證據與適用範圍。', interpretationLimit: '這是已記錄規則下的內容結構比較，不代表 Google、ChatGPT、Gemini 或任何第三方生成式搜尋引擎的真實排名、曝光、流量或轉換結果。' }
}
