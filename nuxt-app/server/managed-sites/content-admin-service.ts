import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { getOwnerContentOperationsWorkspace } from '../content-operations/service'
import type { ContentOperationsRepository, EventInsert } from '../content-operations/repository'
import { createContentOperationsRepository } from '../content-operations/repository'
import { assertPaidManagedSiteProject, assertSiteSpecEntitlement } from './module-authority'
import { getManagedSiteRepository } from './repository'
import type { ManagedSiteRepository, ManagedSiteRole } from './types'
import { roleAllows } from './types'

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function forbidden(message: string): never { throw createError({ statusCode: 403, statusMessage: message }) }

function requireRole(role: ManagedSiteRole, permission: string): void {
  if (!roleAllows(role, permission)) forbidden('This managed-site customer role cannot perform the requested Content Admin action.')
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`${label} is invalid.`)
  return value.trim()
}

async function contentAuthority(ownerUserId: number, projectId: number, managedRepository: ManagedSiteRepository) {
  const authority = await assertPaidManagedSiteProject(ownerUserId, projectId, managedRepository)
  assertSiteSpecEntitlement(authority.spec, 'managed_content_admin')
  if (authority.project.contentOperationClientId === null) conflict('Managed Content Admin is not linked to the canonical Content Operations client.')
  return authority
}

async function resolveEntry(ownerUserId: number, projectId: number, entryId: number, managedRepository: ManagedSiteRepository, operationsRepository: ContentOperationsRepository) {
  const authority = await contentAuthority(ownerUserId, projectId, managedRepository)
  const entry = await operationsRepository.findEntry(ownerUserId, entryId)
  const lineage = await operationsRepository.resolveWorkspaceEntry(ownerUserId, entryId)
  if (!entry || !lineage || lineage.entry.id !== entry.id || lineage.calendar.clientId !== authority.project.contentOperationClientId || lineage.client.id !== authority.project.contentOperationClientId || lineage.client.ownerUserId !== ownerUserId) conflict('Content Admin entry is outside the managed project’s canonical Content Operations client.')
  return { authority, entry, lineage }
}

function adminEvent(input: { ownerUserId: number; clientId: number; entryId: number; eventType: string; metadata: Record<string, unknown>; key: unknown }): EventInsert {
  return { ownerUserId: input.ownerUserId, clientId: input.clientId, calendarId: null, entryId: input.entryId, runId: null, eventType: input.eventType, fromStatus: null, toStatus: null, metadata: input.metadata, eventFingerprint: stableFingerprint(input.key) } as EventInsert
}

async function appendIdempotentEvent(repository: ContentOperationsRepository, input: Parameters<typeof adminEvent>[0]) {
  const fingerprint = stableFingerprint(input.key)
  return repository.transaction(async transaction => {
    const existing = (await transaction.listEvents(input.ownerUserId, input.entryId)).find(event => {
      if (event.eventFingerprint === fingerprint) return true
      const metadata = event.metadata as { idempotencyKey?: unknown } | null
      return metadata?.idempotencyKey === input.metadata.idempotencyKey && event.eventType === input.eventType
    })
    if (existing) {
      if (existing.eventFingerprint !== fingerprint) conflict('Content Admin idempotency key is already associated with a different payload.')
      return { event: existing, replayed: true }
    }
    const event = await transaction.appendEvent(adminEvent(input))
    return { event, replayed: false }
  })
}

export async function getManagedSiteContentAdminWorkspace(ownerUserId: number, projectId: number, role: ManagedSiteRole, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), operationsRepository: ContentOperationsRepository = createContentOperationsRepository()) {
  requireRole(role, 'content:read')
  const authority = await contentAuthority(ownerUserId, projectId, managedRepository)
  const workspace = await getOwnerContentOperationsWorkspace(ownerUserId, operationsRepository)
  const clientId = authority.project.contentOperationClientId
  const calendars = workspace.calendars.filter(calendar => calendar.clientId === clientId)
  const calendarIds = new Set(calendars.map(calendar => calendar.id))
  const entries = workspace.entries.filter(entry => calendarIds.has(entry.calendarId))
  const entryIds = new Set(entries.map(entry => entry.id))
  return {
    projectId,
    role,
    clients: workspace.clients.filter(client => client.id === clientId),
    calendars,
    entries,
    runs: workspace.runs.filter(run => entryIds.has(run.entryId)),
    outcomeAssessments: workspace.outcomeAssessments.filter(outcome => entryIds.has(outcome.entryId)),
    publicationTargets: workspace.publicationTargets.filter(target => target.clientId === clientId),
    capabilities: { canRead: true, canRequestRevision: roleAllows(role, 'content:write'), canReview: roleAllows(role, 'content:review'), canExport: roleAllows(role, 'data:export'), canonicalEngine: 'existing-content-operations-only' as const },
    readiness: workspace.readiness,
    limitations: [...workspace.limitations, 'Content Admin is a scoped façade over canonical Content Operations; it does not create a second calendar, draft, review, risk-gate, publication, measurement, or learning engine.'],
  }
}

export async function requestManagedContentRevision(ownerUserId: number, projectId: number, entryId: number, role: ManagedSiteRole, input: { request: string; idempotencyKey: string }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), operationsRepository: ContentOperationsRepository = createContentOperationsRepository()) {
  requireRole(role, 'content:write')
  const request = boundedText(input.request, 'Content revision request', 2000)
  const idempotencyKey = boundedText(input.idempotencyKey, 'Content revision idempotency key', 128)
  const { entry, lineage } = await resolveEntry(ownerUserId, projectId, entryId, managedRepository, operationsRepository)
  const key = { ownerUserId, projectId, entryId, action: 'request_revision', request, idempotencyKey, evidenceSnapshotHash: entry.evidenceSnapshotHash }
  const result = await appendIdempotentEvent(operationsRepository, { ownerUserId, clientId: lineage.client.id, entryId, eventType: 'managed_content_revision_requested', metadata: { projectId, role, request, idempotencyKey, evidenceSnapshotHash: entry.evidenceSnapshotHash, canonicalEntryStatus: entry.status, providerExecution: false }, key })
  return { ...result, projectId, entryId, action: 'revision_request' as const, writesToProvider: false, externalCalls: false, canonicalEvidenceSnapshotHash: entry.evidenceSnapshotHash, limitation: 'Revision request was recorded in canonical Content Operations events; no draft, provider, or customer-site write was executed.' }
}

export async function recordManagedContentReview(ownerUserId: number, projectId: number, entryId: number, role: ManagedSiteRole, input: { decision: 'reviewed' | 'changes_requested'; riskGateStatus: 'passed' | 'needs_human_review' | 'blocked'; note: string; idempotencyKey: string }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), operationsRepository: ContentOperationsRepository = createContentOperationsRepository()) {
  requireRole(role, 'content:review')
  const note = boundedText(input.note, 'Content review note', 2000)
  const idempotencyKey = boundedText(input.idempotencyKey, 'Content review idempotency key', 128)
  const { entry, lineage } = await resolveEntry(ownerUserId, projectId, entryId, managedRepository, operationsRepository)
  const key = { ownerUserId, projectId, entryId, action: 'review', decision: input.decision, riskGateStatus: input.riskGateStatus, note, idempotencyKey, evidenceSnapshotHash: entry.evidenceSnapshotHash }
  const result = await appendIdempotentEvent(operationsRepository, { ownerUserId, clientId: lineage.client.id, entryId, eventType: 'managed_content_review_recorded', metadata: { projectId, role, decision: input.decision, riskGateStatus: input.riskGateStatus, note, idempotencyKey, evidenceSnapshotHash: entry.evidenceSnapshotHash, providerExecution: false, canonicalReviewRowCreated: false, canonicalRiskGateRowCreated: false }, key })
  return { ...result, projectId, entryId, action: 'review' as const, writesToProvider: false, externalCalls: false, canonicalEvidenceSnapshotHash: entry.evidenceSnapshotHash, limitation: 'Review and risk-gate input was recorded as a bounded managed-admin event; canonical publication still requires the existing Content Operations review, risk, and owner-authority lineage.' }
}
