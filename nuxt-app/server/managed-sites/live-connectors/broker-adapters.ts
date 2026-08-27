import { createError } from 'h3'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { assertExactManagedSiteProviderObject, createManagedSiteHmacBrokerTransport } from './hmac-broker-transport'
import type { ManagedSiteCheckoutSessionAdapter, ManagedSiteCredentialResolver, ManagedSiteDnsTlsAdapter, ManagedSiteDomainAdapter, ManagedSiteExistingSiteOwnershipAdapter } from './types'

type BrokerOptions = { endpointOrigin: string; providerKey: string; credentialReference: string; resolveCredential: ManagedSiteCredentialResolver; fetchImpl?: typeof fetch; clock?: () => Date }
const opaque = (value: unknown, max = 160): value is string => typeof value === 'string' && value.length >= 3 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
function mismatch(): never { throw createError({ statusCode: 409, statusMessage: 'Provider response does not match the exact managed-site request identity.' }) }

export function createInternalHmacV1CheckoutAdapter(options: BrokerOptions): ManagedSiteCheckoutSessionAdapter {
  if (options.providerKey !== 'internal_hmac_v1') throw createError({ statusCode: 503, statusMessage: 'Unsupported payment provider adapter.' })
  const transport = createManagedSiteHmacBrokerTransport(options)
  return { async createSession(input) {
    const response = await transport.post('/v1/managed-sites/checkout-sessions', { schemaVersion: 'managed-site-checkout-request-v1', providerKey: options.providerKey, ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, previewId: input.previewId, quoteId: input.quoteId, draftOrderId: input.draftOrderId, approvalFingerprint: input.approvalFingerprint, commerceSnapshot: { amountMinor: input.amountMinor, currency: input.currency, planKey: input.planKey, cadenceDays: input.cadenceDays, domainOption: input.domainOption, lineSnapshot: input.lineSnapshot, taxStatus: input.taxStatus, snapshotFingerprint: input.snapshotFingerprint }, idempotencyKey: input.idempotencyKey }, { timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey })
    const keys = ['schemaVersion', 'providerKey', 'providerEventId', 'providerReference', 'checkoutUrl', 'ownerUserId', 'projectId', 'releaseId', 'previewId', 'quoteId', 'draftOrderId', 'approvalFingerprint', 'amountMinor', 'currency', 'snapshotFingerprint', 'requestPayloadHash'] as const
    assertExactManagedSiteProviderObject(response.body, keys)
    const b = response.body
    if (b.schemaVersion !== 'managed-site-checkout-response-v1' || b.providerKey !== options.providerKey || b.providerEventId !== response.providerRequestId || !opaque(b.providerEventId) || !opaque(b.providerReference) || b.ownerUserId !== input.ownerUserId || b.projectId !== input.projectId || b.releaseId !== input.releaseId || b.previewId !== input.previewId || b.quoteId !== input.quoteId || b.draftOrderId !== input.draftOrderId || b.approvalFingerprint !== input.approvalFingerprint || b.amountMinor !== input.amountMinor || b.currency !== input.currency || b.snapshotFingerprint !== input.snapshotFingerprint || !sha(b.requestPayloadHash) || b.requestPayloadHash !== stableFingerprint({ ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, previewId: input.previewId, quoteId: input.quoteId, draftOrderId: input.draftOrderId, approvalFingerprint: input.approvalFingerprint, snapshotFingerprint: input.snapshotFingerprint, idempotencyKey: input.idempotencyKey }) || typeof b.checkoutUrl !== 'string') mismatch()
    return { providerKey: options.providerKey, providerEventId: b.providerEventId, providerReference: b.providerReference, checkoutUrl: assertPublicHttpsUrl(b.checkoutUrl, 'Checkout URL'), draftOrderId: input.draftOrderId, amountMinor: input.amountMinor, currency: input.currency, snapshotFingerprint: input.snapshotFingerprint, exactResponseIdentity: response.exactResponseIdentity }
  } }
}

export function createInternalDomainBrokerHmacV1Adapter(options: BrokerOptions): ManagedSiteDomainAdapter {
  if (options.providerKey !== 'internal-domain-broker-hmac-v1') throw createError({ statusCode: 503, statusMessage: 'Unsupported domain provider adapter.' })
  const transport = createManagedSiteHmacBrokerTransport(options)
  return {
    async quote(input) {
      const response = await transport.post('/v1/managed-sites/domain/quote', { schemaVersion: 'managed-site-domain-quote-request-v1', providerKey: options.providerKey, ...input })
      const keys = ['schemaVersion', 'providerKey', 'providerEventId', 'quoteId', 'ownerUserId', 'projectId', 'releaseId', 'canonicalDomain', 'amountMinor', 'currency', 'expiresAt', 'requestFingerprint'] as const; assertExactManagedSiteProviderObject(response.body, keys); const b = response.body
      if (b.schemaVersion !== 'managed-site-domain-quote-response-v1' || b.providerKey !== options.providerKey || b.providerEventId !== response.providerRequestId || !opaque(b.quoteId) || b.ownerUserId !== input.ownerUserId || b.projectId !== input.projectId || b.releaseId !== input.releaseId || b.canonicalDomain !== input.canonicalDomain || !Number.isSafeInteger(b.amountMinor) || Number(b.amountMinor) < 0 || typeof b.currency !== 'string' || !/^[A-Z]{3}$/u.test(b.currency) || typeof b.expiresAt !== 'string' || !Number.isFinite(Date.parse(b.expiresAt)) || b.requestFingerprint !== input.requestFingerprint) mismatch()
      return { providerKey: options.providerKey, quoteId: b.quoteId, canonicalDomain: input.canonicalDomain, amountMinor: Number(b.amountMinor), currency: b.currency, expiresAt: b.expiresAt, exactResponseIdentity: response.exactResponseIdentity }
    },
    async createPurchaseIntent(input) {
      const response = await transport.post('/v1/managed-sites/domain/purchase', { schemaVersion: 'managed-site-domain-purchase-request-v1', providerKey: options.providerKey, ...input, quote: { ...input.quote } }, { timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey })
      const keys = ['schemaVersion', 'providerKey', 'providerEventId', 'providerReference', 'ownerUserId', 'projectId', 'releaseId', 'draftOrderId', 'canonicalDomain', 'status', 'commerceSnapshotFingerprint', 'paymentReceiptFingerprint'] as const; assertExactManagedSiteProviderObject(response.body, keys); const b = response.body
      if (b.schemaVersion !== 'managed-site-domain-purchase-response-v1' || b.providerKey !== options.providerKey || b.providerEventId !== response.providerRequestId || !opaque(b.providerReference) || b.ownerUserId !== input.ownerUserId || b.projectId !== input.projectId || b.releaseId !== input.releaseId || b.draftOrderId !== input.draftOrderId || b.canonicalDomain !== input.quote.canonicalDomain || !['purchase_intent_created', 'registered'].includes(String(b.status)) || b.commerceSnapshotFingerprint !== input.commerceSnapshotFingerprint || b.paymentReceiptFingerprint !== input.paymentReceiptFingerprint) mismatch()
      return { providerKey: options.providerKey, providerEventId: String(b.providerEventId), providerReference: b.providerReference, canonicalDomain: input.quote.canonicalDomain, status: b.status as 'purchase_intent_created' | 'registered', exactResponseIdentity: response.exactResponseIdentity }
    },
  }
}

export function createInternalDnsTlsBrokerHmacV1Adapter(options: BrokerOptions): ManagedSiteDnsTlsAdapter {
  if (options.providerKey !== 'internal-dns-tls-broker-hmac-v1') throw createError({ statusCode: 503, statusMessage: 'Unsupported DNS/TLS provider adapter.' })
  const transport = createManagedSiteHmacBrokerTransport(options)
  return { async configureAndVerify(input) {
    const response = await transport.post('/v1/managed-sites/dns-tls/apply', { schemaVersion: 'managed-site-dns-tls-request-v1', providerKey: options.providerKey, ...input }, { timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey }); const b = response.body
    const keys = ['schemaVersion', 'providerKey', 'providerEventId', 'providerReference', 'ownerUserId', 'projectId', 'releaseId', 'canonicalDomain', 'contentHash', 'requestFingerprint', 'dnsStatus', 'tlsStatus'] as const; assertExactManagedSiteProviderObject(b, keys)
    if (b.schemaVersion !== 'managed-site-dns-tls-response-v1' || b.providerKey !== options.providerKey || b.providerEventId !== response.providerRequestId || !opaque(b.providerReference) || b.ownerUserId !== input.ownerUserId || b.projectId !== input.projectId || b.releaseId !== input.releaseId || b.canonicalDomain !== input.canonicalDomain || b.contentHash !== input.contentHash || b.requestFingerprint !== input.requestFingerprint || !['propagation_pending', 'verified', 'partial_failure'].includes(String(b.dnsStatus)) || !['pending', 'verified', 'failed'].includes(String(b.tlsStatus))) mismatch()
    return { providerKey: options.providerKey, providerEventId: String(b.providerEventId), providerReference: b.providerReference, canonicalDomain: input.canonicalDomain, dnsStatus: b.dnsStatus as any, tlsStatus: b.tlsStatus as any, exactResponseIdentity: response.exactResponseIdentity }
  } }
}

export function createInternalOwnershipBrokerHmacV1Adapter(options: BrokerOptions): ManagedSiteExistingSiteOwnershipAdapter {
  if (options.providerKey !== 'internal-dns-tls-broker-hmac-v1') throw createError({ statusCode: 503, statusMessage: 'Unsupported ownership provider adapter.' })
  const transport = createManagedSiteHmacBrokerTransport(options)
  return {
    async createChallenge(input) {
      const response = await transport.post('/v1/managed-sites/ownership/challenge', { schemaVersion: 'managed-site-ownership-challenge-request-v1', providerKey: options.providerKey, ...input }, { timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey }); const b = response.body
      const keys = ['schemaVersion', 'providerKey', 'providerEventId', 'ownerUserId', 'projectId', 'releaseId', 'canonicalDomain', 'verificationMethod', 'requestFingerprint', 'challengeReference'] as const; assertExactManagedSiteProviderObject(b, keys)
      if (b.schemaVersion !== 'managed-site-ownership-challenge-response-v1' || b.providerKey !== options.providerKey || b.providerEventId !== response.providerRequestId || b.ownerUserId !== input.ownerUserId || b.projectId !== input.projectId || b.releaseId !== input.releaseId || b.canonicalDomain !== input.canonicalDomain || b.verificationMethod !== input.verificationMethod || b.requestFingerprint !== input.requestFingerprint || !opaque(b.challengeReference)) mismatch()
      return { providerKey: options.providerKey, providerEventId: String(b.providerEventId), challengeReference: b.challengeReference, canonicalDomain: input.canonicalDomain, projectId: input.projectId, verificationMethod: input.verificationMethod, exactResponseIdentity: response.exactResponseIdentity }
    },
    async verify(input) {
      const response = await transport.post('/v1/managed-sites/ownership/verify', { schemaVersion: 'managed-site-ownership-verify-request-v1', providerKey: options.providerKey, ...input }); const b = response.body
      const keys = ['schemaVersion', 'providerKey', 'providerEventId', 'providerReference', 'projectId', 'canonicalDomain', 'challengeReference', 'requestFingerprint', 'verificationMethod', 'evidenceHash', 'status'] as const; assertExactManagedSiteProviderObject(b, keys)
      if (b.schemaVersion !== 'managed-site-ownership-verify-response-v1' || b.providerKey !== options.providerKey || b.providerEventId !== response.providerRequestId || !opaque(b.providerReference) || b.projectId !== input.projectId || b.canonicalDomain !== input.canonicalDomain || b.challengeReference !== input.challengeReference || b.requestFingerprint !== input.requestFingerprint || !['dns_txt', 'well_known_file', 'provider_account'].includes(String(b.verificationMethod)) || !sha(b.evidenceHash) || !['verified', 'pending', 'failed'].includes(String(b.status))) mismatch()
      return { providerKey: options.providerKey, providerEventId: String(b.providerEventId), providerReference: b.providerReference, canonicalDomain: input.canonicalDomain, projectId: input.projectId, verificationMethod: b.verificationMethod as any, evidenceHash: b.evidenceHash, status: b.status as any, exactResponseIdentity: response.exactResponseIdentity }
    },
  }
}
