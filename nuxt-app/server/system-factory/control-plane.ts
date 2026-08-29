import { fingerprint, normalizeText, SystemFactoryError } from './canonical'
import { assertLiveRuntimeAuthority, type SystemFactoryRuntimeAuthority } from './runtime-authority'

export const CONTROL_PLANE_OPERATIONS = ['create_site', 'install_apps', 'migrate_site', 'backup_site', 'restore_site', 'apply_upgrade'] as const
export type ControlPlaneOperation = typeof CONTROL_PLANE_OPERATIONS[number]
export type ControlPlaneContext = { systemTenantId: string; siteName: string; credentialReference: string; idempotencyKey: string; targetVersion?: string; runtimeAuthority: SystemFactoryRuntimeAuthority; executionMode: 'mocked' | 'live' }
export type OperationReceipt = { schemaVersion: 'system-factory-operation-receipt-v1'; operation: string; systemTenantId: string; status: 'succeeded'; replayed: boolean; requestFingerprint: string; responseFingerprint: string; receiptFingerprint: string; exactResponseIdentity: string; runtimeAuthorityFingerprint: string; externalCalls: boolean; sanitizedMetadata: Record<string, unknown> }
export type SystemFactoryControlPlanePort = { createSite(input: ControlPlaneContext): Promise<OperationReceipt>; installApps(input: ControlPlaneContext): Promise<OperationReceipt>; migrateSite(input: ControlPlaneContext): Promise<OperationReceipt>; backupSite(input: ControlPlaneContext): Promise<OperationReceipt>; restoreSite(input: ControlPlaneContext): Promise<OperationReceipt>; applyUpgrade(input: ControlPlaneContext): Promise<OperationReceipt> }
export type ReviewedBenchCommand = { executable: 'bench'; args: readonly string[] }
export type ReviewedBenchTransportRequest = { schemaVersion: 'system-factory-bench-request-v1'; operation: ControlPlaneOperation; systemTenantId: string; siteName: string; credentialReference: string; idempotencyKey: string; runtimeAuthorityFingerprint: string; commands: readonly ReviewedBenchCommand[]; timeoutMs: number }
export type ReviewedBenchTransportResponse = { schemaVersion: 'system-factory-bench-response-v1'; operation: ControlPlaneOperation; systemTenantId: string; requestFingerprint: string; runtimeAuthorityFingerprint: string; status: 'succeeded'; replayed: boolean; exactResponseIdentity: string; outputFingerprint: string }
export type ReviewedBenchTransport = { execute(input: ReviewedBenchTransportRequest): Promise<ReviewedBenchTransportResponse> }

function boundedSite(value: string): string { const site = normalizeText(value, 'Frappe site name', 120); if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(site)) throw new SystemFactoryError('SITE_NAME', 'Frappe site name is invalid.', 409); return site }
function fixedCommands(operation: ControlPlaneOperation, site: string, targetVersion?: string): ReviewedBenchCommand[] {
  if (operation === 'create_site') return [{ executable: 'bench', args: ['new-site', site, '--no-mariadb-socket'] }]
  if (operation === 'install_apps') return [{ executable: 'bench', args: ['--site', site, 'install-app', 'erpnext'] }, { executable: 'bench', args: ['--site', site, 'install-app', 'discovery_stack'] }]
  if (operation === 'migrate_site') return [{ executable: 'bench', args: ['--site', site, 'migrate'] }]
  if (operation === 'backup_site') return [{ executable: 'bench', args: ['--site', site, 'backup', '--with-files'] }]
  if (operation === 'restore_site') return [{ executable: 'bench', args: ['--site', site, 'restore', '{REVIEWED_BACKUP_PATH}'] }]
  const version = normalizeText(targetVersion, 'Reviewed upgrade version', 96)
  if (!/^v16\.[0-9]+\.[0-9]+$/u.test(version)) throw new SystemFactoryError('UPGRADE_VERSION', 'Upgrade target is not a reviewed v16 version.', 409)
  return [{ executable: 'bench', args: ['--site', site, 'migrate'] }]
}
function requestFor(operation: ControlPlaneOperation, input: ControlPlaneContext): ReviewedBenchTransportRequest {
  const siteName = boundedSite(input.siteName); const credentialReference = normalizeText(input.credentialReference, 'Opaque credential reference', 192); const idempotencyKey = normalizeText(input.idempotencyKey, 'Idempotency key', 128)
  return { schemaVersion: 'system-factory-bench-request-v1', operation, systemTenantId: normalizeText(input.systemTenantId, 'System tenant id', 128), siteName, credentialReference, idempotencyKey, runtimeAuthorityFingerprint: input.runtimeAuthority.authorityFingerprint, commands: fixedCommands(operation, siteName, input.targetVersion), timeoutMs: operation === 'create_site' || operation === 'install_apps' || operation === 'migrate_site' ? 300_000 : 600_000 }
}
function validateTransportResponse(response: ReviewedBenchTransportResponse, request: ReviewedBenchTransportRequest, requestFingerprint: string): OperationReceipt {
  if (!response || Object.keys(response).sort().join(',') !== ['exactResponseIdentity', 'operation', 'outputFingerprint', 'replayed', 'requestFingerprint', 'runtimeAuthorityFingerprint', 'schemaVersion', 'status', 'systemTenantId'].sort().join(',') || response.schemaVersion !== 'system-factory-bench-response-v1' || response.operation !== request.operation || response.systemTenantId !== request.systemTenantId || response.requestFingerprint !== requestFingerprint || response.runtimeAuthorityFingerprint !== request.runtimeAuthorityFingerprint || response.status !== 'succeeded' || typeof response.replayed !== 'boolean' || !/^[a-f0-9]{64}$/u.test(response.outputFingerprint) || typeof response.exactResponseIdentity !== 'string' || response.exactResponseIdentity.length > 256) throw new SystemFactoryError('CONTROL_PLANE_RESPONSE', 'Control-plane response is malformed or mismatched.', 409)
  const responseFingerprint = fingerprint(response); const receiptFingerprint = fingerprint({ requestFingerprint, responseFingerprint, exactResponseIdentity: response.exactResponseIdentity, authority: request.runtimeAuthorityFingerprint })
  return { schemaVersion: 'system-factory-operation-receipt-v1', operation: request.operation, systemTenantId: request.systemTenantId, status: 'succeeded', replayed: response.replayed, requestFingerprint, responseFingerprint, receiptFingerprint, exactResponseIdentity: response.exactResponseIdentity, runtimeAuthorityFingerprint: request.runtimeAuthorityFingerprint, externalCalls: true, sanitizedMetadata: { outputFingerprint: response.outputFingerprint, commands: request.commands.map(command => ({ executable: command.executable, argumentCount: command.args.length })) } }
}

export function createReviewedBenchControlPlaneAdapter(options: { liveEnabled: boolean; expectedAuthorityFingerprint?: string; transport: ReviewedBenchTransport }): SystemFactoryControlPlanePort {
  const invoke = async (operation: ControlPlaneOperation, input: ControlPlaneContext) => {
    if (input.executionMode !== 'live' || !options.liveEnabled) throw new SystemFactoryError('CONTROL_PLANE_DISABLED', 'Live control-plane execution is disabled.', 503)
    assertLiveRuntimeAuthority(input.runtimeAuthority, options.expectedAuthorityFingerprint)
    const request = requestFor(operation, input); const requestFingerprint = fingerprint(request)
    let response: ReviewedBenchTransportResponse
    try { response = await options.transport.execute(request) } catch (error) { if (error instanceof SystemFactoryError) throw error; throw new SystemFactoryError('CONTROL_PLANE_TRANSPORT', 'Control-plane transport failed without exposing command output.', 502) }
    return validateTransportResponse(response, request, requestFingerprint)
  }
  return { createSite: input => invoke('create_site', input), installApps: input => invoke('install_apps', input), migrateSite: input => invoke('migrate_site', input), backupSite: input => invoke('backup_site', input), restoreSite: input => invoke('restore_site', input), applyUpgrade: input => invoke('apply_upgrade', input) }
}

export function createMockControlPlane(options: { calls?: string[]; failAt?: ControlPlaneOperation; responseOverride?: Partial<ReviewedBenchTransportResponse> } = {}): SystemFactoryControlPlanePort {
  const invoke = async (operation: ControlPlaneOperation, input: ControlPlaneContext) => { options.calls?.push(operation); if (options.failAt === operation) throw new SystemFactoryError('MOCK_RETRYABLE_5XX', 'Injected control-plane failure.', 502); const request = requestFor(operation, input); const requestFingerprint = fingerprint(request); const response: ReviewedBenchTransportResponse = { schemaVersion: 'system-factory-bench-response-v1', operation, systemTenantId: request.systemTenantId, requestFingerprint, runtimeAuthorityFingerprint: request.runtimeAuthorityFingerprint, status: 'succeeded', replayed: false, exactResponseIdentity: `mock-control:${operation}:${requestFingerprint.slice(0, 24)}`, outputFingerprint: fingerprint({ operation, requestFingerprint }), ...options.responseOverride }; return validateTransportResponse(response, request, requestFingerprint) }
  return { createSite: input => invoke('create_site', input), installApps: input => invoke('install_apps', input), migrateSite: input => invoke('migrate_site', input), backupSite: input => invoke('backup_site', input), restoreSite: input => invoke('restore_site', input), applyUpgrade: input => invoke('apply_upgrade', input) }
}
