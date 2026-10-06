import { describe, it, expect } from 'vitest'
import { buildSiteSpec, parseSiteSpecSnapshot } from '../server/managed-sites/site-spec'
import { customerRuntimeManifest, prepareCustomerRuntime } from '../server/managed-sites/customer-runtime'
import { funnelSiteSpec } from '../server/managed-sites/funnel/quote-projection'

// The cross-application contract executes with the complete checkout in Vitest.
// Keep its fixture out of Nuxt's static dependency graph: production packages
// intentionally contain only nuxt-app, not the independently hosted merchant app.
const customerRuntimeConfigUrl = new URL('../../services/customer-site-runtime/lib/config.mjs', import.meta.url)
const { parseConfig } = await import(customerRuntimeConfigUrl.href)

const spec = () => buildSiteSpec({ draftIdentity: 'fixture-brand', brandName: '測試品牌', audience: '一般訪客', brief: '品牌故事與商品', businessGoals: ['sell_online'], customerSitePreset: 'bloom' })
describe('customer runtime generation bridge', () => {
  it('maps preserved brand data and preset into a data-only isolated config, not a live/payment receipt', () => {
    const s = spec(); const m = customerRuntimeManifest(s, { ownerUserId: 1, projectId: 8, versionId: 12 }, { engine: 'commerce', mode: 'production' })
    expect(parseConfig(m.config)).toMatchObject({ siteId: 'ds-1-8', preset: 'bloom', commerce: { paymentMode: 'disabled' } })
    expect(m.launch).toMatchObject({ deployed: false, paymentVerified: false, databaseProvisioned: false, blocker: 'runtime_deployment_adapter_required' })
    expect(m.moduleAuthority.fulfillsExistingShopifyOrder).toBe(false)
    expect(m.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(m).toEqual(customerRuntimeManifest(s, { ownerUserId: 1, projectId: 8, versionId: 12 }, { engine: 'commerce', mode: 'production' }))
  })
  it('keeps legacy SiteSpec fingerprints unchanged unless a new explicit preset is supplied', () => {
    const s = spec(); expect(parseSiteSpecSnapshot(s).customerSitePreset).toBe('bloom')
    expect(() => buildSiteSpec({ draftIdentity: 'test', brandName: 'Test', audience: 'Public', brief: 'brief', businessGoals: ['build_brand'], customerSitePreset: 'arbitrary-code' })).toThrow()
    const mapped = funnelSiteSpec({ company: { brandName: '品牌', whatWeDo: '服務', mainOffer: '練習', conversionGoals: ['increase_bookings'], feelings: [] }, style: { referenceUrls: [], designTier: 'template', customerSitePreset: 'alignment' }, siteType: 'brand_blog', modules: [] }, 2)
    expect(mapped.customerSitePreset).toBe('alignment')
  })
  it('rejects cross-owner/version/project and suspended state before issuing an artifact', async () => {
    const repository = { findProject: async () => ({ id: 8, ownerUserId: 1, status: 'draft' }), findVersion: async () => ({ id: 12, ownerUserId: 2, projectId: 8 }) } as any
    await expect(prepareCustomerRuntime(1, 8, { versionId: 12, engine: 'commerce', mode: 'preview' }, repository)).rejects.toMatchObject({ statusCode: 404 })
    await expect(prepareCustomerRuntime(1, 8, { versionId: 12, engine: 'commerce', mode: 'preview', password: 'not-allowed' }, repository)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('records only an owner-scoped preparation fingerprint, never source, secrets or fake deployment', async () => {
    const events: any[] = []; const s = spec()
    const repository = { findProject: async () => ({ id: 8, ownerUserId: 1, status: 'draft' }), findVersion: async () => ({ id: 12, ownerUserId: 1, projectId: 8, siteSpecSnapshot: s, versionFingerprint: 'a'.repeat(64) }), insertAuditEvent: async (event: any) => { events.push(event); return event } } as any
    await prepareCustomerRuntime(1, 8, { versionId: 12, engine: 'booking_blog', mode: 'preview' }, repository)
    expect(events[0]).toMatchObject({ authority: 'owner_session', action: 'customer_runtime_configuration_prepared', metadata: { deployed: false, paymentVerified: false } })
    expect(JSON.stringify(events)).not.toContain('品牌故事')
  })
})
