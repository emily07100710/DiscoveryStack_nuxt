import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { executeFirstPartyPublication, planFirstPartyPublication, type FirstPartyFetch, type FirstPartyPublishTarget } from '../server/first-party-publishing'
import { bindPublicationRepositoryChangeSet } from '../server/learning-loop/publication-action'
import { resolvePublicationActionEvidence } from '../server/learning-loop/action-release'
import { publicationLearningSnapshot } from '../server/learning-loop/publication-bridge'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import type { DeliveredPublication } from '../server/content-operations/types'
import { createLearningAuthorization } from '../server/learning-loop/service'
import { buildPublicationIdentity } from '../server/content-operations/publication-identity'
import { learningFixture } from './support/learning-loop-memory-repository'
import { makePublication, response, sha256 } from './fixtures/first-party-publishing/fixtures'

const OWNER = 1, CLIENT = 2, ENTRY = 42, TARGET = 22, DRAFT = 51, VERSION = 3
const NOW = new Date('2026-10-20T12:00:00.000Z')
const PUBLISHED_AT = new Date('2026-10-02T12:00:00.000Z')
const ownerScopeKey = `owner-${sha256(String(OWNER)).slice(0, 32)}`
const fingerprint = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function publisherTarget(): FirstPartyPublishTarget {
  return {
    targetId: 'target-action-001', ownerScopeKey, framework: 'astro', transport: 'first_party_git',
    targetOrigin: 'https://api.github.com', contentRoot: 'content', defaultBranch: 'main',
    repositoryOwner: 'example-owner', repositoryName: 'example-site', endpointPath: null,
    credentialReference: 'github-app-installation:synthetic', status: 'active',
    allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'], maximumPayloadBytes: 100_000, executionEnabled: true,
  }
}

function artifact(target: FirstPartyPublishTarget, publication: ReturnType<typeof makePublication>) {
  const planned = planFirstPartyPublication(target, publication, '2026-10-02T12:00:00.000Z')
  if (planned.status !== 'planned') throw new Error(`publisher fixture blocked: ${planned.code}`)
  return { markdown: `${planned.artifact.frontmatter}\n${planned.artifact.body}`, path: planned.artifact.path, fingerprint: planned.artifact.artifactFingerprint }
}

async function deliveryJourney() {
  const target = publisherTarget()
  const canonicalIdentity = buildPublicationIdentity({ clientId: CLIENT, entryId: ENTRY, targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, contentType: 'article', language: 'zh-hant', title: '已核准的新標題', ownerScopeKey: `owner-${OWNER}` })
  if (!canonicalIdentity.ok) throw new Error('content-operations identity fixture is invalid')
  const publication = makePublication({
    ownerScopeKey, scheduleEntryId: String(ENTRY), productionPlanId: '70', productionDeliverableId: String(ENTRY),
    jobId: '71', draftId: String(DRAFT), draftVersion: VERSION, title: '已核准的新標題',
    body: '第一段已更新內容。\n\n保留的第二段。', slug: canonicalIdentity.identity.slug,
  })
  const previous = makePublication({
    ...publication, productionDeliverableId: 'previous-deliverable', title: '舊標題',
    body: '第一段舊內容。\n\n保留的第二段。', contentHash: sha256('第一段舊內容。\n\n保留的第二段。'),
  })
  const before = artifact(target, previous)
  const calls: Array<{ url: string; init: { method: string; body?: string } }> = []
  const fetchImpl = vi.fn(async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, init })
    if (calls.length === 1) return response(200, {
      type: 'file', path: before.path, sha: 'abcdef1234567', encoding: 'base64',
      content: Buffer.from(before.markdown, 'utf8').toString('base64'),
      repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main',
      commit: { sha: '1234567890abcdef1234567890abcdef12345678' },
    })
    return response(200, { content: { path: before.path, sha: 'fedcba7654321' }, commit: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })
  }) as unknown as FirstPartyFetch
  const result = await executeFirstPartyPublication({
    target, publication, now: '2026-10-02T12:00:00.000Z', serverNow: '2026-10-02T12:00:00.000Z',
    mode: 'execute', fetchImpl, serverCredentialResolver: () => ({ ok: true, value: 'fixture-secret' }),
  })
  if (result.status !== 'delivered' || !result.changeSet) throw new Error(`expected trusted repository update: ${JSON.stringify(result)}`)
  const draftContentHash = sha256(`${publication.title}\n${publication.body}`)
  const publicationContentHash = sha256(publication.body)
  const receiptFingerprint = sha256('synthetic-formal-delivery-receipt')
  const identity = { ownerUserId: OWNER, entryId: ENTRY, draftId: DRAFT, draftVersion: VERSION, draftContentHash, evidenceSnapshotHash: publication.evidenceSnapshotHash, targetId: TARGET, receiptFingerprint, publicationContentHash, artifactFingerprint: result.artifactFingerprint }
  const action = bindPublicationRepositoryChangeSet({ identity, target, path: before.path, title: publication.title, body: publication.body, changeSet: result.changeSet })
  if (!action) throw new Error('change-set did not bind to the approved delivered publication')

  if (canonicalIdentity.identity.path !== before.path) throw new Error('publisher and content-operations paths diverged in fixture')
  const entry = { id: ENTRY, ownerUserId: OWNER, calendarId: 9, status: 'delivered', jobId: 71, draftId: DRAFT, contentHash: draftContentHash, publicationContentHash, publicationTargetId: TARGET, publicationSlug: publication.slug, publicationPath: before.path, publicationIdentityFingerprint: canonicalIdentity.identity.identityFingerprint, evidenceSnapshotHash: publication.evidenceSnapshotHash, contentType: 'article', language: 'zh-hant' }
  const calendar = { id: 9, ownerUserId: OWNER, clientId: CLIENT }
  const client = { id: CLIENT, ownerUserId: OWNER, canonicalSiteOrigin: 'https://client.acme.taipei' }
  const run = { id: 91, ownerUserId: OWNER, entryId: ENTRY, stage: 'publication', state: 'succeeded' }
  const targetRow = { id: TARGET, ownerUserId: OWNER, clientId: CLIENT, transport: 'first_party_git', framework: 'astro', targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, defaultBranch: target.defaultBranch, repositoryOwner: target.repositoryOwner, repositoryName: target.repositoryName, status: 'active' }
  const attempt = { id: 92, ownerUserId: OWNER, clientId: CLIENT, entryId: ENTRY, runId: run.id, targetId: TARGET, attemptNumber: 1, status: 'delivered', mode: 'execute', receiptFingerprint, contentHash: draftContentHash, publicationContentHash, evidenceSnapshotHash: publication.evidenceSnapshotHash, publicationUrl: null, publicationId: `publication-${ENTRY}`, publicationSlug: publication.slug, publicationPath: before.path, artifactFingerprint: result.artifactFingerprint, remoteState: result.remoteState, remoteRevision: result.remoteRevision, completedAt: PUBLISHED_AT }
  const deliverable = { id: ENTRY, ownerUserId: OWNER, planId: 70, selectionId: 1, contentType: 'article', title: publication.title, audience: 'reader', language: 'zh-hant', evidenceSnapshotHash: publication.evidenceSnapshotHash, opportunityKey: 'topic', provenance: {} }
  const job = { id: 71, ownerUserId: OWNER, productionPlanId: 70, productionDeliverableId: ENTRY, strategyRecommendationId: 1, evidenceSnapshotHash: publication.evidenceSnapshotHash, briefId: 80 }
  const draft = { id: DRAFT, jobId: 71, version: VERSION, contentHash: draftContentHash, title: publication.title, body: publication.body, evidenceRefs: [], safetyStatus: 'approved' }
  const publicationIdentity = { publicationId: attempt.publicationId, slug: attempt.publicationSlug, path: attempt.publicationPath, identityFingerprint: entry.publicationIdentityFingerprint }
  const delivered = { entry, calendar, deliverable, job, draft, publicationRun: run, publicationTarget: targetRow, publicationAttempt: attempt, publicationIdentity } as unknown as DeliveredPublication
  const event = {
    id: 101, ownerUserId: OWNER, clientId: CLIENT, calendarId: 9, entryId: ENTRY, runId: run.id,
    draftId: DRAFT, contentHash: publicationContentHash, evidenceSnapshotHash: publication.evidenceSnapshotHash,
    eventType: 'publication_delivered',
    metadata: {
      schemaVersion: 'content-publication-delivered-lineage-v1', attemptId: attempt.id, attemptNumber: 1,
      publicationId: `deliverable-${deliverable.id}`, publicationSlug: attempt.publicationSlug, publicationPath: attempt.publicationPath,
      targetId: TARGET, jobId: job.id, draftId: DRAFT, productionDeliverableId: deliverable.id,
      contentType: entry.contentType, language: entry.language, remoteState: attempt.remoteState, remoteRevision: attempt.remoteRevision,
      repositoryAction: action,
      learningSnapshot: publicationLearningSnapshot({ draftId: DRAFT, draftVersion: VERSION, draftContentHash, title: publication.title, body: publication.body, targetId: TARGET, publicationContentHash, receiptFingerprint }),
    },
  }
  return { target, publication, result, action, delivered, event, client, calls, before }
}

function operationsFixture(journey: Awaited<ReturnType<typeof deliveryJourney>>) {
  let current = journey.delivered
  let events = [journey.event]
  const operations = {
    findClient: vi.fn(async (owner: number, id: number) => owner === OWNER && id === CLIENT ? journey.client : null),
    resolveDeliveredPublication: vi.fn(async (owner: number, entry: number) => owner === OWNER && entry === ENTRY ? current : null),
    listEvents: vi.fn(async (owner: number, entry?: number) => owner === OWNER && (entry === undefined || entry === ENTRY) ? structuredClone(events) : []),
  } as unknown as ContentOperationsRepository
  return {
    operations,
    setPublication(value: DeliveredPublication) { current = value },
    setEvents(value: typeof events) { events = value },
  }
}

async function grantedLearning() {
  const fixture = learningFixture()
  await createLearningAuthorization(OWNER, fixture.input, { repository: fixture.repository, now: () => fixture.now })
  return fixture
}

describe('owner-scoped repository publication action evidence', () => {
  it('does not treat a future delivery or a read taken after delivery as historical action evidence', async () => {
    const journey = await deliveryJourney(), ops = operationsFixture(journey), learning = await grantedLearning()
    await expect(resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => new Date(PUBLISHED_AT.getTime() - 1) })).resolves.toBeNull()
    ops.setPublication({ ...journey.delivered, publicationAttempt: { ...journey.delivered.publicationAttempt!, completedAt: new Date(PUBLISHED_AT.getTime() - 1) } })
    await expect(resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => NOW })).resolves.toBeNull()
  })
  it('resolves one durable action and the current grant from a real mocked Git GET→PUT journey', async () => {
    const journey = await deliveryJourney(), ops = operationsFixture(journey), learning = await grantedLearning()
    const evidence = await resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => NOW })
    expect(journey.calls.map(call => call.init.method)).toEqual(['GET', 'PUT'])
    expect(evidence).toMatchObject({ liveBeforeState: 'unknown', modelTrainingAllowed: false, primaryCitationLabelAllowed: false, authority: { piiStatus: 'reviewed_clean', consentReceiptHash: 'c'.repeat(64) } })
    expect(evidence?.binding).toEqual(journey.action)
    expect(evidence?.binding.changeSet.before.remoteRevision).toBe('1234567890abcdef1234567890abcdef12345678')
    expect(ops.operations.resolveDeliveredPublication).toHaveBeenCalledTimes(2)
    expect(ops.operations.listEvents).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(evidence)).not.toContain(journey.publication.body)
    expect(JSON.stringify(evidence)).not.toContain(journey.publication.title)
  })

  it.each([
    'owner', 'entry', 'target', 'body', 'receipt', 'artifact', 'change-set-hash',
    'attempt-evidence-hash', 'attempt-publication-hash', 'attempt-publication-id', 'attempt-slug', 'attempt-path', 'entry-identity', 'entry-slug', 'entry-path', 'entry-target',
    'event-draft', 'event-client', 'event-content-hash', 'event-evidence-hash',
    'metadata-draft', 'metadata-target', 'metadata-publication', 'metadata-slug', 'metadata-path', 'metadata-receipt',
  ] as const)('fails closed when the durable publication binding drifts: %s', async mutation => {
    const journey = await deliveryJourney(), ops = operationsFixture(journey), learning = await grantedLearning()
    let delivered = journey.delivered
    if (mutation === 'owner') delivered = { ...delivered, entry: { ...delivered.entry, ownerUserId: 99 } } as DeliveredPublication
    if (mutation === 'entry') delivered = { ...delivered, entry: { ...delivered.entry, id: ENTRY + 1 } } as DeliveredPublication
    if (mutation === 'target') delivered = { ...delivered, publicationTarget: { ...delivered.publicationTarget!, targetId: 'different-target' } } as DeliveredPublication
    if (mutation === 'body') delivered = { ...delivered, draft: { ...delivered.draft, body: 'different published body' } } as DeliveredPublication
    if (mutation === 'receipt') delivered = { ...delivered, publicationAttempt: { ...delivered.publicationAttempt!, receiptFingerprint: 'e'.repeat(64) } } as DeliveredPublication
    if (mutation === 'artifact') delivered = { ...delivered, publicationAttempt: { ...delivered.publicationAttempt!, artifactFingerprint: 'f'.repeat(64) } } as DeliveredPublication
    if (mutation === 'attempt-evidence-hash') delivered = { ...delivered, publicationAttempt: { ...delivered.publicationAttempt!, evidenceSnapshotHash: '8'.repeat(64) } } as DeliveredPublication
    if (mutation === 'attempt-publication-hash') delivered = { ...delivered, publicationAttempt: { ...delivered.publicationAttempt!, publicationContentHash: '8'.repeat(64) } } as DeliveredPublication
    if (mutation === 'attempt-publication-id') delivered = { ...delivered, publicationAttempt: { ...delivered.publicationAttempt!, publicationId: 'publication-other' } } as DeliveredPublication
    if (mutation === 'attempt-slug') delivered = { ...delivered, publicationAttempt: { ...delivered.publicationAttempt!, publicationSlug: 'other-slug' } } as DeliveredPublication
    if (mutation === 'attempt-path') delivered = { ...delivered, publicationAttempt: { ...delivered.publicationAttempt!, publicationPath: 'content/zh-hant/articles/other.md' } } as DeliveredPublication
    if (mutation === 'entry-identity') delivered = { ...delivered, entry: { ...delivered.entry, publicationIdentityFingerprint: '8'.repeat(64) } } as DeliveredPublication
    if (mutation === 'entry-slug') delivered = { ...delivered, entry: { ...delivered.entry, publicationSlug: 'other-slug' } } as DeliveredPublication
    if (mutation === 'entry-path') delivered = { ...delivered, entry: { ...delivered.entry, publicationPath: 'content/zh-hant/articles/other.md' } } as DeliveredPublication
    if (mutation === 'entry-target') delivered = { ...delivered, entry: { ...delivered.entry, publicationTargetId: TARGET + 1 } } as DeliveredPublication
    if (mutation === 'change-set-hash') {
      const damaged = structuredClone(journey.event) as unknown as { metadata: Record<string, unknown> }
      const repositoryAction = damaged.metadata.repositoryAction as Record<string, unknown>
      const changeSet = repositoryAction.changeSet as Record<string, unknown>
      repositoryAction.changeSet = { ...changeSet, changesetFingerprint: '0'.repeat(64) }
      ops.setEvents([damaged as unknown as typeof journey.event])
    }
    const eventMutation = new Set(['event-draft', 'event-client', 'event-content-hash', 'event-evidence-hash', 'metadata-draft', 'metadata-target', 'metadata-publication', 'metadata-slug', 'metadata-path', 'metadata-receipt'])
    if (eventMutation.has(mutation)) {
      const damaged = structuredClone(journey.event) as unknown as Record<string, any>
      if (mutation === 'event-draft') damaged.draftId = DRAFT + 1
      if (mutation === 'event-client') damaged.clientId = CLIENT + 1
      if (mutation === 'event-content-hash') damaged.contentHash = '8'.repeat(64)
      if (mutation === 'event-evidence-hash') damaged.evidenceSnapshotHash = '8'.repeat(64)
      if (mutation === 'metadata-draft') damaged.metadata.draftId = DRAFT + 1
      if (mutation === 'metadata-target') damaged.metadata.targetId = TARGET + 1
      if (mutation === 'metadata-publication') damaged.metadata.publicationId = 'publication-other'
      if (mutation === 'metadata-slug') damaged.metadata.publicationSlug = 'other'
      if (mutation === 'metadata-path') damaged.metadata.publicationPath = 'content/other.md'
      if (mutation === 'metadata-receipt') damaged.metadata.learningSnapshot.receiptFingerprint = '8'.repeat(64)
      ops.setEvents([damaged as unknown as typeof journey.event])
    }
    ops.setPublication(delivered)
    await expect(resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => NOW })).resolves.toBeNull()
  })

  it('requires exactly one matching owner/entry/run/attempt delivery event', async () => {
    const journey = await deliveryJourney(), ops = operationsFixture(journey), learning = await grantedLearning()
    ops.setEvents([journey.event, { ...journey.event, id: 102 }])
    await expect(resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => NOW })).resolves.toBeNull()
    ops.setEvents([{ ...journey.event, ownerUserId: 99 }])
    await expect(resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => NOW })).resolves.toBeNull()
  })

  it('returns the recorded repository observation without learning authority when grant is missing, revoked, or expired', async () => {
    for (const state of ['missing', 'revoked', 'expired'] as const) {
      const journey = await deliveryJourney(), ops = operationsFixture(journey), learning = learningFixture()
      if (state !== 'missing') {
        await createLearningAuthorization(OWNER, state === 'expired' ? { ...learning.input, retentionDays: 1 } : learning.input, { repository: learning.repository, now: () => learning.now })
        if (state === 'revoked') { learning.repository.authorizations[0]!.status = 'revoked'; learning.repository.authorizations[0]!.revokedAt = NOW }
      }
      const evidence = await resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => NOW })
      expect(evidence).toMatchObject({ authority: null, liveBeforeState: 'unknown', modelTrainingAllowed: false, primaryCitationLabelAllowed: false, reasonCodes: expect.arrayContaining(['current_learning_authority_required']) })
    }
  })

  it('drops evidence if the second owner-scoped receipt or durable event changes during the read', async () => {
    for (const drift of ['receipt', 'event', 'scope'] as const) {
      const journey = await deliveryJourney(), ops = operationsFixture(journey), learning = await grantedLearning()
      let reads = 0
      const originalResolve = ops.operations.resolveDeliveredPublication
      ;(ops.operations as unknown as { resolveDeliveredPublication: unknown }).resolveDeliveredPublication = vi.fn(async (owner: number, entry: number) => {
        reads += 1
        const value = await originalResolve(owner, entry)
        if (drift === 'receipt' && reads === 2 && value) return { ...value, publicationAttempt: { ...value.publicationAttempt!, receiptFingerprint: '9'.repeat(64) } }
        return value
      })
      if (drift === 'event') {
        let lists = 0
        const originalList = ops.operations.listEvents
        ;(ops.operations as unknown as { listEvents: unknown }).listEvents = vi.fn(async (owner: number, entry?: number) => {
          lists += 1
          const value = await originalList(owner, entry)
          return lists === 2 ? [] : value
        })
      }
      if (drift === 'scope') {
        let scopeReads = 0
        const originalScope = learning.repository.getScope.bind(learning.repository)
        learning.repository.getScope = async (owner: number, id: number) => {
          scopeReads += 1
          if (scopeReads === 2) learning.repository.sources[0]!.termsStatus = 'prohibits_training'
          return originalScope(owner, id)
        }
      }
      const evidence = await resolvePublicationActionEvidence(OWNER, ENTRY, { operations: ops.operations, learning: learning.repository, now: () => NOW })
      if (drift === 'scope') expect(evidence).toMatchObject({ authority: null, modelTrainingAllowed: false, primaryCitationLabelAllowed: false })
      else expect(evidence).toBeNull()
    }
  })

  it('does not bind a wrong parent draft hash and does not invent a change-set for repository creation', async () => {
    const journey = await deliveryJourney()
    const wrongParent = bindPublicationRepositoryChangeSet({
      identity: { ownerUserId: OWNER, entryId: ENTRY, draftId: DRAFT, draftVersion: VERSION, draftContentHash: '0'.repeat(64), evidenceSnapshotHash: journey.publication.evidenceSnapshotHash, targetId: TARGET, receiptFingerprint: '1'.repeat(64), publicationContentHash: sha256(journey.publication.body), artifactFingerprint: journey.result.status === 'delivered' ? journey.result.artifactFingerprint : '' },
      target: journey.target, path: journey.before.path, title: journey.publication.title, body: journey.publication.body, changeSet: journey.result.status === 'delivered' ? journey.result.changeSet : null,
    })
    expect(wrongParent).toBeNull()

    const target = publisherTarget(), current = makePublication({ ownerScopeKey, scheduleEntryId: String(ENTRY), productionPlanId: '70', productionDeliverableId: String(ENTRY), jobId: '71', draftId: String(DRAFT), draftVersion: VERSION })
    const calls: unknown[] = []
    const createFetch = vi.fn(async () => calls.length++ === 0 ? response(404, {}) : response(201, { content: { path: 'content/zh-hant/articles/first-party-release.md', sha: 'abcdef1234567' }, commit: { sha: '1234567890abcdef1234567890abcdef12345678' }, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })) as unknown as FirstPartyFetch
    const created = await executeFirstPartyPublication({ target, publication: current, now: '2026-10-02T12:00:00.000Z', serverNow: '2026-10-20T12:00:00.000Z', mode: 'execute', fetchImpl: createFetch, serverCredentialResolver: () => ({ ok: true, value: 'fixture-secret' }) })
    expect(created).toMatchObject({ status: 'delivered', remoteState: 'created' })
    expect(created).not.toHaveProperty('changeSet')

    const currentPlan = artifact(target, current), previousPlan = artifact(target, makePublication({ ...current, productionDeliverableId: 'previous', contentHash: undefined, title: '前一稿', body: '前一稿內容' }))
    const noncanonical = previousPlan.markdown.replace(/^---\ntitle:[^\n]+\n/u, '---\n')
    let readCount = 0
    const noncanonicalFetch = vi.fn(async () => readCount++ === 0
      ? response(200, { type: 'file', path: previousPlan.path, sha: 'abcdef1234567', encoding: 'base64', content: Buffer.from(noncanonical, 'utf8').toString('base64'), repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })
      : response(200, { content: { path: currentPlan.path, sha: 'fedcba7654321' }, commit: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' }, repository: { owner: 'example-owner', name: 'example-site' }, branch: 'main' })) as unknown as FirstPartyFetch
    const noncanonicalUpdate = await executeFirstPartyPublication({ target, publication: current, now: '2026-10-02T12:00:00.000Z', serverNow: '2026-10-20T12:00:00.000Z', mode: 'execute', fetchImpl: noncanonicalFetch, serverCredentialResolver: () => ({ ok: true, value: 'fixture-secret' }) })
    expect(noncanonicalUpdate).toMatchObject({ status: 'delivered', remoteState: 'updated' })
    expect(noncanonicalUpdate).not.toHaveProperty('changeSet')
  })
})
