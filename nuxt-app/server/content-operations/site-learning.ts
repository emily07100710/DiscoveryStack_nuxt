import { createError } from 'h3'
import { fingerprint } from '../geo-outcome-model/canonical'
import { assessPublishedContentOutcome } from '../outcome-learning/engine'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../outcome-learning/policy-catalog'
import { buildContentLearningDataset, scanOutcomeLearningPii } from '../outcome-learning/content-learning-runtime'
import { resolveLearningAuthority } from '../learning-loop/authority'
import type { LearningLoopRepository } from '../learning-loop/types'
import { stableFingerprint } from './normalization'
import type { ContentOperationsRepository } from './repository'
import type { ContentOperationEventRow, ContentOperationOutcomeAssessmentRow } from './types'
import type { ConfirmedSiteMeasurementLineage } from './site-measurement'

const EVENT_OPT_IN = 'site_learning_opt_in'
const EVENT_REVOKED = 'site_learning_revoked'
const EVENT_REVIEWED = 'site_learning_outcome_reviewed'
const PROOF_VERSION = 'site-learning-collection-proof-v1' as const
const HASH = /^[a-f0-9]{64}$/u
const KEY = /^[A-Za-z0-9_.:-]{8,128}$/u
const LIMIT_ENTRIES = 20
const LIMIT_OUTCOMES = 500

export type SiteLearningOptions = {
  operations: ContentOperationsRepository
  learning: LearningLoopRepository
  resolveSiteLineages: (ownerUserId: number, entryId: number, context: { fresh: boolean; repository?: ContentOperationsRepository }) => Promise<ConfirmedSiteMeasurementLineage[]>
  now: Date | (() => Date)
}

export type SiteLearningCollectionProof = {
  contractVersion: typeof PROOF_VERSION
  grantFingerprint: string
  confirmationFingerprint: string
  authorizationId: number
  authorizationFingerprint: string
  sourceFingerprint: string
  grantedAt: string
  approvedAt: string
  expiresAt: string
  retentionDays: number
  consentVersion: string
}

type GrantEvent = {
  version: typeof PROOF_VERSION
  event: 'opt_in'
  grantFingerprint: string
  idempotencyKeyHash: string
  targetRowId: number
  clientId: number
  confirmationFingerprint: string
  authorizationId: number
  authorizationFingerprint: string
  sourceFingerprint: string
  consentVersion: string
  approvedAt: string
  expiresAt: string
  retentionDays: number
  grantedAt: string
  recordFingerprint: string
}

type RevocationEvent = { version: typeof PROOF_VERSION; event: 'revoke'; grantFingerprint: string; idempotencyKeyHash: string; revokedAt: string; recordFingerprint: string }
type ReviewEvent = { version: typeof PROOF_VERSION; event: 'review'; outcomeId: number; assessmentFingerprint: string; grantFingerprint: string; collectionProofFingerprint: string; decision: 'approve' | 'reject'; piiReviewed: boolean; limitationsUnderstood: boolean; idempotencyKeyHash: string; reviewedAt: string; recordFingerprint: string }

function fail(statusCode = 409): never {
  throw createError({ statusCode, statusMessage: '網站觀察的學習權限或證據目前無法核對。', data: { code: 'SITE_LEARNING_BLOCKED' } })
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return null
      out[key] = descriptor.value
    }
    return out
  } catch { return null }
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = safeRecord(value)
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) fail(422)
  return row
}

function clock(options: SiteLearningOptions): Date {
  const value = typeof options.now === 'function' ? options.now() : options.now
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail()
  return value
}

function validId(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function eventMetadata(event: ContentOperationEventRow): Record<string, unknown> | null { return safeRecord(event.metadata) }
function eventRecordFingerprint(body: Record<string, unknown>, event: Pick<ContentOperationEventRow, 'ownerUserId'|'entryId'|'clientId'|'calendarId'>) {
  return fingerprint({ body, ownerUserId: event.ownerUserId, entryId: event.entryId, clientId: event.clientId, calendarId: event.calendarId })
}
function repository(options: SiteLearningOptions) { return options.operations }
function sameLineage(left: ConfirmedSiteMeasurementLineage, right: ConfirmedSiteMeasurementLineage): boolean {
  return left.ownerUserId === right.ownerUserId && left.entryId === right.entryId && left.targetId === right.targetId && left.clientId === right.clientId
    && left.confirmationFingerprint === right.confirmationFingerprint && left.contentHash === right.contentHash && left.evidenceSnapshotHash === right.evidenceSnapshotHash
    && left.publicationReceiptFingerprint === right.publicationReceiptFingerprint && left.canonicalPage === right.canonicalPage
    && left.timeZone === right.timeZone && left.publicationLocalDate === right.publicationLocalDate
    && left.publishedAt.getTime() === right.publishedAt.getTime() && left.calendarId === right.calendarId
    && left.draftId === right.draftId && left.draftVersion === right.draftVersion && left.jobId === right.jobId
    && left.productionPlanId === right.productionPlanId && left.scheduleKey === right.scheduleKey
    && left.contentType === right.contentType && left.language === right.language
    && fingerprint(left.appliedRuleIds) === fingerprint(right.appliedRuleIds) && left.topicClusterCode === right.topicClusterCode
}

function publicationMatchesLineage(row: ContentOperationOutcomeAssessmentRow, lineage: ConfirmedSiteMeasurementLineage, publication: unknown): boolean {
  const identity = safeRecord(publication)
  const appliedRuleIds = identity && Array.isArray(identity.appliedRuleIds) && identity.appliedRuleIds.every(value => typeof value === 'string')
    ? identity.appliedRuleIds as string[] : null
  if (!identity || !appliedRuleIds || row.ownerUserId !== lineage.ownerUserId || row.entryId !== lineage.entryId || row.targetId !== lineage.targetId
    || row.draftId !== lineage.draftId || row.publicationReceiptFingerprint !== lineage.confirmationFingerprint || row.publishedUrl !== lineage.canonicalPage
    || row.contentHash !== lineage.contentHash || row.evidenceSnapshotHash !== lineage.evidenceSnapshotHash
    || identity.productionPlanId !== String(lineage.productionPlanId) || identity.jobId !== String(lineage.jobId)
    || identity.draftId !== String(lineage.draftId) || identity.draftVersion !== String(lineage.draftVersion)
    || identity.scheduleKey !== lineage.scheduleKey || identity.contentHash !== lineage.contentHash
    || identity.evidenceSnapshotHash !== lineage.evidenceSnapshotHash || identity.publishedAt !== lineage.publishedAt.toISOString()
    || identity.contentType !== lineage.contentType || identity.language !== lineage.language
    || fingerprint(appliedRuleIds) !== fingerprint(lineage.appliedRuleIds) || identity.topicClusterCode !== lineage.topicClusterCode) return false
  return true
}

async function currentAuthority(ownerUserId: number, lineage: ConfirmedSiteMeasurementLineage, authorizationId: number, expectedFingerprint: string, options: SiteLearningOptions, at: Date) {
  if (!validId(authorizationId) || !HASH.test(expectedFingerprint) || lineage.ownerUserId !== ownerUserId || !validId(lineage.clientId) || !validId(lineage.targetId)
    || !HASH.test(lineage.confirmationFingerprint) || !lineage.canonicalPage || !lineage.publishedAt || !Number.isFinite(lineage.publishedAt.getTime())) return null
  const scope = await options.learning.getScope(ownerUserId, authorizationId)
  if (!scope || scope.authorization.authorizationFingerprint !== expectedFingerprint || scope.authorization.clientId !== lineage.clientId) return null
  let pageOrigin: string
  try { pageOrigin = new URL(lineage.canonicalPage).origin } catch { return null }
  const authority = resolveLearningAuthority(scope, { ownerUserId, clientId: lineage.clientId, sourceId: scope.authorization.sourceId }, at)
  if (!authority || scope.authorization.authorizedOrigin !== pageOrigin || authority.sourceFingerprint !== fingerprint(scope.source)
    || new URL(scope.client.canonicalSiteOrigin).origin !== pageOrigin) return null
  return { scope, authority }
}

function parseGrant(event: ContentOperationEventRow): GrantEvent | null {
  const metadata = eventMetadata(event)
  const keys = ['version','event','grantFingerprint','idempotencyKeyHash','targetRowId','clientId','confirmationFingerprint','authorizationId','authorizationFingerprint','sourceFingerprint','consentVersion','approvedAt','expiresAt','retentionDays','grantedAt','recordFingerprint']
  if (!metadata || Object.keys(metadata).length !== keys.length || keys.some(key => !Object.hasOwn(metadata, key)) || metadata.version !== PROOF_VERSION || metadata.event !== 'opt_in'
    || !HASH.test(String(metadata.grantFingerprint)) || !HASH.test(String(metadata.idempotencyKeyHash)) || !validId(metadata.targetRowId) || !validId(metadata.clientId)
    || !HASH.test(String(metadata.confirmationFingerprint)) || !validId(metadata.authorizationId) || !HASH.test(String(metadata.authorizationFingerprint)) || !HASH.test(String(metadata.sourceFingerprint))
    || typeof metadata.consentVersion !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/u.test(metadata.consentVersion) || !iso(metadata.approvedAt) || !iso(metadata.expiresAt) || !iso(metadata.grantedAt)
    || !Number.isSafeInteger(metadata.retentionDays) || (metadata.retentionDays as number) < 1 || (metadata.retentionDays as number) > 30 || !HASH.test(String(metadata.recordFingerprint))
    || event.eventType !== EVENT_OPT_IN || !validId(event.ownerUserId) || !validId(event.entryId) || event.clientId !== metadata.clientId
    || event.eventFingerprint !== fingerprint({ event: EVENT_OPT_IN, ownerUserId: event.ownerUserId, entryId: event.entryId, keyHash: metadata.idempotencyKeyHash })) return null
  const { recordFingerprint, ...body } = metadata
  if (eventRecordFingerprint(body, event) !== recordFingerprint || fingerprint({ contractVersion: PROOF_VERSION, ownerUserId: event.ownerUserId, entryId: event.entryId, targetRowId: metadata.targetRowId,
    confirmationFingerprint: metadata.confirmationFingerprint, authorizationId: metadata.authorizationId, authorizationFingerprint: metadata.authorizationFingerprint,
    sourceFingerprint: metadata.sourceFingerprint, consentVersion: metadata.consentVersion, approvedAt: metadata.approvedAt, expiresAt: metadata.expiresAt,
    retentionDays: metadata.retentionDays, keyHash: metadata.idempotencyKeyHash }) !== metadata.grantFingerprint) return null
  return metadata as unknown as GrantEvent
}

function parseRevocation(event: ContentOperationEventRow): RevocationEvent | null {
  const row = eventMetadata(event), keys = ['version','event','grantFingerprint','idempotencyKeyHash','revokedAt','recordFingerprint']
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.version !== PROOF_VERSION || row.event !== 'revoke'
    || !HASH.test(String(row.grantFingerprint)) || !HASH.test(String(row.idempotencyKeyHash)) || !iso(row.revokedAt) || !HASH.test(String(row.recordFingerprint))
    || event.eventType !== EVENT_REVOKED || !validId(event.ownerUserId) || !validId(event.entryId)
    || event.eventFingerprint !== fingerprint({ event: EVENT_REVOKED, ownerUserId: event.ownerUserId, entryId: event.entryId, grantFingerprint: row.grantFingerprint, keyHash: row.idempotencyKeyHash })) return null
  const { recordFingerprint, ...body } = row
  if (eventRecordFingerprint(body, event) !== recordFingerprint) return null
  return row as unknown as RevocationEvent
}

function parseReview(event: ContentOperationEventRow): ReviewEvent | null {
  const row = eventMetadata(event), keys = ['version','event','outcomeId','assessmentFingerprint','grantFingerprint','collectionProofFingerprint','decision','piiReviewed','limitationsUnderstood','idempotencyKeyHash','reviewedAt','recordFingerprint']
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.version !== PROOF_VERSION || row.event !== 'review'
    || !validId(row.outcomeId) || !HASH.test(String(row.assessmentFingerprint)) || !HASH.test(String(row.grantFingerprint)) || !HASH.test(String(row.collectionProofFingerprint))
    || !['approve','reject'].includes(String(row.decision)) || typeof row.piiReviewed !== 'boolean' || typeof row.limitationsUnderstood !== 'boolean' || !HASH.test(String(row.idempotencyKeyHash)) || !iso(row.reviewedAt)
    || !HASH.test(String(row.recordFingerprint)) || event.eventType !== EVENT_REVIEWED || !validId(event.ownerUserId) || !validId(event.entryId)
    || event.eventFingerprint !== fingerprint({ event: EVENT_REVIEWED, ownerUserId: event.ownerUserId, entryId: event.entryId, outcomeId: row.outcomeId, keyHash: row.idempotencyKeyHash })) return null
  const { recordFingerprint, ...body } = row
  if (eventRecordFingerprint(body, event) !== recordFingerprint) return null
  return row as unknown as ReviewEvent
}

async function siteLineage(ownerUserId: number, entryId: number, targetRowId: number, options: SiteLearningOptions, fresh: boolean, db: ContentOperationsRepository) {
  const lineages = await options.resolveSiteLineages(ownerUserId, entryId, { fresh, repository: db })
  if (!Array.isArray(lineages) || lineages.length > 20) return null
  const matches = lineages.filter(row => row.ownerUserId === ownerUserId && row.entryId === entryId && row.targetId === targetRowId)
  return matches.length === 1 ? matches[0]! : null
}

async function eventsFor(db: ContentOperationsRepository, ownerUserId: number, entryId: number): Promise<ContentOperationEventRow[]> {
  if (!db.listSiteLearningEvents) return []
  const rows = await db.listSiteLearningEvents(ownerUserId, entryId)
  if (!Array.isArray(rows) || rows.length > 500 || rows.some(row => row.ownerUserId !== ownerUserId || row.entryId !== entryId
    || !validId(row.id) || !validId(row.clientId) || !validId(row.calendarId))) fail()
  return rows
}

function latestRevocation(events: ContentOperationEventRow[], grantFingerprint: string) {
  const revokes = events.filter(event => event.eventType === EVENT_REVOKED).map(parseRevocation)
  if (revokes.some(event => !event)) return { corrupt: true, revoked: true }
  return { corrupt: false, revoked: revokes.some(event => event?.grantFingerprint === grantFingerprint) }
}

async function proofForLineage(ownerUserId: number, lineage: ConfirmedSiteMeasurementLineage, options: SiteLearningOptions, db: ContentOperationsRepository, at: Date): Promise<SiteLearningCollectionProof | null> {
  const events = await eventsFor(db, ownerUserId, lineage.entryId)
  const grants = events.filter(event => event.eventType === EVENT_OPT_IN).map(parseGrant)
  if (grants.some(grant => !grant)) return null
  const candidates = (grants as GrantEvent[]).map(grant => ({ grant, event: events.find(event => event.eventFingerprint === fingerprint({ event: EVENT_OPT_IN, ownerUserId, entryId: lineage.entryId, keyHash: grant.idempotencyKeyHash }))! }))
    .filter(item => item.grant.targetRowId === lineage.targetId && item.grant.clientId === lineage.clientId && item.grant.confirmationFingerprint === lineage.confirmationFingerprint)
    .sort((a, b) => b.event.id - a.event.id)
  const latest = candidates[0]
  if (!latest) return null
  if (events.some(event => event.calendarId !== lineage.calendarId || event.clientId !== lineage.clientId)) return null
  const { grant } = latest, revoke = latestRevocation(events, grant.grantFingerprint)
  if (revoke.corrupt || revoke.revoked || Date.parse(grant.expiresAt) <= at.getTime() || Date.parse(grant.grantedAt) > at.getTime()) return null
  const authority = await currentAuthority(ownerUserId, lineage, grant.authorizationId, grant.authorizationFingerprint, options, at)
  if (!authority || authority.authority.sourceFingerprint !== grant.sourceFingerprint || authority.scope.authorization.consentVersion !== grant.consentVersion
    || authority.scope.authorization.approvedAt.toISOString() !== grant.approvedAt || authority.scope.authorization.expiresAt.toISOString() !== grant.expiresAt
    || authority.scope.authorization.retentionDays !== grant.retentionDays) return null
  return { contractVersion: PROOF_VERSION, grantFingerprint: grant.grantFingerprint, confirmationFingerprint: grant.confirmationFingerprint,
    authorizationId: grant.authorizationId, authorizationFingerprint: grant.authorizationFingerprint, sourceFingerprint: grant.sourceFingerprint,
    grantedAt: grant.grantedAt, approvedAt: grant.approvedAt, expiresAt: grant.expiresAt, retentionDays: grant.retentionDays, consentVersion: grant.consentVersion }
}

export async function recordSiteLearningOptIn(ownerUserId: number, entryId: number, value: unknown, options: SiteLearningOptions) {
  const row = exact(value, ['targetRowId','expectedConfirmationFingerprint','authorizationId','expectedAuthorizationFingerprint','customerEvidenceConfirmed','scopeConfirmed','idempotencyKey'])
  if (!validId(ownerUserId) || !validId(entryId) || !validId(row.targetRowId) || !HASH.test(String(row.expectedConfirmationFingerprint)) || !validId(row.authorizationId)
    || !HASH.test(String(row.expectedAuthorizationFingerprint)) || row.customerEvidenceConfirmed !== true || row.scopeConfirmed !== true || typeof row.idempotencyKey !== 'string' || !KEY.test(row.idempotencyKey)) fail(422)
  const db = repository(options), now = clock(options), lineage = await siteLineage(ownerUserId, entryId, row.targetRowId as number, options, true, db)
  if (!lineage || lineage.confirmationFingerprint !== row.expectedConfirmationFingerprint) fail()
  const authority = await currentAuthority(ownerUserId, lineage, row.authorizationId as number, row.expectedAuthorizationFingerprint as string, options, now)
  if (!authority) fail()
  const keyHash = fingerprint({ contractVersion: PROOF_VERSION, key: row.idempotencyKey })
  const grantFingerprint = fingerprint({ contractVersion: PROOF_VERSION, ownerUserId, entryId, targetRowId: lineage.targetId,
    confirmationFingerprint: lineage.confirmationFingerprint, authorizationId: authority.scope.authorization.id,
    authorizationFingerprint: authority.scope.authorization.authorizationFingerprint, sourceFingerprint: authority.authority.sourceFingerprint,
    consentVersion: authority.scope.authorization.consentVersion, approvedAt: authority.scope.authorization.approvedAt.toISOString(),
    expiresAt: authority.scope.authorization.expiresAt.toISOString(), retentionDays: authority.scope.authorization.retentionDays, keyHash })
  const eventFingerprint = fingerprint({ event: EVENT_OPT_IN, ownerUserId, entryId, keyHash })
  const dbEvents = await eventsFor(db, ownerUserId, entryId), priorKey = dbEvents.find(event => parseGrant(event)?.idempotencyKeyHash === keyHash)
  if (priorKey) {
    const prior = parseGrant(priorKey)
    if (!prior || prior.grantFingerprint !== grantFingerprint) fail()
    const revoked = latestRevocation(dbEvents, prior.grantFingerprint)
    if (revoked.corrupt || revoked.revoked) fail()
    return { state: 'granted' as const, replayed: true, grantFingerprint: prior.grantFingerprint }
  }
  return db.transaction(async tx => {
    const currentLineage = await siteLineage(ownerUserId, entryId, lineage.targetId, options, true, tx)
    const currentAuthorityRow = currentLineage && sameLineage(currentLineage, lineage) ? await currentAuthority(ownerUserId, currentLineage, row.authorizationId as number, row.expectedAuthorizationFingerprint as string, options, clock(options)) : null
    if (!currentLineage || !currentAuthorityRow || currentAuthorityRow.authority.sourceFingerprint !== authority.authority.sourceFingerprint) fail()
    const events = await eventsFor(tx, ownerUserId, entryId)
    if (events.some(event => event.eventFingerprint === eventFingerprint)) fail()
    const grantedAt = clock(options).toISOString()
    const grantBase = { version: PROOF_VERSION, event: 'opt_in' as const, grantFingerprint, idempotencyKeyHash: keyHash, targetRowId: lineage.targetId, clientId: lineage.clientId,
      confirmationFingerprint: lineage.confirmationFingerprint, authorizationId: authority.scope.authorization.id, authorizationFingerprint: authority.scope.authorization.authorizationFingerprint,
      sourceFingerprint: authority.authority.sourceFingerprint, consentVersion: authority.scope.authorization.consentVersion, approvedAt: authority.scope.authorization.approvedAt.toISOString(),
      expiresAt: authority.scope.authorization.expiresAt.toISOString(), retentionDays: authority.scope.authorization.retentionDays, grantedAt }
    const grant: GrantEvent = { ...grantBase, recordFingerprint: eventRecordFingerprint(grantBase, { ownerUserId, entryId, clientId: lineage.clientId, calendarId: lineage.calendarId }) }
    const stored = await tx.appendEvent({ ownerUserId, clientId: lineage.clientId, calendarId: lineage.calendarId, entryId, runId: null, eventType: EVENT_OPT_IN,
      fromStatus: null, toStatus: null, eventFingerprint, contentHash: null, evidenceSnapshotHash: null, authorityReference: null, metadata: grant })
    if (parseGrant(stored)?.grantFingerprint !== grantFingerprint) fail()
    return { state: 'granted' as const, replayed: false, grantFingerprint }
  })
}

export async function revokeSiteLearningOptIn(ownerUserId: number, entryId: number, value: unknown, options: SiteLearningOptions) {
  const row = exact(value, ['targetRowId','expectedGrantFingerprint','confirmed','idempotencyKey'])
  if (!validId(ownerUserId) || !validId(entryId) || !validId(row.targetRowId) || !HASH.test(String(row.expectedGrantFingerprint)) || row.confirmed !== true
    || typeof row.idempotencyKey !== 'string' || !KEY.test(row.idempotencyKey)) fail(422)
  const db = repository(options), now = clock(options), events = await eventsFor(db, ownerUserId, entryId)
  const grantEvent = events.find(event => event.eventType === EVENT_OPT_IN && parseGrant(event)?.grantFingerprint === row.expectedGrantFingerprint)
  const grant = grantEvent && parseGrant(grantEvent)
  if (!grant || grant.targetRowId !== row.targetRowId) fail()
  const keyHash = fingerprint({ contractVersion: PROOF_VERSION, key: row.idempotencyKey })
  const eventFingerprint = fingerprint({ event: EVENT_REVOKED, ownerUserId, entryId, grantFingerprint: grant.grantFingerprint, keyHash })
  const prior = events.find(event => event.eventFingerprint === eventFingerprint)
  if (prior) {
    const parsed = parseRevocation(prior)
    if (!parsed || parsed.grantFingerprint !== grant.grantFingerprint || parsed.idempotencyKeyHash !== keyHash) fail()
    return { state: 'revoked' as const, replayed: true, grantFingerprint: grant.grantFingerprint }
  }
  return db.transaction(async tx => {
    const current = await eventsFor(tx, ownerUserId, entryId)
    if (!current.some(event => event.eventFingerprint === grantEvent!.eventFingerprint)) fail()
    const revokeBase = { version: PROOF_VERSION, event: 'revoke' as const, grantFingerprint: grant.grantFingerprint, idempotencyKeyHash: keyHash, revokedAt: now.toISOString() }
    const metadata: RevocationEvent = { ...revokeBase, recordFingerprint: eventRecordFingerprint(revokeBase, { ownerUserId, entryId, clientId: grant.clientId, calendarId: grantEvent!.calendarId }) }
    const stored = await tx.appendEvent({ ownerUserId, clientId: grant.clientId, calendarId: grantEvent!.calendarId, entryId, runId: null, eventType: EVENT_REVOKED,
      fromStatus: null, toStatus: null, eventFingerprint, authorityReference: null, metadata })
    if (parseRevocation(stored)?.grantFingerprint !== grant.grantFingerprint) fail()
    return { state: 'revoked' as const, replayed: false, grantFingerprint: grant.grantFingerprint }
  })
}

export async function resolveSiteLearningCollectionProof(ownerUserId: number, lineage: ConfirmedSiteMeasurementLineage, options: SiteLearningOptions, context: { repository?: ContentOperationsRepository } = {}) {
  if (!validId(ownerUserId) || lineage.ownerUserId !== ownerUserId) return null
  const db = context.repository || repository(options)
  const current = await siteLineage(ownerUserId, lineage.entryId, lineage.targetId, options, false, db)
  if (!current || !sameLineage(current, lineage)) return null
  return proofForLineage(ownerUserId, current, options, db, clock(options))
}

function collectionProof(value: unknown): SiteLearningCollectionProof | null {
  const row = safeRecord(value), keys = ['contractVersion','grantFingerprint','confirmationFingerprint','authorizationId','authorizationFingerprint','sourceFingerprint','grantedAt','approvedAt','expiresAt','retentionDays','consentVersion']
  if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.contractVersion !== PROOF_VERSION
    || !HASH.test(String(row.grantFingerprint)) || !HASH.test(String(row.confirmationFingerprint)) || !validId(row.authorizationId) || !HASH.test(String(row.authorizationFingerprint))
    || !HASH.test(String(row.sourceFingerprint)) || !iso(row.grantedAt) || !iso(row.approvedAt) || !iso(row.expiresAt) || !Number.isSafeInteger(row.retentionDays)
    || (row.retentionDays as number) < 1 || (row.retentionDays as number) > 30 || typeof row.consentVersion !== 'string') return null
  return row as unknown as SiteLearningCollectionProof
}

function snapshotProof(snapshot: unknown): SiteLearningCollectionProof | null {
  const row = safeRecord(snapshot), provenance = row && safeRecord(row.providerProvenance)
  return collectionProof(provenance?.siteLearningCollectionProof)
}

function normalizedSnapshot(snapshot: unknown): Record<string, unknown> | null {
  const row = safeRecord(snapshot)
  const fields = ['source','deidentifiedSubjectKey','scopeFingerprint','phase','windowStart','windowEnd','capturedAt','sourceHash','metrics']
  if (!row || !Object.hasOwn(row, 'providerProvenance') || Object.keys(row).length !== fields.length + 1 || fields.some(key => !Object.hasOwn(row, key))) return null
  const provenance = safeRecord(row.providerProvenance)
  if (!provenance || Object.keys(provenance).length !== 1 || !Object.hasOwn(provenance, 'siteLearningCollectionProof') || !collectionProof(provenance.siteLearningCollectionProof)) return null
  return Object.fromEntries(fields.map(key => [key, row[key]]))
}

function siteAssessment(row: ContentOperationOutcomeAssessmentRow, now?: Date): { publication: unknown; assessment: Record<string, unknown>; baseline: unknown[]; followUp: unknown[]; proof: SiteLearningCollectionProof } | null {
  const saved = safeRecord(row.assessmentSnapshot), publication = saved && safeRecord(saved.publication), baselineRaw = Array.isArray(row.baselineSnapshot) ? row.baselineSnapshot : null,
    followUpRaw = Array.isArray(row.followUpSnapshot) ? row.followUpSnapshot : null, proof = saved && collectionProof(saved.siteLearningCollectionProof)
  if (!saved || !publication || !baselineRaw || !followUpRaw || !proof || saved.evidenceKind !== 'site_publication_confirmation' || saved.learningCandidate !== false
    || row.runId !== null || row.targetId !== proofTarget(saved) || row.publicationReceiptFingerprint !== proof.confirmationFingerprint || row.assessmentFingerprint !== stableFingerprint(saved)
    || saved.confirmationFingerprint !== proof.confirmationFingerprint || row.contentHash !== publication.contentHash || row.evidenceSnapshotHash !== publication.evidenceSnapshotHash) return null
  const baseline = baselineRaw.map(normalizedSnapshot), followUp = followUpRaw.map(normalizedSnapshot)
  if (baseline.some(value => !value) || followUp.some(value => !value)) return null
  const baseRequest = { publication, baselineMeasurements: baseline, followUpMeasurements: followUp, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
  let assessed
  try { assessed = assessPublishedContentOutcome(baseRequest) } catch { return null }
  // The persisted row fingerprint covers the full site-specific snapshot above;
  // the assessment engine fingerprint covers only its base assessment payload.
  if (assessed.assessmentFingerprint !== saved.assessmentFingerprint) return null
  if (baseline.length < 1 || followUp.length < 1 || !(row.measuredAt instanceof Date) || !Number.isFinite(row.measuredAt.getTime())
    || row.measuredAt.getTime() < Date.parse(proof.grantedAt) || row.measuredAt.getTime() < Date.parse(proof.approvedAt)
    || (now && (row.measuredAt > now || row.measuredAt.getTime() + proof.retentionDays * 86_400_000 <= now.getTime() || Date.parse(proof.expiresAt) <= now.getTime()))
    || baselineRaw.some(snapshot => snapshotProof(snapshot)?.grantFingerprint !== proof.grantFingerprint || snapshotProof(snapshot)?.confirmationFingerprint !== proof.confirmationFingerprint || fingerprint(snapshotProof(snapshot)) !== fingerprint(proof))
    || followUpRaw.some(snapshot => snapshotProof(snapshot)?.grantFingerprint !== proof.grantFingerprint || snapshotProof(snapshot)?.confirmationFingerprint !== proof.confirmationFingerprint || fingerprint(snapshotProof(snapshot)) !== fingerprint(proof))
    || !iso(proof.grantedAt) || [...baselineRaw, ...followUpRaw].some((snapshot, index) => {
      const item = safeRecord(snapshot), expectedPhase = index < baseline.length ? 'baseline' : 'follow_up'
      if (!item || item.phase !== expectedPhase || !iso(item.capturedAt) || !iso(item.windowEnd)) return true
      const capturedAt = Date.parse(item.capturedAt)
      return capturedAt < Date.parse(proof.grantedAt) || capturedAt < Date.parse(proof.approvedAt) || capturedAt < Date.parse(item.windowEnd)
        || capturedAt > row.measuredAt.getTime() || Boolean(now && (capturedAt > now.getTime() || capturedAt + proof.retentionDays * 86_400_000 <= now.getTime()))
    })) return null
  return { publication, assessment: assessed as unknown as Record<string, unknown>, baseline, followUp, proof }
}

function proofTarget(saved: Record<string, unknown>): unknown { return saved.targetId }

function parseReviewInput(value: unknown) {
  const row = exact(value, ['expectedAssessmentFingerprint','expectedGrantFingerprint','decision','piiReviewed','limitationsUnderstood','idempotencyKey'])
  if (!HASH.test(String(row.expectedAssessmentFingerprint)) || !HASH.test(String(row.expectedGrantFingerprint)) || !['approve','reject'].includes(String(row.decision))
    || typeof row.piiReviewed !== 'boolean' || typeof row.limitationsUnderstood !== 'boolean' || typeof row.idempotencyKey !== 'string' || !KEY.test(row.idempotencyKey)
    || (row.decision === 'approve' && (row.piiReviewed !== true || row.limitationsUnderstood !== true))) fail(422)
  return row as { expectedAssessmentFingerprint: string; expectedGrantFingerprint: string; decision: 'approve'|'reject'; piiReviewed: boolean; limitationsUnderstood: boolean; idempotencyKey: string }
}

function consentFor(proof: SiteLearningCollectionProof) { return { consentStatus: 'granted', consentVersion: proof.consentVersion, consentedAt: proof.approvedAt,
  consentAllowedUses: ['model_improvement', 'evaluation'], consentRevokedAt: null, rightsConfirmed: true } }

async function findOutcome(ownerUserId: number, outcomeId: number, options: SiteLearningOptions) {
  const outcomes = await options.operations.listOutcomes(ownerUserId, LIMIT_OUTCOMES + 1)
  if (outcomes.length > LIMIT_OUTCOMES) fail()
  return outcomes.find(row => row.id === outcomeId && row.ownerUserId === ownerUserId) || null
}

async function proofMatchesCurrent(ownerUserId: number, row: ContentOperationOutcomeAssessmentRow, options: SiteLearningOptions, fresh: boolean) {
  if (!validId(row.entryId) || !validId(row.targetId)) return null
  const lineage = await siteLineage(ownerUserId, row.entryId, row.targetId, options, fresh, repository(options))
  const saved = siteAssessment(row, clock(options))
  if (!lineage || !saved || lineage.confirmationFingerprint !== saved.proof.confirmationFingerprint || !publicationMatchesLineage(row, lineage, saved.publication)) return null
  const proof = await proofForLineage(ownerUserId, lineage, options, repository(options), clock(options))
  if (!proof || fingerprint(proof) !== fingerprint(saved.proof)) return null
  return { lineage, proof, saved }
}

export async function reviewSiteLearningOutcome(ownerUserId: number, outcomeId: number, value: unknown, options: SiteLearningOptions) {
  const input = parseReviewInput(value), db = repository(options), now = clock(options), outcome = await findOutcome(ownerUserId, outcomeId, options)
  if (!outcome || outcome.assessmentFingerprint !== input.expectedAssessmentFingerprint || !validId(outcome.entryId)) fail()
  const current = await proofMatchesCurrent(ownerUserId, outcome, options, true)
  if (!current || current.proof.grantFingerprint !== input.expectedGrantFingerprint) fail()
  const pii = scanOutcomeLearningPii({ publication: current.saved.publication, assessment: current.saved.assessment, baselineMeasurements: current.saved.baseline, followUpMeasurements: current.saved.followUp })
  if (pii.status !== 'none_detected' || (input.decision === 'approve' && (!input.piiReviewed || !input.limitationsUnderstood))) fail()
  const events = await eventsFor(db, ownerUserId, outcome.entryId), reviews = events.filter(event => event.eventType === EVENT_REVIEWED).map(parseReview)
  if (reviews.some(review => !review)) fail()
  const priorReject = (reviews as ReviewEvent[]).some(review => review.outcomeId === outcomeId && review.decision === 'reject')
  if (input.decision === 'approve' && priorReject) fail()
  const keyHash = fingerprint({ contractVersion: PROOF_VERSION, key: input.idempotencyKey }), eventFingerprint = fingerprint({ event: EVENT_REVIEWED, ownerUserId, entryId: outcome.entryId, outcomeId, keyHash })
  const prior = events.find(event => event.eventFingerprint === eventFingerprint)
  if (prior) {
    const parsed = parseReview(prior)
    if (!parsed || parsed.assessmentFingerprint !== input.expectedAssessmentFingerprint || parsed.grantFingerprint !== input.expectedGrantFingerprint || parsed.decision !== input.decision) fail()
    return { state: parsed.decision === 'approve' ? 'approved' as const : 'rejected' as const, replayed: true, reviewFingerprint: fingerprint(parsed) }
  }
  const reviewBase = { version: PROOF_VERSION, event: 'review' as const, outcomeId, assessmentFingerprint: outcome.assessmentFingerprint,
    grantFingerprint: current.proof.grantFingerprint, collectionProofFingerprint: fingerprint(current.proof), decision: input.decision,
    piiReviewed: input.piiReviewed, limitationsUnderstood: input.limitationsUnderstood, idempotencyKeyHash: keyHash, reviewedAt: now.toISOString() }
  const review: ReviewEvent = { ...reviewBase, recordFingerprint: eventRecordFingerprint(reviewBase, { ownerUserId, entryId: outcome.entryId, clientId: current.lineage.clientId, calendarId: current.lineage.calendarId }) }
  return db.transaction(async tx => {
    const reread = await findOutcome(ownerUserId, outcomeId, { ...options, operations: tx })
    const fresh = reread && reread.assessmentFingerprint === outcome.assessmentFingerprint ? await proofMatchesCurrent(ownerUserId, reread, { ...options, operations: tx }, true) : null
    const racedEvents = await eventsFor(tx, ownerUserId, outcome.entryId)
    if (!fresh || fresh.proof.grantFingerprint !== current.proof.grantFingerprint || racedEvents.some(event => event.eventFingerprint === eventFingerprint)) fail()
    if ((racedEvents.filter(event => event.eventType === EVENT_REVIEWED).map(parseReview) as Array<ReviewEvent|null>).some(item => !item || (item.outcomeId === outcomeId && item.decision === 'reject' && input.decision === 'approve'))) fail()
    const stored = await tx.appendEvent({ ownerUserId, clientId: current.lineage.clientId, calendarId: current.lineage.calendarId, entryId: outcome.entryId,
      runId: null, eventType: EVENT_REVIEWED, fromStatus: null, toStatus: input.decision, eventFingerprint, authorityReference: null, metadata: review })
    if (parseReview(stored)?.assessmentFingerprint !== outcome.assessmentFingerprint) fail()
    return { state: input.decision === 'approve' ? 'approved' as const : 'rejected' as const, replayed: false, reviewFingerprint: fingerprint(review) }
  })
}

async function reviewed(ownerUserId: number, outcome: ContentOperationOutcomeAssessmentRow, proof: SiteLearningCollectionProof, options: SiteLearningOptions) {
  const events = await eventsFor(repository(options), ownerUserId, outcome.entryId), reviews = events.filter(event => event.eventType === EVENT_REVIEWED).map(parseReview)
  if (reviews.some(review => !review)) return false
  const matching = (reviews as ReviewEvent[]).filter(review => review.outcomeId === outcome.id && review.assessmentFingerprint === outcome.assessmentFingerprint && review.grantFingerprint === proof.grantFingerprint)
  if (matching.some(review => review.decision === 'reject')) return false
  return matching.some(review => review.decision === 'approve'
    && review.grantFingerprint === proof.grantFingerprint && review.collectionProofFingerprint === fingerprint(proof) && review.piiReviewed && review.limitationsUnderstood)
}

function releaseProjection(records: Array<{ outcomeRequest: unknown; assessment: unknown; consent: unknown; piiScanStatus: 'none_detected'|'detected'|'unknown' }>, blocked: number) {
  const dataset = buildContentLearningDataset({ records })
  return { status: dataset.status, manifest: dataset.manifest, candidateResults: dataset.candidateResults.map(candidate => ({ candidateStatus: candidate.candidateStatus, candidateFingerprint: candidate.candidateFingerprint, reasonCodes: 'reasonCodes' in candidate ? candidate.reasonCodes : [] })),
    eligibleCandidateCount: dataset.eligibleCandidates.length, blockedOutcomeCount: blocked, datasetDigest: dataset.datasetDigest, releaseFingerprint: fingerprint({ manifestFingerprint: dataset.manifest.manifestFingerprint, datasetDigest: dataset.datasetDigest, blocked }),
    modelTrainingAllowed: false as const, citationTrainingEligible: false as const, limitations: [...dataset.limitations, 'site_confirmation_observational_not_causal', 'site_learning_lane_is_not_formal_delivery', 'dataset_review_is_not_model_training_or_approval'] }
}

export async function buildSiteLearningRelease(ownerUserId: number, options: SiteLearningOptions) {
  const db = repository(options), outcomes = await options.operations.listOutcomes(ownerUserId, LIMIT_OUTCOMES + 1)
  if (outcomes.length > LIMIT_OUTCOMES) return releaseProjection([], outcomes.length)
  const selected = outcomes.filter(row => safeRecord(row.assessmentSnapshot)?.evidenceKind === 'site_publication_confirmation')
  const entryIds = [...new Set(selected.map(row => row.entryId))]
  if (entryIds.length > LIMIT_ENTRIES) return releaseProjection([], selected.length)
  const firstPass = new Map<number, ConfirmedSiteMeasurementLineage[]>()
  for (const entryId of entryIds) {
    try { firstPass.set(entryId, await options.resolveSiteLineages(ownerUserId, entryId, { fresh: true, repository: db })) } catch { firstPass.set(entryId, []) }
  }
  const candidates: Array<{ outcome: ContentOperationOutcomeAssessmentRow; lineage: ConfirmedSiteMeasurementLineage; proof: SiteLearningCollectionProof; saved: NonNullable<ReturnType<typeof siteAssessment>> }> = []
  let blocked = 0
  for (const outcome of selected) {
    const saved = siteAssessment(outcome, clock(options)), lineage = (firstPass.get(outcome.entryId) || []).find(item => item.ownerUserId === ownerUserId && item.entryId === outcome.entryId && item.targetId === outcome.targetId)
    if (!saved || !lineage || lineage.confirmationFingerprint !== saved.proof.confirmationFingerprint || !publicationMatchesLineage(outcome, lineage, saved.publication)) { blocked++; continue }
    const proof = await proofForLineage(ownerUserId, lineage, options, db, clock(options))
    if (!proof || fingerprint(proof) !== fingerprint(saved.proof) || !await reviewed(ownerUserId, outcome, proof, options)) { blocked++; continue }
    const pii = scanOutcomeLearningPii({ publication: saved.publication, assessment: saved.assessment, baselineMeasurements: saved.baseline, followUpMeasurements: saved.followUp })
    if (pii.status !== 'none_detected') { blocked++; continue }
    candidates.push({ outcome, lineage, proof, saved })
  }
  const records: Array<{ outcomeRequest: unknown; assessment: unknown; consent: unknown; piiScanStatus: 'none_detected'|'detected'|'unknown' }> = []
  const finalLineages = new Map<number, ConfirmedSiteMeasurementLineage[]>()
  for (const entryId of [...new Set(candidates.map(candidate => candidate.outcome.entryId))]) {
    try { finalLineages.set(entryId, await options.resolveSiteLineages(ownerUserId, entryId, { fresh: true, repository: db })) } catch { finalLineages.set(entryId, []) }
  }
  for (const candidate of candidates) {
    const reread = await findOutcome(ownerUserId, candidate.outcome.id, options)
    const saved = reread && reread.assessmentFingerprint === candidate.outcome.assessmentFingerprint ? siteAssessment(reread, clock(options)) : null
    const currentLineage = (finalLineages.get(candidate.outcome.entryId) || []).find(item => item.ownerUserId === ownerUserId && item.entryId === candidate.outcome.entryId && item.targetId === candidate.outcome.targetId)
    const stillCurrent = currentLineage ? await proofForLineage(ownerUserId, currentLineage, options, db, clock(options)) : null
    const currentEvents = await eventsFor(db, ownerUserId, candidate.outcome.entryId)
    const approval = currentEvents.map(parseReview).find(item => item?.outcomeId === candidate.outcome.id && item.decision === 'approve' && item.assessmentFingerprint === candidate.outcome.assessmentFingerprint && item.grantFingerprint === candidate.proof.grantFingerprint)
    if (!saved || !reread || !stillCurrent || !currentLineage || !publicationMatchesLineage(reread, currentLineage, saved.publication)
      || currentLineage.confirmationFingerprint !== candidate.proof.confirmationFingerprint || fingerprint(stillCurrent) !== fingerprint(candidate.proof) || !approval || !await reviewed(ownerUserId, reread, candidate.proof, options)) { blocked++; continue }
    const request = { publication: saved.publication, baselineMeasurements: saved.baseline, followUpMeasurements: saved.followUp, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
    records.push({ outcomeRequest: request, assessment: saved.assessment, consent: consentFor(candidate.proof), piiScanStatus: 'none_detected' })
  }
  return releaseProjection(records, blocked)
}

export async function getSiteLearningWorkspace(ownerUserId: number, options: SiteLearningOptions) {
  const db = repository(options), [entries, outcomes, authorizations] = await Promise.all([options.operations.listEntries(ownerUserId), options.operations.listOutcomes(ownerUserId, LIMIT_OUTCOMES + 1), options.learning.listAuthorizations(ownerUserId)])
  if (outcomes.length > LIMIT_OUTCOMES) fail()
  const activeEntries = entries.filter(entry => entry.ownerUserId === ownerUserId).sort((a, b) => Number(b.status === 'awaiting_site_review') - Number(a.status === 'awaiting_site_review')).slice(0, LIMIT_ENTRIES)
  const lineagesByEntry = new Map<number, ConfirmedSiteMeasurementLineage[]>()
  for (const entry of activeEntries) {
    try { lineagesByEntry.set(entry.id, await options.resolveSiteLineages(ownerUserId, entry.id, { fresh: false, repository: db })) } catch { lineagesByEntry.set(entry.id, []) }
  }
  const projectedEntries = []
  for (const entry of activeEntries) {
    const lineages = lineagesByEntry.get(entry.id) || []
    const events = await eventsFor(db, ownerUserId, entry.id)
    const historicalGrants = events.filter(event => event.eventType === EVENT_OPT_IN).map(event => ({ event, grant: parseGrant(event) }))
      .filter((item): item is { event: ContentOperationEventRow; grant: GrantEvent } => Boolean(item.grant && item.event.calendarId === entry.calendarId))
      .sort((a, b) => b.event.id - a.event.id)
    const seenTargets = new Set<number>()
    for (const lineage of lineages.slice(0, 20)) {
      seenTargets.add(lineage.targetId)
      const proof = await proofForLineage(ownerUserId, lineage, options, db, clock(options))
      const historical = historicalGrants.find(item => item.grant.targetRowId === lineage.targetId)
      const revoked = historical && latestRevocation(events, historical.grant.grantFingerprint)
      const relevant = authorizations.filter(row => row.clientId === lineage.clientId).slice(0, 50)
      const authDtos = []
      for (const auth of relevant) {
        const scope = await options.learning.getScope(ownerUserId, auth.id)
        const authority = resolveLearningAuthority(scope, { ownerUserId, clientId: auth.clientId, sourceId: auth.sourceId }, clock(options))
        let pageOrigin = ''
        try { pageOrigin = new URL(lineage.canonicalPage).origin } catch { /* invalid origin is not a candidate */ }
        if (authority && scope && authority.sourceFingerprint === fingerprint(scope.source) && auth.authorizedOrigin === pageOrigin) authDtos.push({ id: auth.id, fingerprint: auth.authorizationFingerprint, consentVersion: auth.consentVersion, expiresAt: auth.expiresAt.toISOString() })
      }
      projectedEntries.push({ entryId: entry.id, targetRowId: lineage.targetId, clientId: lineage.clientId, label: `網站目標 ${lineage.targetId}`, confirmationFingerprint: lineage.confirmationFingerprint,
        grant: proof ? { state: 'active' as const, fingerprint: proof.grantFingerprint, authorizationId: proof.authorizationId }
          : historical && revoked && !revoked.corrupt && !revoked.revoked ? { state: 'active' as const, fingerprint: historical.grant.grantFingerprint, authorizationId: historical.grant.authorizationId } : null, authorizations: authDtos })
    }
    // Revocation must stay available without a working website or an active source authorization.
    for (const { grant } of historicalGrants) {
      if (seenTargets.has(grant.targetRowId)) continue
      seenTargets.add(grant.targetRowId)
      const revoked = latestRevocation(events, grant.grantFingerprint)
      if (revoked.corrupt || revoked.revoked) continue
      projectedEntries.push({ entryId: entry.id, targetRowId: grant.targetRowId, clientId: grant.clientId, label: `網站目標 ${grant.targetRowId}（僅保留撤銷入口）`,
        confirmationFingerprint: grant.confirmationFingerprint, grant: { state: 'active' as const, fingerprint: grant.grantFingerprint, authorizationId: grant.authorizationId }, authorizations: [] })
    }
  }
  const projectedOutcomes = []
  for (const outcome of outcomes.filter(row => safeRecord(row.assessmentSnapshot)?.evidenceKind === 'site_publication_confirmation')) {
    const saved = siteAssessment(outcome, clock(options)), proof = saved?.proof, events = await eventsFor(db, ownerUserId, outcome.entryId)
    const reviews = events.filter(event => event.eventType === EVENT_REVIEWED).map(parseReview)
    const match = (reviews as Array<ReviewEvent|null>).filter(item => item && item.outcomeId === outcome.id && item.assessmentFingerprint === outcome.assessmentFingerprint && item.grantFingerprint === proof?.grantFingerprint).sort((a,b) => b!.reviewedAt.localeCompare(a!.reviewedAt))[0]
    const current = saved ? await proofMatchesCurrent(ownerUserId, outcome, options, false) : null
    const state = !saved || !current ? 'blocked' : !match ? 'pending' : match.decision === 'approve' ? 'approved' : match.decision === 'reject' ? 'rejected' : 'blocked'
    projectedOutcomes.push({ id: outcome.id, entryId: outcome.entryId, targetRowId: outcome.targetId || null, assessmentFingerprint: outcome.assessmentFingerprint, grantFingerprint: proof?.grantFingerprint || null, state })
  }
  return { entries: projectedEntries, outcomes: projectedOutcomes, release: { state: 'not_generated' as const, status: 'gate_blocked' as const, eligibleCandidateCount: 0, blockedOutcomeCount: projectedOutcomes.length,
    modelTrainingAllowed: false as const, citationTrainingEligible: false as const, limitations: ['release_requires_explicit_fresh_recheck'] } }
}
