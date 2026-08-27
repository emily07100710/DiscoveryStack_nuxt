import { createHash, randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { isAllowedBailianEndpoint } from '../../geo/autogeo-bailian-qwen'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { stableFingerprint } from '../../seo-geo-core/repository'
import type { ManagedSiteProviderVerificationReceipt } from './provider-registry'
import type { ManagedSiteConnectorCapability, ManagedSiteCredentialResolver } from './types'

export type ManagedSiteProviderVerifier = (input: { capability: ManagedSiteConnectorCapability; providerKey: string; configurationFingerprint: string; transportConfiguration: Record<string, unknown>; credentialReference: string; resolveCredential: ManagedSiteCredentialResolver; fetchImpl?: typeof fetch; clock: () => Date }) => Promise<ManagedSiteProviderVerificationReceipt>
export type ManagedSiteProviderVerifierRegistry = ReadonlyMap<string, ReadonlyMap<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>>

function unsupported(message = 'unsupported_provider_adapter'): never { throw createError({ statusCode: 422, statusMessage: message }) }

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
  const keys = ['schemaVersion', 'challengeHash', 'providerAccountId', 'providerEventId', 'observedAt', 'payloadHash', 'exactResponseIdentity']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.schemaVersion !== 'managed-site-provider-verification-v1' || value.challengeHash !== challengeHash || typeof value.providerAccountId !== 'string' || typeof value.providerEventId !== 'string' || typeof value.exactResponseIdentity !== 'string' || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.payloadHash)) throw createError({ statusCode: 409, statusMessage: 'Provider verification challenge response identity is mismatched.' })
  const expectedPayloadHash = stableFingerprint({ challengeHash, providerAccountId: value.providerAccountId, providerEventId: value.providerEventId, observedAt: value.observedAt, configurationFingerprint: input.configurationFingerprint })
  if (value.payloadHash !== expectedPayloadHash) throw createError({ statusCode: 409, statusMessage: 'Provider verification payload hash is mismatched.' })
  return { capability: input.capability, providerKey: input.providerKey, configurationFingerprint: input.configurationFingerprint, providerAccountId: value.providerAccountId, providerEventId: value.providerEventId, payloadHash: value.payloadHash, exactResponseIdentity: value.exactResponseIdentity, observedAt: value.observedAt }
}

const unsupportedVerifier: ManagedSiteProviderVerifier = async () => unsupported()

export const MANAGED_SITE_PROVIDER_VERIFIERS: ManagedSiteProviderVerifierRegistry = new Map([
  ['bailian-qwen', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['website_generator', async input => {
    const endpoint = typeof input.transportConfiguration.endpointOrigin === 'string' ? input.transportConfiguration.endpointOrigin : ''
    assertCanonicalBailianManagedSiteEndpoint(endpoint)
    const credential = await input.resolveCredential(input.credentialReference)
    if (!credential.ok) throw createError({ statusCode: 409, statusMessage: 'Provider credential reference is unresolved.' })
    return unsupported('unsupported_provider_adapter: Bailian has no approved zero-business-side-effect account verification endpoint; configuration remains configured.')
  }]])],
  ['internal-deployment-bearer-v1', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['deployment', internalDeploymentVerifier]])],
  ['internal_hmac_v1', new Map<ManagedSiteConnectorCapability, ManagedSiteProviderVerifier>([['payment', unsupportedVerifier]])],
])

export function resolveManagedSiteProviderVerifier(providerKey: string, capability: ManagedSiteConnectorCapability, registry: ManagedSiteProviderVerifierRegistry = MANAGED_SITE_PROVIDER_VERIFIERS): ManagedSiteProviderVerifier {
  const verifier = registry.get(providerKey)?.get(capability)
  if (!verifier) unsupported()
  return verifier
}
