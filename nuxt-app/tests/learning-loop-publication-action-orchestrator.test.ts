import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { executeFirstPartyPublication, planFirstPartyPublication, type FirstPartyFetch } from '../server/first-party-publishing'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
import { createOwnerPublicationTarget, executeContentOperationEntry } from '../server/content-operations/orchestrator'
import { createContentOperationsDeliveredPublicationSource } from '../server/intervention-loop/content-operations-source'
import { createLearningAuthorization } from '../server/learning-loop/service'
import { learningFixture } from './support/learning-loop-memory-repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'
import { response } from './fixtures/first-party-publishing/fixtures'

const OWNER = 1
const NOW = new Date('2026-10-20T12:00:00.000Z')
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

describe('publication action through the content operations orchestrator', () => {
  it('appends and resolves the exact repository action from a real mocked Git update', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(OWNER)
    client.canonicalSiteOrigin = 'https://action-smoke.acme.taipei'
    const calendar = await fixture.addCalendar(OWNER, '2026-10-20', 1)
    const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
    entry.scheduleKey = `schedule-action-smoke-${entry.id}`
    const targetResult = await createOwnerPublicationTarget(OWNER, client.id, {
      idempotencyKey: 'publication-action-orchestrator-smoke', framework: 'nuxt', transport: 'first_party_git',
      targetOrigin: 'https://api.github.com', contentRoot: 'content', defaultBranch: 'main',
      repositoryOwner: 'mock-owner', repositoryName: 'mock-site', endpointPath: null,
      credentialReference: 'synthetic-vault-reference', allowedContentTypes: ['article'],
      allowedLanguages: ['en'], maximumPayloadBytes: 1_000_000, executionEnabled: true,
    }, fixture.repository)
    const target = fixture.targets.find(row => row.id === targetResult.target.id)!

    const body = 'A reviewed answer from the fixture.\n\nA second paragraph for the repository diff.'
    const contentHash = contentFingerprint('Verified action smoke draft', body)
    const bundle = fixture.bundles.get(`${OWNER}:11`)!
    const deliverable = bundle.deliverables.find(row => row.id === entry.productionDeliverableId)!
    const job = { id: 701, ownerUserId: OWNER, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 702, status: 'approved' }
    const draft = { id: 703, ownerUserId: OWNER, jobId: job.id, version: 1, title: 'Verified action smoke draft', body, contentHash, provenance: { stage: 'optimized' }, safetyStatus: 'passed', evidenceRefs: [] }
    const riskGate = { id: 704, ownerUserId: OWNER, draftId: draft.id, status: 'passed', gateVersion: 'content-risk-gate-v1', riskLevel: 'general', findings: [], evidenceSnapshotHash: entry.evidenceSnapshotHash }
    fixture.generated.set(entry.id, { deliverable: { ...deliverable, status: 'approved' }, job, draft, riskGate })
    entry.status = 'ready_to_publish'
    entry.jobId = job.id
    entry.draftId = draft.id
    entry.contentHash = contentHash
    fixture.recordOwnerReview(entry.id, { ownerUserId: OWNER, jobId: job.id, draftId: draft.id, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })

    const learning = learningFixture()
    const learningOrigin = client.canonicalSiteOrigin
    learning.repository.clients[0]!.id = client.id
    learning.repository.clients[0]!.canonicalSiteOrigin = learningOrigin
    learning.repository.sources[0]!.sourceUrl = `${learningOrigin}/`
    learning.repository.sources[0]!.canonicalUrl = `${learningOrigin}/`
    await createLearningAuthorization(OWNER, { ...learning.input, clientId: client.id }, { repository: learning.repository, now: () => learning.now })

    const calls: Array<{ url: string; method: string; body?: string }> = []
    let publisherResult: unknown = null
    let executorFailure: string | null = null
    const executor = vi.fn(async (input: Parameters<NonNullable<import('../server/content-operations/orchestrator').ContentOperationOrchestratorDependencies['publicationExecutor']>>[0]) => {
      try {
      const currentPlan = planFirstPartyPublication(input.target, input.publication, input.now)
      if (currentPlan.status !== 'planned') throw new Error(`orchestrator publication plan blocked: ${currentPlan.code}; ${currentPlan.reasons.join('; ')}`)
      const previousPlan = planFirstPartyPublication(input.target, { ...input.publication, productionDeliverableId: 'previous-deliverable', title: '前一版核准標題', body: '前一版段落。\n\n維持不變的段落。', contentHash: sha256('前一版段落。\n\n維持不變的段落。') }, input.now)
      if (previousPlan.status !== 'planned') throw new Error(`before fixture plan blocked: ${previousPlan.code}`)
      const before = `${previousPlan.artifact.frontmatter}\n${previousPlan.artifact.body}`
      const fetchImpl = vi.fn(async (url: string, init: { method: string; body?: string }) => {
        calls.push({ url, method: init.method, body: init.body })
        if (calls.length === 1) return response(200, {
          type: 'file', path: previousPlan.artifact.path, sha: 'abcdef1234567', encoding: 'base64',
          content: Buffer.from(before, 'utf8').toString('base64'),
          repository: { owner: 'mock-owner', name: 'mock-site' }, branch: 'main',
          commit: { sha: '1234567890abcdef1234567890abcdef12345678' },
        })
        return response(200, {
          content: { path: currentPlan.artifact.path, sha: 'fedcba7654321' },
          commit: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
          repository: { owner: 'mock-owner', name: 'mock-site' }, branch: 'main',
        })
      }) as unknown as FirstPartyFetch
      publisherResult = await executeFirstPartyPublication({
        ...input, fetchImpl,
        serverCredentialResolver: () => ({ ok: true, value: 'synthetic-fixture-credential' }),
      })
      return publisherResult as Awaited<ReturnType<typeof executeFirstPartyPublication>>
      } catch (error) {
        executorFailure = error instanceof Error ? error.message : String(error)
        throw error
      }
    })

    const result = await executeContentOperationEntry({
      ownerUserId: OWNER, entryId: entry.id, trigger: 'owner_manual', now: NOW,
      value: { idempotencyKey: 'orchestrator-action-smoke', mode: 'execute' },
      dependencies: { repository: fixture.repository, publicationExecutor: executor },
    })

    expect(result.outcome, JSON.stringify({ result, publisherResult, executorFailure, calls: calls.length, executorCalls: executor.mock.calls.length })).toBe('delivered')
    expect(calls.map(call => call.method)).toEqual(['GET', 'PUT'])
    const deliveryEvent = fixture.events.find(event => event.eventType === 'publication_delivered' && event.entryId === entry.id)
    expect(deliveryEvent).toBeDefined()
    if (!deliveryEvent) throw new Error('orchestrator did not append a delivery event')
    const deliveryMetadata = deliveryEvent.metadata as Record<string, unknown>
    expect(deliveryMetadata).toMatchObject({ schemaVersion: 'content-publication-delivered-lineage-v1', attemptId: fixture.attempts[0]?.id, draftId: draft.id, targetId: target.id })
    expect(deliveryMetadata.repositoryAction).toMatchObject({ contractVersion: 'content-publication-action-binding-v1', changeSet: { comparisonKind: 'repository_revision_diff', liveBeforeState: 'unknown', causalEligibility: false } })
    expect(deliveryEvent?.draftId).toBe(draft.id)
    expect(deliveryEvent?.clientId).toBe(client.id)
    expect(deliveryEvent?.contentHash).toBe(sha256(body))
    expect(deliveryEvent?.evidenceSnapshotHash).toBe(entry.evidenceSnapshotHash)

    const durable = await fixture.repository.resolveDeliveredPublication(OWNER, entry.id)
    expect(durable?.publicationAttempt?.receiptFingerprint).toBeTruthy()
    const source = createContentOperationsDeliveredPublicationSource(fixture.repository, learning.repository)
    const formalReceipt = await source.resolveDeliveredPublication!(OWNER, entry.id)
    expect(formalReceipt?.receiptFingerprint).toBe(durable?.publicationAttempt?.receiptFingerprint)
    const evidence = await source.resolvePublicationActionEvidence!(OWNER, entry.id, () => NOW)
    expect(evidence).toMatchObject({
      publicationReceiptFingerprint: formalReceipt?.receiptFingerprint,
      liveBeforeState: 'unknown', modelTrainingAllowed: false, primaryCitationLabelAllowed: false,
      authority: { piiStatus: 'reviewed_clean' },
      binding: { changeSet: { comparisonKind: 'repository_revision_diff', liveBeforeState: 'unknown', after: { bodyHash: sha256(body) } } },
    })
    expect(evidence?.binding).toEqual(deliveryMetadata.repositoryAction)
    expect(evidence?.binding.changeSet.before.remoteRevision).toBe('1234567890abcdef1234567890abcdef12345678')
  })
})
