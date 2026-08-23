import { createError } from 'h3'
import type { GeoRule } from './contracts'

export const GEO_RULESET_VERSION = 'autogeo-compatible-rules-v1'

export const geoRules: readonly GeoRule[] = [
  { id: 'direct-answer-first', category: 'answerability', title: '先提供可驗證的直接摘要', instruction: '在開頭以一至兩句保留原文語意的摘要回答主題，不加入未被原文支持的承諾。', rationale: '讓讀者與生成式系統可以先定位頁面回答的核心問題。', priority: 'high' },
  { id: 'semantic-sections', category: 'structure', title: '用語意段落拆解內容', instruction: '使用摘要、詳細說明、適用情境與下一步等可掃讀小節，並保留原文完整內容。', rationale: '明確層級有助於讀者快速比對主張、範圍與行動。', priority: 'high' },
  { id: 'entity-context', category: 'context', title: '補足主題與適用範圍', instruction: '明示本文主題與適用範圍；不臆測地點、產業、成果或第三方背書。', rationale: '將內容限定在可被原文支持的語境，而非只堆疊關鍵字。', priority: 'medium' },
  { id: 'evidence-boundary', category: 'evidence', title: '標示證據邊界', instruction: '保留原有來源與證據；如果原文沒有來源，明確提示上線前補入可驗證依據。', rationale: '避免把格式優化誤當成事實驗證或排名保證。', priority: 'high' },
  { id: 'reader-action', category: 'utility', title: '提供與原文一致的下一步', instruction: '提出一個不誇大的下一步，例如補充證據、補充 FAQ、人工審閱或連結相關頁面。', rationale: '讓優化建議可被實際執行與人工審核。', priority: 'medium' },
  { id: 'claim-safety', category: 'utility', title: '禁止不受支持的成效聲明', instruction: '不得新增保證排名、保證流量、虛構數據、虛構引文或未經證實的比較。', rationale: '保護內容可信度，也讓前後比較維持可審核性。', priority: 'high' },
  { id: 'heading-hierarchy', category: 'structure', title: '強化 heading hierarchy', instruction: '以清楚的 H1、H2 與問題導向段落建立可掃讀的內容層級；不重複或堆疊關鍵字。', rationale: '明確層級讓讀者與檢索系統較容易定位主題與答案範圍。', priority: 'high' },
  { id: 'faq-question-answer', category: 'answerability', title: '建立問題與答案段落', instruction: '由真實受眾問題建立 FAQ 或問題導向段落，短答後再提供有界的詳細解釋。', rationale: '把內容機會轉成可審核的回答單元，而不是虛構搜尋需求。', priority: 'medium' },
  { id: 'citation-readiness', category: 'evidence', title: '提高引用準備度', instruction: '補充來源、日期、作者或方法說明，區分事實、推論與建議；所有新增主張都必須有核准 evidence。', rationale: '讓引用脈絡與限制可以被人工核對。', priority: 'high' },
  { id: 'topic-cluster', category: 'planning', title: '建立 topic cluster', instruction: '將核心服務主題拆成有限的 supporting articles 與 FAQ，避免無限制產文或重複內容。', rationale: '把主題覆蓋轉成有界、可排程的內容機會。', priority: 'medium' },
  { id: 'internal-linking', category: 'planning', title: '建立內部連結規格', instruction: '為每項 deliverable 指定相關頁面、目的與描述性 anchor；不可生成不存在的 URL 或頁面。', rationale: '讓內容機會可被串接，同時維持路徑與 evidence 的可追溯性。', priority: 'medium' },
  { id: 'canonical-signal', category: 'structure', title: '確認 canonical 與語言路徑', instruction: '由網站擁有者確認 canonical、語言與多語 URL 對應，不能自行改寫網站設定或宣稱已部署。', rationale: '技術 SEO 建議必須與實際網站治理責任分開。', priority: 'medium' },
  { id: 'structured-data-safety', category: 'structure', title: '只產生內容支持的 structured data', instruction: '只有頁面可驗證地支持時才規劃 schema；不可為了 rich result 而虛構評分、價格、評論或資格。', rationale: '避免把 eligibility 建議誤當成展示保證。', priority: 'medium' },
]

const geoRuleById = new Map(geoRules.map(rule => [rule.id, rule]))

export function resolveCanonicalGeoRules(ruleIds: readonly string[]): GeoRule[] {
  const uniqueIds = [...new Set(ruleIds)]
  const rules = uniqueIds.map(id => geoRuleById.get(id))
  if (rules.some(rule => !rule)) throw createError({ statusCode: 422, statusMessage: 'Strategy contains an unknown canonical rule ID.' })
  return rules as GeoRule[]
}
