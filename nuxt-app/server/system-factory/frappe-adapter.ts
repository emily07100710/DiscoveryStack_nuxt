import { signEnvelope } from './hmac'
import { fingerprint, SystemFactoryError } from './canonical'
import type { CompiledSystemPlan } from './compiler'

export type OpaqueCredential = { ok: true; value: string } | { ok: false; reason: 'missing' | 'revoked' | 'unavailable' }
export type CredentialResolver = (reference: string) => Promise<OpaqueCredential>
export type ProvisionReceipt = { operation: string; status: 'succeeded'; externalReference: string | null; requestFingerprint: string; responseFingerprint: string; exactResponseIdentity: string; sanitizedMetadata: Record<string, unknown>; externalCalls: boolean }
export type FrappeProvisionerPort = {
  createSite(input: ProvisionContext): Promise<ProvisionReceipt>; installApp(input: ProvisionContext): Promise<ProvisionReceipt>; applyCompiledSpec(input: ProvisionContext): Promise<ProvisionReceipt>; createRolesAndPermissions(input: ProvisionContext): Promise<ProvisionReceipt>; configureModules(input: ProvisionContext): Promise<ProvisionReceipt>; createAdminInvitation(input: ProvisionContext): Promise<ProvisionReceipt>; healthCheck(input: ProvisionContext): Promise<ProvisionReceipt & { healthy: boolean }>; suspendSite(input: ProvisionContext): Promise<ProvisionReceipt>; planUpgrade(input: ProvisionContext): Promise<ProvisionReceipt>; backupBeforeUpgrade(input: ProvisionContext): Promise<ProvisionReceipt>; applyUpgrade(input: ProvisionContext): Promise<ProvisionReceipt>; verifyUpgrade(input: ProvisionContext): Promise<ProvisionReceipt & { healthy: boolean }>; rollbackUpgrade(input: ProvisionContext): Promise<ProvisionReceipt>
}
export type ProvisionContext = { ownerId: string; clientId: string; websiteId: string | null; managedSiteId: string | null; systemTenantId: string; siteName: string; credentialReference: string; idempotencyKey: string; compiledPlan: CompiledSystemPlan; executionMode: 'dry_run' | 'mocked' | 'live'; targetVersion?: string }

const SPECIAL_HOST = /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/u
function ipv4Special(host: string): boolean {
  const parts = host.split('.').map(Number); if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const first = parts[0]!
  return first === 0 || first === 10 || first === 127 || first >= 224 || (first === 169 && parts[1] === 254) || (first === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (first === 192 && parts[1] === 168) || (first === 100 && parts[1]! >= 64 && parts[1]! <= 127)
}

export function assertPublicFrappeOrigin(value: string, allowlist: readonly string[]): string {
  let url: URL; try { url = new URL(value) } catch { throw new SystemFactoryError('FRAPPE_ORIGIN', 'Frappe origin is invalid.', 503) }
  const host = url.hostname.toLocaleLowerCase('en-US').replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.port && url.port !== '443') || SPECIAL_HOST.test(host) || ipv4Special(host) || host === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/u.test(host.replace(/:/gu, ''))) throw new SystemFactoryError('FRAPPE_ORIGIN', 'Frappe origin must be an allowlisted public HTTPS origin.', 503)
  const origins = new Set(allowlist.map(candidate => { const parsed = new URL(candidate); return parsed.origin }))
  if (!origins.has(url.origin)) throw new SystemFactoryError('FRAPPE_ORIGIN', 'Frappe origin is outside the server allowlist.', 503)
  return url.origin
}

const PATHS: Record<keyof FrappeProvisionerPort, string> = {
  createSite: '/api/method/discovery_stack.internal.create_site', installApp: '/api/method/discovery_stack.internal.install_app', applyCompiledSpec: '/api/method/discovery_stack.internal.apply_compiled_spec', createRolesAndPermissions: '/api/method/discovery_stack.internal.create_roles_permissions', configureModules: '/api/method/discovery_stack.internal.configure_modules', createAdminInvitation: '/api/method/discovery_stack.internal.create_admin_invitation', healthCheck: '/api/method/discovery_stack.api.health', suspendSite: '/api/method/discovery_stack.internal.suspend_site', planUpgrade: '/api/method/discovery_stack.internal.plan_upgrade', backupBeforeUpgrade: '/api/method/discovery_stack.internal.backup_before_upgrade', applyUpgrade: '/api/method/discovery_stack.internal.apply_upgrade', verifyUpgrade: '/api/method/discovery_stack.internal.verify_upgrade', rollbackUpgrade: '/api/method/discovery_stack.internal.rollback_upgrade',
}

function boundedError(_error: unknown): never { throw new SystemFactoryError('FRAPPE_TRANSPORT', 'Frappe operation failed; consult the secret-free server receipt.', 502) }

export function createFrappeRestAdapter(options: { endpointOrigin: string; allowedOrigins: string[]; sender: string; receiver: string; keyId: string; credentialResolver: CredentialResolver; fetchImpl?: typeof fetch; timeoutMs?: number; maximumResponseBytes?: number }): FrappeProvisionerPort {
  const origin = assertPublicFrappeOrigin(options.endpointOrigin, options.allowedOrigins); const fetchImpl = options.fetchImpl || fetch; const timeoutMs = Math.min(Math.max(options.timeoutMs || 15_000, 500), 30_000); const maximumResponseBytes = Math.min(Math.max(options.maximumResponseBytes || 262_144, 1024), 1_048_576)
  async function invoke(operation: keyof FrappeProvisionerPort, input: ProvisionContext): Promise<any> {
    if (input.executionMode === 'dry_run') return dryRunReceipt(operation, input)
    if (input.executionMode !== 'live') throw new SystemFactoryError('FRAPPE_MODE', 'Live adapter accepts only dry_run or live execution.', 409)
    const credential = await options.credentialResolver(input.credentialReference); if (!credential.ok) throw new SystemFactoryError('MISSING_CREDENTIAL', 'Server credential reference is unavailable.', 503)
    const path = PATHS[operation]; const bodyObject = { schemaVersion: 'frappe-operation-envelope-v1', operation, ownerId: input.ownerId, clientId: input.clientId, websiteId: input.websiteId, managedSiteId: input.managedSiteId, systemTenantId: input.systemTenantId, siteName: input.siteName, idempotencyKey: input.idempotencyKey, compiledPlanFingerprint: input.compiledPlan.planFingerprint, specFingerprint: input.compiledPlan.specFingerprint, targetVersion: input.targetVersion || null, compiledPlan: operation === 'applyCompiledSpec' ? input.compiledPlan : undefined }; const body = JSON.stringify(bodyObject)
    const signed = signEnvelope({ method: 'POST', path, rawBody: body, sender: options.sender, receiver: options.receiver, keyId: options.keyId, key: credential.value }); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${origin}${path}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey, 'x-ds-timestamp': signed.timestamp, 'x-ds-nonce': signed.nonce, 'x-ds-sender': signed.sender, 'x-ds-receiver': signed.receiver, 'x-ds-key-id': signed.keyId, 'x-ds-body-sha256': signed.bodySha256, 'x-ds-signature': signed.signature }, body })
      const contentLength = Number(response.headers.get('content-length') || 0); if (contentLength > maximumResponseBytes) throw new Error('bounded response')
      const text = await response.text(); if (Buffer.byteLength(text) > maximumResponseBytes) throw new Error('bounded response')
      if (!response.ok) throw new Error('remote status')
      const data = JSON.parse(text) as Record<string, unknown>; if (data.ok !== true || typeof data.receiptFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(data.receiptFingerprint)) throw new Error('invalid receipt')
      return { operation, status: 'succeeded', externalReference: typeof data.externalReference === 'string' ? data.externalReference.slice(0, 160) : null, requestFingerprint: fingerprint(bodyObject), responseFingerprint: data.receiptFingerprint, exactResponseIdentity: `${response.status}:${data.receiptFingerprint}`, sanitizedMetadata: { remoteStatus: response.status, schemaVersion: data.schemaVersion || null }, externalCalls: true, ...((operation === 'healthCheck' || operation === 'verifyUpgrade') ? { healthy: data.healthy === true } : {}) }
    } catch (error) { boundedError(error) } finally { clearTimeout(timer) }
  }
  return Object.fromEntries(Object.keys(PATHS).map(operation => [operation, (input: ProvisionContext) => invoke(operation as keyof FrappeProvisionerPort, input)])) as FrappeProvisionerPort
}

function dryRunReceipt(operation: keyof FrappeProvisionerPort, input: ProvisionContext): ProvisionReceipt & { healthy?: boolean } {
  const requestFingerprint = fingerprint({ operation, tenant: input.systemTenantId, plan: input.compiledPlan.planFingerprint, mode: 'dry_run' }); const result = { operation, status: 'succeeded' as const, externalReference: null, requestFingerprint, responseFingerprint: fingerprint({ requestFingerprint, noWrite: true }), exactResponseIdentity: `dry-run:${requestFingerprint}`, sanitizedMetadata: { limitation: 'Dry-run only; no site, app, metadata, invitation, backup, upgrade or external write occurred.' }, externalCalls: false }
  return (operation === 'healthCheck' || operation === 'verifyUpgrade') ? { ...result, healthy: false } : result
}

export function createMockFrappeProvisioner(options: { failAt?: keyof FrappeProvisionerPort; unhealthyAt?: 'healthCheck' | 'verifyUpgrade'; calls?: string[] } = {}): FrappeProvisionerPort {
  const make = (operation: keyof FrappeProvisionerPort) => async (input: ProvisionContext) => {
    options.calls?.push(operation); if (options.failAt === operation) throw new SystemFactoryError('MOCK_FAILURE', `Mock ${operation} failed.`, 502)
    const base = { operation, status: 'succeeded' as const, externalReference: `${operation}:${input.systemTenantId}`, requestFingerprint: fingerprint({ operation, input: input.compiledPlan.planFingerprint }), responseFingerprint: fingerprint({ operation, tenant: input.systemTenantId, ok: true }), exactResponseIdentity: `mock:${operation}:${input.systemTenantId}`, sanitizedMetadata: { mocked: true }, externalCalls: false }
    return (operation === 'healthCheck' || operation === 'verifyUpgrade') ? { ...base, healthy: options.unhealthyAt !== operation } : base
  }
  return Object.fromEntries(Object.keys(PATHS).map(operation => [operation, make(operation as keyof FrappeProvisionerPort)])) as unknown as FrappeProvisionerPort
}
