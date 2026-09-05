import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, getManagedSitePriceCatalog, MODULE_CATALOG, projectManagedSiteCatalogQuote } from '../server/managed-sites/ordering-service'
import { managedSiteBlueprintModuleMode } from '../server/managed-sites/live-connectors/blueprint'
import { createDeterministicManagedSiteBlueprint } from '../server/managed-sites/live-connectors/adapters'
import { buildManagedSiteGenerationRequest } from '../server/managed-sites/live-connectors/generation-service'
import { projectFunnelQuote } from '../server/managed-sites/funnel/quote-projection'
import type { FunnelAnswers } from '../server/managed-sites/funnel/session-service'
import { buildSiteSpec, parseSiteSpecSnapshot } from '../server/managed-sites/site-spec'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'

const PRICED_MODULES = {
  stripe_payment: { buildMinor: 3000, monthlyMinor: 0, readiness: 'manual_setup' },
  newebpay_payment: { buildMinor: 3000, monthlyMinor: 0, readiness: 'coming_soon' },
  ecpay_payment: { buildMinor: 3000, monthlyMinor: 0, readiness: 'coming_soon' },
  einvoice: { buildMinor: 4000, monthlyMinor: 200, readiness: 'coming_soon' },
  logistics: { buildMinor: 3000, monthlyMinor: 0, readiness: 'coming_soon' },
  erp_crm_backoffice: { buildMinor: 8000, monthlyMinor: 500, readiness: 'coming_soon' },
  bounded_ai_assistant: { buildMinor: 6000, monthlyMinor: 800, readiness: 'coming_soon' },
  line_assisted_integration: { buildMinor: 3000, monthlyMinor: 300, readiness: 'coming_soon' },
  google_booking_assisted_integration: { buildMinor: 4000, monthlyMinor: 0, readiness: 'coming_soon' },
} as const

async function pricingFixture(draftIdentity: string, siteType: 'one_page' | 'brand_blog' | 'simple_commerce' = 'one_page') {
  const ordering = createOrderingMemoryRepository()
  const preview = await createManagedSitePreview(null, {
    draftIdentity,
    brandName: '定價測試工作室',
    audience: '台灣中小企業',
    brief: '建立可驗證的網站報價。',
    businessGoals: ['increase_inquiries'],
    siteType,
    selectedModules: siteType === 'simple_commerce' ? ['shopify_commerce'] : [],
  }, ordering.repository)
  return { ordering, preview }
}

function baseQuote(preview: Awaited<ReturnType<typeof pricingFixture>>['preview'], idempotencyKey: string) {
  return { previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_only' as const, cadenceDays: 30 as const, domainOption: 'existing' as const, idempotencyKey }
}

describe('managed-site TWD pricing catalog', () => {
  it('round-trips and builds a coherent base site with no selected add-on modules', async () => {
    const line = await pricingFixture('zero-modules')
    expect(line.preview.spec.selectedModules).toEqual([])
    const parsed = parseSiteSpecSnapshot(line.preview.spec)
    expect(parsed.selectedModules).toEqual([])

    const request = buildManagedSiteGenerationRequest(1, 10, 20, 'a'.repeat(64), parsed, 'astro', 'zero-modules-generation')
    const blueprint = createDeterministicManagedSiteBlueprint(request)
    expect(blueprint.pages.map(page => page.pageKey)).toEqual(['home'])
    expect(blueprint.pages[0]!.sections).toHaveLength(1)
    expect(blueprint.selectedModulePlacements).toEqual([])

    const quote = await createManagedSiteQuote(baseQuote(line.preview, 'zero-modules-quote'), line.ordering.repository)
    expect(quote.quote.lines.map(item => item.lineKey)).toEqual(['build-one_page', 'monthly-plan-site_only'])
    expect(quote.quote.totalMinor).toBe(12500)
    expect(quote.quote.manualServiceModules).toEqual([])
    expect(quote.quote.comingSoonModules).toEqual([])
  })

  it('treats a skipped funnel module step as an explicit zero-module selection', () => {
    const answers: FunnelAnswers = {
      company: { brandName: '無加購工作室', whatWeDo: '提供顧客服務。', feelings: ['清楚'], mainOffer: '顧問服務', conversionGoals: ['reduce_support'] },
      style: { referenceUrls: [], stylePreset: 'minimal', designTier: 'template' },
      siteType: 'one_page',
      domain: { option: 'existing' },
      plan: { planKey: 'site_only' },
    }
    const quote = projectFunnelQuote(answers)
    expect(quote.lines.map(item => item.lineKey)).toEqual(['build-one_page', 'monthly-plan-site_only'])
    expect(quote.totals.dueTodayMinor).toBe(12500)
    expect(quote.manualServiceModules).toEqual([])
    expect(quote.comingSoonModules).toEqual([])
  })

  it('places Shopify on the home page when a brand blog has no shop page', () => {
    const spec = buildSiteSpec({ draftIdentity: 'brand-blog-shopify', brandName: '品牌商店', audience: '品牌讀者', brief: '以內容介紹品牌並連結外部商店。', businessGoals: ['build_brand'], siteType: 'brand_blog', selectedModules: ['shopify_commerce'], styleReferences: [] })
    const request = buildManagedSiteGenerationRequest(1, 11, 21, 'b'.repeat(64), spec, 'astro', 'brand-blog-shopify-generation')
    const blueprint = createDeterministicManagedSiteBlueprint(request)
    expect(blueprint.pages.some(page => page.pageKey === 'shop')).toBe(false)
    expect(blueprint.selectedModulePlacements).toEqual([expect.objectContaining({ moduleKey: 'shopify_commerce', pageKey: 'home', mode: 'safe_placeholder' })])
    expect(blueprint.pages.find(page => page.pageKey === 'home')?.sections).toEqual(expect.arrayContaining([expect.objectContaining({ moduleKey: 'shopify_commerce' })]))
  })

  it('rejects prototype-chain module keys with 422 before persisting a quote', async () => {
    const line = await pricingFixture('prototype-module-keys')
    for (const moduleKey of ['valueOf', 'constructor', 'toString']) {
      await expect(createManagedSiteQuote({ ...baseQuote(line.preview, `prototype-module-${moduleKey}`), moduleKeys: [moduleKey] }, line.ordering.repository)).rejects.toMatchObject({ statusCode: 422 })
    }
    expect(line.ordering.state.quotes).toEqual([])
    expect(line.ordering.state.lines).toEqual([])
  })

  it('refuses unsafe computed minor amounts before they can be persisted', () => {
    const originalBuildMinor = MODULE_CATALOG.stripe_payment.buildMinor
    try {
      MODULE_CATALOG.stripe_payment.buildMinor = Number.MAX_SAFE_INTEGER
      expect(() => projectManagedSiteCatalogQuote({ siteType: 'one_page', planKey: 'site_only', domainOption: 'existing', moduleKeys: ['stripe_payment'] })).toThrowError('報價金額無效，請重新整理後再試。')
    } finally {
      MODULE_CATALOG.stripe_payment.buildMinor = originalBuildMinor
    }
  })

  it('keeps the simple-commerce Shopify requirement actionable in Traditional Chinese', () => {
    let failure: unknown
    try {
      buildSiteSpec({ draftIdentity: 'commerce-without-shopify', brandName: '簡易商店', audience: '線上顧客', brief: '建立簡易電商網站。', businessGoals: ['sell_online'], siteType: 'simple_commerce', selectedModules: [], styleReferences: [] })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ statusCode: 422, statusMessage: expect.stringMatching(/簡易電商網站.*Shopify.*請返回模組步驟/u) })
  })

  it('publishes the complete TWD catalog and puts every site type build fee on its quote', async () => {
    const catalog = getManagedSitePriceCatalog()
    expect(catalog.currency).toBe('TWD')
    expect(catalog.siteTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'one_page', buildMinor: 12000 }),
      expect.objectContaining({ key: 'brand_blog', buildMinor: 18000 }),
      expect.objectContaining({ key: 'simple_commerce', buildMinor: 30000 }),
    ]))
    expect(catalog.modules).toHaveLength(15)
    expect(catalog.modules.find(module => module.key === 'line_assisted_integration')).toMatchObject({ activation: 'manual_service', readiness: 'coming_soon' })
    expect(catalog.modules.filter(module => module.readiness === 'available').map(module => module.key)).toEqual(['managed_content_admin', 'contact_lead_capture', 'geo_content_subscription', 'geo_measurement_dashboard'])
    for (const module of catalog.modules) {
      if (module.readiness === 'available') expect(managedSiteBlueprintModuleMode(module.key as Parameters<typeof managedSiteBlueprintModuleMode>[0])).toBe('first_party')
      // Shopify setup is bundled into the NT$30,000 電商建置費; charging it again would double-charge every simple-commerce order.
      if (module.readiness === 'manual_setup' && module.key !== 'shopify_commerce') expect(module.buildMinor).toBeGreaterThan(0)
    }

    for (const [siteType, buildMinor] of [['one_page', 12000], ['brand_blog', 18000], ['simple_commerce', 30000]] as const) {
      const line = await pricingFixture(`site-build-${siteType}`, siteType)
      const result = await createManagedSiteQuote(baseQuote(line.preview, `site-build-quote-${siteType}`), line.ordering.repository)
      expect(result.quote.lines.find(item => item.lineKey === `build-${siteType}`)?.lineAmountMinor).toBe(buildMinor)
    }
  })

  it('adds exactly NT$15,000 for designer design and nothing for template design', async () => {
    const line = await pricingFixture('design-tier')
    const template = await createManagedSiteQuote({ ...baseQuote(line.preview, 'template-design'), designTier: 'template' }, line.ordering.repository)
    const designer = await createManagedSiteQuote({ ...baseQuote(line.preview, 'designer-design'), designTier: 'designer' }, line.ordering.repository)
    expect(template.quote.lines.some(item => item.lineKey === 'design-designer')).toBe(false)
    expect(designer.quote.lines.find(item => item.lineKey === 'design-designer')?.lineAmountMinor).toBe(15000)
    expect(designer.quote.totalMinor - template.quote.totalMinor).toBe(15000)
  })

  it('publishes every owner-decided module list price and readiness without drift', () => {
    const catalog = getManagedSitePriceCatalog()
    for (const [moduleKey, expected] of Object.entries(PRICED_MODULES)) {
      expect(catalog.modules.find(module => module.key === moduleKey)).toMatchObject(expected)
    }
  })

  it('changes today and recurring totals by exactly zero for every coming-soon module', async () => {
    const catalog = getManagedSitePriceCatalog()
    const comingSoonModules = catalog.modules.filter(module => module.readiness === 'coming_soon').map(module => module.key)
    const line = await pricingFixture('all-coming-soon-modules')
    const baseline = await createManagedSiteQuote(baseQuote(line.preview, 'all-coming-soon-baseline'), line.ordering.repository)
    const selected = await createManagedSiteQuote({ ...baseQuote(line.preview, 'all-coming-soon-selected'), moduleKeys: comingSoonModules }, line.ordering.repository)
    expect(selected.quote.totalMinor - baseline.quote.totalMinor).toBe(0)
    expect(selected.quote.totals.recurringMonthlyMinor - baseline.quote.totals.recurringMonthlyMinor).toBe(0)
    expect(selected.quote.comingSoonModules).toEqual(comingSoonModules)
    expect(selected.quote.lines.filter(item => item.lineKey.endsWith('-intent'))).toHaveLength(comingSoonModules.length)
    expect(selected.quote.lines.filter(item => item.lineKey.endsWith('-intent')).every(item => item.lineAmountMinor === 0)).toBe(true)
  })

  it('records every not-yet-integrated owner-listed module at zero while billing Stripe NT$3,000', () => {
    const notYetIntegrated = ['newebpay_payment', 'ecpay_payment', 'einvoice', 'logistics', 'erp_crm_backoffice', 'bounded_ai_assistant', 'line_assisted_integration', 'google_booking_assisted_integration'] as const
    const baseline = projectManagedSiteCatalogQuote({ siteType: 'one_page', planKey: 'site_only', domainOption: 'existing', moduleKeys: [] })
    for (const moduleKey of notYetIntegrated) {
      const quote = projectManagedSiteCatalogQuote({ siteType: 'one_page', planKey: 'site_only', domainOption: 'existing', moduleKeys: [moduleKey] })
      expect(MODULE_CATALOG[moduleKey].readiness).toBe('coming_soon')
      expect(quote.totals.dueTodayMinor - baseline.totals.dueTodayMinor).toBe(0)
      // A coming-soon module must add nothing to the recurring bucket either, not just to today's charge.
      expect(quote.totals.recurringMonthlyMinor).toBe(baseline.totals.recurringMonthlyMinor)
      expect(quote.totals.oneTimeMinor).toBe(baseline.totals.oneTimeMinor)
      expect(quote.lines.some(line => line.lineKey === `monthly-module-${moduleKey}`)).toBe(false)
      expect(quote.lines.find(line => line.lineKey === `module-${moduleKey}-intent`)).toMatchObject({ lineAmountMinor: 0 })
    }
    const stripe = projectManagedSiteCatalogQuote({ siteType: 'one_page', planKey: 'site_only', domainOption: 'existing', moduleKeys: ['stripe_payment'] })
    expect(stripe.totals.dueTodayMinor - baseline.totals.dueTodayMinor).toBe(3000)
  })

  it('bills every manual-setup module at its catalog setup and monthly amounts', async () => {
    const catalog = getManagedSitePriceCatalog()
    const manualSetupModules = catalog.modules.filter(module => module.readiness === 'manual_setup')
    for (const module of manualSetupModules) {
      const line = await pricingFixture(`manual-setup-${module.key}`)
      const baseline = await createManagedSiteQuote(baseQuote(line.preview, `manual-setup-baseline-${module.key}`), line.ordering.repository)
      const selected = await createManagedSiteQuote({ ...baseQuote(line.preview, `manual-setup-selected-${module.key}`), moduleKeys: [module.key] }, line.ordering.repository)
      expect(selected.quote.totals.oneTimeMinor - baseline.quote.totals.oneTimeMinor).toBe(module.buildMinor)
      expect(selected.quote.totals.recurringMonthlyMinor - baseline.quote.totals.recurringMonthlyMinor).toBe(module.monthlyMinor)
      expect(selected.quote.totalMinor - baseline.quote.totalMinor).toBe(module.buildMinor + module.monthlyMinor)
      expect(selected.quote.manualSetupModules).toEqual([module.key])
      expect(selected.quote.comingSoonModules).toEqual([])
      expect(selected.quote.lines.some(item => item.lineKey === `module-${module.key}-intent`)).toBe(false)
      if (module.buildMinor > 0) expect(selected.quote.lines.find(item => item.lineKey === `module-${module.key}-setup`)).toMatchObject({ description: expect.stringContaining('・需人工設定'), lineAmountMinor: module.buildMinor })
      if (module.monthlyMinor > 0) expect(selected.quote.lines.find(item => item.lineKey === `monthly-module-${module.key}`)).toMatchObject({ description: expect.stringContaining('・需人工設定'), lineAmountMinor: module.monthlyMinor })
    }
  })

  it('normalises non-autopost plans to 30 days and prices every autopost cadence', async () => {
    for (const [planKey, cadenceDays] of [['site_only', 3], ['site_geo', 7]] as const) {
      const line = await pricingFixture(`normalise-${planKey}`)
      const quote = await createManagedSiteQuote({ ...baseQuote(line.preview, `normalise-quote-${planKey}`), planKey, cadenceDays }, line.ordering.repository)
      expect(quote.quote.cadenceDays).toBe(30)
    }
    for (const [cadenceDays, monthlyMinor] of [[30, 5000], [15, 6500], [7, 8500], [3, 12000]] as const) {
      const line = await pricingFixture(`autopost-${cadenceDays}`)
      const quote = await createManagedSiteQuote({ ...baseQuote(line.preview, `autopost-quote-${cadenceDays}`), planKey: 'site_geo_autopost', cadenceDays }, line.ordering.repository)
      expect(quote.quote.cadenceDays).toBe(cadenceDays)
      expect(quote.quote.lines.find(item => item.lineKey === 'monthly-plan-site_geo_autopost')?.lineAmountMinor).toBe(monthlyMinor)
    }
  })

  it('prices each catalog TLD, rejects a missing new-domain TLD, and maintains exact quote totals', async () => {
    const tlds = { com: 600, 'com.tw': 800, tw: 900, shop: 1200, store: 1400 } as const
    for (const [tld, annualMinor] of Object.entries(tlds) as Array<[keyof typeof tlds, number]>) {
      const line = await pricingFixture(`domain-${tld}`)
      const quote = await createManagedSiteQuote({ ...baseQuote(line.preview, `domain-quote-${tld}`), domainOption: 'new', domainTld: tld }, line.ordering.repository)
      expect(quote.quote.lines.find(item => item.lineKey === `domain-${tld.replaceAll('.', '-')}-year1`)?.lineAmountMinor).toBe(annualMinor)
      expect(quote.quote.lines.reduce((sum, item) => sum + item.lineAmountMinor, 0)).toBe(quote.quote.totalMinor)
      expect(quote.quote.totals.dueTodayMinor).toBe(quote.quote.totalMinor)
      expect(quote.quote.totals.domainRenewalAnnualMinor).toBe(annualMinor)
    }
    const line = await pricingFixture('missing-domain-tld')
    await expect(createManagedSiteQuote({ ...baseQuote(line.preview, 'missing-domain-tld-quote'), domainOption: 'new' }, line.ordering.repository)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('keeps assisted domain setup in the one-time bucket and out of the domain annual bucket', async () => {
    const line = await pricingFixture('assisted-domain')
    const quote = await createManagedSiteQuote({ ...baseQuote(line.preview, 'assisted-domain-quote'), domainOption: 'assisted' }, line.ordering.repository)
    expect(quote.quote.lines.find(item => item.lineKey === 'domain-assisted-setup')?.lineAmountMinor).toBe(2000)
    expect(quote.quote.totals.domainFirstYearMinor).toBe(0)
    expect(quote.quote.totals.domainRenewalAnnualMinor).toBe(0)
    expect(quote.quote.totals.oneTimeMinor).toBe(14000)
    expect(quote.quote.totals.oneTimeMinor + quote.quote.totals.firstMonthMinor + quote.quote.totals.domainFirstYearMinor).toBe(quote.quote.totalMinor)
  })

  it('ignores a missing cadence for non-autopost plans and rejects a missing cadence for autopost', async () => {
    const kept = await pricingFixture('cadence-optional')
    const quote = await createManagedSiteQuote({ ...baseQuote(kept.preview, 'cadence-optional-quote'), cadenceDays: undefined, planKey: 'site_geo' }, kept.ordering.repository)
    expect(quote.quote.cadenceDays).toBe(30)
    const missing = await pricingFixture('cadence-required')
    await expect(createManagedSiteQuote({ ...baseQuote(missing.preview, 'cadence-required-quote'), cadenceDays: undefined, planKey: 'site_geo_autopost' }, missing.ordering.repository)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('keeps second-month recurring charges out of today’s total', async () => {
    const line = await pricingFixture('recurring-totals')
    const quote = await createManagedSiteQuote({
      ...baseQuote(line.preview, 'recurring-totals-quote'),
      planKey: 'site_geo',
      moduleKeys: ['stripe_payment', 'einvoice', 'erp_crm_backoffice', 'line_assisted_integration'],
    }, line.ordering.repository)
    expect(quote.quote.currency).toBe('TWD')
    expect(quote.quote.totals).toMatchObject({ oneTimeMinor: 15000, firstMonthMinor: 2500, domainFirstYearMinor: 0, dueTodayMinor: 17500, recurringMonthlyMinor: 2500, domainRenewalAnnualMinor: 0 })
    expect(quote.quote.totalMinor).toBe(quote.quote.totals.oneTimeMinor + quote.quote.totals.firstMonthMinor + quote.quote.totals.domainFirstYearMinor)
    expect(quote.quote.totalMinor).not.toBe(quote.quote.totals.oneTimeMinor + quote.quote.totals.firstMonthMinor * 2)
    expect(quote.quote.manualServiceModules).toEqual(['stripe_payment', 'einvoice', 'erp_crm_backoffice', 'line_assisted_integration'])
    expect(quote.quote.manualSetupModules).toEqual(['stripe_payment'])
    expect(quote.quote.comingSoonModules).toEqual(['einvoice', 'erp_crm_backoffice', 'line_assisted_integration'])
  })
})
