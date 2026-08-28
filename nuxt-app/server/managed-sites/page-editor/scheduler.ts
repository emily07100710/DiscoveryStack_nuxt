import { createError } from 'h3'
import { canonicalFingerprint } from './canonical'

export const EDITOR_SCHEDULER_LIMITS = Object.freeze({ maxTenantsPerTick: 20, maxJobsPerTenant: 10, leaseMs: 2 * 60 * 1000, maxAttempts: 5 })
export type EditorJobKind = 'media_processing' | 'scheduled_visibility' | 'orphan_upload_expiry' | 'trash_retention' | 'publish_retry'
export interface EditorSchedulerJob { jobId: string; ownerUserId: number; projectId: number; kind: EditorJobKind; attempt: number; availableAt: string; leaseUntil: string | null; stateFingerprint: string; sourceReference?: string; payload?: Record<string, unknown> }
export interface EditorSchedulerPort {
  claim(input: { now: Date; maxTenants: number; maxPerTenant: number; leaseUntil: Date }): Promise<EditorSchedulerJob[]>
  succeed(job: EditorSchedulerJob, receipt: { outcome: string; fingerprint: string }, now: Date): Promise<void>
  retry(job: EditorSchedulerJob, input: { reasonCode: string; nextAttemptAt: Date }, now: Date): Promise<void>
  block(job: EditorSchedulerJob, reasonCode: string, now: Date): Promise<void>
}
export type EditorJobHandlers = Record<EditorJobKind, (job: EditorSchedulerJob) => Promise<{ outcome: string; externalCalls: boolean }>>

export async function runEditorSchedulerTick(port: EditorSchedulerPort, handlers: EditorJobHandlers, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw createError({ statusCode: 422, statusMessage: 'Editor scheduler clock is invalid.' }); const leaseUntil = new Date(now.getTime() + EDITOR_SCHEDULER_LIMITS.leaseMs); const jobs = await port.claim({ now, maxTenants: EDITOR_SCHEDULER_LIMITS.maxTenantsPerTick, maxPerTenant: EDITOR_SCHEDULER_LIMITS.maxJobsPerTenant, leaseUntil }); const tenantCounts = new Map<string, number>(); const receipts = []
  let governedExternalCalls = 0
  for (const job of jobs) { const tenant = `${job.ownerUserId}:${job.projectId}`; const count = (tenantCounts.get(tenant) || 0) + 1; tenantCounts.set(tenant, count); if (count > EDITOR_SCHEDULER_LIMITS.maxJobsPerTenant) { await port.block(job, 'TENANT_TICK_BOUND_EXCEEDED', now); continue } try { const result = await handlers[job.kind](job); if (result.externalCalls) governedExternalCalls++; const fingerprint = canonicalFingerprint({ version: 'managed-site-editor-scheduler-receipt-v1', jobId: job.jobId, stateFingerprint: job.stateFingerprint, attempt: job.attempt, outcome: result.outcome }); await port.succeed(job, { outcome: result.outcome, fingerprint }, now); receipts.push({ jobId: job.jobId, kind: job.kind, status: 'succeeded', outcome: result.outcome, fingerprint, externalCalls: result.externalCalls }) } catch (error: any) { const reasonCode = typeof error?.reasonCode === 'string' ? error.reasonCode : 'EDITOR_JOB_FAILED'; const externalCalls = error?.externalCalls === true; if (externalCalls) governedExternalCalls++; if (error?.terminal === true || job.attempt >= EDITOR_SCHEDULER_LIMITS.maxAttempts) { await port.block(job, reasonCode, now); receipts.push({ jobId: job.jobId, kind: job.kind, status: 'blocked', reasonCode, externalCalls }) } else { const nextAttemptAt = new Date(now.getTime() + Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, job.attempt - 1))); await port.retry(job, { reasonCode, nextAttemptAt }, now); receipts.push({ jobId: job.jobId, kind: job.kind, status: 'retry_wait', reasonCode, nextAttemptAt: nextAttemptAt.toISOString(), externalCalls }) } } }
  return { version: 'managed-site-editor-scheduler-tick-v1', claimed: jobs.length, tenants: tenantCounts.size, receipts, bounded: true, externalCalls: governedExternalCalls > 0, governedExternalCalls }
}

export function createMemoryEditorSchedulerPort(seed: EditorSchedulerJob[]) {
  const jobs = structuredClone(seed); const events: any[] = []
  const port: EditorSchedulerPort = {
    async claim(input) { const tenants = new Set<string>(); const claimed = []; for (const job of jobs.filter(item => Date.parse(item.availableAt) <= input.now.getTime() && (!item.leaseUntil || Date.parse(item.leaseUntil) <= input.now.getTime()))) { const tenant = `${job.ownerUserId}:${job.projectId}`; if (!tenants.has(tenant) && tenants.size >= input.maxTenants) continue; if (claimed.filter(item => item.ownerUserId === job.ownerUserId && item.projectId === job.projectId).length >= input.maxPerTenant) continue; tenants.add(tenant); job.leaseUntil = input.leaseUntil.toISOString(); job.attempt++; claimed.push(structuredClone(job)) } return claimed },
    async succeed(job, receipt, now) { events.push({ jobId: job.jobId, status: 'succeeded', receipt, at: now.toISOString() }); const index = jobs.findIndex(item => item.jobId === job.jobId); if (index >= 0) jobs.splice(index, 1) },
    async retry(job, input, now) { events.push({ jobId: job.jobId, status: 'retry_wait', ...input, at: now.toISOString() }); const current = jobs.find(item => item.jobId === job.jobId); if (current) { current.availableAt = input.nextAttemptAt.toISOString(); current.leaseUntil = null } },
    async block(job, reasonCode, now) { events.push({ jobId: job.jobId, status: 'blocked', reasonCode, at: now.toISOString() }); const index = jobs.findIndex(item => item.jobId === job.jobId); if (index >= 0) jobs.splice(index, 1) },
  }
  return { port, jobs, events }
}
