import { fingerprint, SystemFactoryError } from './canonical'
import type { CompiledSystemPlan } from './compiler'
import type { OperationReceipt } from './control-plane'
import type { ProvisionContext, SystemFactoryProvisionerPort } from './provisioner'
import type { SystemFactoryRuntimeAuthority } from './runtime-authority'

export const PROVISIONING_OPERATIONS = ['create_site', 'install_app', 'apply_compiled_spec', 'create_roles_permissions', 'configure_modules', 'health_check', 'create_admin_invitation'] as const
export type ProvisioningOperation = typeof PROVISIONING_OPERATIONS[number]
export type ProvisioningRunContext = ProvisionContext & { runRowId: number; runPublicId: string; planRowId: number; ownerUserRowId: number; tenantRowId: number; systemSpecRowId: number; runAttempt: number; maxAttempts: number; planFingerprint: string }
export type ProvisioningClaim = { runRowId: number; leaseOwner: string; leaseExpiresAt: Date }
export type ProvisioningAttempt = { operation: ProvisioningOperation; attemptNumber: number; requestFingerprint: string; startedAt: Date }
export type ProvisioningFailure = { code: string; summary: string; retryable: boolean; retryAt: Date | null; blocked: boolean }

export interface DurableProvisioningRepositoryPort {
  listEligible(now: Date, limit: number): Promise<number[]>
  claim(runRowId: number, leaseOwner: string, now: Date, leaseExpiresAt: Date): Promise<ProvisioningClaim | null>
  loadContext(claim: ProvisioningClaim): Promise<ProvisioningRunContext>
  completedOperations(claim: ProvisioningClaim): Promise<ProvisioningOperation[]>
  beginAttempt(claim: ProvisioningClaim, operation: ProvisioningOperation, requestFingerprint: string, now: Date, timeoutMs: number): Promise<ProvisioningAttempt>
  blockClaim(claim: ProvisioningClaim, code: string, now: Date): Promise<void>
  commitSuccess(claim: ProvisioningClaim, context: ProvisioningRunContext, attempt: ProvisioningAttempt, receipt: OperationReceipt, now: Date, terminal: boolean): Promise<void>
  commitFailure(claim: ProvisioningClaim, context: ProvisioningRunContext, attempt: ProvisioningAttempt, failure: ProvisioningFailure, now: Date): Promise<void>
}

const METHODS: Record<ProvisioningOperation, keyof Pick<SystemFactoryProvisionerPort, 'createSite' | 'installApp' | 'applyCompiledSpec' | 'createRolesAndPermissions' | 'configureModules' | 'healthCheck' | 'createAdminInvitation'>> = {
  create_site: 'createSite', install_app: 'installApp', apply_compiled_spec: 'applyCompiledSpec', create_roles_permissions: 'createRolesAndPermissions', configure_modules: 'configureModules', health_check: 'healthCheck', create_admin_invitation: 'createAdminInvitation',
}

function classify(error: unknown, attemptNumber: number, maxAttempts: number, now: Date): ProvisioningFailure {
  const code = error instanceof SystemFactoryError ? error.code : 'UNEXPECTED_EXECUTOR_FAILURE'
  const status = error instanceof SystemFactoryError ? error.statusCode : 500
  const retryable = status === 429 || status >= 500 && !['RUNTIME_AUTHORITY_UNAPPROVED', 'RUNTIME_AUTHORITY_DRIFT', 'MISSING_CREDENTIAL', 'CONTROL_PLANE_DISABLED', 'TENANT_APP_DISABLED'].includes(code)
  const exhausted = attemptNumber >= maxAttempts
  const delayMs = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attemptNumber - 1))
  return { code: code.slice(0, 96), summary: 'Provisioning step failed at a server-only boundary.'.slice(0, 500), retryable: retryable && !exhausted, retryAt: retryable && !exhausted ? new Date(now.getTime() + delayMs) : null, blocked: !retryable || exhausted }
}

function assertReceipt(context: ProvisioningRunContext, operation: ProvisioningOperation, receipt: OperationReceipt): void {
  if (receipt.status !== 'succeeded' || receipt.systemTenantId !== context.systemTenantId || receipt.runtimeAuthorityFingerprint !== context.runtimeAuthority.authorityFingerprint || !/^[a-f0-9]{64}$/u.test(receipt.requestFingerprint) || !/^[a-f0-9]{64}$/u.test(receipt.responseFingerprint) || !/^[a-f0-9]{64}$/u.test(receipt.receiptFingerprint) || !receipt.exactResponseIdentity || receipt.exactResponseIdentity.length > 256) throw new SystemFactoryError('PROVISIONING_RECEIPT_MISMATCH', 'Provisioning receipt failed exact lineage validation.', 409)
  if (operation === 'health_check' && !('healthy' in receipt && receipt.healthy === true)) throw new SystemFactoryError('PROVISIONING_HEALTH_FAILED', 'Tenant health did not verify.', 409)
}

export async function runProvisioningTick(input: { repository: DurableProvisioningRepositoryPort; provisioner: SystemFactoryProvisionerPort; workerId: string; now?: Date; maxTenants?: number; maxStepsPerTenant?: number; maxTotalSteps?: number; leaseMs?: number; timeoutMs?: number }) {
  const now = input.now || new Date(); const maxTenants = Math.min(Math.max(input.maxTenants || 20, 1), 20); const maxStepsPerTenant = Math.min(Math.max(input.maxStepsPerTenant || 10, 1), 10); const maxTotalSteps = Math.min(Math.max(input.maxTotalSteps || 100, 1), 200); const leaseMs = Math.min(Math.max(input.leaseMs || 120_000, 10_000), 600_000); const timeoutMs = Math.min(Math.max(input.timeoutMs || 30_000, 1_000), 120_000)
  const candidates = await input.repository.listEligible(now, maxTenants); let claimed = 0; let executed = 0; let completed = 0; let retryWait = 0; let blocked = 0
  for (const runRowId of candidates) {
    if (executed >= maxTotalSteps) break
    const claim = await input.repository.claim(runRowId, input.workerId, now, new Date(now.getTime() + leaseMs)); if (!claim) continue
    claimed++
    let context: ProvisioningRunContext
    try { context = await input.repository.loadContext(claim) } catch (error) { await input.repository.blockClaim(claim, error instanceof SystemFactoryError ? error.code : 'CONTEXT_LOAD_FAILED', now); blocked++; continue }
    for (let ordinal = 0; ordinal < maxStepsPerTenant && executed < maxTotalSteps; ordinal++) {
      const done = await input.repository.completedOperations(claim); const operation = PROVISIONING_OPERATIONS.find(item => !done.includes(item)); if (!operation) break
      const requestFingerprint = fingerprint({ schemaVersion: 'provisioning-step-request-v1', operation, runId: context.runPublicId, tenant: context.systemTenantId, plan: context.planFingerprint, compiledPlan: context.compiledPlan.planFingerprint, authority: context.runtimeAuthority.authorityFingerprint })
      let attempt: ProvisioningAttempt
      try { attempt = await input.repository.beginAttempt(claim, operation, requestFingerprint, now, timeoutMs) } catch (error) { await input.repository.blockClaim(claim, error instanceof SystemFactoryError ? error.code : 'ATTEMPT_CLAIM_FAILED', now); blocked++; break }
      executed++
      try {
        const method = METHODS[operation]; const receipt = await (input.provisioner[method] as (value: ProvisionContext) => Promise<OperationReceipt>)({ ...context, idempotencyKey: `${context.runPublicId}:${operation}` }); assertReceipt(context, operation, receipt)
        const terminal = operation === PROVISIONING_OPERATIONS.at(-1); await input.repository.commitSuccess(claim, context, attempt, receipt, new Date(), terminal)
        if (terminal) { completed++; break }
      } catch (error) {
        const failure = classify(error, attempt.attemptNumber, context.maxAttempts, now); await input.repository.commitFailure(claim, context, attempt, failure, new Date()); if (failure.retryable) retryWait++; else blocked++; break
      }
    }
  }
  return { enabled: true, claimed, executed, completed, retryWait, blocked, bounds: { maxTenants, maxStepsPerTenant, maxTotalSteps } }
}

type MemoryRun = { context: ProvisioningRunContext; status: 'queued' | 'processing' | 'retry_wait' | 'blocked' | 'completed'; leaseOwner: string | null; leaseExpiresAt: Date | null; retryEligibleAt: Date | null; completed: ProvisioningOperation[]; attempts: ProvisioningAttempt[]; receipts: OperationReceipt[] }
export class MemoryProvisioningRepository implements DurableProvisioningRepositoryPort {
  readonly runs = new Map<number, MemoryRun>(); failCommitOnce = false
  constructor(contexts: ProvisioningRunContext[] = []) { for (const context of contexts) this.runs.set(context.runRowId, { context, status: 'queued', leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, completed: [], attempts: [], receipts: [] }) }
  async listEligible(now: Date, limit: number) { return [...this.runs.entries()].filter(([, run]) => run.status === 'queued' || run.status === 'retry_wait' && Boolean(run.retryEligibleAt && run.retryEligibleAt <= now) || run.status === 'processing' && Boolean(run.leaseExpiresAt && run.leaseExpiresAt <= now)).slice(0, limit).map(([id]) => id) }
  async claim(runRowId: number, leaseOwner: string, now: Date, leaseExpiresAt: Date) { const run = this.runs.get(runRowId); if (!run || !(run.status === 'queued' || run.status === 'retry_wait' && Boolean(run.retryEligibleAt && run.retryEligibleAt <= now) || run.status === 'processing' && Boolean(run.leaseExpiresAt && run.leaseExpiresAt <= now))) return null; run.status = 'processing'; run.leaseOwner = leaseOwner; run.leaseExpiresAt = leaseExpiresAt; return { runRowId, leaseOwner, leaseExpiresAt } }
  private owned(claim: ProvisioningClaim) { const run = this.runs.get(claim.runRowId); if (!run || run.status !== 'processing' || run.leaseOwner !== claim.leaseOwner) throw new SystemFactoryError('LEASE_LOST', 'Provisioning lease is no longer owned.', 409); return run }
  async loadContext(claim: ProvisioningClaim) { return this.owned(claim).context }
  async completedOperations(claim: ProvisioningClaim) { return [...this.owned(claim).completed] }
  async beginAttempt(claim: ProvisioningClaim, operation: ProvisioningOperation, requestFingerprint: string, now: Date) { const run = this.owned(claim); const prior = run.attempts.filter(item => item.operation === operation); const collision = prior.find(item => item.requestFingerprint !== requestFingerprint); if (collision) throw new SystemFactoryError('IDEMPOTENCY_COLLISION', 'Provisioning operation payload changed.', 409); const attempt = { operation, attemptNumber: prior.length + 1, requestFingerprint, startedAt: now }; run.attempts.push(attempt); return attempt }
  async blockClaim(claim: ProvisioningClaim) { const run = this.owned(claim); run.status = 'blocked'; run.leaseOwner = null; run.leaseExpiresAt = null }
  async commitSuccess(claim: ProvisioningClaim, _context: ProvisioningRunContext, attempt: ProvisioningAttempt, receipt: OperationReceipt, _now: Date, terminal: boolean) { const run = this.owned(claim); if (this.failCommitOnce) { this.failCommitOnce = false; throw new SystemFactoryError('TRANSACTION_ROLLBACK', 'Injected transaction rollback.', 500) }; if (!run.completed.includes(attempt.operation)) run.completed.push(attempt.operation); run.receipts.push(receipt); if (terminal) { run.status = 'completed'; run.leaseOwner = null; run.leaseExpiresAt = null } }
  async commitFailure(claim: ProvisioningClaim, _context: ProvisioningRunContext, _attempt: ProvisioningAttempt, failure: ProvisioningFailure) { const run = this.owned(claim); run.status = failure.retryable ? 'retry_wait' : 'blocked'; run.retryEligibleAt = failure.retryAt; run.leaseOwner = null; run.leaseExpiresAt = null }
}

export function mockedProvisioningContext(input: { runRowId?: number; compiledPlan: CompiledSystemPlan; authority: SystemFactoryRuntimeAuthority }): ProvisioningRunContext { const id = input.runRowId || 1; return { runRowId: id, runPublicId: `system-run-${id}`, planRowId: id, ownerUserRowId: 1, tenantRowId: id, systemSpecRowId: id, runAttempt: 0, maxAttempts: 3, planFingerprint: fingerprint({ id }), ownerId: 'owner:1', clientId: 'client:1', websiteId: 'site:1', managedSiteId: 'managed-site:1', systemTenantId: `system-tenant-${id}`, siteName: `tenant-${id}.factory.invalid`, controlPlaneCredentialReference: 'opaque:control', tenantAppCredentialReference: 'opaque:hmac', idempotencyKey: `system-run-${id}`, compiledPlan: input.compiledPlan, executionMode: 'mocked', runtimeAuthority: input.authority } }
