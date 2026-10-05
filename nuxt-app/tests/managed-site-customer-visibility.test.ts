import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent, recordVerifiedPaymentEvent } from '../server/managed-sites/ordering-service'
import { convertPaidOrderToManagedProject } from '../server/managed-sites/conversion-service'
import { linkManagedSiteContentOperations } from '../server/managed-sites/modules-service'
import { getManagedSiteCustomerVisibilityDashboard } from '../server/managed-sites/customer-visibility-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createInjectedManagedSiteCheckoutAuthorityResolver, createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const paymentVerifier: PaymentEventVerifier = { verify: async () => true }

async function paidSite() {
  const managed = createManagedSiteMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const content = new ContentOperationsFixture()
  const preview = await createManagedSitePreview(1, { draftIdentity: 'customer-visibility-preview-001', brandName: 'Visibility Client', audience: 'Readers', brief: 'An evidence-led site.', businessGoals: ['improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['geo_measurement_dashboard', 'geo_content_subscription'], styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo_autopost', cadenceDays: 7, domainOption: 'new', domainTld: 'com', idempotencyKey: 'customer-visibility-quote-001' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Visibility Owner', email: 'owner@visibility.taipei', company: 'Visibility Client', website: 'https://visibility.taipei', privacyConsent: true, recontactConsent: false, idempotencyKey: 'customer-visibility-lead-001' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'customer-visibility-order-001' }, ordering.repository)
  await recordVerifiedPaymentEvent({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'customer-visibility-payment-001', providerReference: 'customer-visibility-payment-ref-001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'd'.repeat(64) }, paymentVerifier, ordering.repository, undefined, createInjectedManagedSiteCheckoutAuthorityResolver(1))
  const conversion = await convertPaidOrderToManagedProject(1, { draftOrderId: order.order.id, idempotencyKey: 'customer-visibility-conversion-001' }, { ordering: ordering.repository, managed: managed.repository })
  await linkManagedSiteContentOperations(1, conversion.project.id, { displayName: 'Visibility Client', canonicalSiteOrigin: 'https://visibility.taipei', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: 'customer-visibility-client-001' }, managed.repository, content.repository)
  return { managed, content, projectId: conversion.project.id }
}

const summary = {
  project: { canonicalDomain: 'visibility.taipei', status: 'active' },
  queries: [{ id: 5, promptText: '附近值得信任的品牌', active: true }],
  metrics: { current: { status: 'ready', totalQueries: 1, observedQueries: 1, n: 1, brandMentionRate: 1, citationRate: 1, exactCitationRate: 1, limitations: [] }, period: { currentStart: '2026-09-05', currentEnd: '2026-10-05' } },
  recentObservations: [
    { queryId: 5, provider: 'chatgpt', observationMode: 'manual_verified', observedAt: new Date('2026-10-01'), brandMentioned: true, citationUrls: ['https://visibility.taipei/services', 'https://unrelated.taipei/page'], boundedExcerpt: 'private owner note' },
    { queryId: 5, provider: 'gemini', observationMode: 'manual_verified', observedAt: new Date('2026-08-30'), brandMentioned: false, citationUrls: [], boundedExcerpt: 'older observation' },
  ],
} as any

describe('managed-site customer citation dashboard', () => {
  it('returns only the paid site’s exact domain and approved observations without owner notes or unrelated citations', async () => {
    const site = await paidSite()
    const reader = { listProjects: async (owner: number, domain: string) => { expect(owner).toBe(1); expect(domain).toBe('visibility.taipei'); return [{ id: 9, canonicalDomain: domain }] }, getSummary: async (owner: number, id: number) => { expect([owner, id]).toEqual([1, 9]); return summary } } as any
    const result = await getManagedSiteCustomerVisibilityDashboard(1, site.projectId, site.managed.repository, site.content.repository, reader)
    expect(result).toMatchObject({ status: 'ready', domain: 'visibility.taipei', sampleCount: 1, exactCitationRate: 1 })
    expect(result).toHaveProperty('observations')
    expect(JSON.stringify(result)).toContain('https://visibility.taipei/services')
    expect(JSON.stringify(result)).not.toContain('unrelated.taipei')
    expect(JSON.stringify(result)).not.toContain('private owner note')
    expect(JSON.stringify(result)).not.toContain('older observation')
    if (!('observations' in result)) throw new Error('Expected a scoped visibility report.')
    expect(result.observations).toHaveLength(1)
  })

  it('fails closed for a different owner, duplicate domain projects, or mismatched summary', async () => {
    const site = await paidSite()
    const reader = { listProjects: async () => [{ id: 9, canonicalDomain: 'visibility.taipei' }, { id: 10, canonicalDomain: 'visibility.taipei' }], getSummary: async () => summary } as any
    await expect(getManagedSiteCustomerVisibilityDashboard(2, site.projectId, site.managed.repository, site.content.repository, reader)).rejects.toMatchObject({ statusCode: 404 })
    await expect(getManagedSiteCustomerVisibilityDashboard(1, site.projectId, site.managed.repository, site.content.repository, reader)).rejects.toMatchObject({ statusCode: 409 })
    reader.listProjects = async () => [{ id: 9, canonicalDomain: 'visibility.taipei' }]
    reader.getSummary = async () => ({ ...summary, project: { canonicalDomain: 'other.taipei', status: 'active' } })
    await expect(getManagedSiteCustomerVisibilityDashboard(1, site.projectId, site.managed.repository, site.content.repository, reader)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('shows not configured before an owner creates observation data for the linked site', async () => {
    const site = await paidSite()
    const reader = { listProjects: async () => [], getSummary: async () => { throw new Error('must not read unrelated data') } } as any
    const result = await getManagedSiteCustomerVisibilityDashboard(1, site.projectId, site.managed.repository, site.content.repository, reader)
    expect(result).toMatchObject({ status: 'not_configured' })
  })
})
