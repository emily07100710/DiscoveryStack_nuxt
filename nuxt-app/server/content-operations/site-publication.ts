import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { checkFirstPartySitePublication, normalizeSitePublicationObservation, type SitePublicationObservation, type SitePublicationStatusDependencies } from '../first-party-publishing/site-publication-status'
import { validateFirstPartyPublishTarget } from '../first-party-publishing/target-guard'
import { draftReceiptFromAttempt } from './draft-receipt'
import { stableFingerprint } from './normalization'
import { createContentOperationsRepository, type ContentOperationsRepository } from './repository'
import type { ContentOperationCalendarEntryRow, ContentOperationCalendarEntryTargetRow, ContentOperationEventRow, ContentOperationPublicationAttemptRow, ContentOperationPublicationTargetRow } from './types'

const VERSION = 'content-operation-site-observation-v1'
export const SITE_PUBLICATION_EVENT = 'site_publication_observed'
export const SITE_PUBLICATION_HISTORY_LIMIT = 500
const HASH = /^[a-f0-9]{64}$/u
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
function fail(statusCode: number): never { throw createError({ statusCode, statusMessage: '網站發布狀態暫時無法核驗，沒有執行發布或授予學習權限。' }) }

export type SitePublicationSummary = {
  state: 'published' | 'private' | 'archived'
  contentMatch: 'matched' | 'changed' | 'unverifiable' | 'not_published'
  observedAt: string
  publishedAt: string | null
  postVersion: number
  publishedVersion: number | null
  hasUnpublishedChanges: boolean
  receiptIsCurrentState: false
}

function data(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return null
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (!property || !property.enumerable || !('value' in property)) return null
      result[key] = property.value
    }
    return result
  } catch { return null }
}

function wireObservation(observation: SitePublicationObservation) {
  const { documentState: _derived, ...wire } = observation
  return wire
}

function summary(observation: SitePublicationObservation): SitePublicationSummary {
  return { state: observation.state, contentMatch: observation.documentState === 'in_sync' ? 'matched' : observation.documentState,
    observedAt: observation.observedAt, publishedAt: observation.publishedAt, postVersion: observation.postVersion,
    publishedVersion: observation.publishedVersion, hasUnpublishedChanges: observation.hasUnpublishedChanges, receiptIsCurrentState: false }
}

/** No publication or learning authority is derived from this read-only context. */
export function sitePublicationContext(entry: ContentOperationCalendarEntryRow, target: ContentOperationPublicationTargetRow, attempts: ContentOperationPublicationAttemptRow[], bindings: ContentOperationCalendarEntryTargetRow[]) {
  try {
    if (entry.ownerUserId !== target.ownerUserId || target.status !== 'active' || target.revokedAt !== null || !target.executionEnabled
      || !target.activeSlot || !HASH.test(target.configurationFingerprint) || ['cancelled', 'skipped'].includes(entry.status)) return null
    const matches = bindings.filter(binding => binding.targetId === target.id)
    if (bindings.length ? matches.length !== 1 || bindings.some(binding => binding.ownerUserId !== entry.ownerUserId || binding.entryId !== entry.id) : entry.publicationTargetId !== target.id) return null
    const attempt = attempts.filter(row => row.targetId === target.id).sort((a, b) => b.id - a.id)[0]
    if (!attempt || attempt.ownerUserId !== entry.ownerUserId || attempt.entryId !== entry.id) return null
    const receipt = draftReceiptFromAttempt(attempt, entry, target)
    if (!receipt) return null
    const guarded = validateFirstPartyPublishTarget({ targetId: target.targetId, ownerScopeKey: `owner-${sha(String(entry.ownerUserId)).slice(0, 32)}`,
      framework: target.framework, transport: target.transport, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot,
      defaultBranch: target.defaultBranch ?? 'main', repositoryOwner: target.repositoryOwner, repositoryName: target.repositoryName,
      endpointPath: target.endpointPath, credentialReference: target.credentialReference, status: target.status,
      allowedContentTypes: target.allowedContentTypes, allowedLanguages: target.allowedLanguages,
      maximumPayloadBytes: target.maximumPayloadBytes, executionEnabled: target.executionEnabled })
    if (guarded.status !== 'valid' || guarded.target.framework !== 'nextjs' || guarded.target.transport !== 'first_party_signed_api') return null
    const contextFingerprint = stableFingerprint({ version: VERSION, ownerUserId: entry.ownerUserId, clientId: target.clientId,
      calendarId: entry.calendarId, entryId: entry.id, jobId: entry.jobId, draftId: entry.draftId, contentHash: entry.contentHash,
      evidenceSnapshotHash: entry.evidenceSnapshotHash, attemptId: attempt.id, runId: attempt.runId,
      attemptInputFingerprint: attempt.inputFingerprint, draftReceiptFingerprint: attempt.receiptFingerprint,
      targetRowId: target.id, targetConfigurationFingerprint: target.configurationFingerprint,
      targetSnapshotFingerprint: stableFingerprint(guarded.target), bindingFingerprint: matches.length ? stableFingerprint(matches[0]) : null })
    return { entry, target, attempt, receipt, publisherTarget: guarded.target, contextFingerprint }
  } catch { return null }
}

type Context = NonNullable<ReturnType<typeof sitePublicationContext>>
type ObservationRecord = { version: string; keyHash: string; contextFingerprint: string; targetRowId: number; attemptId: number; responseFingerprint: string; observation: ReturnType<typeof wireObservation>; recordFingerprint: string }
const RECORD_KEYS = ['version', 'keyHash', 'contextFingerprint', 'targetRowId', 'attemptId', 'responseFingerprint', 'observation', 'recordFingerprint']
const commandFingerprint = (ownerUserId: number, entryId: number, keyHash: string) => stableFingerprint({ version: VERSION, ownerUserId, entryId, keyHash })

function validatedRecord(event: ContentOperationEventRow, context: Context): { record: ObservationRecord; observation: SitePublicationObservation } | null {
  try {
    const raw = data(event.metadata)
    if (!raw || Object.keys(raw).length !== RECORD_KEYS.length || RECORD_KEYS.some(key => !(key in raw)) || raw.version !== VERSION
      || typeof raw.keyHash !== 'string' || !HASH.test(raw.keyHash) || raw.contextFingerprint !== context.contextFingerprint
      || raw.targetRowId !== context.target.id || raw.attemptId !== context.attempt.id
      || typeof raw.responseFingerprint !== 'string' || !HASH.test(raw.responseFingerprint) || typeof raw.recordFingerprint !== 'string' || !HASH.test(raw.recordFingerprint)
      || event.ownerUserId !== context.entry.ownerUserId || event.entryId !== context.entry.id || event.calendarId !== context.entry.calendarId
      || event.clientId !== context.target.clientId || event.runId !== context.attempt.runId || event.eventType !== SITE_PUBLICATION_EVENT
      || event.eventFingerprint !== commandFingerprint(event.ownerUserId, context.entry.id, raw.keyHash)
      || event.contentHash !== context.attempt.publicationContentHash || event.evidenceSnapshotHash !== context.entry.evidenceSnapshotHash) return null
    const { recordFingerprint: _checksum, ...base } = raw
    if (stableFingerprint(base) !== raw.recordFingerprint) return null
    const observation = normalizeSitePublicationObservation(raw.observation)
    if (!observation || observation.targetId !== context.target.targetId || observation.targetOrigin !== context.target.targetOrigin
      || observation.publicationId !== context.receipt.publicationId || observation.postId !== context.receipt.postId || observation.contentHash !== context.receipt.contentHash) return null
    return { record: raw as ObservationRecord, observation }
  } catch { return null }
}

/** Latest verified point-in-time snapshot, never a statement that the site is still in this state now. */
export function projectSitePublicationHistory(context: ReturnType<typeof sitePublicationContext>, events: ContentOperationEventRow[]): SitePublicationSummary | null {
  const latest = latestSitePublicationRecord(context, events)
  return latest ? summary(latest.observation) : null
}

/** Internal evidence reader; the public summary deliberately excludes hashes and nonce. */
export function latestSitePublicationRecord(context: ReturnType<typeof sitePublicationContext>, events: ContentOperationEventRow[]) {
  if (!context || events.length > SITE_PUBLICATION_HISTORY_LIMIT) return null
  if (events.some(event => {
    if (event.eventType !== SITE_PUBLICATION_EVENT) return false
    const raw = data(event.metadata)
    if (!raw || Object.keys(raw).length !== RECORD_KEYS.length || RECORD_KEYS.some(key => !(key in raw))) return true
    const { recordFingerprint, ...base } = raw
    return raw.version !== VERSION || typeof recordFingerprint !== 'string' || stableFingerprint(base) !== recordFingerprint
  })) return null
  const candidates = events.filter(event => event.eventType === SITE_PUBLICATION_EVENT && data(event.metadata)?.targetRowId === context.target.id)
  if (!candidates.length) return null
  const mostRecentlyStored = [...candidates].sort((a, b) => b.id - a.id)[0]!
  if (data(mostRecentlyStored.metadata)?.contextFingerprint !== context.contextFingerprint) return null
  const sameContext = candidates.filter(event => data(event.metadata)?.contextFingerprint === context.contextFingerprint)
  const verified = sameContext.map(event => validatedRecord(event, context))
  // Do not hide corrupt, superseded, or mismatched records behind an older positive observation.
  if (verified.some(value => !value)) return null
  const latest = verified.filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => b.observation.observedAt.localeCompare(a.observation.observedAt) || b.record.responseFingerprint.localeCompare(a.record.responseFingerprint))[0]
  return latest ?? null
}

export async function listSitePublicationHistory(repository: ContentOperationsRepository, ownerUserId: number, entryId: number) {
  const events = repository.listSitePublicationEvents ? await repository.listSitePublicationEvents(ownerUserId, entryId) : await repository.listEvents(ownerUserId, entryId)
  if (!Array.isArray(events) || events.length > SITE_PUBLICATION_HISTORY_LIMIT || (!repository.listSitePublicationEvents && events.length >= SITE_PUBLICATION_HISTORY_LIMIT)) fail(409)
  return events.filter(event => event.eventType === SITE_PUBLICATION_EVENT)
}

export async function loadSitePublicationContext(repository: ContentOperationsRepository, ownerUserId: number, entryId: number, targetRowId: number) {
  const [entry, target] = await Promise.all([repository.findEntry(ownerUserId, entryId), repository.findPublicationTarget(ownerUserId, targetRowId)])
  if (!entry || !target) fail(404)
  const [calendar, client, attempts, bindings] = await Promise.all([repository.findCalendar(ownerUserId, entry.calendarId), repository.findClient(ownerUserId, target.clientId), repository.listPublicationAttempts(ownerUserId, entryId), repository.listEntryTargetBindings(ownerUserId, entryId)])
  if (!calendar || !client || calendar.ownerUserId !== ownerUserId || calendar.clientId !== target.clientId || client.ownerUserId !== ownerUserId || client.status !== 'active') fail(409)
  const context = sitePublicationContext(entry, target, attempts, bindings)
  if (!context) fail(409)
  return context
}

export function parseSitePublicationCheckInput(value: unknown): { targetRowId: number; idempotencyKey: string } {
  const raw = data(value)
  if (!raw || Object.keys(raw).length !== 2 || !('targetRowId' in raw) || !('idempotencyKey' in raw)
    || !Number.isSafeInteger(raw.targetRowId) || (raw.targetRowId as number) < 1 || typeof raw.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/u.test(raw.idempotencyKey)) fail(422)
  return { targetRowId: raw.targetRowId as number, idempotencyKey: raw.idempotencyKey as string }
}

export async function checkOwnerSitePublication(input: { ownerUserId: number; entryId: number; value: unknown; dependencies: SitePublicationStatusDependencies; repository?: ContentOperationsRepository }) {
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1 || !Number.isSafeInteger(input.entryId) || input.entryId < 1) fail(422)
  const raw = parseSitePublicationCheckInput(input.value)
  const repository = input.repository ?? createContentOperationsRepository()
  const targetRowId = raw.targetRowId as number
  const context = await loadSitePublicationContext(repository, input.ownerUserId, input.entryId, targetRowId)
  const keyHash = sha(raw.idempotencyKey as string)
  const eventFingerprint = commandFingerprint(input.ownerUserId, input.entryId, keyHash)
  const events = await listSitePublicationHistory(repository, input.ownerUserId, input.entryId)
  const prior = repository.findSitePublicationEvent ? await repository.findSitePublicationEvent(input.ownerUserId, eventFingerprint) : events.find(event => event.eventFingerprint === eventFingerprint)
  if (prior) {
    const verified = validatedRecord(prior, context)
    if (!verified) fail(409)
    return { status: 'verified' as const, replayed: true, observation: summary(verified.observation), workflowChanged: false, learningAuthorized: false }
  }
  const result = await checkFirstPartySitePublication({ publicationId: context.receipt.publicationId, contentHash: context.receipt.contentHash, postId: context.receipt.postId }, context.publisherTarget, input.dependencies)
  if (result.status !== 'verified') fail(503)
  return repository.transaction(async transaction => {
    const fresh = await loadSitePublicationContext(transaction, input.ownerUserId, input.entryId, targetRowId)
    if (fresh.contextFingerprint !== context.contextFingerprint) fail(409)
    // Recheck the bound history in the same transaction; the remote read never grants a workflow transition.
    const freshEvents = await listSitePublicationHistory(transaction, input.ownerUserId, input.entryId)
    if (freshEvents.some(event => event.eventFingerprint !== eventFingerprint && data(data(event.metadata)?.observation)?.nonce === result.observation.nonce)) fail(409)
    const base = { version: VERSION, keyHash, contextFingerprint: context.contextFingerprint, targetRowId, attemptId: context.attempt.id,
      responseFingerprint: result.responseFingerprint, observation: wireObservation(result.observation) }
    const stored = await transaction.appendEvent({ ownerUserId: input.ownerUserId, clientId: context.target.clientId,
      calendarId: context.entry.calendarId, entryId: context.entry.id, runId: context.attempt.runId, eventType: SITE_PUBLICATION_EVENT,
      fromStatus: null, toStatus: null, eventFingerprint, metadata: { ...base, recordFingerprint: stableFingerprint(base) },
      websiteId: context.target.websiteId ?? null, deliverableId: context.entry.productionDeliverableId, draftId: context.entry.draftId,
      routingPlanId: context.attempt.routingPlanId ?? null, routeId: context.attempt.routeId ?? null,
      executorRunId: context.attempt.executorRunId ?? null, contentHash: context.attempt.publicationContentHash ?? null,
      evidenceSnapshotHash: context.entry.evidenceSnapshotHash, authorityReference: null })
    const verified = validatedRecord(stored, fresh)
    if (!verified) fail(409)
    return { status: 'verified' as const, replayed: verified.record.responseFingerprint !== result.responseFingerprint,
      observation: summary(verified.observation), workflowChanged: false, learningAuthorized: false }
  })
}
