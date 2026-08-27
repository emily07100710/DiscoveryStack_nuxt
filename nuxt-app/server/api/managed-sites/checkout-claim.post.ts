import { readBody, setResponseHeader } from 'h3'
import { claimManagedSiteCheckout } from '../../managed-sites/checkout-claim-service'
import { getPreviewRepository } from '../../managed-sites/ordering-repository'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { requireOwner } from '../../utils/auth'
import { managedSiteOwnerContext } from '../../managed-sites/live-connectors/http'

const ALLOWED_FIELDS = new Set(['previewId', 'previewAccessToken', 'quoteId', 'leadIntentId', 'draftOrderId'])

export default defineEventHandler(async (event) => {
  const injected = process.env.NODE_ENV === 'test' ? await managedSiteOwnerContext(event) : null
  const owner = injected ? { openId: '' } : await requireOwner(event)
  const ownerUserId = injected ? injected.ownerUserId : await getOwnerDatabaseUserId(owner.openId)
  const orderingRepository = injected?.orderingRepository || getPreviewRepository()
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !ALLOWED_FIELDS.has(key))) {
    throw createError({ statusCode: 422, statusMessage: 'Checkout claim input is invalid.' })
  }
  const result = await claimManagedSiteCheckout(ownerUserId, body, orderingRepository)
  setResponseHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  return {
    ownerUserId: result.ownerUserId,
    previewId: result.previewId,
    quoteId: result.quoteId,
    leadIntentId: result.leadIntentId,
    draftOrderId: result.draftOrderId,
    replayed: result.replayed,
    claimedAt: result.claimedAt,
    externalCalls: false,
  }
})
