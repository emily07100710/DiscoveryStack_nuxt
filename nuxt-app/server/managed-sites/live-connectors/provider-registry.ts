import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { getManagedSiteLiveConnectorRepository } from './repository'
import {
  MANAGED_SITE_CONNECTOR_CAPABILITIES,
  type ManagedSiteConnectorCapability,
  type ManagedSiteCredentialResolution,
  type ManagedSiteCredentialResolver,
  type ManagedSiteLiveConnectorRepository,
  type ManagedSiteProviderConfigurationInput,
  type ManagedSiteProviderReadiness,
  type ManagedSiteProviderReadinessItem,
} from './types'
import { MANAGED_SITE_PROVIDER_VERIFIERS, resolveManagedSiteProviderVerifier, type ManagedSiteProviderVerifierRegistry } from './provider-verifiers'
import { assertManagedSiteCheckoutOrigin } from './canonical'

const MAX_REGISTRY_BYTES = 64 * 1024
const MAX_CREDENTIAL_BYTES = 8 * 1024
const SENSITIVE_KEY = /(secret|token|password|authorization|api.?key|credential.?value)/iu
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const CREDENTIAL_REFERENCE = /^(?:vault|secret-ref|kms|envref):[A-Za-z0-9][A-Za-z0-9._:/-]{2,154}$/u
const TRANSPORT_CONFIGURATION_FIELDS = new Set(['endpointOrigin', 'model', 'checkoutOrigin'])

function isManagedSiteCredentialReference(value: unknown): value is string { return typeof value === 'string' && CREDENTIAL_REFERENCE.test(value) && !/(?:sk-[A-Za-z0-9]|bearer\s|-----BEGIN)/iu.test(value) }
function isManagedSiteProviderKey(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 96 && /^[a-z0-9][a-z0-9._-]*$/u.test(value) && !value.includes('..') }

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

function isCapability(value: unknown): value is ManagedSiteConnectorCapability {
  return typeof value === 'string' && (MANAGED_SITE_CONNECTOR_CAPABILITIES as readonly string[]).includes(value)
}

function safeTransportConfiguration(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid('Transport configuration must be a plain object.')
  const output: Record<string, string | number | boolean | null> = Object.create(null)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 24) invalid('Transport configuration has too many fields.')
  for (const [key, item] of entries) {
    if (!TRANSPORT_CONFIGURATION_FIELDS.has(key) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || SENSITIVE_KEY.test(key)) invalid('Transport configuration contains a forbidden or unsupported field.')
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') invalid('Transport configuration values must be bounded primitives.')
    if (typeof item === 'string' && (item.length > 2048 || CONTROL.test(item) || /(?:bearer\s+|-----BEGIN|sk-[A-Za-z0-9])/iu.test(item))) invalid('Transport configuration must not contain credential material.')
    if (typeof item === 'number' && !Number.isSafeInteger(item)) invalid('Transport configuration contains an invalid number.')
    output[key] = item
  }
  return output
}

type CredentialRegistry = Record<string, string>

function parseCredentialRegistry(raw: string | undefined): CredentialRegistry | null {
  if (typeof raw !== 'string' || raw.length < 2 || Buffer.byteLength(raw, 'utf8') > MAX_REGISTRY_BYTES) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))) return null
  const registry: CredentialRegistry = Object.create(null)
  for (const [reference, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isManagedSiteCredentialReference(reference) || typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES || CONTROL.test(value)) return null
    registry[reference] = value
  }
  return registry
}

/** Resolves an opaque reference from an injected server-only registry. Values never enter projections or logs. */
export function resolveManagedSiteCredential(credentialReference: string): ManagedSiteCredentialResolution {
  if (!isManagedSiteCredentialReference(credentialReference)) return { ok: false, reason: 'invalid_reference' }
  const registry = parseCredentialRegistry(process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON)
  if (!registry) return { ok: false, reason: 'registry_unavailable' }
  const value = registry[credentialReference]
  return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: 'missing_reference' }
}

export function parseManagedSiteCredentialRegistryForTests(raw: string | undefined): { ok: true; references: string[] } | { ok: false } {
  const registry = parseCredentialRegistry(raw)
  return registry ? { ok: true, references: Object.keys(registry).sort() } : { ok: false }
}

export async function configureManagedSiteProvider(
  ownerUserId: number,
  input: ManagedSiteProviderConfigurationInput,
  repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(),
  clock: () => Date = () => new Date(),
) {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) invalid('Owner identity is invalid.')
  if (!isCapability(input.capability)) invalid('Provider capability is invalid.')
  if (!isManagedSiteProviderKey(input.providerKey)) invalid('Provider key is invalid.')
  if (!['disabled', 'mock', 'configured'].includes(input.readinessStatus)) invalid('Provider readiness status cannot be caller-promoted to verified or blocked.')
  if (!isOpaqueReference(input.idempotencyKey, 128)) invalid('Provider configuration idempotency key is invalid.')
  const credentialReference = input.credentialReference == null || input.credentialReference === '' ? null : input.credentialReference
  if (credentialReference !== null && !isManagedSiteCredentialReference(credentialReference)) invalid('Credential reference must be an opaque server registry reference, not credential material.')
  if (input.readinessStatus === 'configured' && credentialReference === null) invalid('Configured providers require an opaque credential reference.')
  if (input.readinessStatus === 'mock' && process.env.NODE_ENV !== 'test') invalid('Mock provider configuration is restricted to the test runtime.')
  const transportConfiguration = safeTransportConfiguration(input.transportConfiguration)
  const hmacBroker = input.providerKey === 'internal_hmac_v1' && input.capability === 'payment'
    || input.providerKey === 'internal-domain-broker-hmac-v1' && input.capability === 'domain_registration'
    || input.providerKey === 'internal-dns-tls-broker-hmac-v1' && input.capability === 'dns_tls'
  const allowedTransportFields = input.providerKey === 'bailian-qwen' && input.capability === 'website_generator' ? new Set(['endpointOrigin', 'model']) : input.providerKey === 'internal_hmac_v1' && input.capability === 'payment' ? new Set(['endpointOrigin', 'checkoutOrigin']) : input.providerKey === 'internal-deployment-bearer-v1' && input.capability === 'deployment' || hmacBroker ? new Set(['endpointOrigin']) : new Set<string>()
  if (Object.keys(transportConfiguration).some(key => !allowedTransportFields.has(key))) invalid('Transport configuration is not allowlisted for this exact provider and capability.')
  if (input.providerKey === 'internal_hmac_v1' && input.capability === 'payment' && input.readinessStatus === 'configured') transportConfiguration.checkoutOrigin = assertManagedSiteCheckoutOrigin(transportConfiguration.checkoutOrigin)
  const configurationFingerprint = stableFingerprint({ capability: input.capability, providerKey: input.providerKey, readinessStatus: input.readinessStatus, credentialReference, transportConfiguration })
  const mockCapabilityIdentity = input.readinessStatus === 'mock' ? `mock-capability:${configurationFingerprint.slice(0, 48)}` : null
  const mockVerificationReceiptFingerprint = input.readinessStatus === 'mock' ? stableFingerprint({ authority: 'test-only-mock-provider-configuration', configurationFingerprint }) : null
  const existing = await repository.findProviderConfiguration(ownerUserId, input.capability)
  const sameFingerprint = await repository.findProviderConfigurationByFingerprint(ownerUserId, configurationFingerprint)
  if (sameFingerprint && sameFingerprint.capability !== input.capability) conflict('Provider configuration fingerprint collides with another capability.')
  const now = clock()
  if (existing) {
    if (existing.configurationFingerprint === configurationFingerprint) return { configuration: existing, replayed: true }
    const configuration = await repository.updateProviderConfiguration(ownerUserId, existing.id, {
      providerKey: input.providerKey,
      readinessStatus: input.readinessStatus,
      credentialReference,
      transportConfiguration,
      configurationFingerprint,
      verificationReceiptFingerprint: mockVerificationReceiptFingerprint,
      capabilityIdentity: mockCapabilityIdentity,
      blockedReasonCode: null,
      verifiedAt: null,
    })
    if (!configuration) conflict('Provider configuration changed concurrently.')
    return { configuration, replayed: false }
  }
  const configuration = await repository.insertProviderConfiguration({ ownerUserId, capability: input.capability, providerKey: input.providerKey, readinessStatus: input.readinessStatus, credentialReference, transportConfiguration, configurationFingerprint, verificationReceiptFingerprint: mockVerificationReceiptFingerprint, capabilityIdentity: mockCapabilityIdentity, blockedReasonCode: null, verifiedAt: null } as any)
  return { configuration, replayed: false, configuredAt: now.toISOString() }
}

export type ManagedSiteProviderVerificationReceipt = {
  capability: ManagedSiteConnectorCapability
  providerKey: string
  configurationFingerprint: string
  capabilityIdentity: string
  providerEventId: string
  payloadHash: string
  exactResponseIdentity: string
  observedAt: string
}

export async function verifyManagedSiteProviderConfiguration(
  ownerUserId: number,
  capability: ManagedSiteConnectorCapability,
  repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(),
  credentialResolver: ManagedSiteCredentialResolver = resolveManagedSiteCredential,
  clock: () => Date = () => new Date(),
  verifierRegistry: ManagedSiteProviderVerifierRegistry = MANAGED_SITE_PROVIDER_VERIFIERS,
  fetchImpl?: typeof fetch,
) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, capability)
  if (!configuration || configuration.readinessStatus !== 'configured' || !configuration.credentialReference) conflict('Provider must be configured before server verification.')
  const credential = await credentialResolver(configuration.credentialReference)
  if (!credential.ok) conflict('Provider credential reference could not be resolved; configuration remains configured.')
  const verifier = resolveManagedSiteProviderVerifier(configuration.providerKey, capability, verifierRegistry)
  let receipt: ManagedSiteProviderVerificationReceipt
  try {
    receipt = await verifier({ capability, providerKey: configuration.providerKey, configurationFingerprint: configuration.configurationFingerprint, transportConfiguration: configuration.transportConfiguration as Record<string, unknown>, credentialReference: configuration.credentialReference, resolveCredential: credentialResolver, fetchImpl, clock })
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    conflict('Provider verification failed without changing provider readiness.')
  }
  const observedAt = new Date(receipt.observedAt)
  const verifiedAt = clock()
  if (receipt.capability !== capability || receipt.providerKey !== configuration.providerKey || receipt.configurationFingerprint !== configuration.configurationFingerprint || !isOpaqueReference(receipt.capabilityIdentity, 160) || !isOpaqueReference(receipt.providerEventId, 160) || !/^[a-f0-9]{64}$/u.test(receipt.payloadHash) || !isOpaqueReference(receipt.exactResponseIdentity, 256) || !Number.isFinite(observedAt.getTime()) || Math.abs(verifiedAt.getTime() - observedAt.getTime()) > 10 * 60_000) conflict('Provider verification receipt identity or timestamp is incomplete or mismatched.')
  const receiptFingerprint = stableFingerprint(receipt)
  const verified = await repository.verifyProviderConfigurationCas(ownerUserId, configuration.id, configuration.configurationFingerprint, { readinessStatus: 'verified', blockedReasonCode: null, verificationReceiptFingerprint: receiptFingerprint, capabilityIdentity: receipt.capabilityIdentity, verifiedAt })
  if (!verified) conflict('Provider configuration changed before verification completed.')
  return { configuration: verified, receiptFingerprint }
}

function configuredStatus(status: string): boolean { return status === 'configured' || status === 'verified' }

export async function getManagedSiteProviderReadiness(
  ownerUserId: number,
  repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(),
  credentialResolver: ManagedSiteCredentialResolver = resolveManagedSiteCredential,
): Promise<ManagedSiteProviderReadiness> {
  const configurations = await repository.listProviderConfigurations(ownerUserId)
  const byCapability = new Map(configurations.map(configuration => [configuration.capability, configuration]))
  const capabilities: ManagedSiteProviderReadinessItem[] = []
  for (const capability of MANAGED_SITE_CONNECTOR_CAPABILITIES) {
    const configuration = byCapability.get(capability)
    if (!configuration) {
      capabilities.push({ capability, providerKey: null, status: 'disabled', configured: false, verified: false, credentialReferenceConfigured: false, credentialResolvable: false, liveMutationAllowed: false, missing: ['provider_configuration', 'credential_reference', 'verification_receipt'], blockedReasonCode: null, verifiedAt: null })
      continue
    }
    const resolution = configuration.credentialReference ? await credentialResolver(configuration.credentialReference) : { ok: false as const, reason: 'missing_reference' as const }
    const isMock = configuration.readinessStatus === 'mock'
    const verified = configuration.readinessStatus === 'verified' && Boolean(configuration.verificationReceiptFingerprint) && Boolean(configuration.verifiedAt) && resolution.ok
    const status = configuration.readinessStatus === 'configured' && !resolution.ok ? 'blocked' : configuration.readinessStatus as ManagedSiteProviderReadinessItem['status']
    const missing: string[] = []
    if (!configuredStatus(configuration.readinessStatus) && !isMock) missing.push('provider_configuration')
    if (!configuration.credentialReference && !isMock) missing.push('credential_reference')
    if (configuration.credentialReference && !resolution.ok) missing.push('credential_resolution')
    if (!verified && !isMock) missing.push('verification_receipt')
    capabilities.push({ capability, providerKey: configuration.providerKey, status, configured: configuredStatus(configuration.readinessStatus), verified, credentialReferenceConfigured: Boolean(configuration.credentialReference), credentialResolvable: resolution.ok, liveMutationAllowed: verified, missing, blockedReasonCode: status === 'blocked' ? configuration.blockedReasonCode || 'CREDENTIAL_REFERENCE_UNRESOLVED' : configuration.blockedReasonCode, verifiedAt: verified ? configuration.verifiedAt!.toISOString() : null })
  }
  return {
    capabilities,
    liveReady: capabilities.every(item => item.liveMutationAllowed),
    dryRunAllowed: true,
    mockedAllowed: process.env.NODE_ENV === 'test',
    truthfulBoundary: [
      'configured does not mean verified; live mutation requires an exact server-verified provider receipt.',
      'credential values never appear in this projection, browser responses, logs, fixtures, or database rows.',
      'dry-run is always non-mutating; mocked execution is restricted to tests.',
    ],
  }
}

export async function requireVerifiedManagedSiteProvider(ownerUserId: number, capability: ManagedSiteConnectorCapability, repository: ManagedSiteLiveConnectorRepository = getManagedSiteLiveConnectorRepository(), credentialResolver: ManagedSiteCredentialResolver = resolveManagedSiteCredential) {
  const readiness = await getManagedSiteProviderReadiness(ownerUserId, repository, credentialResolver)
  const item = readiness.capabilities.find(candidate => candidate.capability === capability)!
  if (!item.liveMutationAllowed) throw createError({ statusCode: 503, statusMessage: `Managed-site ${capability} provider is not server-verified.` })
  const configuration = await repository.findProviderConfiguration(ownerUserId, capability)
  if (!configuration?.credentialReference) throw createError({ statusCode: 503, statusMessage: `Managed-site ${capability} credential reference is unavailable.` })
  return configuration
}
