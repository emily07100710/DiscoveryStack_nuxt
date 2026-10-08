import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { checkFirstPartySitePublication, normalizeSitePublicationObservation, type SitePublicationObservation, type SitePublicationStatusDependencies } from '../first-party-publishing/site-publication-status'
import { createWeeklyContentRepository, type WeeklyContentRepository } from '../weekly-content/repository'
import { revalidateConsumedWeeklyPublicationConsent } from '../weekly-content/site-measurement-consent'
import { createBoundedFetch } from './bounded-fetch'
import { getContentOperationsRuntimeDependencies } from './runtime-dependencies'
import { createContentOperationsRepository, type ContentOperationsRepository } from './repository'
import { stableFingerprint } from './normalization'
import { resolvePublicationPublicUrl } from './publication-public-url'
import { latestSitePublicationRecord, listSitePublicationHistory, loadSitePublicationContext } from './site-publication'
import { publicationLocalDate } from '../measurement-collection/normalization'
import { contentFingerprint } from '../seo-geo-core/riskGate'
import type { ContentOperationEventRow } from './types'

const VERSION = 'site-measurement-confirmation-v1'
export const SITE_MEASUREMENT_EVENT = 'site_measurement_confirmed'
const LIMIT = 500
const HASH = /^[a-f0-9]{64}$/u
const MAX_OBSERVATION_AGE_MS = 5 * 60_000
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const commandFingerprint = (ownerUserId: number, entryId: number, keyHash: string) => stableFingerprint({ version: VERSION, ownerUserId, entryId, keyHash })
function fail(statusCode = 409): never { throw createError({ statusCode, statusMessage: '目前無法確認接入成效觀察；沒有發布文章或授予訓練權限。' }) }
type Options = { repository?: ContentOperationsRepository; dependencies?: SitePublicationStatusDependencies; now?: Date; weeklyRepository?: WeeklyContentRepository; weeklyRepositoryFactory?: () => WeeklyContentRepository }
export type SiteMeasurementSummary = { state: 'available' | 'confirmed' | 'blocked'; publicationFingerprint: string | null; confirmedAt: string | null; reason: 'not_verified' | 'not_published' | 'content_changed' | 'observation_expired' | 'authority_invalid' | 'confirmed' | 'available' }
const blocked = (reason: SiteMeasurementSummary['reason']): SiteMeasurementSummary => ({ state: 'blocked', publicationFingerprint: null, confirmedAt: null, reason })

function object(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !property?.enumerable || !('value' in property)) return null
      out[key] = property.value
    }
    return out
  } catch { return null }
}

export function parseSiteMeasurementConfirmInput(value: unknown) {
  const raw = object(value), keys = ['targetRowId', 'expectedPublicationFingerprint', 'confirmed', 'idempotencyKey']
  if (!raw || Object.keys(raw).length !== keys.length || keys.some(key => !(key in raw))
    || !Number.isSafeInteger(raw.targetRowId) || (raw.targetRowId as number) < 1 || raw.confirmed !== true
    || typeof raw.expectedPublicationFingerprint !== 'string' || !HASH.test(raw.expectedPublicationFingerprint)
    || typeof raw.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/u.test(raw.idempotencyKey)) fail(422)
  return { targetRowId: raw.targetRowId as number, expectedPublicationFingerprint: raw.expectedPublicationFingerprint as string, confirmed: true as const, idempotencyKey: raw.idempotencyKey as string }
}

/** Manual review is the only ingest mode currently accepted by the Do pilot. No machine authority is fabricated. */
async function authority(ownerUserId: number, entryId: number, targetRowId: number, repository: ContentOperationsRepository, options: Options) {
  const context = await loadSitePublicationContext(repository, ownerUserId, entryId, targetRowId)
  const lineage = await repository.resolveWorkspaceEntry(ownerUserId, entryId)
  if (!lineage?.job || !lineage.draft || !lineage.review || !lineage.riskGate || context.attempt.authorityReference != null || context.attempt.routeId
    || lineage.entry.id !== entryId || lineage.entry.ownerUserId !== ownerUserId || lineage.entry.status !== 'awaiting_site_review'
    || lineage.calendar.ownerUserId !== ownerUserId || lineage.client.ownerUserId !== ownerUserId || lineage.client.id !== context.target.clientId
    || lineage.calendar.clientId !== context.target.clientId || lineage.deliverable.ownerUserId !== ownerUserId
    || lineage.deliverable.id !== context.entry.productionDeliverableId || lineage.deliverable.planId !== lineage.calendar.productionPlanId
    || lineage.deliverable.contentType !== context.entry.contentType || lineage.deliverable.language !== context.entry.language
    || lineage.job.ownerUserId !== ownerUserId || lineage.job.id !== context.entry.jobId || lineage.job.productionPlanId !== lineage.calendar.productionPlanId
    || lineage.job.productionDeliverableId !== context.entry.productionDeliverableId || lineage.job.strategyRecommendationId !== context.entry.strategyRecommendationId
    || lineage.job.evidenceSnapshotHash !== context.entry.evidenceSnapshotHash || lineage.draft.id !== context.entry.draftId
    || lineage.draft.jobId !== lineage.job.id || lineage.draft.contentHash !== context.entry.contentHash || lineage.draft.safetyStatus !== 'passed'
    || !Number.isSafeInteger(lineage.draft.version) || lineage.draft.version < 1 || !context.attempt.startedAt || !context.attempt.completedAt) fail()
  const [latestDraft, review, risk, canonical, runs] = await Promise.all([
    repository.findLatestOptimizedDraft(ownerUserId, lineage.job.id),
    repository.findLatestReview(ownerUserId, lineage.job.id, lineage.draft.id, context.entry.evidenceSnapshotHash),
    repository.findRiskGate(ownerUserId, lineage.draft.id, context.entry.evidenceSnapshotHash),
    repository.resolveCanonicalContext(ownerUserId, lineage.calendar.productionPlanId, context.entry.productionDeliverableId),
    repository.listRuns(ownerUserId, entryId),
  ])
  const ingestRun = runs.find(run => run.id === context.attempt.runId && run.ownerUserId === ownerUserId && run.entryId === entryId && run.stage === 'publication' && run.state === 'succeeded')
  if (!latestDraft || latestDraft.id !== lineage.draft.id || latestDraft.version !== lineage.draft.version || latestDraft.contentHash !== context.entry.contentHash
    || contentFingerprint(latestDraft.title, latestDraft.body) !== context.entry.contentHash || sha(latestDraft.body) !== context.attempt.publicationContentHash
    || !review || review.id !== context.entry.reviewId || review.id !== lineage.review.id || review.reviewerUserId !== ownerUserId
    || review.jobId !== lineage.job.id || review.draftId !== lineage.draft.id || review.evidenceSnapshotHash !== context.entry.evidenceSnapshotHash || review.decision !== 'approved_for_delivery'
    || !risk || risk.status !== 'passed' || risk.id !== lineage.riskGate.id || risk.draftId !== lineage.draft.id || risk.evidenceSnapshotHash !== context.entry.evidenceSnapshotHash
    || canonical.evidenceSnapshot.hash !== context.entry.evidenceSnapshotHash || canonical.deliverable.id !== context.entry.productionDeliverableId
    || canonical.strategy.id !== context.entry.strategyRecommendationId || canonical.opportunity.key !== context.entry.topicCluster || !ingestRun) fail()
  const ruleIds = canonical.rules.map(rule => typeof rule.id === 'string' ? rule.id.trim() : '').filter(Boolean).sort()
  if (!ruleIds.length || new Set(ruleIds).size !== ruleIds.length || !Array.isArray(canonical.evidenceSnapshot.refs) || !canonical.evidenceSnapshot.refs.length) fail()
  if (!context.entry.publicationIdentityFingerprint || !HASH.test(context.entry.publicationIdentityFingerprint)
    || context.entry.publicationTargetId !== targetRowId || context.entry.publicationSlug !== context.attempt.publicationSlug || context.entry.publicationPath !== context.attempt.publicationPath
    || context.attempt.inputFingerprint !== stableFingerprint({ entryId, mode: 'execute', identityFingerprint: context.entry.publicationIdentityFingerprint,
      contentHash: context.entry.contentHash, publicationContentHash: context.attempt.publicationContentHash, evidenceSnapshotHash: context.entry.evidenceSnapshotHash })) fail()
  const publicUrl = resolvePublicationPublicUrl({ ownerUserId, client: lineage.client, target: context.target,
    identity: context.attempt.publicationSlug && context.attempt.publicationPath ? { publicationId: `publication-${entryId}`, slug: context.attempt.publicationSlug, path: context.attempt.publicationPath, identityFingerprint: context.entry.publicationIdentityFingerprint } : null,
    entry: context.entry })
  if (!publicUrl.configured || new URL(publicUrl.publicationUrl).origin !== context.target.targetOrigin) fail()
  const canonicalPage = publicUrl.publicationUrl
  let consentFingerprint: string | null = null
  if (lineage.client.requireCustomerApproval === true) {
    if (!options.weeklyRepository && !options.weeklyRepositoryFactory) fail() // Partial injection never falls through to a real database.
    const consent = await revalidateConsumedWeeklyPublicationConsent({ ownerUserId, clientId: lineage.client.id, entryId,
      attempt: { status: 'draft_received', ownerUserId, clientId: lineage.client.id, entryId, jobId: lineage.job.id, draftId: lineage.draft.id,
        draftVersion: lineage.draft.version, contentType: context.entry.contentType, language: context.entry.language,
        contentHash: context.entry.contentHash!, evidenceSnapshotHash: context.entry.evidenceSnapshotHash, targetId: targetRowId,
        targetConfigurationFingerprint: context.target.configurationFingerprint, startedAt: context.attempt.startedAt,
        authorityReference: null, reviewId: review.id }, now: options.now ?? new Date(), repository: options.weeklyRepository ?? options.weeklyRepositoryFactory!() })
    if (consent.status !== 'verified') fail()
    consentFingerprint = consent.authorityFingerprint
  }
  const authorityFingerprint = stableFingerprint({ version: VERSION, contextFingerprint: context.contextFingerprint, reviewId: review.id, reviewDecision: review.decision,
    draftVersion: lineage.draft.version, riskGateId: risk.id, ruleIds, canonicalEvidenceFingerprint: stableFingerprint(canonical.evidenceSnapshot.refs),
    canonicalPage, timeZone: lineage.client.timeZone, requireCustomerApproval: lineage.client.requireCustomerApproval, consentFingerprint })
  return { context, lineage, canonicalPage, authorityFingerprint, ruleIds }
}
type Authority = Awaited<ReturnType<typeof authority>>

function publicationFingerprint(current: Authority, observation: SitePublicationObservation): string | null {
  if (observation.state !== 'published' || observation.documentState !== 'in_sync' || !observation.publishedAt || !observation.publishedVersion
    || !observation.publishedDocumentHash || observation.receivedDocumentHash !== observation.publishedDocumentHash
    || observation.targetId !== current.context.target.targetId || observation.targetOrigin !== current.context.target.targetOrigin
    || observation.publicationId !== current.context.receipt.publicationId || observation.postId !== current.context.receipt.postId
    || observation.contentHash !== current.context.receipt.contentHash || Date.parse(observation.publishedAt) < current.context.attempt.completedAt!.getTime()) return null
  // Observation clock, nonce and private draft version are not public-version identity.
  return stableFingerprint({ version: VERSION, contextFingerprint: current.context.contextFingerprint, authorityFingerprint: current.authorityFingerprint,
    canonicalPage: current.canonicalPage, publishedVersion: observation.publishedVersion, publishedAt: observation.publishedAt, publishedDocumentHash: observation.publishedDocumentHash })
}
const receiptFingerprint = (current: Authority, publicFingerprint: string) => stableFingerprint({ version: VERSION, kind: 'owner_measurement_opt_in', ownerUserId: current.context.entry.ownerUserId, entryId: current.context.entry.id, targetId: current.context.target.id, publicFingerprint })
const wire = (value: SitePublicationObservation) => { const { documentState: _derived, ...out } = value; return out }
const RECORD_KEYS = ['version', 'keyHash', 'contextFingerprint', 'authorityFingerprint', 'publicationFingerprint', 'confirmationFingerprint', 'targetRowId', 'attemptId', 'responseFingerprint', 'observation', 'confirmedAt', 'recordFingerprint']

async function history(repository: ContentOperationsRepository, ownerUserId: number, entryId: number) {
  const events = repository.listSiteMeasurementEvents ? await repository.listSiteMeasurementEvents(ownerUserId, entryId) : await repository.listEvents(ownerUserId, entryId)
  if (!Array.isArray(events) || events.length > LIMIT || (!repository.listSiteMeasurementEvents && events.length >= LIMIT)) fail()
  const selected = events.filter(event => event.eventType === SITE_MEASUREMENT_EVENT)
  for (const event of selected) {
    const raw = object(event.metadata)
    if (!raw || Object.keys(raw).length !== RECORD_KEYS.length || RECORD_KEYS.some(key => !(key in raw))) fail()
    const { recordFingerprint, ...base } = raw
    if (raw.version !== VERSION || typeof recordFingerprint !== 'string' || !HASH.test(recordFingerprint) || stableFingerprint(base) !== recordFingerprint
      || event.ownerUserId !== ownerUserId || event.entryId !== entryId) fail()
  }
  return selected
}
function validated(event: ContentOperationEventRow, current: Authority) {
  try {
    const raw = object(event.metadata)
    if (!raw || Object.keys(raw).length !== RECORD_KEYS.length || RECORD_KEYS.some(key => !(key in raw)) || raw.version !== VERSION
      || !['keyHash', 'responseFingerprint', 'recordFingerprint', 'publicationFingerprint', 'confirmationFingerprint'].every(key => typeof raw[key] === 'string' && HASH.test(raw[key] as string))
      || raw.contextFingerprint !== current.context.contextFingerprint || raw.authorityFingerprint !== current.authorityFingerprint
      || raw.targetRowId !== current.context.target.id || raw.attemptId !== current.context.attempt.id
      || event.ownerUserId !== current.context.entry.ownerUserId || event.clientId !== current.context.target.clientId || event.entryId !== current.context.entry.id
      || event.calendarId !== current.context.entry.calendarId || event.runId !== null || event.eventType !== SITE_MEASUREMENT_EVENT
      || event.contentHash !== current.context.entry.contentHash || event.evidenceSnapshotHash !== current.context.entry.evidenceSnapshotHash
      || event.eventFingerprint !== commandFingerprint(event.ownerUserId, event.entryId!, raw.keyHash as string)
      || typeof raw.confirmedAt !== 'string' || !Number.isFinite(Date.parse(raw.confirmedAt)) || new Date(raw.confirmedAt).toISOString() !== raw.confirmedAt) return null
    const { recordFingerprint: _checksum, ...base } = raw
    const observation = normalizeSitePublicationObservation(raw.observation)
    if (stableFingerprint(base) !== raw.recordFingerprint || !observation || publicationFingerprint(current, observation) !== raw.publicationFingerprint
      || receiptFingerprint(current, raw.publicationFingerprint as string) !== raw.confirmationFingerprint
      || Math.abs(Date.parse(raw.confirmedAt) - Date.parse(observation.observedAt)) > MAX_OBSERVATION_AGE_MS) return null
    return { observation, publicationFingerprint: raw.publicationFingerprint as string, confirmationFingerprint: raw.confirmationFingerprint as string, confirmedAt: raw.confirmedAt, keyHash: raw.keyHash, responseFingerprint: raw.responseFingerprint }
  } catch { return null }
}

async function latestConfirmation(repository: ContentOperationsRepository, current: Authority) {
  const events = await history(repository, current.context.entry.ownerUserId, current.context.entry.id)
  const candidates = events.filter(event => object(event.metadata)?.targetRowId === current.context.target.id).sort((a, b) => b.id - a.id)
  if (!candidates.length) return null
  const latest = validated(candidates[0]!, current)
  if (!latest) fail()
  return latest
}

export async function projectSiteMeasurement(ownerUserId: number, entryId: number, targetRowId: number, options: Options = {}): Promise<SiteMeasurementSummary> {
  try {
    if (!options.repository) return blocked('authority_invalid')
    const repository = options.repository
    const current = await authority(ownerUserId, entryId, targetRowId, repository, options)
    const record = latestSitePublicationRecord(current.context, await listSitePublicationHistory(repository, ownerUserId, entryId))
    const confirmation = await latestConfirmation(repository, current)
    if (!record && !confirmation) return blocked('not_verified')
    const observation = record?.observation ?? confirmation!.observation
    if (observation.state !== 'published') return blocked('not_published')
    if (observation.documentState !== 'in_sync') return blocked('content_changed')
    const fingerprint = publicationFingerprint(current, observation)
    if (!fingerprint) return blocked('authority_invalid')
    if (confirmation && confirmation.publicationFingerprint === fingerprint) return { state: 'confirmed', publicationFingerprint: fingerprint, confirmedAt: confirmation.confirmedAt, reason: 'confirmed' }
    const age = (options.now ?? new Date()).getTime() - Date.parse(observation.observedAt)
    if (Math.abs(age) > MAX_OBSERVATION_AGE_MS) return blocked('observation_expired')
    return { state: 'available', publicationFingerprint: fingerprint, confirmedAt: null, reason: 'available' }
  } catch { return blocked('authority_invalid') }
}

function statusDependencies(options: Options): SitePublicationStatusDependencies {
  if (options.dependencies) return options.dependencies
  return fail(503)
}

export async function confirmOwnerSiteMeasurement(input: { ownerUserId: number; entryId: number; value: unknown } & Options) {
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1 || !Number.isSafeInteger(input.entryId) || input.entryId < 1) fail(422)
  const value = parseSiteMeasurementConfirmInput(input.value)
  if (!input.repository) fail(503)
  const repository = input.repository
  const options = { ...input, now: input.now ?? input.dependencies?.now ?? new Date() }
  const current = await authority(input.ownerUserId, input.entryId, value.targetRowId, repository, options)
  const keyHash = sha(value.idempotencyKey), eventFingerprint = commandFingerprint(input.ownerUserId, input.entryId, keyHash)
  const events = await history(repository, input.ownerUserId, input.entryId)
  const prior = repository.findSiteMeasurementEvent ? await repository.findSiteMeasurementEvent(input.ownerUserId, eventFingerprint) : events.find(event => event.eventFingerprint === eventFingerprint)
  const result = (confirmedAt: string, replayed: boolean) => ({ status: 'confirmed' as const, replayed, confirmedAt, workflowChanged: false as const, learningAuthorized: false as const, receiptIsCurrentAuthority: false as const })
  if (prior) {
    const verified = validated(prior, current)
    if (!verified || verified.publicationFingerprint !== value.expectedPublicationFingerprint) fail()
    return result(verified.confirmedAt, true) // Historical replay is not fresh website authority; collection still rechecks.
  }
  const checked = await checkFirstPartySitePublication({ publicationId: current.context.receipt.publicationId, contentHash: current.context.receipt.contentHash, postId: current.context.receipt.postId }, current.context.publisherTarget, statusDependencies(options))
  if (checked.status !== 'verified') fail(503)
  const publicFingerprint = publicationFingerprint(current, checked.observation)
  if (!publicFingerprint || publicFingerprint !== value.expectedPublicationFingerprint) fail()
  return repository.transaction(async transaction => {
    const confirmedAt = input.now ?? input.dependencies?.serverNowProvider?.() ?? new Date()
    const fresh = await authority(input.ownerUserId, input.entryId, value.targetRowId, transaction, { ...options, now: confirmedAt })
    if (fresh.authorityFingerprint !== current.authorityFingerprint || fresh.context.contextFingerprint !== current.context.contextFingerprint) fail()
    const freshEvents = await history(transaction, input.ownerUserId, input.entryId)
    const raced = freshEvents.find(event => event.eventFingerprint === eventFingerprint)
    if (raced) {
      const verified = validated(raced, fresh)
      if (!verified || verified.publicationFingerprint !== publicFingerprint) fail()
      return result(verified.confirmedAt, true)
    }
    const siteEvents = await listSitePublicationHistory(transaction, input.ownerUserId, input.entryId)
    if ([...freshEvents, ...siteEvents].some(event => object(object(event.metadata)?.observation)?.nonce === checked.observation.nonce)) fail()
    const base = { version: VERSION, keyHash, contextFingerprint: fresh.context.contextFingerprint, authorityFingerprint: fresh.authorityFingerprint,
      publicationFingerprint: publicFingerprint, confirmationFingerprint: receiptFingerprint(fresh, publicFingerprint), targetRowId: value.targetRowId,
      attemptId: fresh.context.attempt.id, responseFingerprint: checked.responseFingerprint, observation: wire(checked.observation), confirmedAt: confirmedAt.toISOString() }
    const stored = await transaction.appendEvent({ ownerUserId: input.ownerUserId, clientId: fresh.context.target.clientId, calendarId: fresh.context.entry.calendarId,
      entryId: input.entryId, runId: null, eventType: SITE_MEASUREMENT_EVENT, fromStatus: null, toStatus: null, eventFingerprint,
      contentHash: fresh.context.entry.contentHash, evidenceSnapshotHash: fresh.context.entry.evidenceSnapshotHash,
      metadata: { ...base, recordFingerprint: stableFingerprint(base) }, authorityReference: null })
    const verified = validated(stored, fresh)
    if (!verified || verified.publicationFingerprint !== publicFingerprint) fail()
    return result(verified.confirmedAt, verified.responseFingerprint !== checked.responseFingerprint)
  })
}

export async function resolveConfirmedSiteMeasurementLineages(ownerUserId: number, entryId: number, options: Options & { fresh: boolean }) {
  if (!options.repository) {
    if (options.dependencies || options.weeklyRepository || options.weeklyRepositoryFactory) return []
    options = { ...options, repository: createContentOperationsRepository(), weeklyRepositoryFactory: createWeeklyContentRepository,
      dependencies: options.fresh ? { ...getContentOperationsRuntimeDependencies(), fetchImpl: createBoundedFetch({ maxResponseBodyBytes: 4096 }), now: options.now ?? new Date() } : undefined }
  }
  const repository = options.repository!
  const entry = await repository.findEntry(ownerUserId, entryId)
  if (!entry || entry.status !== 'awaiting_site_review') return []
  const bindings = await repository.listEntryTargetBindings(ownerUserId, entryId)
  const targetIds = bindings.length ? bindings.map(binding => binding.targetId) : entry.publicationTargetId ? [entry.publicationTargetId] : []
  if (targetIds.length > 20 || new Set(targetIds).size !== targetIds.length) return []
  const result = []
  for (const targetId of targetIds) {
    try {
      let current = await authority(ownerUserId, entryId, targetId, repository, options)
      const confirmed = await latestConfirmation(repository, current)
      if (!confirmed) continue
      const cached = latestSitePublicationRecord(current.context, await listSitePublicationHistory(repository, ownerUserId, entryId))
      if (cached && Date.parse(cached.observation.observedAt) >= Date.parse(confirmed.observation.observedAt) && publicationFingerprint(current, cached.observation) !== confirmed.publicationFingerprint) continue
      if (options.fresh) {
        const checked = await checkFirstPartySitePublication({ publicationId: current.context.receipt.publicationId, contentHash: current.context.receipt.contentHash, postId: current.context.receipt.postId }, current.context.publisherTarget, statusDependencies(options))
        if (checked.status !== 'verified' || publicationFingerprint(current, checked.observation) !== confirmed.publicationFingerprint) continue
        const fresh = await authority(ownerUserId, entryId, targetId, repository, options)
        if (fresh.authorityFingerprint !== current.authorityFingerprint || fresh.context.contextFingerprint !== current.context.contextFingerprint) continue
        current = fresh
      }
      const publishedAt = new Date(confirmed.observation.publishedAt!)
      result.push({ evidenceKind: 'site_publication_confirmation' as const, ownerUserId, entryId, targetId, clientId: current.context.target.clientId,
        canonicalPage: current.canonicalPage, publicationReceiptFingerprint: confirmed.confirmationFingerprint, confirmationFingerprint: confirmed.confirmationFingerprint,
        contentHash: current.context.entry.contentHash!, evidenceSnapshotHash: current.context.entry.evidenceSnapshotHash, timeZone: current.lineage.client.timeZone,
        publicationLocalDate: publicationLocalDate(publishedAt, current.lineage.client.timeZone), publishedAt, calendarId: current.context.entry.calendarId,
        draftId: current.lineage.draft!.id, draftVersion: current.lineage.draft!.version, jobId: current.lineage.job!.id, productionPlanId: current.lineage.calendar.productionPlanId,
        scheduleKey: current.context.entry.scheduleKey, contentType: current.context.entry.contentType, language: current.context.entry.language,
        appliedRuleIds: current.ruleIds, topicClusterCode: current.context.entry.topicCluster })
    } catch { /* No current authority is derived from uncertain or unavailable evidence. */ }
  }
  return result
}
export type ConfirmedSiteMeasurementLineage = Awaited<ReturnType<typeof resolveConfirmedSiteMeasurementLineages>>[number]
