import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as utility from '../utils/managedSiteFunnel'

const source = readFileSync(new URL('../pages/customer/managed-sites/start.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)![1]!
const available = { available: true, canonicalDomain: 'chosen-customer.com', quoteFingerprint: 'server-quote', expiresAt: new Date(Date.now() + 600_000).toISOString(), customerPrice: { amountMinor: 100000, currency: 'TWD' } }
function harness(lookup: () => Promise<any> = async () => available) {
  const projection = { consentVersion: 'current-consent', domainDelegationVersion: 'current-delegation' }
  const fetch = vi.fn(async (url: string, _options: unknown) => url.endsWith('/domain-availability') ? lookup() : projection)
  const vue = { ref: (value: unknown) => ({ value }), computed: (definition: any) => ({ get value() { return typeof definition === 'function' ? definition() : definition.get() }, set value(value: unknown) { definition.set(value) } }), onMounted: vi.fn(), onBeforeUnmount: vi.fn() }
  const useRuntimeConfig = vi.fn(() => ({ public: { discoveryStackPublicSiteOrigin: 'https://www.discoverystack.tw' } }))
  const script = ts.transpileModule(`${source}\nexport { answers, currentStep, sessionId, sessionToken, consentScrolledToBottom, consentChecked, domainRegistrant, domainDelegated, domainName, domainTld, domainAvailability, nextDisabled, checkDomainAvailability, saveCurrentAndAdvance };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', '$fetch', 'useHead', 'useRuntimeConfig', script)((name: string) => name === 'vue' ? vue : utility, module, module.exports, fetch, vi.fn(), useRuntimeConfig)
  const page = module.exports
  page.currentStep.value = 7; page.sessionId.value = 7; page.sessionToken.value = 'capability-token'
  page.answers.value.domain = { option: 'new', name: 'chosen-customer', tld: 'com' }
  page.consentScrolledToBottom.value = true; page.consentChecked.value = true
  page.domainRegistrant.value = { firstName: 'Customer', lastName: '', organization: '', address1: '1 Example Road', city: 'Taipei', state: '', postalCode: '100', country: 'TW', phoneCountryCode: '886', phone: '912345678', email: 'customer@example.test' }
  return { page, fetch }
}

describe('actual domain wizard behavior', () => {
  it('queries before advance and sends only server fingerprint plus explicit registrant delegation', async () => {
    const { page, fetch } = harness()
    expect(page.nextDisabled.value).toBe(true)
    await page.checkDomainAvailability()
    expect(page.nextDisabled.value).toBe(true)
    page.domainDelegated.value = true
    expect(page.nextDisabled.value).toBe(false)
    await page.saveCurrentAndAdvance()
    expect(page.currentStep.value).toBe(8)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/managed-sites/funnel/sessions/7/domain-availability', '/api/managed-sites/funnel/sessions/7', '/api/managed-sites/funnel/sessions/7/consent', '/api/managed-sites/funnel/sessions/7/domain-delegation'])
    const delegation = fetch.mock.calls[3]![1] as any
    expect(delegation.body).toEqual({ delegated: true, registrant: page.domainRegistrant.value, quoteFingerprint: 'server-quote', termsVersion: 'current-delegation' })
    expect(JSON.stringify(delegation.body)).not.toMatch(/amount|price|USD|providerAuthority/)
  })
  it('invalidates availability and consent when the selected domain changes', async () => {
    const { page } = harness(); await page.checkDomainAvailability(); page.domainDelegated.value = true
    page.domainName.value = 'another-customer'
    expect(page.domainAvailability.value).toBeNull(); expect(page.domainDelegated.value).toBe(false); expect(page.nextDisabled.value).toBe(true)
  })
  it('ignores an in-flight result for the previous domain', async () => {
    let resolve!: (value: unknown) => void
    const { page } = harness(() => new Promise(done => { resolve = done }))
    const checking = page.checkDomainAvailability(); page.domainName.value = 'another-customer'; resolve(available); await checking
    expect(page.domainAvailability.value).toBeNull(); expect(page.nextDisabled.value).toBe(true)
  })
  it('keeps the customer at domain selection when lookup fails or is unavailable', async () => {
    const { page } = harness(async () => ({ available: false, messageZh: '網域已被註冊' }))
    await page.checkDomainAvailability(); page.domainDelegated.value = true; await page.saveCurrentAndAdvance()
    expect(page.currentStep.value).toBe(7); expect(page.nextDisabled.value).toBe(true)
  })
})
