import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent } from '../server/managed-sites/ordering-service'
import type { ExistingSiteDiagnosisResolver } from '../server/managed-sites/diagnosis-binding'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import { processManagedSitePaymentAndConversion } from '../server/managed-sites/conversion-service'
import { createManagedSiteDomainIntent, createManagedSiteProvisioningPlan, executeManagedSiteProvisioningPlan } from '../server/managed-sites/provisioning-service'
import { acceptManagedSiteInvitation, inviteManagedSiteMember, getManagedSiteCustomerSession, setManagedSiteSubscriptionStatus } from '../server/managed-sites/service'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createInjectedManagedSiteCheckoutAuthorityResolver, createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createProvisioningMemoryRepository } from './fixtures/managed-site/provisioning-repository'

const paymentVerifier: PaymentEventVerifier = { verify: async () => true }
const ownerActor = (ownerUserId: number) => ({ ownerUserId, actorUserId: ownerUserId, authority: 'owner_session' as const, role: 'owner' as const, principal: `owner-${ownerUserId}@acme.taipei` })

async function createPaidPreview(ownerUserId: number, draftIdentity: string, existingSiteUrl?: string, diagnosisId?: number, resolver?: ExistingSiteDiagnosisResolver) {
  const ordering = createOrderingMemoryRepository()
  const managed = createManagedSiteMemoryRepository()
  const fixtureNow = new Date()
  const brief = { draftIdentity, brandName: existingSiteUrl ? 'Existing Site Client' : 'New Site Client', audience: 'Taiwan service buyers', brief: 'A governed managed site with evidence-bound GEO content.', businessGoals: ['increase_inquiries', 'improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'bounded_ai_assistant', 'geo_content_subscription', 'geo_measurement_dashboard'], styleReferences: [], ...(existingSiteUrl ? { existingSiteUrl, diagnosisId, diagnosisFindingIds: ['missing-answer'] } : {}) }
  const preview = await createManagedSitePreview(ownerUserId, brief, ordering.repository, () => fixtureNow, resolver)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: existingSiteUrl ? 'existing' : 'new', idempotencyKey: `${draftIdentity}-quote` }, ordering.repository, () => fixtureNow)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Managed Owner', email: `${draftIdentity}@acme.taipei`, company: 'Managed Client', privacyConsent: true, recontactConsent: false, idempotencyKey: `${draftIdentity}-lead` }, ordering.repository, () => fixtureNow)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: `${draftIdentity}-order` }, ordering.repository, () => fixtureNow)
  const conversion = await processManagedSitePaymentAndConversion({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: `${draftIdentity}-payment`, providerReference: `${draftIdentity}-payment-ref`, eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'e'.repeat(64), idempotencyKey: `${draftIdentity}-conversion` }, paymentVerifier, { ordering: ordering.repository, managed: managed.repository }, createInjectedManagedSiteCheckoutAuthorityResolver(ownerUserId))
  return { ordering, managed, preview, quote, order: conversion.order, conversion }
}

describe('managed-site application acceptance', () => {
  it('takes an existing site through server-owned diagnosis binding, quote, verified payment, and automatic conversion', async () => {
    const resolverCalls: Array<{ ownerUserId: number; url: string; diagnosisId: number }> = []
    const resolver: ExistingSiteDiagnosisResolver = { resolve: async (ownerUserId, input) => { resolverCalls.push({ ownerUserId, url: input.existingSiteUrl, diagnosisId: input.diagnosisId }); return { diagnosisId: input.diagnosisId, normalizedSiteUrl: input.existingSiteUrl, findings: [{ id: 'missing-answer', issueCode: 'content.answer_readiness', area: 'answer_content', severity: 'medium', priority: 'medium', title: 'Answer structure', explanation: 'Add a direct answer section.', affectedUrls: ['https://existing.acme.taipei/'], evidence: [], recommendationKey: 'add_answer_content', engine: 'deterministic-diagnosis-v1', limitations: ['single-site synthetic diagnosis'] }], limitations: ['single-site synthetic diagnosis'], engine: 'deterministic-diagnosis-v1', evidenceSnapshot: { refs: [{ sourceId: 77, artifactId: 88, locator: 'https://existing.acme.taipei/about', artifactHash: 'a'.repeat(64), approvedAt: '2026-08-01T00:00:00.000Z', reason: 'approved synthetic evidence' }], context: 'approved synthetic evidence', hash: 'a'.repeat(64), materials: [{ sourceId: 77, artifactId: 88, artifactType: 'html', artifactHash: 'a'.repeat(64), reviewedText: 'Approved synthetic service facts.' }], approvalTimestamps: ['2026-08-01T00:00:00.000Z'], freshnessBasis: '2026-08-01T00:00:00.000Z' } } } }
    const line = await createPaidPreview(7, 'existing-application-001', 'https://existing.acme.taipei', 42, resolver)
    expect(resolverCalls).toEqual([{ ownerUserId: 7, url: 'https://existing.acme.taipei/', diagnosisId: 42 }])
    expect(line.preview.preview.sourceMode).toBe('existing_site')
    expect(line.preview.spec.diagnosisBinding).toEqual({ diagnosisId: 42, findingIds: ['missing-answer'] })
    expect(line.preview.spec.contentProvenance.evidenceSnapshotHash).toBe('a'.repeat(64))
    expect(line.order.status).toBe('payment_verified')
    expect(line.conversion.project.status).toBe('active')
    expect(line.conversion.version.lifecycleStatus).toBe('active')
    expect(line.conversion.subscription.status).toBe('active')
    expect(line.conversion.order.projectId).toBe(line.conversion.project.id)
  })

  it('terminates without deletion, revokes sessions, and blocks all subsequent domain/provisioning work', async () => {
    const line = await createPaidPreview(1, 'cancel-application-001')
    const invitation = await inviteManagedSiteMember(1, line.conversion.project.id, ownerActor(1), { email: 'cancel-editor@acme.taipei', role: 'editor', idempotencyKey: 'cancel-editor-invite' }, line.managed.repository)
    const accepted = await acceptManagedSiteInvitation(invitation.invitationToken!, line.managed.repository)
    expect(await getManagedSiteCustomerSession(accepted.sessionToken, line.managed.repository)).not.toBeNull()
    const provisioning = createProvisioningMemoryRepository()
    const domain = await createManagedSiteDomainIntent(1, { projectId: line.conversion.project.id, draftOrderId: line.order.id, mode: 'new_registration', requestedDomain: 'cancel-application.acme.taipei', providerKey: 'registrar-neutral', idempotencyKey: 'cancel-domain-001' }, provisioning.repository, line.managed.repository)
    const plan = await createManagedSiteProvisioningPlan(1, { projectId: line.conversion.project.id, versionId: line.conversion.version.id, domainIntentId: domain.intent.id, platform: 'vercel', deploymentMode: 'preview_only', idempotencyKey: 'cancel-plan-001' }, provisioning.repository, line.managed.repository)
    const terminated = await setManagedSiteSubscriptionStatus(1, line.conversion.project.id, ownerActor(1), 'terminated', line.managed.repository)
    expect(terminated.subscription.status).toBe('terminated')
    expect(line.managed.state.projects.find(project => project.id === line.conversion.project.id)?.status).toBe('suspended')
    expect(await getManagedSiteCustomerSession(accepted.sessionToken, line.managed.repository)).toBeNull()
    expect(line.managed.state.projects).toHaveLength(1)
    expect(line.managed.state.versions).toHaveLength(1)
    expect(provisioning.state.plans).toHaveLength(1)
    await expect(createManagedSiteDomainIntent(1, { projectId: line.conversion.project.id, draftOrderId: line.order.id, mode: 'new_registration', requestedDomain: 'new-after-cancel.acme.taipei', providerKey: 'registrar-neutral', idempotencyKey: 'cancel-domain-002' }, provisioning.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(createManagedSiteProvisioningPlan(1, { projectId: line.conversion.project.id, versionId: line.conversion.version.id, domainIntentId: domain.intent.id, platform: 'vercel', deploymentMode: 'preview_only', idempotencyKey: 'cancel-plan-002' }, provisioning.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(executeManagedSiteProvisioningPlan(1, plan.plan.id, 'dry_run', undefined, provisioning.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 409 })
  })
})
