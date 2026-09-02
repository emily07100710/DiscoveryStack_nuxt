import { describe, expect, it, vi } from 'vitest'
import { observationInputSchema, ownerManualObservationImportSchema, VisibilityContractError } from '../server/llm-visibility/contracts'
import { createTrackingQuery, importObservationSnapshot, type ProjectRecord, type QueryRecord, type QueryWorkflowRepository, type RunRecord, type VisibilityWorkflowRepository } from '../server/llm-visibility/service'

const project: ProjectRecord = { id: 10, ownerUserId: 7, name: 'Acme monitor', canonicalWebsiteUrl: 'https://example.com/', canonicalDomain: 'example.com', locale: 'en', brandName: 'Acme', brandAliases: ['ACME Inc'], competitorBrands: ['Rival'], status: 'active' }
const query: QueryRecord = { id: 20, ownerUserId: 7, projectId: 10, promptText: 'Which product fits?', promptHash: 'a'.repeat(64), intent: 'discovery', locale: 'en', active: true }
const validInput = () => ownerManualObservationImportSchema.parse({ projectId: 10, queryId: 20, provider: 'chatgpt', modelLabel: 'manual browser check', observedAt: '2026-08-24T01:00:00.000Z', requestFingerprint: 'b'.repeat(64), limitationCode: 'manual_snapshot_pending_owner_review', brandMentioned: true, exactMentionCount: 1, firstMentionPosition: 1, citedDomain: 'example.com', citationUrls: ['https://example.com/proof'], competitorMentions: { Rival: 0 }, boundedExcerpt: 'Acme appears here.', responseHash: 'c'.repeat(64), evidenceLocator: 'owner-screenshot-42', reviewerNote: 'Pending snapshot context.' })

function workflow(overrides: Partial<VisibilityWorkflowRepository> = {}): VisibilityWorkflowRepository {
  return {
    getProject: vi.fn(async owner => owner === 7 ? project : null),
    getQuery: vi.fn(async owner => owner === 7 ? query : null),
    getRun: vi.fn(async () => null),
    findRunByFingerprint: vi.fn(async () => null),
    hasObservation: vi.fn(async () => false),
    commitObservation: vi.fn(async () => ({ runId: 30, observationId: 40 })),
    ...overrides,
  }
}

describe('LLM visibility mocked repository workflow', () => {
  it('commits a bounded, owner-scoped snapshot after validating references and evidence', async () => {
    const repository = workflow({ ensurePromptVersion: vi.fn(async () => ({ id: 91, versionNumber: 1 })) })
    await expect(importObservationSnapshot(repository, 7, validInput(), new Date('2026-08-24T02:00:00Z'))).resolves.toEqual({ runId: 30, observationId: 40 })
    expect(repository.ensurePromptVersion).toHaveBeenCalledWith(query)
    expect(repository.commitObservation).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 7, boundedExcerpt: 'Acme appears here.', responseHash: 'c'.repeat(64), citedDomain: 'example.com', promptVersionId: 91 }))
  })

  it('fails closed on provider API mode before repository access or commit', async () => {
    const repository = workflow()
    const providerApiInput = observationInputSchema.parse({ ...validInput(), observationMode: 'provider_api_observation', status: 'completed', verifiedByOwner: true })
    await expect(importObservationSnapshot(repository, 7, providerApiInput, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 422 })
    expect(repository.getProject).not.toHaveBeenCalled()
    expect(repository.getQuery).not.toHaveBeenCalled()
    expect(repository.commitObservation).not.toHaveBeenCalled()
  })

  it('fails closed on cross-owner project/query references', async () => {
    await expect(importObservationSnapshot(workflow(), 8, validInput(), new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects duplicate request fingerprints and duplicate run/query pairs', async () => {
    await expect(importObservationSnapshot(workflow({ findRunByFingerprint: vi.fn(async () => ({ id: 30 } as RunRecord)) }), 7, validInput(), new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 409 })
    const withRun = { ...validInput(), runId: 30 }
    const matchingRun: RunRecord = { id: 30, ownerUserId: 7, projectId: 10, provider: 'chatgpt', modelLabel: 'manual browser check', observationMode: 'manual_verified', status: 'completed', observedAt: withRun.observedAt, requestFingerprint: withRun.requestFingerprint, limitationCode: withRun.limitationCode }
    await expect(importObservationSnapshot(workflow({ getRun: vi.fn(async () => matchingRun), hasObservation: vi.fn(async () => true) }), 7, withRun, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('requires every existing run contract field to match before attaching an observation', async () => {
    const input = { ...validInput(), runId: 30 }
    const blockedRun: RunRecord = { id: 30, ownerUserId: 7, projectId: 10, provider: 'chatgpt', modelLabel: input.modelLabel, observationMode: 'manual_verified', status: 'blocked', observedAt: input.observedAt, requestFingerprint: input.requestFingerprint, limitationCode: input.limitationCode }
    await expect(importObservationSnapshot(workflow({ getRun: vi.fn(async () => blockedRun) }), 7, input, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 422 })
  })

  it('rejects mismatched citation, excerpt, competitor and stale time evidence', async () => {
    await expect(importObservationSnapshot(workflow(), 7, { ...validInput(), citedDomain: 'notexample.com' }, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 422 })
    await expect(importObservationSnapshot(workflow(), 7, { ...validInput(), boundedExcerpt: 'No brand here.' }, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 422 })
    await expect(importObservationSnapshot(workflow(), 7, { ...validInput(), boundedExcerpt: 'Acme and Rival.', competitorMentions: { Rival: 0 } }, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 422 })
    await expect(importObservationSnapshot(workflow(), 7, { ...validInput(), boundedExcerpt: 'Acme and Rival.', competitorMentions: {} }, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 422 })
    await expect(importObservationSnapshot(workflow(), 7, { ...validInput(), observedAt: '2020-01-01T00:00:00Z' }, new Date('2026-08-24T02:00:00Z'))).rejects.toMatchObject({ statusCode: 422 })
  })

  it('rejects duplicate normalized prompts through a mocked repository', async () => {
    const repository: QueryWorkflowRepository = { getProject: vi.fn(async () => project), findQueryByHash: vi.fn(async () => query), insertQuery: vi.fn(async () => ({ id: 21 })) }
    await expect(createTrackingQuery(repository, 7, { projectId: 10, promptText: '  WHICH  product fits? ', intent: 'discovery', locale: 'en', active: true })).rejects.toEqual(expect.objectContaining<Partial<VisibilityContractError>>({ statusCode: 409 }))
    expect(repository.insertQuery).not.toHaveBeenCalled()
  })
})

describe('LLM visibility fail-closed import schema', () => {
  it('accepts pending snapshot fields and rejects caller-supplied authority fields', () => {
    expect(ownerManualObservationImportSchema.safeParse(validInput()).success).toBe(true)
    expect(ownerManualObservationImportSchema.safeParse({ ...validInput(), observationMode: 'provider_api_observation' }).success).toBe(false)
    expect(ownerManualObservationImportSchema.safeParse({ ...validInput(), observationMode: 'manual_verified', status: 'completed', verifiedByOwner: true }).success).toBe(false)
  })

  it('rejects unknown provider/status, invalid time, missing evidence/hash and raw response persistence', () => {
    const base = validInput()
    const broad = { ...base, observationMode: 'manual_verified', status: 'completed', verifiedByOwner: true }
    expect(observationInputSchema.safeParse({ ...broad, provider: 'consumer_scraper' }).success).toBe(false)
    expect(observationInputSchema.safeParse({ ...broad, status: 'processing' }).success).toBe(false)
    expect(observationInputSchema.safeParse({ ...broad, observedAt: 'yesterday' }).success).toBe(false)
    expect(observationInputSchema.safeParse({ ...broad, evidenceLocator: '' }).success).toBe(false)
    expect(observationInputSchema.safeParse({ ...broad, responseHash: '' }).success).toBe(false)
    expect(observationInputSchema.safeParse({ ...broad, rawResponse: 'must never persist' }).success).toBe(false)
  })
})
