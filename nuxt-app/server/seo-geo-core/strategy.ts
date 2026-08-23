import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { AUTOGEO_STRATEGY_VERSION, type AutoGeoStrategyRecommendation, type AutoGeoStrategyRule, type DiagnosisFinding, type StrategyContentOpportunity, type StrategyDeliverableType } from './contracts'
import { GEO_RULESET_VERSION, geoRules } from '../geo/rules'

const strategyRuleCatalog = new Map(geoRules.map(rule => [rule.id, rule]))

const strategyMapping: Record<string, { ruleIds: string[], recommendedActions: string[], deliverableTypes: StrategyDeliverableType[], opportunities: Array<Omit<StrategyContentOpportunity, 'goals' | 'constraints'> & { goals: string[], constraints: string[] }> }> = {
  remove_noindex: {
    ruleIds: ['canonical-signal', 'claim-safety'],
    recommendedActions: ['確認公開頁面的 robots／noindex／canonical 設定', '由網站擁有者決定是否將頁面納入公開內容路徑'],
    deliverableTypes: ['service_page'],
    opportunities: [{ key: 'indexable-service-page', deliverableType: 'service_page', title: '公開服務頁索引與範圍修訂', audience: '正在評估此服務的決策者', goals: ['清楚定義頁面主題與適用範圍'], constraints: ['不得宣稱已部署或保證收錄', '由網站擁有者確認索引設定'] }],
  },
  clarify_page_topic: {
    ruleIds: ['entity-context', 'heading-hierarchy', 'direct-answer-first'],
    recommendedActions: ['定義核心實體、受眾與服務範圍', '在前段提供直接答案並建立清楚 heading hierarchy'],
    deliverableTypes: ['service_page', 'article'],
    opportunities: [{ key: 'entity-clarity-service-page', deliverableType: 'service_page', title: '核心服務與實體定義頁', audience: '需要理解服務範圍的研究者', goals: ['回答頁面服務誰、解決什麼問題'], constraints: ['只使用 approved evidence', '不得新增案例或成效宣稱'] }, { key: 'topic-explainer-article', deliverableType: 'article', title: '主題解釋文章', audience: '正在釐清問題的讀者', goals: ['以問題導向段落解釋核心主題'], constraints: ['不得虛構搜尋需求或排名'] }],
  },
  add_primary_action: {
    ruleIds: ['reader-action', 'entity-context'],
    recommendedActions: ['補上與頁面承諾一致的自主下一步', '將 CTA 限定為可由 owner 驗證的行動'],
    deliverableTypes: ['service_page', 'faq'],
    opportunities: [{ key: 'service-next-step', deliverableType: 'service_page', title: '服務頁下一步與適用條件', audience: '已理解問題並需要下一步的訪客', goals: ['說明選擇服務前需要知道的條件'], constraints: ['不得暗示轉換保證', '不得捏造客戶結果'] }],
  },
  improve_service_routing: {
    ruleIds: ['internal-linking', 'semantic-sections', 'reader-action'],
    recommendedActions: ['建立服務、資源與 FAQ 的有限內部路徑', '為每條連結寫明目的與 destination，並由 owner 驗證 URL'],
    deliverableTypes: ['service_page', 'article'],
    opportunities: [{ key: 'service-routing-page', deliverableType: 'service_page', title: '服務路徑與相關資源頁', audience: '需要比較服務選項的訪客', goals: ['把服務定義、適用情境與相關資源連起來'], constraints: ['不得生成不存在的 URL', '不得宣稱已完成內部連結部署'] }],
  },
  add_canonical: {
    ruleIds: ['canonical-signal', 'citation-readiness'],
    recommendedActions: ['確認正式 URL、canonical 與多語路徑的對應', '將 technical recommendation 與內容主張分開記錄'],
    deliverableTypes: ['service_page', 'article'],
    opportunities: [{ key: 'canonical-aware-page', deliverableType: 'service_page', title: 'Canonical-aware 服務頁修訂', audience: '需要確認服務正式資訊的讀者', goals: ['在內容中明確標示頁面範圍與版本'], constraints: ['不得自行改寫網站設定', '不得保證 rich result 或收錄'] }],
  },
  add_structured_data: {
    ruleIds: ['structured-data-safety', 'citation-readiness'],
    recommendedActions: ['先確認可被可見內容支持的 schema 類型', '只規劃已存在的屬性，不建立虛構價格、評分或評論'],
    deliverableTypes: ['service_page', 'faq'],
    opportunities: [{ key: 'schema-ready-faq', deliverableType: 'faq', title: '可核對的 FAQ 內容單元', audience: '需要快速確認服務問題的讀者', goals: ['以真實問題與有界回答整理 FAQ'], constraints: ['只有內容支持時才規劃 schema', '不得保證 rich result 展示'] }],
  },
  add_trust_evidence: {
    ruleIds: ['citation-readiness', 'evidence-boundary', 'claim-safety'],
    recommendedActions: ['補充來源、日期、作者或方法說明', '區分事實、推論與建議並標示證據邊界'],
    deliverableTypes: ['article', 'service_page', 'faq'],
    opportunities: [{ key: 'evidence-led-explainer', deliverableType: 'article', title: 'Evidence-led 方法與限制說明', audience: '需要核對方法與依據的評估者', goals: ['呈現可核對的來源脈絡與限制'], constraints: ['只可使用 approved evidence', '不得加入客戶案例或 ROI'] }],
  },
  add_answer_content: {
    ruleIds: ['direct-answer-first', 'faq-question-answer', 'semantic-sections'],
    recommendedActions: ['建立問題導向的 FAQ 或段落', '每個回答先給簡潔結論，再提供有界詳細說明'],
    deliverableTypes: ['faq', 'article'],
    opportunities: [{ key: 'answer-first-faq', deliverableType: 'faq', title: '直接回答 FAQ', audience: '帶著明確問題查找答案的讀者', goals: ['以 approved evidence 支持每個問題的短答與解釋'], constraints: ['不得虛構使用者問題', '不得新增未支持的事實'] }, { key: 'answer-first-article', deliverableType: 'article', title: '問題導向說明文章', audience: '需要完整背景的研究者', goals: ['從直接答案延伸到方法與限制'], constraints: ['不得用 heuristic 分數宣稱真實成效'] }],
  },
  add_human_contact: {
    ruleIds: ['reader-action', 'entity-context'],
    recommendedActions: ['說明何時需要真人判斷', '提供責任範圍與由 owner 驗證的聯絡路徑'],
    deliverableTypes: ['service_page', 'faq'],
    opportunities: [{ key: 'human-review-faq', deliverableType: 'faq', title: '真人協助與適用條件 FAQ', audience: '需要知道何時尋求專業協助的訪客', goals: ['清楚說明自助資訊與真人協助的邊界'], constraints: ['不得承諾個案結果', '不得虛構客服或聯絡 SLA'] }],
  },
  review_deeper_pages: {
    ruleIds: ['topic-cluster', 'internal-linking', 'evidence-boundary'],
    recommendedActions: ['建立有限的 supporting article／FAQ 清單', '先取得授權頁面清單再逐頁驗證，不以首頁推測深層頁面'],
    deliverableTypes: ['article', 'faq', 'service_page'],
    opportunities: [{ key: 'bounded-topic-cluster', deliverableType: 'article', title: '有界 topic cluster 規劃', audience: '需要延伸理解核心主題的讀者', goals: ['列出有限且不重複的 supporting topics'], constraints: ['每批最多 10 個 deliverables', '不得從首頁推測深層頁面內容'] }],
  },
}

const expectedIssueCodes: Record<string, string> = {
  remove_noindex: 'technical.noindex',
  clarify_page_topic: 'content.topic_clarity',
  add_primary_action: 'journey.primary_action',
  improve_service_routing: 'journey.service_routing',
  add_canonical: 'technical.canonical',
  add_structured_data: 'technical.structured_data',
  add_trust_evidence: 'evidence.trust_readiness',
  add_answer_content: 'content.answer_readiness',
  add_human_contact: 'journey.human_contact',
  review_deeper_pages: 'scope.deeper_pages',
}

function hashEvidence(refs: DiagnosisFinding['evidence']): string {
  return createHash('sha256').update(JSON.stringify(refs.map(({ sourceId, artifactId, locator, artifactHash }) => ({ sourceId: sourceId ?? null, artifactId: artifactId ?? null, locator: locator || null, artifactHash: artifactHash || null })))).digest('hex')
}

function rulesFor(ruleIds: string[]): AutoGeoStrategyRule[] {
  return ruleIds.map(id => {
    const rule = strategyRuleCatalog.get(id)
    if (!rule) throw createError({ statusCode: 500, statusMessage: `Unknown AutoGEO strategy rule: ${id}` })
    return { id: rule.id, title: rule.title, instruction: rule.instruction, rationale: rule.rationale, priority: rule.priority }
  })
}

export function buildAutoGeoStrategyRecommendation(diagnosisId: number, finding: DiagnosisFinding): AutoGeoStrategyRecommendation {
  const mapping = strategyMapping[finding.recommendationKey]
  if (!mapping || expectedIssueCodes[finding.recommendationKey] !== finding.issueCode || finding.issueCode !== finding.issueCode.trim()) throw createError({ statusCode: 422, statusMessage: `Unknown deterministic diagnosis recommendation key: ${finding.recommendationKey}` })
  const rules = rulesFor(mapping.ruleIds)
  const contentEvidence = finding.evidence.filter(ref => Boolean(ref.artifactId))
  const evidenceSnapshotHash = hashEvidence(contentEvidence)
  return {
    diagnosisId,
    issueCode: finding.issueCode,
    recommendationKey: finding.recommendationKey,
    ruleSetVersion: GEO_RULESET_VERSION,
    ruleIds: rules.map(rule => rule.id),
    rules,
    priority: finding.priority,
    rationale: `${finding.explanation} Strategy 只把此 finding 轉成可檢查的改善選項，不代表排名、流量、轉換或收入預測。`,
    recommendedActions: mapping.recommendedActions,
    deliverableTypes: mapping.deliverableTypes,
    contentOpportunities: mapping.opportunities,
    evidenceRefs: contentEvidence,
    evidenceSnapshotHash,
    status: 'proposed',
    limitations: ['此策略是 deterministic mapping，不是模型自動選擇或成效預測，也不代表排名、曝光、流量、轉換、營收或 ROI。', 'Provider 可協助文字說明，但不能更改 rule IDs、創造 evidence、案例或商業成效主張。', '選擇策略後仍需 owner 建立 Production Plan、Risk gate 與人工 review。'],
    version: 1,
    provenance: { engine: AUTOGEO_STRATEGY_VERSION, diagnosisEngine: finding.engine, sourceRecommendationKey: finding.recommendationKey, ruleCatalogVersion: GEO_RULESET_VERSION, ruleSource: 'discoverystack-autogeo-compatible', ruleSourceKind: 'deterministic-compatible-catalog-not-official-extracted-rules' },
  }
}

export function buildAutoGeoStrategyRecommendations(diagnosisId: number, findings: DiagnosisFinding[]): AutoGeoStrategyRecommendation[] {
  return findings.map(finding => buildAutoGeoStrategyRecommendation(diagnosisId, finding))
}

export function getStrategyRuleCatalog(): AutoGeoStrategyRule[] {
  return geoRules.map(rule => ({ id: rule.id, title: rule.title, instruction: rule.instruction, rationale: rule.rationale, priority: rule.priority }))
}
