import { readBody, setResponseHeaders } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { configureManagedSiteProvider } from '../../../managed-sites/live-connectors/provider-registry'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const body = await readBody(event)
  const allowed = ['capability', 'providerKey', 'readinessStatus', 'credentialReference', 'transportConfiguration', 'idempotencyKey']
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw createError({ statusCode: 422, statusMessage: 'Provider configuration contains unknown fields.' })
  const result = await configureManagedSiteProvider(ownerUserId, body)
  return { capability: result.configuration.capability, providerKey: result.configuration.providerKey, status: result.configuration.readinessStatus, credentialReferenceConfigured: Boolean(result.configuration.credentialReference), verificationReceiptConfigured: Boolean(result.configuration.verificationReceiptFingerprint), verifiedAt: result.configuration.verifiedAt, replayed: result.replayed }
})
