import { resolveOpenAiCompatibleProviderConfiguration } from '../llm-provider/openai-compatible'
import { normalizePublicHttpsOrigin } from '../content-operations/normalization'
import { managedSiteEmailReadinessFromEnv } from './contact-inbox/email-transport'
import { managedSiteEmailOutboxReadinessFromEnv } from './email-outbox/configuration'
import { managedSiteVaultConfigurationFromEnv } from './live-connectors/s3-vault'
import { parseManagedSiteInternalBrokerConfiguration } from './live-connectors/internal-broker/config'
import { parseManagedSiteCredentialRegistryForTests } from './live-connectors/provider-registry'
import { managedSiteAllowedProviderOrigins } from './live-connectors/provider-verifiers'
import type { ManagedSiteProviderReadiness } from './live-connectors/types'

type Environment = Record<string, string | undefined>
export type SetupCheck = {
  id: string
  label: string
  status: 'configured' | 'missing' | 'invalid' | 'verification_required' | 'verified'
  required: boolean
  settings: string[]
  action: string
}

function httpsOrigin(value: string | undefined): boolean {
  try {
    normalizePublicHttpsOrigin(value || '')
    return true
  } catch { return false }
}

function jsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || Buffer.byteLength(raw) > 64 * 1024) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

/** Pure, read-only projection. It never returns values, opens a DB, or calls a provider. */
export function getDiscoveryStackSetupReadiness(input: {
  env?: Environment
  runtimeConfig?: Record<string, unknown>
  providers?: ManagedSiteProviderReadiness
} = {}) {
  const env = input.env || process.env
  const runtimeConfig = input.runtimeConfig || {}
  const checks: SetupCheck[] = []
  const add = (id: string, label: string, settings: string[], valid: boolean, action: string, required = true) => {
    checks.push({ id, label, settings, required, status: valid ? 'configured' : settings.some(name => !env[name]?.trim()) ? 'missing' : 'invalid', action })
  }
  add('origins', '官網與客戶後台網址', ['DISCOVERYSTACK_PUBLIC_SITE_ORIGIN', 'NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN'],
    httpsOrigin(env.DISCOVERYSTACK_PUBLIC_SITE_ORIGIN) && httpsOrigin(env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN),
    '填入官網及後台的 HTTPS 網址；同步設定公開站的 PUBLIC_SITE_URL、PUBLIC_OPS_API_ORIGIN 與 PUBLIC_OPS_UI_ORIGIN。')
  let databaseValid = false
  try { const url = new URL(env.DATABASE_URL || ''); databaseValid = url.protocol === 'mysql:' && Boolean(url.hostname && url.pathname.length > 1) } catch { /* no values in errors */ }
  add('database', '資料庫連線設定', ['DATABASE_URL'], databaseValid, '在後台服務設定 MySQL/TiDB 連線。連線設定存在仍需完成 migration 與交易驗收。')
  const session = String(runtimeConfig.sessionSecret || env.NUXT_SESSION_SECRET || env.JWT_SECRET || '')
  checks.push({ id: 'session', label: '登入簽章密鑰', required: true, settings: ['NUXT_SESSION_SECRET 或 JWT_SECRET'], status: !session ? 'missing' : Buffer.byteLength(session) < 32 ? 'invalid' : 'configured', action: '使用至少 32 bytes 的獨立隨機密鑰，存放在後台服務 Secrets。' })
  add('owner', '平台擁有人', ['OWNER_OPEN_ID'], Boolean(env.OWNER_OPEN_ID?.trim()), '設定 OWNER_OPEN_ID，並確認資料庫中對應使用者具備 admin 權限。')
  const simplePassword = env.OWNER_SIMPLE_LOGIN_PASSWORD || ''
  const oauthOrigin = String(runtimeConfig.discoveryStackOauthAllowedOrigin || env.NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN || env.OAUTH_ALLOWED_ORIGIN || '')
  const oauthConfigured = [runtimeConfig.oauthServerUrl || env.NUXT_OAUTH_SERVER_URL || env.OAUTH_SERVER_URL, runtimeConfig.oauthPortalUrl || env.NUXT_OAUTH_PORTAL_URL || env.VITE_OAUTH_PORTAL_URL, runtimeConfig.oauthAppId || env.NUXT_OAUTH_APP_ID || env.VITE_APP_ID].every(value => typeof value === 'string' && Boolean(value.trim()))
    && httpsOrigin(oauthOrigin) && oauthOrigin.replace(/\/$/u, '') === (env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN || '').replace(/\/$/u, '')
  checks.push({ id: 'owner_login', label: '擁有人登入方式', required: true, settings: ['OWNER_SIMPLE_LOGIN_PASSWORD 或 OAuth 設定', 'OAuth：NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN'], status: simplePassword ? simplePassword.length >= 16 ? 'configured' : 'invalid' : oauthConfigured ? 'configured' : 'missing', action: 'OAuth 必須設定服務網址、portal、app ID 與同一後台的 allowed origin；使用密碼登入時請設定至少 16 個字元的強密碼。' })
  const email = managedSiteEmailReadinessFromEnv(env)
  checks.push({ id: 'email', label: 'Resend 系統寄信', required: true, settings: ['NUXT_MANAGED_SITE_EMAIL_API_KEY', 'NUXT_MANAGED_SITE_EMAIL_FROM', 'DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS'], status: email.status, action: '驗證寄件網域後設定 Resend API key 和寄件人，將 https://api.resend.com 加入 provider allowlist。完成後實測邀請、登入信與表單通知。' })
  const emailOutbox = managedSiteEmailOutboxReadinessFromEnv(env)
  checks.push({ id: 'email_queue', label: '郵件加密與可靠佇列', required: true, settings: ['NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY'], status: emailOutbox.status, action: '設定獨立的 32 至 4096 bytes 隨機密鑰；套用經審核的郵件佇列 migration。設定存在不代表資料庫或寄送已驗收。' })
  const emailSwitch = env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED
  checks.push({ id: 'email_scheduler', label: '郵件自動寄送開關', required: false, settings: ['NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED', 'MANAGED_SITE_EMAIL_OUTBOX_CRON'], status: emailOutbox.enabled ? 'configured' : emailSwitch && emailSwitch !== 'false' ? 'invalid' : 'verification_required', action: '預設關閉。完成 migration、寄件網域與收信驗收後才明確設為 true；這會同時允許即時寄信與排程重試，且主機必須常駐。' })
  add('email_codes', '收信信箱驗證碼', ['NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER'], Buffer.byteLength(env.NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER || '') >= 32, '設定獨立的至少 32 bytes 隨機密鑰，驗證碼只保存雜湊。')
  const llm = resolveOpenAiCompatibleProviderConfiguration({ env, runtimeConfig })
  checks.push({ id: 'ai', label: '網站與內容 AI', required: true, settings: ['NUXT_LLM_ENDPOINT', 'NUXT_LLM_API_KEY', 'NUXT_LLM_MODEL'], status: llm.configured ? 'configured' : llm.reason.endsWith('missing') ? 'missing' : 'invalid', action: '設定官方 OpenAI 相容端點、API key 與模型，再在 Managed Sites 驗證網站生成供應商。' })
  add('ai_switches', '內容生成與 AI 編輯開關', ['NUXT_CONTENT_DRAFT_PROVIDER', 'NUXT_PAGE_EDITOR_AI_PROVIDER'],
    env.NUXT_CONTENT_DRAFT_PROVIDER === 'openai_compatible' && env.NUXT_PAGE_EDITOR_AI_PROVIDER === 'openai_compatible', '兩個 provider 開關均設定為 openai_compatible。')
  add('content_scheduler', '內容背景排程開關', ['NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED'],
    env.NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED === 'true', '完成生成、審核與發布驗收後，明確設為 true。開關不會取代客戶的內容計畫、風險審核或發布授權，且主機必須常駐。')
  add('editor_preview', '編輯器預覽簽章', ['NUXT_PAGE_EDITOR_PREVIEW_SECRET'], Buffer.byteLength(env.NUXT_PAGE_EDITOR_PREVIEW_SECRET || '') >= 32, '設定獨立的至少 32 bytes 隨機密鑰。')
  add('site_forms', '客戶網站聯絡表單', ['DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN', 'NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER'],
    httpsOrigin(env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN) && Buffer.byteLength(env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER || '') >= 32,
    '表單接收網址設定為後台 HTTPS origin；設定獨立 token pepper，客戶完成收信信箱綁定後才能收到通知。')
  let scannerEndpointValid = false
  try {
    const endpoint = new URL(env.NUXT_MEDIA_SCANNER_ENDPOINT || '')
    scannerEndpointValid = httpsOrigin(endpoint.origin) && endpoint.pathname.length > 1 && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
  } catch { /* configuration-only, no scanner request */ }
  const scannerReference = env.NUXT_MEDIA_SCANNER_CREDENTIAL_REF || ''
  const scannerCredential = /^[A-Z][A-Z0-9_]{7,159}$/u.test(scannerReference) ? env[scannerReference] || '' : ''
  add('media_scanner', '客戶圖片安全掃描', ['NUXT_MEDIA_SCANNER_ENDPOINT', 'NUXT_MEDIA_SCANNER_CREDENTIAL_REF'],
    scannerEndpointValid && scannerCredential.length >= 16 && scannerCredential.length <= 4096,
    '設定 HTTPS 掃描端點與指向 bearer secret 的環境變數名稱，再在「圖片倉庫」為各專案執行健康檢查；未通過時圖片保留隔離。')
  checks.push({ id: 'media_storage', label: '各專案圖片倉庫', required: false, settings: [], status: 'verification_required', action: '在「圖片倉庫」為需要圖片編輯的專案設定 S3/R2 connection，並確認 storage 與 scanner health。網站程式檔案 vault 不會自動建立圖片 connection。' })
  let vaultValid = false
  try { managedSiteVaultConfigurationFromEnv(env); vaultValid = true } catch { /* never include raw JSON */ }
  add('vault', '網站檔案倉庫', ['DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    vaultValid && Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY), '設定私人 R2/S3 bucket 與憑證，完成實際 immutable 檔案寫入／讀回驗收。')
  const registry = parseManagedSiteCredentialRegistryForTests(env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON)
  add('credentials', '供應商憑證參照', ['DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON'], registry.ok && registry.references.length > 0, 'Secrets 保存 reference→value registry；後台只輸入 reference，不輸入金鑰。')
  const broker = parseManagedSiteInternalBrokerConfiguration(env.DISCOVERYSTACK_MANAGED_SITE_INTERNAL_BROKER_JSON)
  const brokerRefs = broker ? [broker.deploymentCredentialReference, broker.dnsTlsCredentialReference, broker.cloudflare.apiTokenReference] : []
  add('broker', 'Cloudflare 部署與 DNS', ['DISCOVERYSTACK_MANAGED_SITE_INTERNAL_BROKER_JSON'],
    Boolean(broker && registry.ok && brokerRefs.every(ref => registry.references.includes(ref))), '設定 account ID、專案前綴與部署／DNS／Cloudflare references；每個 reference 都必須能由 registry 解析。')
  let originsValid = false
  try {
    const origins = managedSiteAllowedProviderOrigins(env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS)
    originsValid = ['https://api.resend.com', 'https://api.stripe.com', 'https://api.porkbun.com', 'https://managed-sites-broker.discoverystack.dev'].every(origin => origins.has(origin))
  } catch { /* safe projection */ }
  add('provider_origins', '供應商允許清單', ['DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS'], originsValid, '允許 Resend、Stripe、Porkbun 及內部 broker 的精確 HTTPS origins。')
  const checkoutOrigins = (env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS || '').split(',').map(value => value.trim())
  add('checkout_origin', 'Stripe 結帳網址', ['DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS'], checkoutOrigins.includes('https://checkout.stripe.com'), '加入 https://checkout.stripe.com。')
  const webhookRef = env.DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF || ''
  add('webhook', 'Stripe webhook 簽章', ['DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY', 'DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF'],
    env.DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY === 'stripe' && registry.ok && registry.references.includes(webhookRef), '設定 stripe 與獨立 webhook 簽章 reference；在 Stripe 註冊 /api/managed-sites/payments/stripe/webhook。')
  const policy = jsonObject(env.MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON)
  const policyValid = Boolean(policy && Object.keys(policy).length && Object.entries(policy).every(([tld, entry]) => {
    if (!/^[a-z]{2,63}(?:\.[a-z]{2,63})?$/u.test(tld) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const value = entry as Record<string, unknown>
    return Object.keys(value).sort().join(',') === 'currency,maxAmountMinor' && /^[A-Z]{3}$/u.test(String(value.currency || '')) && Number.isSafeInteger(value.maxAmountMinor) && Number(value.maxAmountMinor) > 0
  }))
  add('domain_budget', '新網域採購預算', ['MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON'], policyValid, '為開放的 TLD 設定幣別與每年上限；未配置的 TLD 維持關閉。')
  const cap = env.MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT
  checks.push({ id: 'build_limit', label: '公開建站額度', required: true, settings: ['MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT'], status: cap === undefined || cap === '' || /^\d+$/u.test(cap) && Number.isSafeInteger(Number(cap)) && Number(cap) > 0 ? 'configured' : 'invalid', action: '預設每天 20 次。0 會暫停建站；設定正整數後才接受公開建站。' })
  for (const capability of ['website_generator', 'payment', 'domain_registration', 'dns_tls', 'deployment'] as const) {
    const item = input.providers?.capabilities.find(row => row.capability === capability)
    checks.push({ id: `provider_${capability}`, label: ({ website_generator: '網站生成', payment: '付款', domain_registration: '網域註冊', dns_tls: 'DNS／HTTPS', deployment: '部署' } as const)[capability] + '供應商驗證', required: true, settings: [],
      status: item?.verified && item.liveMutationAllowed ? 'verified' : item?.configured && item.credentialResolvable ? 'verification_required' : 'missing', action: '在 Managed Sites 保存 provider reference 與連線設定，再執行驗證。測試模式付款僅供測試，不能授權真實網域採購。' })
  }
  const configured = checks.filter(check => check.required).every(check => !['missing', 'invalid'].includes(check.status))
  return {
    configurationReady: configured,
    providerVerificationComplete: Boolean(input.providers?.liveReady),
    productionAccepted: false as const,
    checks,
    acceptance: [
      '資料庫 migration、真實持久化及付款交易回滾驗收。',
      '寄件網域 DNS 驗證，以及登入信、邀請信和聯絡表單通知實際收信。',
      '郵件佇列 migration、同交易保存連結、重啟恢復及併發不重複寄送驗收；provider 接受與實際收信分開記錄。',
      'Stripe 測試付款與 webhook 重播；正式收費需另開 live mode。',
      '指定網域的註冊、DNS／HTTPS、部署及客戶網址內容驗證。',
      '關閉瀏覽器後背景排程仍執行；主機休眠時無法提供這項能力。',
    ],
  }
}
