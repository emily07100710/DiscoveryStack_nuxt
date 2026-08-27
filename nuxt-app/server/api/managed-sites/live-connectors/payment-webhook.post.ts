import { getHeader, readRawBody, setResponseHeader } from 'h3'
import { createHmacRawBodyPaymentWebhookAdapter } from '../../../managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../../../managed-sites/live-connectors/payment-webhook'

export default defineEventHandler(async event => {
  const providerKey = String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY || '')
  const credentialReference = String(process.env.DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF || '')
  if (!providerKey || !credentialReference) throw createError({ statusCode: 503, statusMessage: 'Managed-site payment webhook transport is not configured.' })
  const raw = await readRawBody(event, false)
  const signatureHeader = String(getHeader(event, 'x-discoverystack-provider-signature') || '')
  const result = await processManagedSiteRawPaymentWebhook({ rawBody: raw || new Uint8Array(), signatureHeader, credentialReference, executionMode: 'live' }, createHmacRawBodyPaymentWebhookAdapter(providerKey))
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { accepted: true, replayed: result.replayed, effective: result.effective }
})
