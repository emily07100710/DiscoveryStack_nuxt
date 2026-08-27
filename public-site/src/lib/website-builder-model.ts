export type BuilderStep =
  | 'entry'
  | 'diagnosis_or_brief'
  | 'site_architecture'
  | 'style_and_modules'
  | 'generating'
  | 'interactive_preview'
  | 'plan_and_cadence'
  | 'domain_and_launch'
  | 'review_order'
  | 'handoff'

export type EntryMode = 'existing' | 'new'
export type SiteType = 'one-page' | 'brand-blog' | 'commerce'
export type ThemeKey = 'mineral' | 'forest' | 'sunset'
export type PlanKey = 'launch' | 'growth' | 'autopilot'
export type Viewport = 'desktop' | 'tablet' | 'mobile'
export type PreviewPage = 'home' | 'services' | 'about' | 'content' | 'products'

export const builderSteps: Array<{ id: BuilderStep; label: string; shortLabel: string }> = [
  { id: 'entry', label: '從哪裡開始', shortLabel: '開始' },
  { id: 'diagnosis_or_brief', label: '理解你的品牌', shortLabel: '品牌' },
  { id: 'site_architecture', label: '安排網站結構', shortLabel: '結構' },
  { id: 'style_and_modules', label: '選擇風格與功能', shortLabel: '風格' },
  { id: 'generating', label: '整理概念預覽', shortLabel: '生成' },
  { id: 'interactive_preview', label: '看看互動預覽', shortLabel: '預覽' },
  { id: 'plan_and_cadence', label: '選擇持續方式', shortLabel: '方案' },
  { id: 'domain_and_launch', label: '規劃網域與上線', shortLabel: '上線' },
  { id: 'review_order', label: '確認這個方向', shortLabel: '確認' },
  { id: 'handoff', label: '交接給 DiscoveryStack', shortLabel: '交接' },
]

export const siteTypes: Array<{ id: SiteType; label: string; eyebrow: string; description: string; bestFor: string; pages: string[] }> = [
  {
    id: 'one-page',
    label: '一頁式網站',
    eyebrow: 'ONE PAGE',
    description: '把服務、信任與聯絡入口集中在一個清楚的轉換頁。',
    bestFor: '適合剛開始、需要快速說清楚價值的品牌。',
    pages: ['首頁', '服務', '聯絡'],
  },
  {
    id: 'brand-blog',
    label: '品牌＋部落格',
    eyebrow: 'EDITORIAL',
    description: '用品牌故事與答案型內容，建立長期搜尋與 GEO 素材。',
    bestFor: '適合專業服務、顧問與需要持續教育市場的團隊。',
    pages: ['首頁', '服務', '關於', '內容'],
  },
  {
    id: 'commerce',
    label: '簡易電商',
    eyebrow: 'COMMERCE',
    description: '以品牌體驗呈現商品，未來可接 Shopify 的安全結帳。',
    bestFor: '適合已有商品，想先打造獨特品牌前台的商家。',
    pages: ['首頁', '商品', '關於'],
  },
]

export const moduleOptions: Array<{ id: string; label: string; outcome: string; note: string; requiresHandoff?: boolean }> = [
  { id: 'admin', label: '內容後台', outcome: '你可以管理文章、案例與網站內容。', note: '核心配置' },
  { id: 'ai', label: 'AI 問答助手', outcome: '讓訪客先得到常見問題的即時答案。', note: '概念互動' },
  { id: 'booking', label: 'Google 預約', outcome: '把想諮詢的人帶到清楚的預約入口。', note: '付款後協助授權', requiresHandoff: true },
  { id: 'payment', label: '線上金流', outcome: '為正式方案預留安全付款與結帳流程。', note: '付款後協助授權', requiresHandoff: true },
  { id: 'invoice', label: '電子發票', outcome: '讓正式交易後的開立流程更完整。', note: '付款後協助授權', requiresHandoff: true },
  { id: 'line', label: 'LINE 導入', outcome: '讓台灣客戶能用熟悉的方式聯絡品牌。', note: '付款後協助授權', requiresHandoff: true },
  { id: 'member', label: '會員系統', outcome: '為回訪客戶保留登入與專屬內容空間。', note: '建議人工規劃', requiresHandoff: true },
  { id: 'app', label: 'PWA／App', outcome: '把常用服務延伸成可安裝的行動體驗。', note: '建議人工規劃', requiresHandoff: true },
]

export const themes: Array<{ id: ThemeKey; label: string; descriptor: string; colors: [string, string, string]; texture: string }> = [
  { id: 'mineral', label: '理性清晰', descriptor: '精準、安靜、可信', colors: ['#15213a', '#e7edf3', '#ee7658'], texture: 'blueprint' },
  { id: 'forest', label: '自然信任', descriptor: '溫和、專業、踏實', colors: ['#153d35', '#e9f0e7', '#d2a458'], texture: 'grain' },
  { id: 'sunset', label: '溫暖精品', descriptor: '有品味、親近、細膩', colors: ['#5d3040', '#f5e5da', '#c86b4c'], texture: 'glow' },
]

export const stylePreferences = [
  { id: 'space', label: '留白感', hint: '讓重要訊息有呼吸' },
  { id: 'editorial', label: '編輯風', hint: '像一本被好好編排的刊物' },
  { id: 'premium', label: '精品感', hint: '細節與材質更講究' },
  { id: 'tech', label: '科技感', hint: '清楚、有層次、向前' },
  { id: 'warm', label: '親切感', hint: '讓第一次來的人放鬆' },
]

export const plans: Array<{ id: PlanKey; label: string; price: number; oneTime: number; description: string; outcome: string; accent: string }> = [
  { id: 'launch', label: '網站上線', price: 0, oneTime: 58800, description: '先把一個可信、可維護的網站做好。', outcome: '適合想先完成品牌基礎的團隊。', accent: 'START' },
  { id: 'growth', label: 'GEO 持續成長', price: 12800, oneTime: 88800, description: '每月整理內容與可見性訊號，持續找到改善方向。', outcome: '適合想讓網站越來越容易被理解的品牌。', accent: 'MOST CHOSEN' },
  { id: 'autopilot', label: 'GEO 自動營運', price: 28800, oneTime: 128800, description: '文章排程、監測、AI 助手與人工品質檢查一起運作。', outcome: '適合希望有人持續替網站負責的團隊。', accent: 'FULL SERVICE' },
]

export const cadences = [3, 7, 15, 30] as const

export const generationStages = [
  '理解品牌與訪客目標',
  '建立網站資訊架構',
  '安排 SEO／GEO 內容結構',
  '套用視覺與功能模組',
  '建立互動預覽',
] as const

export const timeline = [
  { label: '付款確認', detail: '正式確認後才會開始', state: 'after' },
  { label: '網域確認', detail: '重新確認價格與可用性', state: 'after' },
  { label: 'DNS 與 SSL', detail: '由 DiscoveryStack 協助處理', state: 'after' },
  { label: '網站部署', detail: '通過上線檢查後執行', state: 'after' },
  { label: '啟動 GEO 服務', detail: '依方案開始內容與監測', state: 'after' },
] as const

export const pagesForSiteType = (siteType: SiteType): PreviewPage[] => {
  if (siteType === 'one-page') return ['home', 'services']
  if (siteType === 'commerce') return ['home', 'products', 'about']
  return ['home', 'services', 'about', 'content']
}

export const pageLabels: Record<PreviewPage, string> = {
  home: '首頁',
  services: '服務',
  about: '關於',
  content: '內容',
  products: '商品',
}

export const formatMoney = (value: number) => new Intl.NumberFormat('zh-TW').format(value)

export const normalizePublicUrl = (value: string): string | null => {
  const trimmed = value.trim()
  if (!/^https?:\/\/[^\s]+$/iu.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

export const normalizeDomain = (value: string) => value.trim().toLowerCase().replace(/^https?:\/\//iu, '').split('/')[0] || ''

export const siteTypeFor = (siteType: SiteType | null) => siteTypes.find((item) => item.id === siteType) ?? siteTypes[0]
export const themeFor = (theme: ThemeKey) => themes.find((item) => item.id === theme) ?? themes[0]
export const planFor = (plan: PlanKey | null) => plans.find((item) => item.id === plan) ?? plans[0]

export const canUseExample = (value: string) => value.trim().length === 0
