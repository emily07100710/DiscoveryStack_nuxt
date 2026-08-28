import { fingerprint, SystemFactoryError } from './canonical'
import type { CompiledSystemPlan } from './compiler'
import type { OperationReceipt, SystemFactoryControlPlanePort } from './control-plane'
import { createMockControlPlane } from './control-plane'
import type { TenantAppPort } from './frappe-adapter'
import { createMockTenantApp } from './frappe-adapter'
import type { SystemFactoryRuntimeAuthority } from './runtime-authority'

export type ProvisionContext = { ownerId: string; clientId: string; websiteId: string | null; managedSiteId: string | null; systemTenantId: string; siteName: string; controlPlaneCredentialReference: string; tenantAppCredentialReference: string; idempotencyKey: string; compiledPlan: CompiledSystemPlan; executionMode: 'mocked' | 'live'; runtimeAuthority: SystemFactoryRuntimeAuthority; targetVersion?: string }
export type SystemFactoryProvisionerPort = { createSite(input: ProvisionContext): Promise<OperationReceipt>; installApp(input: ProvisionContext): Promise<OperationReceipt>; applyCompiledSpec(input: ProvisionContext): Promise<OperationReceipt>; createRolesAndPermissions(input: ProvisionContext): Promise<OperationReceipt>; configureModules(input: ProvisionContext): Promise<OperationReceipt>; healthCheck(input: ProvisionContext): Promise<OperationReceipt & { healthy: boolean }>; createAdminInvitation(input: ProvisionContext): Promise<OperationReceipt>; suspendSite(input: ProvisionContext): Promise<OperationReceipt>; planUpgrade(input: ProvisionContext): Promise<OperationReceipt>; backupBeforeUpgrade(input: ProvisionContext): Promise<OperationReceipt>; applyUpgrade(input: ProvisionContext): Promise<OperationReceipt>; verifyUpgrade(input: ProvisionContext): Promise<OperationReceipt & { healthy: boolean }>; rollbackUpgrade(input: ProvisionContext): Promise<OperationReceipt> }

function combine(operation: string, receipts: OperationReceipt[]): OperationReceipt {
  if (!receipts.length || receipts.some(receipt => receipt.status !== 'succeeded') || new Set(receipts.map(receipt => receipt.systemTenantId)).size !== 1 || new Set(receipts.map(receipt => receipt.runtimeAuthorityFingerprint)).size !== 1) throw new SystemFactoryError('COMPOSITE_RECEIPT', 'Composite operation receipt lineage is invalid.', 409)
  const requestFingerprint = fingerprint(receipts.map(receipt => receipt.requestFingerprint)); const responseFingerprint = fingerprint(receipts.map(receipt => receipt.responseFingerprint)); const receiptFingerprint = fingerprint({ operation, requestFingerprint, responseFingerprint, authority: receipts[0]!.runtimeAuthorityFingerprint })
  return { schemaVersion: 'system-factory-operation-receipt-v1', operation, systemTenantId: receipts[0]!.systemTenantId, status: 'succeeded', replayed: receipts.every(receipt => receipt.replayed), requestFingerprint, responseFingerprint, receiptFingerprint, exactResponseIdentity: receipts.map(receipt => receipt.exactResponseIdentity).join('|').slice(0, 256), runtimeAuthorityFingerprint: receipts[0]!.runtimeAuthorityFingerprint, externalCalls: receipts.some(receipt => receipt.externalCalls), sanitizedMetadata: { subOperations: receipts.map(receipt => receipt.operation) } }
}

export function createSystemFactoryProvisioner(input: { controlPlane: SystemFactoryControlPlanePort; tenantApp: TenantAppPort }): SystemFactoryProvisionerPort {
  const control = (context: ProvisionContext) => ({ systemTenantId: context.systemTenantId, siteName: context.siteName, credentialReference: context.controlPlaneCredentialReference, idempotencyKey: context.idempotencyKey, targetVersion: context.targetVersion, runtimeAuthority: context.runtimeAuthority, executionMode: context.executionMode })
  const tenant = (context: ProvisionContext) => ({ ...context, credentialReference: context.tenantAppCredentialReference })
  const plan = async (context: ProvisionContext) => { const requestFingerprint = fingerprint({ operation: 'plan_upgrade', tenant: context.systemTenantId, targetVersion: context.targetVersion, authority: context.runtimeAuthority.authorityFingerprint }); return { schemaVersion: 'system-factory-operation-receipt-v1' as const, operation: 'plan_upgrade', systemTenantId: context.systemTenantId, status: 'succeeded' as const, replayed: false, requestFingerprint, responseFingerprint: fingerprint({ requestFingerprint, reviewed: true }), receiptFingerprint: fingerprint({ requestFingerprint, authority: context.runtimeAuthority.authorityFingerprint }), exactResponseIdentity: `reviewed-plan:${requestFingerprint}`, runtimeAuthorityFingerprint: context.runtimeAuthority.authorityFingerprint, externalCalls: false, sanitizedMetadata: { reviewedIntentOnly: true } } }
  return {
    createSite: context => input.controlPlane.createSite(control(context)),
    installApp: async context => combine('install_app', [await input.controlPlane.installApps({ ...control(context), idempotencyKey: `${context.idempotencyKey}:install` }), await input.controlPlane.migrateSite({ ...control(context), idempotencyKey: `${context.idempotencyKey}:migrate` })]),
    applyCompiledSpec: context => input.tenantApp.applyCompiledSpec(tenant(context)),
    createRolesAndPermissions: context => input.tenantApp.configureRoles(tenant(context)),
    configureModules: context => input.tenantApp.configureModules(tenant(context)),
    healthCheck: context => input.tenantApp.health(tenant(context)),
    createAdminInvitation: context => input.tenantApp.prepareAdminInvitation(tenant(context)),
    suspendSite: context => input.tenantApp.suspendTenant(tenant(context)),
    planUpgrade: plan,
    backupBeforeUpgrade: context => input.controlPlane.backupSite(control(context)),
    applyUpgrade: context => input.controlPlane.applyUpgrade(control(context)),
    verifyUpgrade: context => input.tenantApp.health(tenant(context)),
    rollbackUpgrade: context => input.controlPlane.restoreSite(control(context)),
  }
}

export function createMockSystemFactoryProvisioner(options: { calls?: string[]; failAt?: keyof SystemFactoryProvisionerPort; unhealthyAt?: 'healthCheck' | 'verifyUpgrade' } = {}): SystemFactoryProvisionerPort {
  const calls = options.calls; const controlCalls: string[] = []; const tenantCalls: string[] = []; const provisioner = createSystemFactoryProvisioner({ controlPlane: createMockControlPlane({ calls: controlCalls }), tenantApp: createMockTenantApp({ calls: tenantCalls, unhealthy: options.unhealthyAt === 'healthCheck' || options.unhealthyAt === 'verifyUpgrade' }) })
  const wrapped: Record<string, (input: ProvisionContext) => Promise<any>> = {}
  for (const operation of Object.keys(provisioner) as Array<keyof SystemFactoryProvisionerPort>) wrapped[operation] = async context => { calls?.push(operation); if (options.failAt === operation) throw new SystemFactoryError('MOCK_RETRYABLE_5XX', `Mock ${operation} failed.`, 502); const result = await (provisioner[operation] as (value: ProvisionContext) => Promise<OperationReceipt>)(context); if ((operation === 'healthCheck' || operation === 'verifyUpgrade') && options.unhealthyAt === operation) return { ...result, healthy: false }; return result }
  return wrapped as unknown as SystemFactoryProvisionerPort
}
