import { getHeader, readRawBody, setResponseHeaders } from 'h3'
import { createInternalHmacV1PaymentWebhookAdapter } from '../../../managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../../../managed-sites/live-connectors/payment-webhook'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const providerKey = String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY || '')
  const credentialReference = String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF || '')
  if (providerKey !== 'internal_hmac_v1' || !credentialReference) throw createError({ statusCode: 503, statusMessage: 'Only the exact internal_hmac_v1 payment webhook adapter is registered; vendor adapters remain unsupported.' })
  const raw = await readRawBody(event, false)
  const signatureHeader = String(getHeader(event, 'x-discoverystack-provider-signature') || '')
  const result = await processManagedSiteRawPaymentWebhook({ rawBody: raw || new Uint8Array(), signatureHeader, credentialReference, executionMode: 'live' }, createInternalHmacV1PaymentWebhookAdapter('internal_hmac_v1'))
  return { accepted: true, replayed: result.replayed, effective: result.effective }
})
