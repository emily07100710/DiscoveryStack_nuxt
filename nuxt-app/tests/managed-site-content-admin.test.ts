import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent, recordVerifiedPaymentEvent } from '../server/managed-sites/ordering-service'
import { convertPaidOrderToManagedProject } from '../server/managed-sites/conversion-service'
import { linkManagedSiteContentOperations } from '../server/managed-sites/modules-service'
import { createCalendarFromProductionPlan } from '../server/content-operations/service'
import { getManagedSiteContentAdminWorkspace, recordManagedContentReview, requestManagedContentRevision } from '../server/managed-sites/content-admin-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createInjectedManagedSiteCheckoutAuthorityResolver, createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const paymentVerifier: PaymentEventVerifier = { verify: async () => true }

async function makeLine() {
  const managed = createManagedSiteMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const content = new ContentOperationsFixture()
  const preview = await createManagedSitePreview(1, { draftIdentity: 'content-admin-preview-001', brandName: 'Content Admin Client', audience: 'B2B readers', brief: 'A governed content workspace.', businessGoals: ['increase_inquiries', 'improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'], styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'business', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'content-admin-quote-001' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Content Admin Owner', email: 'content-admin-owner@acme.taipei', company: 'Content Admin Client', website: 'https://content-admin.acme.taipei', privacyConsent: true, recontactConsent: false, idempotencyKey: 'content-admin-lead-001' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'content-admin-order-001' }, ordering.repository)
  await recordVerifiedPaymentEvent({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'content-admin-payment-001', providerReference: 'content-admin-payment-ref-001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'd'.repeat(64) }, paymentVerifier, ordering.repository, undefined, createInjectedManagedSiteCheckoutAuthorityResolver(1))
  const conversion = await convertPaidOrderToManagedProject(1, { draftOrderId: order.order.id, idempotencyKey: 'content-admin-conversion-001' }, { ordering: ordering.repository, managed: managed.repository })
  const linked = await linkManagedSiteContentOperations(1, conversion.project.id, { displayName: 'Content Admin Client', canonicalSiteOrigin: 'https://content-admin.acme.taipei', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: 'content-admin-client-001' }, managed.repository, content.repository)
  content.addPlan(1, 1)
  const calendar = await createCalendarFromProductionPlan(1, { clientId: linked.client.id, productionPlanId: 11, planStartDate: '2026-01-01', planEndDate: '2026-12-31', publishLocalTime: '09:00', cadenceDays: 7, monthlyBudgetUnits: 100, defaultCostUnits: 10, maxItemsPerCalendarMonth: 10, maximumTotalItems: 12, catchUpPolicy: 'skip_missed', idempotencyKey: 'content-admin-calendar-001' }, content.repository)
  return { managed, content, project: conversion.project, entryId: calendar.entries[0]!.id }
}

describe('managed Content Admin boundary', () => {
  it('projects only the linked canonical Content Operations client and exposes fixed role capabilities', async () => {
    const line = await makeLine()
    const analyst = await getManagedSiteContentAdminWorkspace(1, line.project.id, 'analyst', line.managed.repository, line.content.repository)
    const editor = await getManagedSiteContentAdminWorkspace(1, line.project.id, 'editor', line.managed.repository, line.content.repository)
    const reviewer = await getManagedSiteContentAdminWorkspace(1, line.project.id, 'reviewer', line.managed.repository, line.content.repository)
    const owner = await getManagedSiteContentAdminWorkspace(1, line.project.id, 'owner', line.managed.repository, line.content.repository)
    expect(analyst.clients).toHaveLength(1)
    expect(analyst.entries).toHaveLength(1)
    expect(analyst.capabilities).toMatchObject({ canRead: true, canRequestRevision: false, canReview: false, canExport: false })
    expect(editor.capabilities).toMatchObject({ canRequestRevision: true, canReview: false })
    expect(reviewer.capabilities).toMatchObject({ canRequestRevision: false, canReview: true })
    expect(owner.capabilities).toMatchObject({ canRequestRevision: true, canReview: true, canExport: true })
    expect(editor.capabilities.canonicalEngine).toBe('existing-content-operations-only')
  })

  it('allows editor revision request, keeps it idempotent, and denies analyst/reviewer writes', async () => {
    const line = await makeLine()
    const input = { request: '請補充服務範圍與可核對限制。', idempotencyKey: 'content-revision-001' }
    const first = await requestManagedContentRevision(1, line.project.id, line.entryId, 'editor', input, line.managed.repository, line.content.repository)
    const replay = await requestManagedContentRevision(1, line.project.id, line.entryId, 'editor', input, line.managed.repository, line.content.repository)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(line.content.events.filter(event => event.eventType === 'managed_content_revision_requested')).toHaveLength(1)
    await expect(requestManagedContentRevision(1, line.project.id, line.entryId, 'editor', { ...input, request: '改寫成未經 evidence 支持的保證性文案。' }, line.managed.repository, line.content.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(requestManagedContentRevision(1, line.project.id, line.entryId, 'analyst', input, line.managed.repository, line.content.repository)).rejects.toMatchObject({ statusCode: 403 })
    await expect(requestManagedContentRevision(1, line.project.id, line.entryId, 'reviewer', input, line.managed.repository, line.content.repository)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('allows reviewer risk/review intent, denies editor review, and never fabricates canonical review or risk rows', async () => {
    const line = await makeLine()
    const result = await recordManagedContentReview(1, line.project.id, line.entryId, 'reviewer', { decision: 'changes_requested', riskGateStatus: 'needs_human_review', note: '需要 owner 依 approved evidence 補充內容。', idempotencyKey: 'content-review-001' }, line.managed.repository, line.content.repository)
    expect(result.replayed).toBe(false)
    expect(result.writesToProvider).toBe(false)
    expect(result.limitation).toContain('canonical publication')
    expect(line.content.events.find(event => event.eventType === 'managed_content_review_recorded')).toBeTruthy()
    expect(line.content.reviews).toHaveLength(0)
    expect(line.content.generated.size).toBe(0)
    await expect(recordManagedContentReview(1, line.project.id, line.entryId, 'editor', { decision: 'reviewed', riskGateStatus: 'passed', note: 'not allowed', idempotencyKey: 'content-review-editor-001' }, line.managed.repository, line.content.repository)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('fails closed when the Content Admin capability is not selected in the active SiteSpec', async () => {
    const line = await makeLine()
    const version = line.managed.state.versions.find(item => item.projectId === line.project.id)!
    const spec = version.siteSpecSnapshot as Record<string, unknown>
    spec.selectedModules = ['geo_content_subscription']
    await expect(getManagedSiteContentAdminWorkspace(1, line.project.id, 'editor', line.managed.repository, line.content.repository)).rejects.toMatchObject({ statusCode: 422 })
  })
})
