import { getHeader, getMethod, getRequestURL, setResponseHeaders } from 'h3'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getManagedSiteOrders } from '../../../managed-sites/live-connectors/orders'
import { managedSiteOwnerContext, managedSitePaymentWebhookContextForTests, readBoundedManagedSitePaymentWebhookBody, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../managed-sites/live-connectors/http'
import { reconcileManagedSiteStripePayment } from '../../../managed-sites/live-connectors/payment-reconciliation'
import { processManagedSiteRawPaymentWebhook } from '../../../managed-sites/live-connectors/payment-webhook'
import { createStripePaymentWebhookAdapter, stripeWebhookIgnoredReason } from '../../../managed-sites/live-connectors/stripe-adapters'
import { parsePathId } from '../../../managed-sites/normalization'
import { requireOwner } from '../../../utils/auth'

const paymentsPrefix = '/api/managed-sites/payments'
const privateHeaders = { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' }

export default defineEventHandler(async event => {
  setResponseHeaders(event, privateHeaders)

  const pathname = getRequestURL(event).pathname
  if (!pathname.startsWith(paymentsPrefix)) throw createError({ statusCode: 404, statusMessage: 'Managed-site payments route was not found.' })
  const segments = pathname.slice(paymentsPrefix.length).split('/').filter(Boolean)
  const subPath = `/${segments.join('/')}`
  const method = getMethod(event)

  if (segments.length === 2 && subPath === '/stripe/webhook') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site payments route method is not allowed.' })
    setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
    const injected = managedSitePaymentWebhookContextForTests()
    const providerKey = injected?.paymentWebhookAdapter ? 'stripe' : String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY || '')
    const credentialReference = injected?.paymentWebhookCredentialReference || String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF || '')
    if (providerKey !== 'stripe' || !credentialReference || injected && (!injected.paymentWebhookAdapter || !injected.paymentWebhookJointTransaction || !injected.credentialResolver)) throw createError({ statusCode: 503, statusMessage: 'The exact Stripe payment webhook adapter is not configured.' })
    const raw = await readBoundedManagedSitePaymentWebhookBody(event)
    const signatureHeader = String(getHeader(event, 'stripe-signature') || '')
    if (signatureHeader.length < 1 || signatureHeader.length > 1024) throw createError({ statusCode: 400, statusMessage: 'Stripe webhook signature or payload is invalid.' })
    const adapter = injected?.paymentWebhookAdapter || createStripePaymentWebhookAdapter()
    const executionMode = injected?.paymentWebhookExecutionMode || 'live'
    try {
      const result = await processManagedSiteRawPaymentWebhook({ rawBody: raw || new Uint8Array(), signatureHeader, credentialReference, executionMode }, adapter, injected ? { jointTransaction: injected.paymentWebhookJointTransaction, credentialResolver: injected.credentialResolver, clock: injected.paymentWebhookClock } : undefined)
      return { accepted: true, replayed: result.replayed, effective: result.effective }
    } catch (error) {
      const ignored = stripeWebhookIgnoredReason(error)
      if (ignored) return { accepted: true, ignored }
      throw error
    }
  }

  if (segments.length === 1 && subPath === '/orders') {
    if (method !== 'GET') throw createError({ statusCode: 405, statusMessage: 'Managed-site payments route method is not allowed.' })
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    setResponseHeaders(event, privateHeaders)
    return getManagedSiteOrders(ownerUserId)
  }

  // POST /projects/:projectId/releases/:releaseId/reconcile
  if (segments.length === 5 && segments[0] === 'projects' && segments[2] === 'releases' && segments[4] === 'reconcile') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site payments route method is not allowed.' })
    const { ownerUserId, repository, orderingRepository, credentialResolver, fetchImpl, paymentWebhookJointTransaction, paymentWebhookClock } = await managedSiteOwnerContext(event)
    const projectId = parsePathId(segments[1], 'Managed-site project id'); const releaseId = parsePathId(segments[3], 'Managed-site release id')
    await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
    const body = await strictManagedSiteBody(event, ['idempotencyKey'])
    return reconcileManagedSiteStripePayment(ownerUserId, { projectId, releaseId, idempotencyKey: String(body.idempotencyKey || '') }, { repository, orderingRepository, credentialResolver, fetchImpl, jointTransaction: paymentWebhookJointTransaction, clock: paymentWebhookClock })
  }

  throw createError({ statusCode: 404, statusMessage: 'Managed-site payments route was not found.' })
})
