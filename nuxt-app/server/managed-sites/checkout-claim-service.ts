import { createError } from 'h3'
import { tokenHash } from './normalization'
import { getPreviewRepository } from './ordering-repository'
import type { ManagedSiteCheckoutClaimInput, ManagedSiteCheckoutClaimResult, PreviewRepository } from './ordering-types'

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function positiveId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(`${label} is invalid.`)
  return value
}

function assertFiniteDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(`${label} is invalid.`)
  return value
}

function assertPreviewAccess(accessToken: string, accessTokenHash: string) {
  if (tokenHash(accessToken) !== accessTokenHash) {
    throw createError({ statusCode: 404, statusMessage: 'Managed site checkout lineage was not found.' })
  }
}

type CheckoutPreview = NonNullable<Awaited<ReturnType<PreviewRepository['findPreviewById']>>>
type CheckoutQuote = NonNullable<Awaited<ReturnType<PreviewRepository['findQuoteById']>>>
type CheckoutLeadIntent = NonNullable<Awaited<ReturnType<PreviewRepository['findLeadIntentById']>>>
type CheckoutDraftOrder = NonNullable<Awaited<ReturnType<PreviewRepository['findDraftOrderById']>>>
type CheckoutSubscriptionIntent = NonNullable<Awaited<ReturnType<PreviewRepository['findSubscriptionIntentByQuote']>>>

function assertLineage(input: ManagedSiteCheckoutClaimInput, preview: CheckoutPreview, quote: CheckoutQuote, leadIntent: CheckoutLeadIntent, draftOrder: CheckoutDraftOrder, subscriptionIntent: CheckoutSubscriptionIntent) {
  if (quote.previewId !== preview.id || leadIntent.previewId !== preview.id || leadIntent.quoteId !== quote.id || draftOrder.previewId !== preview.id || draftOrder.quoteId !== quote.id || draftOrder.leadId !== leadIntent.leadId || subscriptionIntent.quoteId !== quote.id || input.previewId !== preview.id || input.quoteId !== quote.id || input.leadIntentId !== leadIntent.id || input.draftOrderId !== draftOrder.id) {
    conflict('Checkout claim identifiers do not describe one exact persisted lineage.')
  }
}

function assertClaimableStatus(preview: { status: string; expiresAt: Date }, quote: { status: string; expiresAt: Date }, draftOrder: { status: string }, now: Date) {
  if (preview.status === 'expired' || preview.expiresAt.getTime() <= now.getTime()) throw createError({ statusCode: 410, statusMessage: 'This preview has expired and cannot be claimed.' })
  if (!['draft', 'generated', 'saved'].includes(preview.status)) conflict('This preview is no longer claimable.')
  if (quote.status !== 'quoted' || quote.expiresAt.getTime() <= now.getTime()) throw createError({ statusCode: 410, statusMessage: 'This quote has expired and cannot be claimed.' })
  if (draftOrder.status !== 'payment_pending') conflict('This draft order is not awaiting checkout claim.')
}

export async function claimManagedSiteCheckout(ownerUserId: number, input: unknown, repository: PreviewRepository = getPreviewRepository(), clock: () => Date = () => new Date()): Promise<ManagedSiteCheckoutClaimResult> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) throw createError({ statusCode: 401, statusMessage: 'A valid owner session is required for checkout claim.' })
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Checkout claim input is invalid.')
  const candidate = input as Record<string, unknown>
  const previewId = positiveId(candidate.previewId, 'Preview id')
  const quoteId = positiveId(candidate.quoteId, 'Quote id')
  const leadIntentId = positiveId(candidate.leadIntentId, 'Lead intent id')
  const draftOrderId = positiveId(candidate.draftOrderId, 'Draft order id')
  if (typeof candidate.previewAccessToken !== 'string' || candidate.previewAccessToken.length < 32 || candidate.previewAccessToken.length > 256) invalid('Preview access token is invalid.')
  const previewAccessToken = candidate.previewAccessToken
  const claimedAt = assertFiniteDate(clock(), 'Checkout claim time')

  return repository.transaction(async transaction => {
    // Every claim for this lineage shares the preview row. A locking read makes it
    // the serialization point so two owners cannot both observe an unclaimed
    // snapshot and then overwrite one another under MySQL transaction isolation.
    const preview = await transaction.findPreviewByIdForUpdate(previewId)
    const quote = await transaction.findQuoteById(quoteId)
    const leadIntent = await transaction.findLeadIntentById(leadIntentId)
    const draftOrder = await transaction.findDraftOrderById(draftOrderId)
    const subscriptionIntent = await transaction.findSubscriptionIntentByQuote(quoteId)
    if (!preview || !quote || !leadIntent || !draftOrder || !subscriptionIntent) conflict('Checkout claim lineage is incomplete.')
    assertPreviewAccess(previewAccessToken, preview.accessTokenHash)
    assertLineage({ previewId, previewAccessToken, quoteId, leadIntentId, draftOrderId }, preview, quote, leadIntent, draftOrder, subscriptionIntent)
    assertClaimableStatus(preview, quote, draftOrder, claimedAt)

    const owners = [preview.ownerUserId, quote.ownerUserId, leadIntent.ownerUserId, draftOrder.ownerUserId, subscriptionIntent.ownerUserId]
    if (owners.some(owner => owner !== null && owner !== ownerUserId)) conflict('Checkout lineage is already bound to a different owner.')
    const replayed = owners.every(owner => owner === ownerUserId)
    if (replayed) return { ownerUserId, previewId, quoteId, leadIntentId, draftOrderId, subscriptionQuoteId: subscriptionIntent.quoteId, replayed: true, claimedAt }

    const boundPreview = await transaction.updatePreview(preview.id, { ownerUserId, updatedAt: claimedAt } as any)
    const boundQuote = await transaction.updateQuote(quote.id, { ownerUserId, updatedAt: claimedAt } as any)
    const boundLeadIntent = await transaction.updateLeadIntent(leadIntent.id, { ownerUserId } as any)
    const boundDraftOrder = await transaction.updateDraftOrder(draftOrder.id, { ownerUserId, updatedAt: claimedAt } as any)
    const boundSubscriptionIntent = await transaction.updateSubscriptionIntent(subscriptionIntent.quoteId, { ownerUserId, updatedAt: claimedAt } as any)
    if (!boundPreview || !boundQuote || !boundLeadIntent || !boundDraftOrder || !boundSubscriptionIntent) conflict('Checkout lineage could not be atomically claimed.')
    return { ownerUserId, previewId, quoteId, leadIntentId, draftOrderId, subscriptionQuoteId: boundSubscriptionIntent.quoteId, replayed: false, claimedAt }
  })
}
