import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../pages/customer/managed-sites/start.vue', import.meta.url), 'utf8')
const utility = readFileSync(new URL('../utils/managedSiteFunnel.ts', import.meta.url), 'utf8')

describe('managed-site funnel wizard UI contract', () => {
  it('wires the read-to-bottom consent gate into the real controls', () => {
    expect(page).toContain('consentGateState')
    expect(page).toContain('isScrolledToBottom')
    expect(page).toContain(':disabled="!consentGate.canTick"')
    // Submitting step 7 is gated through the shared footer control, so pin both halves of that path.
    expect(page).toContain('consentGate.value.canSubmit')
    expect(page).toContain(':disabled="nextDisabled"')
  })

  it('keeps customer-influenced preview content inside a fully sandboxed iframe', () => {
    expect(page).toContain('sandbox=""')
    expect(page).not.toContain('allow-scripts')
    expect(page).not.toContain('allow-same-origin')
    expect(page).not.toContain('v-html')
  })

  it('uses token authority without owner sessions or cookies', () => {
    expect(page).toContain("'x-managed-site-funnel-token'")
    expect(page).not.toContain("credentials: 'include'")
    expect(page).not.toContain('requireOwner')
    expect(page).not.toContain('/api/auth')
    expect(page).not.toContain("from '../../../server/")
  })

  it('limits every API string literal to the funnel and catalog public surfaces', () => {
    const apiLiterals = [...page.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/gu)].map(match => match[1]!)
    expect(apiLiterals.length).toBeGreaterThan(0)
    for (const literal of apiLiterals) {
      expect(
        literal.startsWith('/api/managed-sites/funnel/')
        || literal.startsWith('/api/managed-sites/price-catalog'),
        `unexpected API literal: ${literal}`,
      ).toBe(true)
    }
  })

  it('formats server money without client-side price arithmetic or embedded catalog prices', () => {
    for (const forbidden of ['12000', '18000', '30000', '15000', '2500', 'dueTodayMinor +', '* 100', '/ 100']) expect(page).not.toContain(forbidden)
    expect(page).toContain('formatTwd(quote.totals.dueTodayMinor)')
    expect(page.match(/quote\.totals\.dueTodayMinor/gu)).toHaveLength(1)
  })

  it('states the manual-service and domain limits without fake promises', () => {
    expect(page).toContain('結帳後由我們代為註冊')
    expect(page).toContain('需人工設定')
    expect(page).toContain("module.readiness === 'manual_setup'")
    expect(page).toContain('付款後由我們為你設定開通')
    expect(page).toContain("module.readiness === 'coming_soon'")
    expect(page).toContain('即將推出・本次不收費')
    expect(page).toContain('本次結帳 {{ formatTwd(0) }}')
    expect(page).toContain('已登記需求，但本次不會開通，也未收取任何費用')
    expect(page).toContain('完成前不會顯示為已開通')
    expect(page).not.toContain('已購買網域')
    expect(page).not.toContain('立即開通')
    expect(page).not.toContain('即時註冊成功')
  })

  it('collects required contact identity and uses only the corrected domain vocabulary', () => {
    expect(page).toContain('answers.contact.email')
    expect(page).toContain('answers.contact.contactName')
    expect(page).not.toContain("'none'")
    expect(utility).toContain("missing.push('聯絡人姓名')")
    expect(utility).toContain("missing.push('聯絡 Email')")
  })

  it('keeps the page out of search indexes', () => {
    expect(page).toContain("'noindex, nofollow, noarchive'")
  })

  it('preserves a saved token after retryable restore failures but clears expired sessions', () => {
    expect(page).toContain('function isExpiredSession')
    expect(page).toContain('[404, 410].includes')
    expect(page).toContain("bootstrapError.value = '暫時讀不到你的進度，請稍後再試'")
    expect(page).toContain('@click="bootstrap">再試一次</button>')
    expect(page).toMatch(/if \(isExpiredSession\(error\)\) \{\s*clearStoredSession\(\)\s*await createFreshSession\(\)/u)
  })

  it('keeps the commerce module required across restore, module submission, and build', () => {
    for (const symbol of ['normalizedModulesForSiteType', 'missingRequiredModulesForSiteType', 'requiredModulesForSiteType']) expect(page).toContain(symbol)
    expect(page).toContain('answers.value.modules = normalizedModulesForSiteType(answers.value.siteType, answers.value.modules)')
    expect(page).toContain('return { modules: normalizedModulesForSiteType(answers.value.siteType, answers.value.modules) }')
    expect(page).toContain('必選功能（已啟用）')
    expect(page).toContain('請先選擇必需功能：')
    expect(utility).toContain("siteType === 'simple_commerce' ? ['shopify_commerce'] : []")
    expect(utility).toContain("missing.push(MODULE_HELP[module]?.label || module)")
  })

  it('renders the real non-blocking inbox verification states without exposing codes or cookies', () => {
    for (const text of ['寄出驗證碼', '確認綁定', '換綁其他信箱', '驗證次數過多，請重新寄送驗證碼', '寄信服務尚未開通，這個模組會先記錄你的信箱需求，上線後我們會協助綁定', '表單送出的資料仍會保存並可查看，但不會轉寄到信箱']) expect(page).toContain(text)
    expect(page).toContain("'/inbox-binding'")
    expect(page).toContain("'/inbox-binding-confirm'")
    expect(page).not.toMatch(/['"`]\d{6}['"`]/u)
    expect(page).not.toMatch(/console\.(?:log|info|debug|warn|error)\([^)]*code/iu)
    expect(page).not.toContain("credentials: 'include'")
  })
})
