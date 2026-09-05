import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStripeCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/stripe-adapters'
import type { ManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/types'
import { getManagedSitePriceCatalog, MODULE_CATALOG, projectManagedSiteCatalogQuote } from '../server/managed-sites/ordering-service'
import { managedSiteQuoteLineBilling } from '../server/managed-sites/quote-line-billing'

const savedProviderOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
const savedCheckoutOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS

beforeEach(() => { process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'; process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com' })
afterEach(() => {
  if (savedProviderOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = savedProviderOrigins
  if (savedCheckoutOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = savedCheckoutOrigins
})

type CheckoutInput = Parameters<ManagedSiteCheckoutSessionAdapter['createSession']>[0]
type CheckoutLine = CheckoutInput['lineSnapshot'][number]

const realisticLines: CheckoutLine[] = [
  { lineKey: 'build-simple_commerce', quantity: 1, unitAmountMinor: 30000, lineAmountMinor: 30000 },
  { lineKey: 'design-designer', quantity: 1, unitAmountMinor: 15000, lineAmountMinor: 15000 },
  { lineKey: 'module-stripe_payment-setup', quantity: 1, unitAmountMinor: 3000, lineAmountMinor: 3000 },
  { lineKey: 'monthly-plan-site_geo_autopost', quantity: 1, unitAmountMinor: 12000, lineAmountMinor: 12000 },
  { lineKey: 'module-einvoice-intent', quantity: 1, unitAmountMinor: 0, lineAmountMinor: 0 },
  { lineKey: 'domain-com-year1', quantity: 1, unitAmountMinor: 600, lineAmountMinor: 600 },
]

function checkoutInput(lineSnapshot: CheckoutLine[], cadenceDays = 3): CheckoutInput {
  return {
    ownerUserId: 7,
    projectId: 11,
    releaseId: 13,
    previewId: 17,
    approvalFingerprint: 'a'.repeat(64),
    draftOrderId: 19,
    quoteId: 23,
    amountMinor: lineSnapshot.reduce((total, line) => total + line.lineAmountMinor, 0),
    currency: 'TWD',
    planKey: 'site_geo_autopost',
    cadenceDays,
    domainOption: 'new',
    lineSnapshot,
    taxStatus: 'not_calculated',
    snapshotFingerprint: 'b'.repeat(64),
    checkoutReceiptFingerprint: 'c'.repeat(64),
    configurationFingerprint: 'd'.repeat(64),
    verificationReceiptFingerprint: 'e'.repeat(64),
    capabilityIdentity: 'stripe-balance:test',
    idempotencyKey: 'stripe-line-billing-001',
    timeoutMs: 5000,
  }
}

async function captureStripeBody(lineSnapshot: CheckoutLine[], cadenceDays = 3) {
  const input = checkoutInput(lineSnapshot, cadenceDays)
  let body: URLSearchParams | undefined
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const requestBody = new URLSearchParams(String(init?.body || '')); body = requestBody
    const metadata = Object.fromEntries([...requestBody.entries()].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice('metadata['.length, -1), value]))
    return new Response(JSON.stringify({ id: 'cs_test_billing_001', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_billing_001', amount_total: input.amountMinor * 100, currency: 'twd', metadata }), { status: 200 })
  })
  const adapter = createStripeCheckoutSessionAdapter({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: 'https://merchant.example.com', credentialReference: 'vault:stripe-test', resolveCredential: async () => ({ ok: true, value: 'stripe-test-credential' }), fetchImpl: fetchImpl as typeof fetch })
  await adapter.createSession(input)
  if (!body) throw new Error('Stripe checkout request was not captured')
  return { body, fetchImpl }
}

function lineIndex(body: URLSearchParams, lineKey: string): number {
  for (let index = 0; body.has(`line_items[${index}][price_data][product_data][name]`); index++) if (body.get(`line_items[${index}][price_data][product_data][name]`) === lineKey) return index
  throw new Error(`Stripe line was not found: ${lineKey}`)
}

function recurringValue(body: URLSearchParams, lineKey: string, field: 'interval' | 'interval_count'): string | null {
  return body.get(`line_items[${lineIndex(body, lineKey)}][price_data][recurring][${field}]`)
}

describe('managed-site quote line billing authority', () => {
  it('never marks one-time build, design, setup, or year-one domain lines as recurring', async () => {
    const { body } = await captureStripeBody(realisticLines, 3)
    for (const lineKey of ['build-simple_commerce', 'design-designer', 'module-stripe_payment-setup', 'domain-com-year1']) {
      expect(recurringValue(body, lineKey, 'interval')).toBeNull()
      expect(recurringValue(body, lineKey, 'interval_count')).toBeNull()
    }
    expect([...body.entries()].some(([key, value]) => key.includes('[recurring]') && value === 'day')).toBe(false)
  })

  it('marks monthly plan lines as monthly regardless of posting cadence', async () => {
    const { body } = await captureStripeBody(realisticLines, 3)
    for (const lineKey of ['monthly-plan-site_geo_autopost']) {
      expect(recurringValue(body, lineKey, 'interval')).toBe('month')
      expect(recurringValue(body, lineKey, 'interval_count')).toBe('1')
    }
  })

  it('omits zero-amount intent lines while validating the complete snapshot total', async () => {
    const ecpayIntentLine = { lineKey: 'module-ecpay_payment-intent', quantity: 1, unitAmountMinor: 0, lineAmountMinor: 0 }
    const { body } = await captureStripeBody([...realisticLines, ecpayIntentLine], 3)
    for (const intentLine of [realisticLines.find(line => line.lineKey === 'module-einvoice-intent')!, ecpayIntentLine]) {
      expect(body.toString()).not.toContain(intentLine.lineKey)
      expect([...body.values()]).not.toContain(intentLine.lineKey)
    }
    expect(body.get('mode')).toBe('subscription')
  })

  it('uses payment mode for only one-time lines and subscription mode when any monthly line exists', async () => {
    const oneTime = await captureStripeBody(realisticLines.filter(line => !line.lineKey.startsWith('monthly-')), 3)
    expect(oneTime.body.get('mode')).toBe('payment')
    expect([...oneTime.body.keys()].some(key => key.includes('[recurring]'))).toBe(false)
    const subscription = await captureStripeBody([realisticLines[0]!, realisticLines[3]!], 3)
    expect(subscription.body.get('mode')).toBe('subscription')
  })

  it('fails closed on an unknown snapshot line without issuing an HTTP request', async () => {
    const fetchImpl = vi.fn()
    const adapter = createStripeCheckoutSessionAdapter({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: 'https://merchant.example.com', credentialReference: 'vault:stripe-test', resolveCredential: async () => ({ ok: true, value: 'stripe-test-credential' }), fetchImpl: fetchImpl as typeof fetch })
    await expect(adapter.createSession(checkoutInput([{ lineKey: 'unknown-charge', quantity: 1, unitAmountMinor: 100, lineAmountMinor: 100 }]))).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Managed-site quote line billing classification is unknown.' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('matches the former display classification for every line emitted across the real catalogs', () => {
    const catalog = getManagedSitePriceCatalog()
    const moduleKeys = Object.keys(MODULE_CATALOG)
    const domainSelections = [{ domainOption: 'existing' as const }, { domainOption: 'assisted' as const }, ...catalog.domainTlds.map(({ tld }) => ({ domainOption: 'new' as const, domainTld: tld }))]
    const seen = new Set<string>()
    for (const siteType of catalog.siteTypes.map(item => item.key)) for (const designTier of catalog.designTiers.map(item => item.key)) for (const plan of catalog.plans) for (const cadenceDays of plan.key === 'site_geo_autopost' ? catalog.cadence.map(item => item.days) : [undefined]) for (const domain of domainSelections) {
      const projection = projectManagedSiteCatalogQuote({ siteType: siteType as Parameters<typeof projectManagedSiteCatalogQuote>[0]['siteType'], designTier: designTier as Parameters<typeof projectManagedSiteCatalogQuote>[0]['designTier'], planKey: plan.key as Parameters<typeof projectManagedSiteCatalogQuote>[0]['planKey'], cadenceDays: cadenceDays as Parameters<typeof projectManagedSiteCatalogQuote>[0]['cadenceDays'], domainOption: domain.domainOption, domainTld: 'domainTld' in domain ? domain.domainTld as Parameters<typeof projectManagedSiteCatalogQuote>[0]['domainTld'] : undefined, moduleKeys })
      for (const line of projection.lines) {
        seen.add(line.lineKey)
        const formerDisplayBilling = line.lineKey.startsWith('monthly-') ? 'monthly' : /^domain-[a-z0-9-]+-year1$/u.test(line.lineKey) ? 'annual' : 'one_time'
        expect(managedSiteQuoteLineBilling(line.lineKey), line.lineKey).toBe(formerDisplayBilling)
      }
    }
    const expected = new Set([
      ...catalog.siteTypes.map(item => `build-${item.key}`),
      ...catalog.designTiers.filter(item => item.oneTimeMinor > 0).map(item => `design-${item.key}`),
      ...moduleKeys.flatMap(module => MODULE_CATALOG[module as keyof typeof MODULE_CATALOG].readiness === 'coming_soon' ? [`module-${module}-intent`] : MODULE_CATALOG[module as keyof typeof MODULE_CATALOG].buildMinor > 0 ? [`module-${module}-setup`] : []),
      ...catalog.plans.map(item => `monthly-plan-${item.key}`),
      ...moduleKeys.filter(module => MODULE_CATALOG[module as keyof typeof MODULE_CATALOG].readiness !== 'coming_soon' && MODULE_CATALOG[module as keyof typeof MODULE_CATALOG].monthlyMinor > 0).map(module => `monthly-module-${module}`),
      ...catalog.domainTlds.map(item => `domain-${item.tld.replaceAll('.', '-')}-year1`),
      'domain-assisted-setup',
    ])
    expect(seen).toEqual(expected)
  })
})
