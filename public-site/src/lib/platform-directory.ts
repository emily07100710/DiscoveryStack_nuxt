import { platformBrands, type IntegrationLocale } from './integration-platforms'

/** API-capable platforms to discuss during scoping. Listing one never asserts a live integration or partnership. */
const additionalPlatforms = {
  shopify: { name: 'Shopify', asset: '/platforms/shopify.svg', website: 'https://www.shopify.com/', api: 'https://shopify.dev/docs/api/admin-graphql/latest', mark: 'S' },
  woocommerce: { name: 'WooCommerce', asset: '/platforms/woocommerce.svg', website: 'https://woocommerce.com/', api: 'https://woocommerce.com/document/woocommerce-rest-api/', mark: 'W' },
  wordpress: { name: 'WordPress', asset: '/platforms/wordpress.svg', website: 'https://wordpress.org/', api: 'https://developer.wordpress.org/rest-api/', mark: 'W' },
  webflow: { name: 'Webflow', asset: '/platforms/webflow.svg', website: 'https://webflow.com/', api: 'https://developers.webflow.com/data/reference/rest-introduction', mark: 'W' },
  wix: { name: 'Wix', asset: '/platforms/wix.svg', website: 'https://www.wix.com/', api: 'https://dev.wix.com/docs/api-reference/', mark: 'W' },
  squarespace: { name: 'Squarespace', asset: '/platforms/squarespace.svg', website: 'https://www.squarespace.com/', api: 'https://commerce-apis.squarespace.com/commerce-apis/overview', mark: 'S' },
  telegram: { name: 'Telegram', asset: '/platforms/telegram.svg', website: 'https://telegram.org/', api: 'https://core.telegram.org/bots/api', mark: 'T' },
  messenger: { name: 'Messenger', asset: '/platforms/messenger.svg', website: 'https://www.messenger.com/', api: 'https://developers.facebook.com/docs/messenger-platform/', mark: 'M' },
  instagram: { name: 'Instagram', asset: '/platforms/instagram.svg', website: 'https://www.instagram.com/', api: 'https://developers.facebook.com/docs/instagram-platform/', mark: 'I' },
  slack: { name: 'Slack', asset: null, website: 'https://slack.com/', api: 'https://api.slack.com/apis', mark: 'S' },
  discord: { name: 'Discord', asset: '/platforms/discord.svg', website: 'https://discord.com/', api: 'https://discord.com/developers/docs/intro', mark: 'D' },
  twilio: { name: 'Twilio', asset: null, website: 'https://www.twilio.com/', api: 'https://www.twilio.com/docs/usage/api', mark: 'T' },
  fedex: { name: 'FedEx', asset: '/platforms/fedex.svg', website: 'https://www.fedex.com/', api: 'https://developer.fedex.com/api/en-us/home.html', mark: 'F' },
  ups: { name: 'UPS', asset: '/platforms/ups.svg', website: 'https://www.ups.com/', api: 'https://developer.ups.com/', mark: 'U' },
  shippo: { name: 'Shippo', asset: null, website: 'https://goshippo.com/', api: 'https://docs.goshippo.com/', mark: 'SH' },
  adyen: { name: 'Adyen', asset: '/platforms/adyen.svg', website: 'https://www.adyen.com/', api: 'https://docs.adyen.com/api-explorer/', mark: 'A' },
  paddle: { name: 'Paddle', asset: '/platforms/paddle.svg', website: 'https://www.paddle.com/', api: 'https://developer.paddle.com/api-reference/', mark: 'P' },
  square: { name: 'Square', asset: '/platforms/square.svg', website: 'https://squareup.com/', api: 'https://developer.squareup.com/reference/square', mark: 'S' },
  salesforce: { name: 'Salesforce', asset: null, website: 'https://www.salesforce.com/', api: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/', mark: 'SF' },
  mailchimp: { name: 'Mailchimp', asset: '/platforms/mailchimp.svg', website: 'https://mailchimp.com/', api: 'https://mailchimp.com/developer/marketing/api/', mark: 'M' },
  klaviyo: { name: 'Klaviyo', asset: null, website: 'https://www.klaviyo.com/', api: 'https://developers.klaviyo.com/en/docs/get_started', mark: 'K' },
  zoho: { name: 'Zoho CRM', asset: '/platforms/zoho.svg', website: 'https://www.zoho.com/crm/', api: 'https://www.zoho.com/crm/developer/docs/api/v8/', mark: 'Z' },
  airtable: { name: 'Airtable', asset: '/platforms/airtable.svg', website: 'https://www.airtable.com/', api: 'https://airtable.com/developers/web/api/introduction', mark: 'A' },
  notion: { name: 'Notion', asset: '/platforms/notion.svg', website: 'https://www.notion.com/', api: 'https://developers.notion.com/reference/intro', mark: 'N' },
  calendly: { name: 'Calendly', asset: '/platforms/calendly.svg', website: 'https://calendly.com/', api: 'https://developer.calendly.com/getting-started/', mark: 'C' },
  zoom: { name: 'Zoom', asset: '/platforms/zoom.svg', website: 'https://www.zoom.com/', api: 'https://developers.zoom.us/docs/api/', mark: 'Z' },
  outlook: { name: 'Microsoft Outlook', asset: null, website: 'https://outlook.com/', api: 'https://learn.microsoft.com/en-us/graph/api/resources/calendar?view=graph-rest-1.0', mark: 'O' },
  analytics: { name: 'Google Analytics', asset: '/platforms/googleanalytics.svg', website: 'https://analytics.google.com/', api: 'https://developers.google.com/analytics/devguides/reporting/data/v1', mark: 'GA' },
  searchconsole: { name: 'Google Search Console', asset: '/platforms/googlesearchconsole.svg', website: 'https://search.google.com/search-console', api: 'https://developers.google.com/webmaster-tools/about', mark: 'GSC' },
  youtube: { name: 'YouTube', asset: '/platforms/youtube.svg', website: 'https://www.youtube.com/', api: 'https://developers.google.com/youtube/v3', mark: 'Y' },
  maps: { name: 'Google Maps', asset: '/platforms/googlemaps.svg', website: 'https://www.google.com/maps', api: 'https://developers.google.com/maps/documentation', mark: 'G' },
} as const

export const platformDirectory = { ...platformBrands, ...additionalPlatforms } as const
export type PlatformDirectoryKey = keyof typeof platformDirectory

export const platformDirectoryGroups: Array<{
  id: string
  title: Record<IntegrationLocale, string>
  brands: PlatformDirectoryKey[]
}> = [
  { id: 'web', title: { 'zh-hant': '網站與商務', en: 'Websites & commerce' }, brands: ['cloudflare', 'shopify', 'woocommerce', 'wordpress', 'webflow', 'wix', 'squarespace'] },
  { id: 'messaging', title: { 'zh-hant': '訊息與社群', en: 'Messaging & social' }, brands: ['line', 'whatsapp', 'telegram', 'messenger', 'instagram', 'slack', 'discord', 'twilio'] },
  { id: 'shipping', title: { 'zh-hant': '物流與配送', en: 'Shipping & fulfilment' }, brands: ['dhl', 'sf', 'fedex', 'ups', 'shippo'] },
  { id: 'payments', title: { 'zh-hant': '金流與收款', en: 'Payments' }, brands: ['stripe', 'paypal', 'adyen', 'paddle', 'square'] },
  { id: 'crm', title: { 'zh-hant': '客戶與行銷', en: 'CRM & marketing' }, brands: ['hubspot', 'salesforce', 'mailchimp', 'klaviyo', 'zoho', 'airtable', 'notion'] },
  { id: 'insights', title: { 'zh-hant': '分析與預約', en: 'Insights & scheduling' }, brands: ['calendar', 'calendly', 'zoom', 'outlook', 'analytics', 'searchconsole', 'youtube', 'maps'] },
]

export const platformDirectoryCount = platformDirectoryGroups.reduce((count, group) => count + group.brands.length, 0)
