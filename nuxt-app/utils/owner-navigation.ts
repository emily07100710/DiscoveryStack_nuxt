export interface OwnerNavigationItem {
  id: string
  label: string
  description: string
  to: string
}

export interface OwnerNavigationGroup {
  id: string
  label: string
  advanced: boolean
  items: OwnerNavigationItem[]
}

export const OWNER_NAVIGATION_GROUPS: OwnerNavigationGroup[] = [
  {
    id: 'customers-content',
    label: '客戶與內容',
    advanced: false,
    items: [
      { id: 'leads', label: '客戶名單', description: '查看網站送出的客戶需求', to: '/leads' },
      { id: 'content-operations', label: '內容工作台', description: '整理內容題目與工作安排', to: '/audit-lab/content-operations' },
      { id: 'content-strategy', label: '內容策略', description: '規劃主題與內容方向', to: '/audit-lab/content-operations/strategy' },
      { id: 'weekly-content', label: '文章送審與 LINE', description: '處理每週文章審核與 LINE 核准流程', to: '/audit-lab/weekly-content' },
    ],
  },
  {
    id: 'performance-improvement',
    label: '成效與改善',
    advanced: false,
    items: [
      { id: 'measurement-operations', label: '成效觀察', description: '查看網站與搜尋表現', to: '/audit-lab/measurement-operations' },
      { id: 'interventions', label: '改善追蹤', description: '追蹤已採取的調整與結果', to: '/audit-lab/interventions' },
      { id: 'llm-visibility', label: 'AI 搜尋能見度', description: '查看品牌在 AI 搜尋中的出現情況', to: '/audit-lab/llm-visibility' },
    ],
  },
  {
    id: 'knowledge-data',
    label: '知識與資料',
    advanced: false,
    items: [
      { id: 'knowledge', label: '知識資料庫', description: '管理可供工作流程參考的知識', to: '/audit-lab/knowledge' },
      { id: 'site-evidence', label: '網站資料', description: '查看網站內容與來源紀錄', to: '/audit-lab/site-evidence' },
    ],
  },
  {
    id: 'systems-settings',
    label: '系統與設定',
    advanced: false,
    items: [
      { id: 'email-delivery', label: '郵件紀錄', description: '查看系統寄出的郵件紀錄', to: '/audit-lab/email-delivery' },
    ],
  },
  {
    id: 'advanced-tools',
    label: '進階工具',
    advanced: true,
    items: [
      { id: 'geo', label: 'GEO 工作台', description: '進階搜尋與 GEO 作業工具', to: '/audit-lab/geo' },
      { id: 'seo-geo', label: 'SEO / GEO 核心', description: '搜尋優化核心設定與流程', to: '/audit-lab/seo-geo' },
      { id: 'geo-outcome-model', label: 'AI 引用模型', description: '管理 AI 搜尋引用觀察與模型資料', to: '/audit-lab/geo-outcome-model' },
      { id: 'learning-loop', label: '資料授權與模型學習', description: '檢視授權資料如何用於模型訓練與改善', to: '/audit-lab/learning-loop' },
      { id: 'managed-sites', label: '網站管理', description: '管理已連結的網站與服務', to: '/audit-lab/managed-sites' },
      { id: 'system-factory', label: '系統工廠', description: '進階系統建置工具', to: '/audit-lab/system-factory' },
      { id: 'training-pipeline', label: '資料處理管線', description: '檢視與執行資料處理步驟', to: '/training-pipeline' },
      { id: 'ml-lab-preview', label: '模型開發工作台', description: '使用預覽工作台檢視模型開發流程', to: '/ml-lab-preview' },
    ],
  },
]

export interface ResolvedOwnerNavigation {
  activeItem: OwnerNavigationItem | null
  activeGroup: OwnerNavigationGroup | null
}

const OWNER_OVERVIEW_ITEM: OwnerNavigationItem = {
  id: 'overview',
  label: '工作總覽',
  description: '查看整體工作狀態',
  to: '/audit-lab',
}

function normalizedPath(path: string): string {
  const withoutQueryOrHash = path.split(/[?#]/, 1)[0] || '/'
  if (withoutQueryOrHash === '/') return '/'
  return withoutQueryOrHash.replace(/\/+$/, '') || '/'
}

export function resolveOwnerNavigation(path: string): ResolvedOwnerNavigation {
  const currentPath = normalizedPath(path)
  if (currentPath === OWNER_OVERVIEW_ITEM.to) return { activeItem: OWNER_OVERVIEW_ITEM, activeGroup: null }
  let match: { item: OwnerNavigationItem; group: OwnerNavigationGroup } | null = null

  for (const group of OWNER_NAVIGATION_GROUPS) {
    for (const item of group.items) {
      const destination = normalizedPath(item.to)
      if (currentPath !== destination && !currentPath.startsWith(`${destination}/`)) continue
      if (!match || destination.length > match.item.to.length) match = { item, group }
    }
  }

  return match ? { activeItem: match.item, activeGroup: match.group } : { activeItem: null, activeGroup: null }
}
