import { getHeader, getMethod, getRequestURL, setResponseHeaders } from 'h3'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getManagedSiteOrders } from '../../../managed-sites/live-connectors/orders'
import { managedSiteOwnerContext, managedSitePaymentWebhookContextForTests, readBoundedManagedSitePaymentWebhookBody, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../managed-sites/live-connectors/http'
import { reconcileManagedSiteStripePayment } from '../../../managed-sites/live-connectors/payment-reconciliation'
import { processManagedSiteRawPaymentWebhook, productionManagedSiteJointTransaction } from '../../../managed-sites/live-connectors/payment-webhook'
import { createStripePaymentWebhookAdapter, stripeWebhookIgnoredReason } from '../../../managed-sites/live-connectors/stripe-adapters'
import { resolveManagedSiteManualModuleFulfilment } from '../../../managed-sites/funnel/module-fulfilment'
import { parsePathId } from '../../../managed-sites/normalization'
import { SITE_MODULES, type SiteModule } from '../../../managed-sites/site-spec'
import { suspendManagedSiteProject } from '../../../managed-sites/service'
import { getManagedSiteRepository } from '../../../managed-sites/repository'
import { isOpaqueReference } from '../../../first-party-publishing/normalization'
import { requireOwner } from '../../../utils/auth'

const paymentsPrefix = '/api/managed-sites/payments'
const privateHeaders = { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' }
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u

function managementBody(body: Record<string, unknown>, confirmation: 'service_delivered' | 'not_activated' | 'suspend_project') {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  const idempotencyKey = body.idempotencyKey
  if (reason.length < 8 || reason.length > 500 || controlCharacters.test(reason)) throw createError({ statusCode: 422, statusMessage: 'Managed-site management reason must be 8–500 characters without control characters.' })
  if (!isOpaqueReference(idempotencyKey, 128)) throw createError({ statusCode: 422, statusMessage: 'Managed-site management idempotency key is invalid.' })
  if (body.confirmation !== confirmation) throw createError({ statusCode: 422, statusMessage: 'Managed-site management confirmation does not match the requested operation.' })
  return { reason, idempotencyKey }
}

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

  // POST /orders/:orderId/modules/:moduleKey/(complete|cancel)
  if (segments.length === 5 && segments[0] === 'orders' && segments[2] === 'modules' && ['complete', 'cancel'].includes(segments[4] || '')) {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site payments route method is not allowed.' })
    const context = await managedSiteOwnerContext(event)
    const orderId = parsePathId(segments[1], 'Managed-site order id')
    const moduleKey = segments[3]
    if (!(SITE_MODULES as readonly string[]).includes(moduleKey || '')) throw createError({ statusCode: 422, statusMessage: 'Managed-site module key is invalid.' })
    const operation = segments[4] as 'complete' | 'cancel'
    const body = await strictManagedSiteBody(event, ['reason', 'idempotencyKey', 'confirmation'])
    const input = managementBody(body, operation === 'complete' ? 'service_delivered' : 'not_activated')
    const jointTransaction = context.paymentWebhookJointTransaction || (!context.orderingRepository && !context.managedRepository ? productionManagedSiteJointTransaction() : null)
    if (!jointTransaction) throw createError({ statusCode: 503, statusMessage: 'Managed-site management requires one genuine joint transaction boundary.' })
    return resolveManagedSiteManualModuleFulfilment(context.ownerUserId, orderId, moduleKey as SiteModule, operation === 'complete' ? 'manual_setup_completed' : 'cancelled', input, jointTransaction)
  }

  // POST /projects/:projectId/suspend
  if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'suspend') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site payments route method is not allowed.' })
    const context = await managedSiteOwnerContext(event)
    const projectId = parsePathId(segments[1], 'Managed-site project id')
    const body = await strictManagedSiteBody(event, ['reason', 'idempotencyKey', 'confirmation'])
    const input = managementBody(body, 'suspend_project')
    const managedRepository = context.managedRepository || (!context.orderingRepository ? getManagedSiteRepository() : null)
    if (!managedRepository) throw createError({ statusCode: 503, statusMessage: 'Managed-site project management repository is unavailable.' })
    return suspendManagedSiteProject(context.ownerUserId, projectId, { ownerUserId: context.ownerUserId, actorUserId: context.ownerUserId, authority: 'owner_session', role: 'owner' }, input, managedRepository)
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
