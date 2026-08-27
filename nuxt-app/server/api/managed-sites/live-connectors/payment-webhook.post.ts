import { getHeader, readRawBody, setResponseHeaders } from 'h3'
import { createInternalHmacV1PaymentWebhookAdapter } from '../../../managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../../../managed-sites/live-connectors/payment-webhook'
import { managedSitePaymentWebhookContextForTests } from '../../../managed-sites/live-connectors/http'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const injected = managedSitePaymentWebhookContextForTests()
  const providerKey = injected?.paymentWebhookAdapter ? 'test-injected' : String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY || '')
  const credentialReference = injected?.paymentWebhookCredentialReference || String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF || '')
  if ((!injected && providerKey !== 'internal_hmac_v1') || !credentialReference || injected && (!injected.paymentWebhookAdapter || !injected.paymentWebhookJointTransaction || !injected.credentialResolver)) throw createError({ statusCode: 503, statusMessage: 'Only the exact internal_hmac_v1 payment webhook adapter is registered; vendor adapters remain unsupported.' })
  const raw = await readRawBody(event, false)
  const signatureHeader = String(getHeader(event, 'x-discoverystack-provider-signature') || '')
  const adapter = injected?.paymentWebhookAdapter || createInternalHmacV1PaymentWebhookAdapter('internal_hmac_v1')
  const executionMode = injected?.paymentWebhookExecutionMode || 'live'
  const result = await processManagedSiteRawPaymentWebhook({ rawBody: raw || new Uint8Array(), signatureHeader, credentialReference, executionMode }, adapter, injected ? { jointTransaction: injected.paymentWebhookJointTransaction, credentialResolver: injected.credentialResolver } : undefined)
  return { accepted: true, replayed: result.replayed, effective: result.effective }
})
