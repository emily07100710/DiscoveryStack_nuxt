import type { GeoRule } from './contracts'

export const GEO_RULESET_VERSION = 'autogeo-compatible-rules-v1'

export const geoRules: readonly GeoRule[] = [
  { id: 'direct-answer-first', category: 'answerability', title: '先提供可驗證的直接摘要', instruction: '在開頭以一至兩句保留原文語意的摘要回答主題，不加入未被原文支持的承諾。', rationale: '讓讀者與生成式系統可以先定位頁面回答的核心問題。', priority: 'high' },
  { id: 'semantic-sections', category: 'structure', title: '用語意段落拆解內容', instruction: '使用摘要、詳細說明、適用情境與下一步等可掃讀小節，並保留原文完整內容。', rationale: '明確層級有助於讀者快速比對主張、範圍與行動。', priority: 'high' },
  { id: 'entity-context', category: 'context', title: '補足主題與適用範圍', instruction: '明示本文主題與適用範圍；不臆測地點、產業、成果或第三方背書。', rationale: '將內容限定在可被原文支持的語境，而非只堆疊關鍵字。', priority: 'medium' },
  { id: 'evidence-boundary', category: 'evidence', title: '標示證據邊界', instruction: '保留原有來源與證據；如果原文沒有來源，明確提示上線前補入可驗證依據。', rationale: '避免把格式優化誤當成事實驗證或排名保證。', priority: 'high' },
  { id: 'reader-action', category: 'utility', title: '提供與原文一致的下一步', instruction: '提出一個不誇大的下一步，例如補充證據、補充 FAQ、人工審閱或連結相關頁面。', rationale: '讓優化建議可被實際執行與人工審核。', priority: 'medium' },
  { id: 'claim-safety', category: 'utility', title: '禁止不受支持的成效聲明', instruction: '不得新增保證排名、保證流量、虛構數據、虛構引文或未經證實的比較。', rationale: '保護內容可信度，也讓前後比較維持可審核性。', priority: 'high' },
]
