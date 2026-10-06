import { fail, integer, text } from './errors.mjs'

export const PRESETS = ['atelier', 'bloom', 'alignment']
export const AFTERCARE_POLICY = Object.freeze({ days: 30, startsAt: 'verified_delivery', included: ['layout', 'color', 'typography', 'image_placement'], excluded: ['new_features', 'data_migration', 'new_integrations', 'third_party_fees'], label: '正式交付後 30 天內，原功能範圍的排版、美術調整免費。新增功能、資料搬遷及第三方費用另行確認。' })
const optional = (value, label, max = 2000) => value === undefined || value === '' ? '' : text(value, label, max)
export function mediaUrl(value) {
  if (!value) return ''
  const url = text(value, '圖片網址', 2048)
  if (/^\/media\/[a-f0-9]{64}\.(png|jpg|webp)$/u.test(url)) return url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) return parsed.toString()
  } catch { /* refuse executable or ambiguous media */ }
  fail(422, '圖片必須使用不含登入資訊的 HTTPS 網址或本網站媒體庫')
}

/** Configuration is data only. It cannot contain code, credentials or provider success flags. */
export function parseConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, '網站設定格式不正確')
  const allowed = ['schemaVersion', 'siteId', 'siteType', 'preset', 'brandName', 'tagline', 'description', 'hero', 'about', 'contact', 'currency', 'policies', 'booking', 'commerce', 'mode', 'aftercare']
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(422, '網站設定包含不支援的欄位')
  const siteId = text(value.siteId, '網站識別', 80)
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/u.test(siteId)) fail(422, '網站識別格式不正確')
  if (!['commerce', 'booking_blog'].includes(value.siteType)) fail(422, '網站類型不支援')
  if (!['preview', 'production'].includes(value.mode)) fail(422, '網站模式不支援')
  const preset = value.preset || (value.siteType === 'commerce' ? 'atelier' : 'alignment')
  if (!PRESETS.includes(preset)) fail(422, '品牌版型不支援')
  if (value.currency && value.currency !== 'TWD') fail(422, '目前支援新台幣整數分單位')
  const hero = value.hero || {}
  const contact = value.contact || {}
  const policies = value.policies || {}
  const commerce = value.commerce || {}
  const booking = value.booking || {}
  const paymentMode = commerce.paymentMode || 'disabled'
  if (!['disabled', 'manual', 'sandbox'].includes(paymentMode) || value.mode === 'production' && paymentMode === 'sandbox') fail(422, '正式網站不可使用模擬付款')
  const email = optional(contact.email, '聯絡 Email', 320).toLowerCase()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(422, '聯絡 Email 格式不正確')
  const timeZone = booking.timeZone || 'Asia/Taipei'
  try { new Intl.DateTimeFormat('zh-TW', { timeZone }) } catch { fail(422, '預約時區不正確') }
  const brandName = text(value.brandName, '品牌名稱', 160)
  return {
    schemaVersion: 'customer-site-config-v1', siteId, siteType: value.siteType, preset, mode: value.mode,
    brandName, tagline: optional(value.tagline, '品牌短句', 240), description: optional(value.description, '品牌說明', 2000),
    hero: { title: optional(hero.title, '首頁標題', 240) || brandName, description: optional(hero.description, '首頁說明', 800), eyebrow: optional(hero.eyebrow, '首頁引言', 120), image: mediaUrl(hero.image) },
    about: optional(value.about, '關於品牌', 8000),
    contact: { email, phone: optional(contact.phone, '電話', 80), address: optional(contact.address, '地址', 400) },
    currency: 'TWD',
    policies: { shipping: optional(policies.shipping, '配送政策', 4000), returns: optional(policies.returns, '退換政策', 4000), privacy: optional(policies.privacy, '隱私說明', 8000) },
    commerce: { paymentMode, currency: 'TWD', shippingFeeMinor: integer(commerce.shippingFeeMinor ?? 0, '運費', 0, 10000000), freeShippingThresholdMinor: integer(commerce.freeShippingThresholdMinor ?? 0, '免運門檻', 0, 100000000), orderHoldMinutes: integer(commerce.orderHoldMinutes ?? 30, '付款保留分鐘', 5, 1440), manualPaymentInstructions: optional(commerce.manualPaymentInstructions, '人工付款說明', 2000) },
    booking: { timeZone, cancellationHours: integer(booking.cancellationHours ?? 24, '取消提前小時', 0, 720), holdMinutes: integer(booking.holdMinutes ?? 30, '預約保留分鐘', 5, 1440) },
    aftercare: { ...AFTERCARE_POLICY },
  }
}

export function changeVisualSettings(config, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['preset', 'tagline', 'description', 'hero', 'about', 'contact', 'policies'].includes(key))) fail(422, '只能修改品牌、排版與內容設定，不能改動網站身份或付款模式')
  return parseConfig({ ...config, ...patch, hero: { ...config.hero, ...(patch.hero || {}) }, contact: { ...config.contact, ...(patch.contact || {}) }, policies: { ...config.policies, ...(patch.policies || {}) } })
}
