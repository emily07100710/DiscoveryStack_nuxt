/** Platform examples for project scoping, not evidence of a live connection or a commercial partnership. */
export type IntegrationLocale = 'zh-hant' | 'en'

export const platformBrands = {
  cloudflare: { name: 'Cloudflare', asset: '/platforms/cloudflare.svg', website: 'https://www.cloudflare.com/', source: 'https://www.cloudflare.com/logo/', api: 'https://developers.cloudflare.com/api/', shape: 'icon' },
  line: { name: 'LINE', asset: '/platforms/line.png', website: 'https://www.line.me/', source: 'https://www.line.me/en/logo', api: 'https://developers.line.biz/en/docs/messaging-api/overview/', shape: 'icon', staticOnly: true },
  whatsapp: { name: 'WhatsApp', asset: '/platforms/whatsapp.svg', website: 'https://www.whatsapp.com/', source: 'https://about.meta.com/brand/resources/whatsapp/whatsapp-brand/', api: 'https://developers.facebook.com/docs/whatsapp/cloud-api/overview/', shape: 'icon' },
  dhl: { name: 'DHL', asset: '/platforms/dhl.svg', website: 'https://www.dhl.com/', source: 'https://www.dpdhl-brands.com/dhl/en/guides/design-basics/logo-and-claim.html', api: 'https://developer.dhl.com/api-reference/dhl-express-mydhl-api', shape: 'wide' },
  sf: { name: 'SF Express', asset: '/platforms/sf-express.png', website: 'https://hk.sf-express.com/hk/tc', source: 'https://hk.sf-express.com/_next/static/media/ic-black-logo.c86816fe.png', api: 'https://open.sf-express.com/', shape: 'icon' },
  stripe: { name: 'Stripe', asset: '/platforms/stripe.svg', website: 'https://stripe.com/', source: 'https://stripe.com/newsroom/information', api: 'https://docs.stripe.com/api', shape: 'icon' },
  paypal: { name: 'PayPal', asset: '/platforms/paypal.svg', website: 'https://www.paypal.com/', source: 'https://newsroom.paypal-corp.com/media-resources', api: 'https://developer.paypal.com/api/rest/', shape: 'icon' },
  hubspot: { name: 'HubSpot', asset: '/platforms/hubspot.svg', website: 'https://www.hubspot.com/', source: 'https://www.hubspot.com/style-guide', api: 'https://developers.hubspot.com/docs/api-reference/latest/overview', shape: 'icon' },
  calendar: { name: 'Google Calendar', asset: '/platforms/google-calendar.svg', website: 'https://calendar.google.com/', source: 'https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v8/192px.svg', api: 'https://developers.google.com/workspace/calendar/api/guides/overview', shape: 'icon' },
} as const

export type PlatformBrandKey = keyof typeof platformBrands
export const platformBelt: PlatformBrandKey[] = ['cloudflare', 'whatsapp', 'dhl', 'sf', 'stripe', 'paypal', 'hubspot', 'calendar']

export const integrationCategories: Array<{
  id: string
  title: Record<IntegrationLocale, string>
  subtitle: string
  description: Record<IntegrationLocale, string>
  brands: PlatformBrandKey[]
  x: number
  y: number
  path: string
}> = [
  { id: 'domain', title: { 'zh-hant': '網域與 DNS', en: 'Domain & DNS' }, subtitle: 'YOUR ADDRESS', description: { 'zh-hant': '讓品牌自己的網址，成為網站與客戶的起點。', en: 'Make your own domain the starting point for your brand and customers.' }, brands: ['cloudflare'], x: 20, y: 20, path: 'M400 280 C320 280 320 130 245 130' },
  { id: 'messaging', title: { 'zh-hant': '訊息與聯絡', en: 'Messaging' }, subtitle: 'KEEP IN TOUCH', description: { 'zh-hant': '從 LINE 到 WhatsApp，把詢問帶進客戶熟悉的對話。', en: 'Bring enquiries into the conversations your customers know, from LINE to WhatsApp.' }, brands: ['line', 'whatsapp'], x: 80, y: 20, path: 'M600 280 C680 280 680 130 755 130' },
  { id: 'logistics', title: { 'zh-hant': '物流與配送', en: 'Shipping' }, subtitle: 'DELIVER THE EXPERIENCE', description: { 'zh-hant': '規劃 DHL、順豐的配送與追蹤流程，讓購物體驗走到最後一哩。', en: 'Plan DHL and SF Express shipping and tracking, through the last mile of the experience.' }, brands: ['dhl', 'sf'], x: 84, y: 50, path: 'M615 325 H780' },
  { id: 'payment', title: { 'zh-hant': '付款與交易', en: 'Payments' }, subtitle: 'A SMOOTHER CHECKOUT', description: { 'zh-hant': '依服務地區與收款需求，規劃合適的付款與交易流程。', en: 'Plan payment and transaction flows around your market and payment requirements.' }, brands: ['stripe', 'paypal'], x: 80, y: 80, path: 'M600 370 C680 370 680 520 755 520' },
  { id: 'crm', title: { 'zh-hant': '客戶與 CRM', en: 'Customer & CRM' }, subtitle: 'BUILD THE RELATIONSHIP', description: { 'zh-hant': '把網站詢問與客戶紀錄接起來，讓後續跟進更有條理。', en: 'Connect website enquiries with customer records, so the next conversation has context.' }, brands: ['hubspot'], x: 20, y: 80, path: 'M400 370 C320 370 320 520 245 520' },
  { id: 'booking', title: { 'zh-hant': '預約與行程', en: 'Booking & Calendar' }, subtitle: 'MAKE TIME FOR CLIENTS', description: { 'zh-hant': '安排預約與行程，讓想了解你的客戶，輕鬆找到下一步。', en: 'Plan bookings and calendars, making the next step easy for interested customers.' }, brands: ['calendar'], x: 16, y: 50, path: 'M385 325 H220' },
]

export const simpleIconsSource = {
  repository: 'https://github.com/simple-icons/simple-icons',
  revision: '98820a4dc8c363ca72fa2c0d294ea4a0a9bba75d',
  license: 'https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md',
  disclaimer: 'https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md',
}
