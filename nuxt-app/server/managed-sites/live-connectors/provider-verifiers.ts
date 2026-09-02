import { createHash, randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { isAllowedBailianEndpoint } from '../../geo/autogeo-bailian-qwen'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { stableFingerprint } from '../../seo-geo-core/repository'
import type { ManagedSiteProviderVerificationReceipt } from './provider-registry'
import type { ManagedSiteConnectorCapability, ManagedSiteCredentialResolver } from './types'
import { assertExactManagedSiteProviderObject, createManagedSiteHmacBrokerTransport, readBoundedManagedSiteResponse } from './hmac-broker-transport'

export type ManagedSiteProviderVerifier = (input: { capability: ManagedSiteConnectorCapability; providerKey: string; configurationFingerprint: string; transportConfiguration: Record<string, unknown>; credentialReference: string; resolveCredential: ManagedSiteCredentialResolver; fetchImpl?: typeof fetch; clock: () => Date }) => Promise<ManagedSiteProviderVerificationReceipt>
export type ManagedSiteProviderVerifierRegistry = ReadonlyMap<string, ReadonlyMap<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>>

export function managedSiteAllowedProviderOrigins(raw = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS): Set<string> {
  const origins = new Set<string>()
  for (const item of String(raw || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const normalized = assertPublicHttpsUrl(item, 'Managed-site allowed provider origin')
    const parsed = new URL(normalized)
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw createError({ statusCode: 503, statusMessage: 'Managed-site provider allowlist must contain exact HTTPS origins only.' })
    origins.add(parsed.origin)
  }
  return origins
}

export function assertAllowedManagedSiteProviderOrigin(value: string, raw?: string): string {
  const normalized = assertPublicHttpsUrl(value, 'Managed-site provider endpoint')
  const parsed = new URL(normalized)
  if (parsed.search || parsed.hash || parsed.username || parsed.password) throw createError({ statusCode: 503, statusMessage: 'Managed-site provider endpoint cannot contain query credentials or fragments.' })
  const allowlist = managedSiteAllowedProviderOrigins(raw)
  if (!allowlist.has(parsed.origin)) throw createError({ statusCode: 503, statusMessage: 'Managed-site provider origin is not in the server-only exact allowlist.' })
  return parsed.origin
}

export function assertCanonicalBailianManagedSiteEndpoint(value: string): string {
  if (!isAllowedBailianEndpoint(value)) throw createError({ statusCode: 503, statusMessage: 'Bailian endpoint is outside the canonical official allowlist.' })
  return value
}

const internalDeploymentVerifier: ManagedSiteProviderVerifier = async input => {
  const endpointOrigin = typeof input.transportConfiguration.endpointOrigin === 'string' ? input.transportConfiguration.endpointOrigin : ''
  const origin = assertAllowedManagedSiteProviderOrigin(endpointOrigin)
  const credential = await input.resolveCredential(input.credentialReference)
  if (!credential.ok) throw createError({ statusCode: 409, statusMessage: 'Provider credential reference is unresolved.' })
  const challenge = randomBytes(32).toString('hex')
  const challengeHash = createHash('sha256').update(challenge).digest('hex')
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000)
  let response: Response
  try { response = await (input.fetchImpl || fetch)(`${origin}/v1/managed-sites/verify`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.value}` }, body: JSON.stringify({ schemaVersion: 'managed-site-provider-verification-v1', challenge, configurationFingerprint: input.configurationFingerprint }) }) } catch { throw createError({ statusCode: 409, statusMessage: 'Provider verification transport failed.' }) } finally { clearTimeout(timer) }
  if (!response.ok) throw createError({ statusCode: 409, statusMessage: 'Provider verification was rejected.' })
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > 16_000) throw createError({ statusCode: 409, statusMessage: 'Provider verification response is oversized.' })
  let value: any
  try { value = JSON.parse(raw) } catch { throw createError({ statusCode: 409, statusMessage: 'Provider verification response is malformed.' }) }
  const keys = ['schemaVersion', 'challengeHash', 'capabilityIdentity', 'providerEventId', 'observedAt', 'payloadHash', 'exactResponseIdentity']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.schemaVersion !== 'managed-site-provider-verification-v1' || value.challengeHash !== challengeHash || typeof value.capabilityIdentity !== 'string' || typeof value.providerEventId !== 'string' || typeof value.exactResponseIdentity !== 'string' || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.payloadHash)) throw createError({ statusCode: 409, statusMessage: 'Provider verification challenge response identity is mismatched.' })
  const expectedPayloadHash = stableFingerprint({ challengeHash, capabilityIdentity: value.capabilityIdentity, providerEventId: value.providerEventId, observedAt: value.observedAt, configurationFingerprint: input.configurationFingerprint })
  if (value.payloadHash !== expectedPayloadHash) throw createError({ statusCode: 409, statusMessage: 'Provider verification payload hash is mismatched.' })
  return { capability: input.capability, providerKey: input.providerKey, configurationFingerprint: input.configurationFingerprint, capabilityIdentity: value.capabilityIdentity, providerEventId: value.providerEventId, payloadHash: value.payloadHash, exactResponseIdentity: value.exactResponseIdentity, observedAt: value.observedAt }
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u

/** Owner-triggered, bounded model-access probe. It never stores or returns generated text. */
const bailianCapabilityProbe: ManagedSiteProviderVerifier = async input => {
  const endpoint = typeof input.transportConfiguration.endpointOrigin === 'string' ? input.transportConfiguration.endpointOrigin : ''
  const model = typeof input.transportConfiguration.model === 'string' ? input.transportConfiguration.model : 'qwen-plus'
  assertCanonicalBailianManagedSiteEndpoint(endpoint)
  if (!MODEL_ID.test(model)) throw createError({ statusCode: 422, statusMessage: 'Bailian model identifier is invalid.' })
  const credential = await input.resolveCredential(input.credentialReference)
  if (!credential.ok) throw createError({ statusCode: 409, statusMessage: 'Provider credential reference is unresolved.' })
  const requestIdentity = `capability-probe-${randomBytes(12).toString('hex')}`
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000)
  let response: Response
  try {
    response = await (input.fetchImpl || fetch)(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.value}`, 'x-discoverystack-request-id': requestIdentity }, body: JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 4, messages: [{ role: 'user', content: 'Reply with OK. This is a credential capability probe with no customer data.' }] }) })
  } catch { throw createError({ statusCode: 409, statusMessage: controller.signal.aborted ? 'Bailian capability probe timed out.' : 'Bailian capability probe transport failed.' }) } finally { clearTimeout(timer) }
  if (!response.ok) throw createError({ statusCode: 409, statusMessage: 'Bailian capability probe was rejected.' })
  const raw = await readBoundedManagedSiteResponse(response, 16_000)
  let value: any
  try { value = JSON.parse(raw) } catch { throw createError({ statusCode: 409, statusMessage: 'Bailian capability probe response is malformed.' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw createError({ statusCode: 409, statusMessage: 'Bailian capability probe response is malformed.' })
  const keys = ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint']; const actualKeys = Object.keys(value)
  const choice = value.choices?.[0]; const message = choice?.message; const usage = value.usage
  if (actualKeys.length < 6 || actualKeys.length > 7 || actualKeys.some(key => !keys.includes(key)) || !['id', 'object', 'created', 'model', 'choices', 'usage'].every(key => Object.hasOwn(value, key)) || typeof value.id !== 'string' || !/^[A-Za-z0-9._:-]{3,160}$/u.test(value.id) || response.headers.get('x-request-id') !== value.id || value.object !== 'chat.completion' || !Number.isSafeInteger(value.created) || value.model !== model || !Array.isArray(value.choices) || value.choices.length !== 1 || !choice || typeof choice !== 'object' || Array.isArray(choice) || Object.keys(choice).length !== 3 || choice.index !== 0 || choice.finish_reason !== 'stop' || !message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 2 || message.role !== 'assistant' || typeof message.content !== 'string' || message.content.length > 128 || !usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).length !== 3 || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0) || usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) throw createError({ statusCode: 409, statusMessage: 'Bailian capability probe response identity is mismatched.' })
  const observedAt = input.clock().toISOString()
  const responseMetadata = { id: value.id, object: value.object, created: value.created, model: value.model, choiceCount: value.choices.length, finishReason: choice.finish_reason, usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } }
  const payloadHash = stableFingerprint({ configurationFingerprint: input.configurationFingerprint, requestIdentity, responseMetadata })
  return { capability: input.capability, providerKey: input.providerKey, configurationFingerprint: input.configurationFingerprint, capabilityIdentity: `model-access:${model}`, providerEventId: value.id, payloadHash, exactResponseIdentity: `bailian-probe:${stableFingerprint({ requestIdentity, payloadHash })}`, observedAt }
}

const hmacCapabilityVerifier: ManagedSiteProviderVerifier = async input => {
  const endpointOrigin = typeof input.transportConfiguration.endpointOrigin === 'string' ? input.transportConfiguration.endpointOrigin : ''
  const challenge = randomBytes(32).toString('hex'); const challengeHash = createHash('sha256').update(challenge).digest('hex')
  const transport = createManagedSiteHmacBrokerTransport({ endpointOrigin, providerKey: input.providerKey, credentialReference: input.credentialReference, resolveCredential: input.resolveCredential, fetchImpl: input.fetchImpl, clock: input.clock })
  const response = await transport.post('/v1/managed-sites/verify', { schemaVersion: 'managed-site-broker-verification-v1', capability: input.capability, providerKey: input.providerKey, configurationFingerprint: input.configurationFingerprint, challengeHash })
  const keys = ['schemaVersion', 'capability', 'providerKey', 'configurationFingerprint', 'challengeHash', 'capabilityIdentity', 'providerEventId', 'observedAt'] as const
  assertExactManagedSiteProviderObject(response.body, keys)
  if (response.body.schemaVersion !== 'managed-site-broker-verification-v1' || response.body.capability !== input.capability || response.body.providerKey !== input.providerKey || response.body.configurationFingerprint !== input.configurationFingerprint || response.body.challengeHash !== challengeHash || typeof response.body.capabilityIdentity !== 'string' || typeof response.body.providerEventId !== 'string' || response.body.providerEventId !== response.providerRequestId || response.body.observedAt !== response.observedAt) throw createError({ statusCode: 409, statusMessage: 'Provider broker verification identity is mismatched.' })
  return { capability: input.capability, providerKey: input.providerKey, configurationFingerprint: input.configurationFingerprint, capabilityIdentity: response.body.capabilityIdentity, providerEventId: response.providerRequestId, payloadHash: stableFingerprint({ configurationFingerprint: input.configurationFingerprint, bodyHash: response.bodyHash, providerRequestId: response.providerRequestId }), exactResponseIdentity: response.exactResponseIdentity, observedAt: response.observedAt }
}

/** Read-only Stripe credential/capability probe. It never creates or mutates a Stripe object. */
const stripeBalanceVerifier: ManagedSiteProviderVerifier = async input => {
  const endpointOrigin = typeof input.transportConfiguration.endpointOrigin === 'string' ? input.transportConfiguration.endpointOrigin : ''
  const origin = assertAllowedManagedSiteProviderOrigin(endpointOrigin)
  const credential = await input.resolveCredential(input.credentialReference)
  if (!credential.ok) throw createError({ statusCode: 409, statusMessage: 'Stripe credential reference is unresolved.' })
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000)
  let response: Response
  try { response = await (input.fetchImpl || fetch)(`${origin}/v1/balance`, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${credential.value}` } }) } catch { throw createError({ statusCode: 409, statusMessage: controller.signal.aborted ? 'Stripe balance verification timed out.' : 'Stripe balance verification transport failed.' }) } finally { clearTimeout(timer) }
  if (!response.ok) throw createError({ statusCode: 409, statusMessage: 'Stripe balance verification was rejected.' })
  const raw = await readBoundedManagedSiteResponse(response, 64 * 1024)
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw createError({ statusCode: 409, statusMessage: 'Stripe balance verification response is malformed.' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw createError({ statusCode: 409, statusMessage: 'Stripe balance verification response is malformed.' })
  const balance = value as Record<string, unknown>
  const validEntries = (entries: unknown) => Array.isArray(entries) && entries.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && Object.getPrototypeOf(entry) === Object.prototype && Number.isSafeInteger((entry as any).amount) && typeof (entry as any).currency === 'string' && /^[a-z]{3}$/u.test((entry as any).currency))
  const requestId = response.headers.get('request-id') || response.headers.get('stripe-request-id') || ''
  if (balance.object !== 'balance' || typeof balance.livemode !== 'boolean' || !validEntries(balance.available) || !validEntries(balance.pending) || !/^req_[A-Za-z0-9_]{3,156}$/u.test(requestId)) throw createError({ statusCode: 409, statusMessage: 'Stripe balance verification identity is incomplete or mismatched.' })
  const payloadHash = createHash('sha256').update(raw).digest('hex'); const observedAt = input.clock().toISOString()
  return { capability: input.capability, providerKey: input.providerKey, configurationFingerprint: input.configurationFingerprint, capabilityIdentity: `stripe-balance:${balance.livemode ? 'live' : 'test'}`, providerEventId: requestId, payloadHash, exactResponseIdentity: `stripe-verification:${stableFingerprint({ providerKey: input.providerKey, path: '/v1/balance', requestId, payloadHash })}`, observedAt }
}

export const MANAGED_SITE_PROVIDER_VERIFIERS: ManagedSiteProviderVerifierRegistry = new Map([
  ['bailian-qwen', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['website_generator', bailianCapabilityProbe]])],
  ['internal-deployment-bearer-v1', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['deployment', internalDeploymentVerifier]])],
  ['internal_hmac_v1', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['payment', hmacCapabilityVerifier]])],
  ['stripe', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['payment', stripeBalanceVerifier]])],
  ['internal-domain-broker-hmac-v1', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['domain_registration', hmacCapabilityVerifier]])],
  ['internal-dns-tls-broker-hmac-v1', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['dns_tls', hmacCapabilityVerifier]])],
])

export function resolveManagedSiteProviderVerifier(providerKey: string, capability: ManagedSiteConnectorCapability, registry: ManagedSiteProviderVerifierRegistry = MANAGED_SITE_PROVIDER_VERIFIERS): ManagedSiteProviderVerifier {
  const verifier = registry.get(providerKey)?.get(capability)
  if (!verifier) throw createError({ statusCode: 422, statusMessage: 'unsupported_provider_adapter' })
  return verifier
}
