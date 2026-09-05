export type FunnelStepKey =
  | 'existing_site' | 'company' | 'style' | 'site_type' | 'modules'
  | 'preview' | 'domain_consent' | 'plan' | 'checkout'

export type FunnelAnswersView = {
  existingSite?: {
    hasSite: boolean
    url?: string
    diagnosisId?: number | null
    snapshot?: {
      analysedAt: string
      analysisVersion: string
      snapshotFingerprint: string
      scores: { overall: number; seo: number; geo: number; brandContent: number; ux: number }
    }
  }
  company?: { brandName: string; whatWeDo: string; feelings: string[]; mainOffer: string; conversionGoals: string[] }
  contact?: { email: string; contactName: string; phone?: string }
  style?: { referenceUrls: string[]; stylePreset?: 'minimal' | 'business' | 'premium' | 'warm' | 'lively' | 'tech'; designTier: 'template' | 'designer' }
  siteType?: 'one_page' | 'brand_blog' | 'simple_commerce'
  modules?: string[]
  previewDraft?: { generatedAt: string; source: 'llm' | 'template'; headline: string; sections: { heading: string; body: string }[] }
  domain?: { option: 'existing' | 'new' | 'assisted'; tld?: string; name?: string }
  plan?: { planKey: 'site_only' | 'site_geo' | 'site_geo_autopost'; cadenceDays?: 3 | 7 | 15 | 30 }
}

export const FUNNEL_STEPS: { step: number; key: FunnelStepKey; title: string; help: string }[] = [
  { step: 1, key: 'existing_site', title: '目前狀況', help: '告訴我們你是否已有網站，我們會從最適合的起點開始。' },
  { step: 2, key: 'company', title: '你的公司', help: '用平常向客人介紹生意的方式，說說品牌、服務和聯絡方式。' },
  { step: 3, key: 'style', title: '喜歡的風格', help: '挑一種喜歡的感覺，或提供你欣賞的網站作為參考。' },
  { step: 4, key: 'site_type', title: '網站型態', help: '依照內容多寡和銷售方式，選擇最合適的網站規模。' },
  { step: 5, key: 'modules', title: '加購功能', help: '選擇現在需要的額外功能，沒有需要也可以直接繼續。' },
  { step: 6, key: 'preview', title: '生成預覽', help: '先看一份示意草稿，確認網站大致會如何呈現。' },
  { step: 7, key: 'domain_consent', title: '網域與授權', help: '選擇網址處理方式，並讀完授權內容後表示同意。' },
  { step: 8, key: 'plan', title: '選擇方案', help: '依照你需要的維護和內容服務，選擇每月方案。' },
  { step: 9, key: 'checkout', title: '確認結帳', help: '再次確認所有費用與後續安排，再開始建置和付款。' },
]

export const STYLE_PRESETS: { key: 'minimal' | 'business' | 'premium' | 'warm' | 'lively' | 'tech'; label: string; help: string }[] = [
  { key: 'minimal', label: '簡約留白', help: '資訊清楚、畫面安靜，讓重點更容易被看見。' },
  { key: 'business', label: '穩重專業', help: '適合重視信任、流程和專業形象的服務。' },
  { key: 'premium', label: '精緻質感', help: '以細節和視覺層次呈現較高端的品牌感受。' },
  { key: 'warm', label: '溫暖親切', help: '用柔和的色彩和語氣拉近與客人的距離。' },
  { key: 'lively', label: '活潑鮮明', help: '用明快節奏與色彩傳達熱情和行動力。' },
  { key: 'tech', label: '俐落科技', help: '適合創新服務、數位工具與講求效率的品牌。' },
]

export const FEELING_OPTIONS: { key: string; label: string }[] = [
  { key: 'professional', label: '專業可靠' },
  { key: 'warm', label: '溫暖親切' },
  { key: 'premium', label: '精緻有質感' },
  { key: 'energetic', label: '有活力' },
  { key: 'innovative', label: '創新俐落' },
  { key: 'natural', label: '自然安心' },
]

export const CONVERSION_GOAL_OPTIONS: { key: string; label: string }[] = [
  { key: 'increase_inquiries', label: '收到更多詢問' },
  { key: 'increase_bookings', label: '讓客人直接預約' },
  { key: 'sell_online', label: '在線上販售商品' },
  { key: 'reduce_support', label: '減少重複客服問題' },
  { key: 'build_brand', label: '建立品牌信任' },
  { key: 'improve_search_ai_understanding', label: '讓搜尋服務更懂我的品牌' },
  { key: 'membership_repurchase', label: '鼓勵會員再次購買' },
]

export const SITE_TYPE_HELP: Record<'one_page' | 'brand_blog' | 'simple_commerce', { label: string; whenToPick: string; difference: string }> = {
  one_page: { label: '一頁式網站', whenToPick: '服務單純、希望客人快速看懂並聯絡時選它。', difference: '所有重點集中在同一頁，內容精簡、行動路徑直接。' },
  brand_blog: { label: '品牌內容網站', whenToPick: '需要多頁介紹服務、案例或持續發布文章時選它。', difference: '能分頁整理內容，適合長期累積品牌信任與搜尋內容。' },
  simple_commerce: { label: '簡易電商網站', whenToPick: '希望展示商品並建立基本線上銷售流程時選它。', difference: '除了品牌內容，也會安排商品展示與購買動線。' },
}

export const MODULE_HELP: Record<string, { label: string; plain: string }> = {
  managed_content_admin: { label: '內容管理後台', plain: '日後可自行修改網站上的文字與內容。' },
  contact_lead_capture: { label: '聯絡表單／名單收集', plain: '讓網站訪客留下姓名、Email 與訊息，送到你驗證過的收信信箱。' },
  bounded_ai_assistant: { label: '網站問答助理', plain: '依照你核准的網站內容回答訪客常見問題。' },
  shopify_commerce: { label: '商品與購物流程', plain: '連結既有商品資料，安排展示與購買流程。' },
  line_assisted_integration: { label: '官方帳號整合', plain: '讓網站訪客可以前往你的官方帳號繼續聯絡。' },
  google_booking_assisted_integration: { label: '預約服務整合', plain: '把可用的預約服務連到網站，方便客人安排時段。' },
  geo_content_subscription: { label: '搜尋內容服務', plain: '持續規劃更容易被搜尋與理解的網站內容。' },
  geo_measurement_dashboard: { label: '搜尋成效儀表板', plain: '集中查看網站在搜尋與內容上的追蹤資訊。' },
  pwa_reference_only: { label: '手機使用體驗規劃', plain: '提供接近手機應用程式的使用方式與規劃參考。' },
  stripe_payment: { label: '海外線上付款', plain: '讓客人可以在網站上使用支援的付款方式結帳。' },
  newebpay_payment: { label: '藍新線上付款', plain: '串接藍新服務，讓客人能在網站上付款。' },
  ecpay_payment: { label: '綠界線上付款', plain: '串接綠界服務，讓客人能在網站上付款。' },
  einvoice: { label: '電子發票', plain: '協助安排電子發票的開立與管理流程。' },
  logistics: { label: '出貨物流整合', plain: '把訂單與出貨流程接在一起，方便後續處理。' },
  erp_crm_backoffice: { label: '客戶與營運後台', plain: '集中整理訂單、客戶資料與日常營運資訊。' },
}

export function requiredModulesForSiteType(siteType: FunnelAnswersView['siteType']): string[] {
  return siteType === 'simple_commerce' ? ['shopify_commerce'] : []
}

export function normalizedModulesForSiteType(siteType: FunnelAnswersView['siteType'], modules: string[] | undefined): string[] {
  return [...new Set([...(modules || []), ...requiredModulesForSiteType(siteType)])]
}

export function missingRequiredModulesForSiteType(siteType: FunnelAnswersView['siteType'], modules: string[] | undefined): string[] {
  const selected = new Set(modules || [])
  return requiredModulesForSiteType(siteType).filter(module => !selected.has(module))
}

export const PLAN_HELP: Record<'site_only' | 'site_geo' | 'site_geo_autopost', { label: string; plain: string }> = {
  site_only: { label: '網站維護', plain: '適合先把網站穩定上線，持續處理基本維護。' },
  site_geo: { label: '網站維護＋搜尋追蹤', plain: '除了維護網站，也持續觀察搜尋服務如何理解品牌。' },
  site_geo_autopost: { label: '網站維護＋搜尋追蹤＋定期發文', plain: '適合希望固定新增內容，並持續追蹤成效的品牌。' },
}

export function formatTwd(minor: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'TWD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(minor)
}

export function isScrolledToBottom(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, tolerancePx = 4): boolean {
  if (metrics.scrollHeight <= metrics.clientHeight) return true
  return metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - tolerancePx
}

export function consentGateState(input: { scrolledToBottom: boolean; checked: boolean }): { canTick: boolean; canSubmit: boolean; reason: string } {
  if (!input.scrolledToBottom) return { canTick: false, canSubmit: false, reason: '請先把授權同意書捲到最後再勾選。' }
  if (!input.checked) return { canTick: true, canSubmit: false, reason: '請勾選同意授權後才能繼續。' }
  return { canTick: true, canSubmit: true, reason: '' }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validEmail(value: unknown): boolean {
  return hasText(value) && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
}

function normalizedHttpsUrl(value: unknown, maxLength: number): string | null {
  if (!hasText(value) || value.length > maxLength) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password ? parsed.toString() : null
  } catch {
    return null
  }
}

export function stepCompletion(step: number, answers: FunnelAnswersView, consent: { accepted: boolean }): { complete: boolean; missing: string[] } {
  const missing: string[] = []
  if (step === 1) {
    if (typeof answers.existingSite?.hasSite !== 'boolean') missing.push('目前是否有網站')
    else if (answers.existingSite.hasSite) {
      if (!normalizedHttpsUrl(answers.existingSite.url, 2048)) missing.push('現有網站網址')
      if (!answers.existingSite.snapshot) missing.push('網站分析結果')
    }
  }
  if (step === 2) {
    if (!hasText(answers.company?.brandName)) missing.push('品牌名稱')
    if (!hasText(answers.company?.whatWeDo)) missing.push('你在做什麼')
    if (!hasText(answers.company?.mainOffer)) missing.push('主要賣什麼')
    if (!answers.company?.conversionGoals?.length) missing.push('希望怎麼成交')
    if (!hasText(answers.contact?.contactName)) missing.push('聯絡人姓名')
    if (!validEmail(answers.contact?.email)) missing.push('聯絡 Email')
    if (hasText(answers.contact?.phone) && (answers.contact.phone.length > 40 || !/^[0-9+() -]+$/u.test(answers.contact.phone))) missing.push('聯絡電話')
  }
  if (step === 3) {
    const references = answers.style?.referenceUrls || []
    const normalizedReferences = references.map(reference => normalizedHttpsUrl(reference, 512))
    if (!answers.style || !['template', 'designer'].includes(answers.style.designTier)) missing.push('設計方式')
    if (!answers.style?.stylePreset && !references.length) missing.push('風格預設或參考網址')
    if (references.length > 3 || normalizedReferences.some(reference => !reference)) missing.push('有效的參考網址')
    if (normalizedReferences.every(Boolean) && new Set(normalizedReferences).size !== normalizedReferences.length) missing.push('不重複的參考網址')
  }
  if (step === 4 && !answers.siteType) missing.push('網站型態')
  if (step === 5) {
    if (!Array.isArray(answers.modules)) missing.push('加購模組選擇')
    for (const module of missingRequiredModulesForSiteType(answers.siteType, answers.modules)) missing.push(MODULE_HELP[module]?.label || module)
  }
  if (step === 7) {
    if (!answers.domain?.option) missing.push('網域處理方式')
    if (answers.domain?.option === 'new') {
      if (!hasText(answers.domain.name) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(answers.domain.name)) missing.push('新網域名稱')
      if (!hasText(answers.domain.tld)) missing.push('網域結尾')
    }
    if (!consent.accepted) missing.push('授權同意')
  }
  if (step === 8) {
    if (!answers.plan?.planKey) missing.push('每月方案')
    if (answers.plan?.planKey === 'site_geo_autopost' && !answers.plan.cadenceDays) missing.push('發文頻率')
  }
  if (step === 9) {
    for (const requiredStep of [1, 2, 3, 4, 5, 7, 8]) missing.push(...stepCompletion(requiredStep, answers, consent).missing)
  }
  return { complete: missing.length === 0, missing: [...new Set(missing)] }
}

export function canAdvance(step: number, answers: FunnelAnswersView, consent: { accepted: boolean }): boolean {
  return stepCompletion(step, answers, consent).complete
}

export function firstIncompleteStep(answers: FunnelAnswersView, consent: { accepted: boolean }): number {
  for (let step = 1; step <= 8; step += 1) if (!canAdvance(step, answers, consent)) return step
  return 9
}
