import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import { buildPublicationIdentity } from '../server/content-operations/publication-identity'
import { createOwnerPublicationTarget, executeContentOperationEntry, runContentOperationsExecutionTick, updateOwnerPublicationTarget } from '../server/content-operations/orchestrator'
import type { ContentOperationOrchestratorDependencies } from '../server/content-operations/orchestrator'
import type { ContentOperationPublicationTargetRow, ContentOperationRunRow } from '../server/content-operations/types'
import { parseExecuteInput, parsePublicationTargetInput } from '../server/content-operations/normalization'
import { ContentOperationsFixture, fixtureClient } from './fixtures/content-operations/repository'

const NOW = new Date('2026-01-10T09:00:00.000Z')
const BODY_HASH = createHash('sha256').update('Direct answer\n\nEvidence-bound body.', 'utf8').digest('hex')

function targetInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'target-key-1',
    framework: 'nuxt',
    transport: 'first_party_git',
    targetOrigin: 'https://api.github.com',
    contentRoot: 'content',
    defaultBranch: 'main',
    repositoryOwner: 'owner',
    repositoryName: 'repository',
    endpointPath: null,
    credentialReference: 'server-ref-1',
    allowedContentTypes: ['article', 'faq', 'service_page'],
    allowedLanguages: ['en', 'zh-hant'],
    maximumPayloadBytes: 1000000,
    executionEnabled: true,
    ...overrides,
  }
}

function attachLineage(fixture: ContentOperationsFixture, entryId: number, target: ContentOperationPublicationTargetRow | null) {
  const entry = fixture.entries.find(item => item.id === entryId)!
  const calendar = fixture.calendars.find(item => item.id === entry.calendarId)!
  const client = fixture.clients.find(item => item.id === calendar.clientId)!
  let review: Record<string, unknown> | null = null
  const job = { id: 700, ownerUserId: entry.ownerUserId, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 701 }
  const draft = { id: 702, jobId: job.id, version: 1, title: 'Verified draft', body: 'Direct answer\n\nEvidence-bound body.', contentHash: BODY_HASH, provenance: { stage: 'optimized', selectedRuleIds: ['rule-topic'], appliedRuleIds: ['rule-topic'] }, safetyStatus: 'passed', evidenceRefs: [] }
  const gate = { id: 703, draftId: draft.id, status: 'passed', evidenceSnapshotHash: entry.evidenceSnapshotHash }
  const repository = fixture.repository as ContentOperationsRepository
  repository.findLatestOptimizedDraft = async () => draft
  repository.findRiskGate = async () => gate
  repository.findLatestReview = async () => review as never
  repository.resolveWorkspaceEntry = async () => ({ entry, calendar, client, target, deliverable: { id: entry.productionDeliverableId, ownerUserId: entry.ownerUserId, planId: calendar.productionPlanId, briefId: job.briefId, jobId: job.id, selectionId: entry.strategyRecommendationId, contentType: entry.contentType, title: 'Verified draft', audience: 'owner audience', language: entry.language, evidenceSnapshotHash: entry.evidenceSnapshotHash, opportunityKey: '1:opportunity-1', provenance: {} }, job, draft, review: review as never, riskGate: gate })
  return {
    repository,
    setReview(value: Record<string, unknown> | null) { review = value },
    entry,
    target,
    job,
    draft,
    gate,
  }
}

describe('content operations execution orchestrator', () => {
  it('strictly parses execute and target input without accepting owner or secret fields', () => {
    expect(parseExecuteInput({ idempotencyKey: 'entry-1' })).toEqual({ idempotencyKey: 'entry-1', mode: 'dry_run' })
    expect(() => parseExecuteInput({ idempotencyKey: 'entry-1', ownerUserId: 1 })).toThrow()
    expect(parsePublicationTargetInput(targetInput())).toMatchObject({ framework: 'nuxt', transport: 'first_party_git' })
    expect(() => parsePublicationTargetInput({ ...targetInput(), credential: 'raw-secret' })).toThrow()
  })

  it('binds target framework/transport to the owner client and persists no credential value in the returned projection', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const result = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    expect(result.replayed).toBe(false)
    expect(result.target).toMatchObject({ clientId: client.id, framework: 'nuxt', transport: 'first_party_git', credentialConfigured: true })
    expect(JSON.stringify(result.target)).not.toContain('credential-ref')
    const replay = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    expect(replay.replayed).toBe(true)
    await expect(createOwnerPublicationTarget(1, client.id, targetInput({ contentRoot: 'docs' }), fixture.repository)).rejects.toThrow(/idempotency/i)
    await expect(createOwnerPublicationTarget(1, client.id, targetInput({ idempotencyKey: 'target-key-2' }), fixture.repository)).rejects.toThrow(/one active publication target/i)
    await expect(createOwnerPublicationTarget(1, client.id, targetInput({ framework: 'astro', idempotencyKey: 'target-key-3' }), fixture.repository)).rejects.toThrow()
  })

  it('supports owner target pause, revoke, and reactivation without exposing credential material', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const created = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    const target = fixture.targets.find(row => row.id === created.target.id)!
    const paused = await updateOwnerPublicationTarget(1, target.id, { status: 'paused', executionEnabled: false }, fixture.repository)
    expect(paused.target.status).toBe('paused')
    expect(paused.target.executionEnabled).toBe(false)
    const revoked = await updateOwnerPublicationTarget(1, target.id, { status: 'revoked' }, fixture.repository)
    expect(revoked.target.status).toBe('revoked')
    const reactivated = await updateOwnerPublicationTarget(1, target.id, { status: 'active', executionEnabled: true }, fixture.repository)
    expect(reactivated.target.status).toBe('active')
    expect(reactivated.target.executionEnabled).toBe(true)
    expect(JSON.stringify(reactivated.target)).not.toContain('server-ref-1')
    await expect(updateOwnerPublicationTarget(1, target.id, { unknownField: true }, fixture.repository)).rejects.toThrow()
  })

  it('accepts signed API targets only with fixed endpoint and nullable Git fields', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    client.publicationTransport = 'first_party_signed_api'
    const created = await createOwnerPublicationTarget(1, client.id, targetInput({ transport: 'first_party_signed_api', targetOrigin: 'https://customer.example', defaultBranch: null, repositoryOwner: null, repositoryName: null, endpointPath: '/api/first-party/content-ingest' }), fixture.repository)
    expect(created.target.transport).toBe('first_party_signed_api')
    expect(created.target.defaultBranch).toBeNull()
    expect(created.target.repositoryOwner).toBeNull()
    expect(created.target.endpointPath).toBe('/api/first-party/content-ingest')
    await expect(createOwnerPublicationTarget(1, client.id, targetInput({ idempotencyKey: 'signed-invalid-path', transport: 'first_party_signed_api', targetOrigin: 'https://customer.example', defaultBranch: null, repositoryOwner: null, repositoryName: null, endpointPath: '/other' }), fixture.repository)).rejects.toThrow()
    await expect(createOwnerPublicationTarget(1, client.id, targetInput({ idempotencyKey: 'signed-branch', transport: 'first_party_signed_api', targetOrigin: 'https://customer.example', defaultBranch: 'main', repositoryOwner: null, repositoryName: null, endpointPath: '/api/first-party/content-ingest' }), fixture.repository)).rejects.toThrow()
  })

  it('creates stable unicode-safe identity, uses formal article path, and separates different entry identities', () => {
    const base = { clientId: 1, targetId: 'target-1', targetOrigin: 'https://api.github.com', contentRoot: 'content', contentType: 'article' as const, language: 'en' as const, ownerScopeKey: 'owner-1' }
    const first = buildPublicationIdentity({ ...base, entryId: 11, title: 'Café & 決策' })
    const second = buildPublicationIdentity({ ...base, entryId: 12, title: 'Café & 決策' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.identity.slug).toMatch(/^[a-z0-9-]+$/)
      expect(first.identity.path).toBe(`content/en/articles/${first.identity.slug}.md`)
      expect(first.identity.identityFingerprint).not.toBe(second.identity.identityFingerprint)
      expect(first.identity.publicationId).not.toBe(second.identity.publicationId)
    }
  })

  it('executes generation once, waits for real review synchronization, then records dry-run and delivery attempts append-only', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-01-10', 1)
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    entry.status = 'materialized'
    const targetResult = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    const target = fixture.targets.find(item => item.id === targetResult.target.id)!
    if (!target) throw new Error('target missing')
    const lineage = attachLineage(fixture, entry.id, target)
    const first = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'execute-1', mode: 'dry_run' }, dependencies: { repository: lineage.repository, productionDeliverableRunner: async () => ({ job: { id: lineage.job.id } }) } })
    expect(first.outcome).toBe('awaiting_review')
    expect(lineage.entry.status).toBe('awaiting_review')
    lineage.setReview({ id: 704, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash })
    const approved = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'execute-2', mode: 'dry_run' }, dependencies: { repository: lineage.repository, productionDeliverableRunner: async () => ({ job: { id: lineage.job.id } }) } })
    expect(approved.outcome).toBe('ready_to_publish')
    const publicationRun = fixture.runs.find(run => run.entryId === entry.id && run.stage === 'publication')
    expect(publicationRun).toBeDefined()
    expect(publicationRun?.state).toBe('queued')
    const dryRun = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'execute-3', mode: 'dry_run' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => ({ status: 'dry_run', preview: { mode: 'dry_run', method: 'PUT', url: 'https://api.github.com', targetOrigin: 'https://api.github.com', path: 'content/en/articles/verified.md', branch: 'main', bodyBytes: 10, bodyIncluded: false, headerNames: [], includesAuthorization: false, includesSecret: false, redirect: 'manual' } }) } })
    expect(dryRun.outcome).toBe('dry_run_succeeded')
    expect(publicationRun?.state).toBe('queued')
    expect(fixture.attempts).toHaveLength(1)
    const delivered = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'execute-4', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: async input => ({ status: 'delivered', remoteState: 'created', publicationId: input.publication.productionDeliverableId, contentHash: input.publication.contentHash, remoteRevision: 'commit-1', artifactFingerprint: 'f'.repeat(64), idempotencyKey: 'execute-4' }) } })
    expect(delivered.outcome).toBe('delivered')
    expect(lineage.entry.status).toBe('delivered')
    expect(fixture.attempts).toHaveLength(2)
    expect(fixture.events.some(event => event.eventType === 'publication_delivered')).toBe(true)
  })

  it('classifies retryable publisher failure, schedules bounded backoff, then succeeds on the next eligible attempt', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-01-10', 1)
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    entry.status = 'ready_to_publish'; entry.jobId = 700; entry.draftId = 702
    const targetResult = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    const target = fixture.targets.find(item => item.id === targetResult.target.id)!
    if (!target) throw new Error('target missing')
    const lineage = attachLineage(fixture, entry.id, target)
    lineage.setReview({ id: 704, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })
    let calls = 0
    const retrying = async () => { calls += 1; return calls === 1 ? { status: 'retryable_failure' as const, code: 'REMOTE_RATE_LIMITED' as const, reasons: ['rate limited'], httpStatus: 429 } : { status: 'delivered' as const, remoteState: 'idempotent_replay' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'commit-replay', artifactFingerprint: 'e'.repeat(64), idempotencyKey: 'retry-2' } }
    const first = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'retry-1', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: retrying } })
    expect(first.outcome).toBe('retry_wait')
    expect(first.retryAt?.toISOString()).toBe('2026-01-10T09:05:00.000Z')
    const second = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'scheduler', now: new Date('2026-01-10T09:06:00.000Z'), value: { idempotencyKey: 'retry-2', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: retrying } })
    expect(second.outcome).toBe('delivered')
    expect(fixture.attempts.map(attempt => attempt.status)).toEqual(['retryable_failure', 'delivered'])
  })

  it('runs the bounded execution tick only for the controlled owner and leaves other owners untouched', async () => {
    const fixture = new ContentOperationsFixture()
    fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-01-10', 1)
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    entry.status = 'materialized'
    const lineage = attachLineage(fixture, entry.id, null)
    const generated = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'tick-seed', mode: 'dry_run' }, dependencies: { repository: lineage.repository, productionDeliverableRunner: async () => ({ job: { id: lineage.job.id } }) } })
    expect(generated.outcome).toBe('awaiting_review')
    const seeded = fixture.runs.find(run => run.entryId === entry.id && run.stage === 'generation')!
    Object.assign(seeded, { state: 'queued', leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, completedAt: null })
    fixture.runs.push({ ...seeded, id: seeded.id + 1000, ownerUserId: 2, entryId: 999, idempotencyKey: 'other-owner-run' } as ContentOperationRunRow)
    const tick = await runContentOperationsExecutionTick({ ownerUserId: 1, repository: fixture.repository, now: NOW, maxRuns: 50, dependencies: { productionDeliverableRunner: async () => ({ job: { id: lineage.job.id } }) } })
    expect(tick.processed).toBe(2)
    expect(tick.results).toHaveLength(2)
    expect(tick.results.every(result => result.ownerUserId === 1)).toBe(true)
    expect(tick.results.some(result => result.outcome === 'awaiting_review')).toBe(true)
    expect(fixture.runs.find(run => run.ownerUserId === 2)?.state).toBe('queued')
  })

  it('keeps repeated identical publication idempotency as a replay without another attempt', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-01-10', 1)
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!; entry.status = 'ready_to_publish'; entry.jobId = 700; entry.draftId = 702
    const targetResult = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    const target = fixture.targets.find(item => item.id === targetResult.target.id)!
    if (!target) throw new Error('target missing')
    const lineage = attachLineage(fixture, entry.id, target)
    lineage.setReview({ id: 704, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })
    const executor = async (input: Parameters<NonNullable<ContentOperationOrchestratorDependencies['publicationExecutor']>>[0]) => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: input.publication.productionDeliverableId, contentHash: input.publication.contentHash, remoteRevision: 'commit-1', artifactFingerprint: 'a'.repeat(64), idempotencyKey: 'same' })
    const first = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'same-key', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: executor } })
    const second = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'same-key', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: executor } })
    expect(first.outcome).toBe('delivered')
    expect(second.outcome).toBe('replayed')
    expect(fixture.attempts).toHaveLength(1)
  })

  it('exposes a single-deliverable production runner with explicit lineage fields without calling the full plan runner', () => {
    const service = readFileSync(new URL('../server/seo-geo-core/service.ts', import.meta.url), 'utf8')
    const start = service.indexOf('export async function runOwnerProductionDeliverable(')
    const end = service.indexOf('/** Standalone owner request.', start)
    const singleRunner = service.slice(start, end)
    for (const field of ['planId', 'deliverableId', 'briefId', 'jobId', 'optimizedDraftId', 'contentHash', 'riskGateId', 'riskGateDecision', 'resultingStatus']) expect(singleRunner).toContain(field)
    expect(singleRunner).toContain('resolveProductionContext')
    expect(singleRunner).not.toContain('runOwnerProductionPlan(')
  })

  it('keeps route and workbench owner-only, mutation-only, and explicitly marks dry-run limitations', () => {
    const executeRoute = readFileSync(new URL('../server/api/content-operations/entries/[id]/execute.post.ts', import.meta.url), 'utf8')
    const targetRoute = readFileSync(new URL('../server/api/content-operations/clients/[id]/publication-target.post.ts', import.meta.url), 'utf8')
    const page = readFileSync(new URL('../pages/audit-lab/content-operations.vue', import.meta.url), 'utf8')
    expect(executeRoute).toContain('requireOwner')
    expect(executeRoute).toContain('readBody(event)')
    expect(targetRoute).toContain('requireOwner')
    expect(targetRoute).toContain('createOwnerPublicationTarget')
    expect(page).toContain('Publication target registry')
    expect(page).toContain('dry-run')
    expect(page).toContain('executeEntry(entry, \'execute\')')
  })
})
