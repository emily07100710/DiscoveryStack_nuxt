import { createError } from 'h3'
import { getDatabase } from '../database'
import { stableFingerprint } from '../seo-geo-core/repository'
import { makeOrderingRepository } from './ordering-repository'
import { makeManagedSiteRepository } from './repository'
import { createManagedSiteProject, createManagedSiteVersion } from './service'
import { parseSiteSpecSnapshot, type SiteSpec } from './site-spec'
import { createManagedSiteCheckoutAuthorityResolver, FAIL_CLOSED_PAYMENT_EVENT_VERIFIER, recordVerifiedPaymentEvent } from './ordering-service'
import type { ManagedSiteDraftOrder, ManagedSiteProject, ManagedSiteSubscription, ManagedSiteVersion } from '../database/schema'
import type { ManagedSiteActor, ManagedSiteRepository } from './types'
import type { ManagedSiteCheckoutAuthorityResolver, OrderConversionInput, PaymentEventVerifier, PreviewRepository } from './ordering-types'

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function fail(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function ensureOwner(ownerUserId: number): number {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) invalid('A server-owned customer identity is required before order conversion.')
  return ownerUserId
}

function ensureIdempotency(value: string): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 128) invalid('Order conversion idempotency key is invalid.')
  return value.trim()
}

export type ManagedSiteOrderConversionResult = {
  order: ManagedSiteDraftOrder
  project: ManagedSiteProject
  version: ManagedSiteVersion
  subscription: ManagedSiteSubscription
  replayed: boolean
  saga: 'payment_verified_then_conversion'
}

export type ConversionRepositories = {
  ordering: PreviewRepository
  managed: ManagedSiteRepository
}

function nonNested<T extends { transaction: (work: (repository: T) => Promise<unknown>) => Promise<unknown> }>(repository: T): T {
  return { ...repository, transaction: async (work: (repository: T) => Promise<unknown>) => work(repository) } as T
}

async function convertPaidOrderWithinRepositories(ownerUserId: number, input: OrderConversionInput, repositories: ConversionRepositories, clock: () => Date): Promise<ManagedSiteOrderConversionResult> {
  const orderId = input.draftOrderId
  if (!Number.isSafeInteger(orderId) || orderId < 1) invalid('Draft order id is invalid.')
  const conversionKey = ensureIdempotency(input.idempotencyKey)
  const order = await repositories.ordering.findDraftOrderById(orderId)
  if (!order || order.ownerUserId !== ownerUserId) throw createError({ statusCode: 404, statusMessage: 'Paid draft order was not found.' })
  const preview = await repositories.ordering.findPreviewById(order.previewId)
  const quote = await repositories.ordering.findQuoteById(order.quoteId)
  const lead = await repositories.ordering.findLeadById(order.leadId)
  const subscriptionIntent = await repositories.ordering.findSubscriptionIntentByQuote(order.quoteId)
  if (!preview || !quote || !lead || !subscriptionIntent) fail('Paid order lineage is incomplete and cannot be converted.')
  if (order.ownerUserId !== preview.ownerUserId || quote.ownerUserId !== ownerUserId || quote.previewId !== preview.id || subscriptionIntent.ownerUserId !== ownerUserId || subscriptionIntent.quoteId !== quote.id) fail('Paid order lineage does not match its preview, quote, lead, and entitlement.')
  if (order.status !== 'payment_verified' && !order.projectId) fail('Only a server-verified paid order can be converted.')
  if (order.projectId) {
    if (input.expectedProjectId !== undefined && input.expectedProjectId !== order.projectId) fail('Order conversion project lineage does not match the existing project.')
    const existingProject = await repositories.managed.findProject(ownerUserId, order.projectId)
    const existingVersions = existingProject ? await repositories.managed.listVersions(ownerUserId, existingProject.id) : []
    const existingSubscription = existingProject ? await repositories.managed.findSubscription(ownerUserId, existingProject.id) : null
    const activeVersion = existingProject && existingProject.activeVersionId ? existingVersions.find(version => version.id === existingProject.activeVersionId) : null
    if (!existingProject || !activeVersion || !existingSubscription) fail('Paid order conversion is partially linked and requires a safe retry.')
    return { order, project: existingProject, version: activeVersion, subscription: existingSubscription, replayed: true, saga: 'payment_verified_then_conversion' }
  }
  if (quote.status !== 'locked' || subscriptionIntent.status !== 'entitled' || !order.paymentIntentReference) fail('Paid order has not completed the server-owned entitlement transition.')
  const spec: SiteSpec = parseSiteSpecSnapshot(preview.siteSpecSnapshot)
  const projectKey = `order-conversion:${order.id}`
  const canonicalClientIdentity = lead.company.trim()
  const canonicalWebsiteIdentity = lead.website?.trim() || `managed-site://preview/${preview.id}`
  const actor: ManagedSiteActor = { ownerUserId, actorUserId: null, authority: 'system_workflow', role: 'owner', principal: `payment-order:${order.id}` }
  const managedScoped = nonNested(repositories.managed)
  const createdProject = await createManagedSiteProject(ownerUserId, actor, { canonicalClientIdentity, canonicalWebsiteIdentity, siteType: spec.siteType, idempotencyKey: projectKey }, managedScoped)
  const project = await repositories.managed.findProject(ownerUserId, createdProject.project.id)
  if (!project) fail('Managed project was not available after conversion.')
  const existingVersions = await repositories.managed.listVersions(ownerUserId, project.id)
  const existingActive = project.activeVersionId ? existingVersions.find(version => version.id === project.activeVersionId) : null
  let version = existingActive
  if (!version) {
    const versionResult = await createManagedSiteVersion(ownerUserId, project.id, actor, {
      siteSpecSnapshot: spec,
      designTokenSnapshot: spec.designTokens,
      selectedModuleSnapshot: spec.selectedModules,
      contentFingerprint: stableFingerprint({ specFingerprint: spec.deterministicFingerprint, quoteId: quote.id, conversionKey }),
      createdByAuthority: 'verified_payment_order_conversion',
      lifecycleStatus: 'active',
    }, managedScoped)
    version = versionResult.version
  }
  if (!version) fail('Managed project version could not be established.')
  const nowDate = clock()
  if (!(nowDate instanceof Date) || !Number.isFinite(nowDate.getTime())) invalid('Conversion clock is invalid.')
  const termEndsAt = new Date(nowDate)
  termEndsAt.setUTCMonth(termEndsAt.getUTCMonth() + 12)
  const existingSubscription = await repositories.managed.findSubscription(ownerUserId, project.id)
  const subscription = existingSubscription || await repositories.managed.insertSubscription({ ownerUserId, projectId: project.id, planKey: quote.planKey, status: 'active', subscriptionReference: `verified-payment:${order.id}`, gracePeriodEndsAt: null, termEndsAt, idempotencyKey: `subscription-conversion:${order.id}`, stateFingerprint: stableFingerprint({ projectId: project.id, quoteId: quote.id, orderId: order.id, status: 'active' }) } as any)
  await repositories.managed.updateProject(ownerUserId, project.id, { status: 'active', activeVersionId: version.id, updatedAt: nowDate } as any)
  await repositories.ordering.updateDraftOrder(order.id, { projectId: project.id, updatedAt: nowDate } as any)
  await repositories.ordering.updateQuote(quote.id, { projectId: project.id, updatedAt: nowDate } as any)
  await repositories.ordering.updateSubscriptionIntent(quote.id, { projectId: project.id, updatedAt: nowDate } as any)
  await repositories.ordering.updatePreview(preview.id, { status: 'converted', updatedAt: nowDate } as any)
  const finalOrder = await repositories.ordering.findDraftOrderById(order.id)
  const finalProject = await repositories.managed.findProject(ownerUserId, project.id)
  const finalVersion = await repositories.managed.findVersion(ownerUserId, version.id)
  const finalSubscription = await repositories.managed.findSubscription(ownerUserId, project.id)
  if (!finalOrder || !finalProject || !finalVersion || !finalSubscription) fail('Managed order conversion could not be reloaded.')
  return { order: finalOrder, project: finalProject, version: finalVersion, subscription: finalSubscription, replayed: createdProject.replayed || Boolean(existingActive), saga: 'payment_verified_then_conversion' }
}

export async function convertPaidOrderToManagedProject(ownerUserId: number, input: OrderConversionInput, repositories?: ConversionRepositories, clock: () => Date = () => new Date()): Promise<ManagedSiteOrderConversionResult> {
  ensureOwner(ownerUserId)
  if (repositories) return repositories.ordering.transaction(async transaction => convertPaidOrderWithinRepositories(ownerUserId, input, { ordering: transaction, managed: repositories.managed }, clock)) as Promise<ManagedSiteOrderConversionResult>
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed site conversion is temporarily unavailable.' })
  return database.transaction(async (transaction: any) => convertPaidOrderWithinRepositories(ownerUserId, input, { ordering: makeOrderingRepository(transaction), managed: makeManagedSiteRepository(transaction) }, clock))
}

export type ManagedSitePaymentConversionResult = ManagedSiteOrderConversionResult & {
  paymentEvent: Awaited<ReturnType<typeof recordVerifiedPaymentEvent>>['paymentEvent']
  authority: Awaited<ReturnType<typeof recordVerifiedPaymentEvent>>['authority']
  paymentReplayed: boolean
  conversionReplayed: boolean
}

export async function processManagedSitePaymentAndConversion(
  input: unknown,
  verifier: PaymentEventVerifier = FAIL_CLOSED_PAYMENT_EVENT_VERIFIER,
  repositories?: ConversionRepositories,
  authorityResolver?: ManagedSiteCheckoutAuthorityResolver,
  clock: () => Date = () => new Date(),
): Promise<ManagedSitePaymentConversionResult> {
  const ordering = repositories?.ordering
  const payment = await recordVerifiedPaymentEvent(input, verifier, ordering, clock, authorityResolver || createManagedSiteCheckoutAuthorityResolver())
  const ownerUserId = payment.authority.ownerUserId
  const paymentKey = input && typeof input === 'object' && !Array.isArray(input) ? String((input as Record<string, unknown>).idempotencyKey || `${payment.paymentEvent.providerKey}:${payment.paymentEvent.eventId}`) : `${payment.paymentEvent.providerKey}:${payment.paymentEvent.eventId}`
  const conversionIdempotencyKey = `payment-conversion:${payment.order.id}:${paymentKey}`.slice(0, 128)
  const conversion = await convertPaidOrderToManagedProject(ownerUserId, { draftOrderId: payment.order.id, idempotencyKey: conversionIdempotencyKey }, repositories, clock)
  return { ...conversion, paymentEvent: payment.paymentEvent, authority: payment.authority, paymentReplayed: payment.replayed, conversionReplayed: conversion.replayed }
}
