import { createError } from 'h3'
import { AutoGeoConfigurationError, AutoGeoProviderError, AUTOGEO_UPSTREAM, createAutoGeoApiAdapter } from './autogeo-api'
import { AutoGeoBailianConfigurationError, AutoGeoBailianProviderError, createAutoGeoBailianQwenAdapter } from './autogeo-bailian-qwen'
import { GEO_WORKBENCH_VERSION, type GeoDocumentInput, type GeoFallbackReason, type GeoOptimizationResult, type GeoRequestedProvider, type GeoRewriteAdapter, type GeoRewriteCandidate } from './contracts'
import { evaluateDocument } from './metrics'
import { AutoGeoUnsafeOutputError } from './output-safety'
import { GEO_RULESET_VERSION, geoRules } from './rules'

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

function referenceCandidate(document: GeoDocumentInput, rules: readonly { id: string }[], fallbackReason: GeoFallbackReason, requestedProvider: GeoRequestedProvider = 'autogeo-bailian-qwen', model = 'qwen-plus'): GeoRewriteCandidate {
  const summary = summaryOf(document.content)
  const optimizedTitle = document.language === 'zh-hant' ? `${document.title}｜重點與可驗證說明` : `${document.title} | Key points and verification notes`
  const optimizedContent = document.language === 'zh-hant'
    ? `# ${optimizedTitle}\n\n## 直接摘要\n${summary}\n\n## 本文範圍\n本頁聚焦於「${document.title}」。以下內容保留原文資訊，不新增未被原文支持的成果、數據或第三方背書。\n\n## 詳細說明\n${document.content}\n\n## 驗證與補強\n本文未因格式優化而新增外部事實。上線前請由內容擁有者補入可驗證來源、案例或 FAQ，並人工核對主張。\n\n## 建議下一步\n依內容目標補齊證據、常見問題與相關頁面連結，再以相同評估設定比較更新前後。`
    : `# ${optimizedTitle}\n\n## Direct summary\n${summary}\n\n## Scope\nThis page focuses on “${document.title}”. The original information is preserved below; no unsupported results, statistics, or third-party endorsements are added.\n\n## Details\n${document.content}\n\n## Verification and reinforcement\nThis formatting pass does not add external facts. Before publishing, the content owner should add verifiable sources, examples, or FAQs and review every claim.\n\n## Suggested next step\nAdd evidence, frequently asked questions, and relevant internal links, then compare the same evaluation settings before and after the revision.`
  return {
    provider: 'reference-rules-v1', providerVersion: '1.0.0', optimizedTitle, optimizedContent, appliedRuleIds: rules.map(rule => rule.id),
    safetyNotes: ['完整 AutoGEO API 本次未執行；此為 reference-rules-v1 fallback，不可稱為 AutoGEO 生成結果。', '保留原文作為詳細說明，避免透過摘要刪除重要限制。', '不新增排名、流量、轉換或第三方引擎效果保證。', '外部來源、數據與產品主張必須由 owner 人工驗證。'],
    provenance: { requestedProvider, execution: 'reference-fallback', upstreamRepository: AUTOGEO_UPSTREAM.repository, upstreamRevision: AUTOGEO_UPSTREAM.revision, rewriteMethod: AUTOGEO_UPSTREAM.rewriteMethod, ruleset: AUTOGEO_UPSTREAM.ruleset, model, fallbackReason },
  }
}

export const referenceRulesAdapter: GeoRewriteAdapter = { id: 'reference-rules-v1', version: '1.0.0', async rewrite(document, rules) { return referenceCandidate(document, rules, 'autogeo-not-configured') } }

function safeFallback(document: GeoDocumentInput): GeoRewriteCandidate {
  const candidate = referenceCandidate(document, geoRules, 'provider-output-safety-rejected')
  candidate.safetyNotes.unshift('百鍊／AutoGEO provider 草稿加入原文未支持的商業主張，已由 server-side source-bound guard 拒絕。', '以下為 reference-rules-v1 fallback，供 owner 審閱；它不是 provider 成功產出，也不會自動發布。')
  return candidate
}

async function rewriteWithPreferredProvider(document: GeoDocumentInput): Promise<GeoRewriteCandidate> {
  let bailianFallbackReason: GeoFallbackReason
  try { return await createAutoGeoBailianQwenAdapter().rewrite(document, geoRules) }
  catch (error) {
    if (isUnsafeProviderRewrite(error)) return safeFallback(document)
    if (!(error instanceof AutoGeoBailianConfigurationError) && !(error instanceof AutoGeoBailianProviderError)) throw error
    bailianFallbackReason = error instanceof AutoGeoBailianConfigurationError && error.issue === 'invalid-endpoint' ? 'bailian-invalid-configuration' : error instanceof AutoGeoBailianConfigurationError ? 'bailian-not-configured' : 'bailian-provider-unavailable'
  }
  try { return await createAutoGeoApiAdapter().rewrite(document, geoRules) }
  catch (error) {
    if (isUnsafeProviderRewrite(error)) return safeFallback(document)
    if (!(error instanceof AutoGeoConfigurationError) && !(error instanceof AutoGeoProviderError)) throw error
    if (bailianFallbackReason !== 'bailian-not-configured') return referenceCandidate(document, geoRules, bailianFallbackReason, 'autogeo-bailian-qwen')
    const fallbackReason: GeoFallbackReason = error instanceof AutoGeoConfigurationError ? 'bailian-not-configured' : 'autogeo-provider-unavailable'
    return referenceCandidate(document, geoRules, fallbackReason, error instanceof AutoGeoConfigurationError ? 'autogeo-bailian-qwen' : 'autogeo-api', error instanceof AutoGeoConfigurationError ? 'qwen-plus' : AUTOGEO_UPSTREAM.model)
  }
}

export async function optimiseGeoDocument(input: GeoDocumentInput, adapter?: GeoRewriteAdapter): Promise<GeoOptimizationResult> {
  const document = cleanInput(input)
  const baseline = evaluateDocument(document)
  let candidate: GeoRewriteCandidate
  try { candidate = adapter ? await adapter.rewrite(document, geoRules) : await rewriteWithPreferredProvider(document) }
  catch (error) { if (isUnsafeProviderRewrite(error)) candidate = safeFallback(document); else throw error }
  const optimized = evaluateDocument({ title: candidate.optimizedTitle, content: candidate.optimizedContent, language: document.language }, { sourceContent: document.content })
  const comparison = baseline.metrics.map(metric => { const after = optimized.metrics.find(candidateMetric => candidateMetric.id === metric.id); return { ...metric, before: metric.score, after: after?.score || 0, delta: (after?.score || 0) - metric.score } })
  const changed = comparison.filter(metric => metric.delta > 0).map(metric => metric.label)
  return { version: GEO_WORKBENCH_VERSION, rulesetVersion: GEO_RULESET_VERSION, original: document, candidate, baseline, optimized, comparison, summary: changed.length ? `在相同 heuristic 下，${changed.join('、')} 的結構訊號提高；請人工驗證所有內容主張。` : '此版本沒有可量化的 heuristic 提升；請檢查內容證據與適用範圍。', interpretationLimit: '這是已記錄規則下的內容結構比較，不代表 Google、ChatGPT、Gemini 或任何第三方生成式搜尋引擎的真實排名、曝光、流量或轉換結果。' }
}
