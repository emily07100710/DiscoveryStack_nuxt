import { describe, expect, it, vi } from 'vitest'
import { createInMemoryKnowledgeRepository, createKnowledgeService } from '../server/knowledge'
import { DrizzleKnowledgeRepository, type KnowledgeDrizzleDatabase } from '../server/knowledge/repository-drizzle'

const OWNER = 41
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function fixture() {
  const repository = createInMemoryKnowledgeRepository()
  const service = createKnowledgeService({ ownerUserId: OWNER, repository })
  return { repository, service }
}

async function entity(service: ReturnType<typeof createKnowledgeService>, canonicalName: string, overrides: Partial<Parameters<typeof service.createEntity>[0]> = {}) {
  const result = await service.createEntity({ entityType: 'Organization', canonicalName, ...overrides })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error(result.reason)
  return result.value.entity
}

async function sourceVersion(service: ReturnType<typeof createKnowledgeService>) {
  const source = await service.registerSource({ canonicalUrl: 'https://example.com/reference', sourceClass: 'official documentation' })
  expect(source.status).toBe('ok')
  if (source.status !== 'ok') throw new Error(source.reason)
  const version = await service.addSourceVersion({ sourceId: source.value.id, contentHash: HASH_A, retrievedAt: new Date('2026-08-01T00:00:00.000Z') })
  expect(version.status).toBe('ok')
  if (version.status !== 'ok') throw new Error(version.reason)
  return { source: source.value, version: version.value }
}

describe('knowledge foundation service', () => {
  it('rejects exact identity duplicates but sends normalized same-name matches only to review', async () => {
    const { service } = fixture()
    const first = await entity(service, 'Acme Research', {
      canonicalUri: 'https://acme.example/about',
      externalIds: [{ idType: 'wikidata', idValue: 'Q123' }],
    })
    const externalDuplicate = await service.createEntity({ entityType: 'Organization', canonicalName: 'Different label', externalIds: [{ idType: 'wikidata', idValue: 'Q123' }] })
    expect(externalDuplicate).toMatchObject({ status: 'rejected', code: 'DUPLICATE_ENTITY', existingEntityId: first.id, matchedOn: { method: 'exact_external_id' } })
    const uriDuplicate = await service.createEntity({ entityType: 'Organization', canonicalName: 'Another label', canonicalUri: 'https://acme.example/about' })
    expect(uriDuplicate).toMatchObject({ status: 'rejected', code: 'DUPLICATE_ENTITY', existingEntityId: first.id, matchedOn: { method: 'exact_canonical_uri' } })

    const sameName = await service.createEntity({ entityType: 'Organization', canonicalName: '  ACME RESEARCH  ' })
    expect(sameName.status).toBe('ok')
    if (sameName.status !== 'ok') return
    expect(sameName.value.entity.status).toBe('active')
    expect(sameName.value.entity.mergedIntoEntityId).toBeNull()
    expect(sameName.value.mergeCandidates).toHaveLength(1)
    expect(sameName.value.mergeCandidates[0]).toMatchObject({ sourceEntityId: sameName.value.entity.id, targetEntityId: first.id, matchMethod: 'normalized_name', status: 'pending' })
    expect((await service.resolveEntity(sameName.value.entity.id))).toMatchObject({ status: 'ok', value: { id: sameName.value.entity.id } })
  })

  it('redirects merged entity IDs and preserves a reversible append-only merge trail', async () => {
    const { service } = fixture()
    const source = await entity(service, 'Old Organization')
    const target = await entity(service, 'Canonical Organization')
    const merged = await service.mergeEntities({ sourceEntityId: source.id, targetEntityId: target.id, reason: 'Owner approved exact identity review.' })
    expect(merged.status).toBe('ok')
    if (merged.status !== 'ok') return
    expect(await service.resolveEntity(source.id)).toMatchObject({ status: 'ok', value: { id: target.id } })
    const undone = await service.undoMerge({ mergeEventId: merged.value.id, reason: 'Owner discovered two distinct organizations.' })
    expect(undone).toMatchObject({ status: 'ok', value: { id: merged.value.id, undoneAt: expect.any(Date), undoReason: 'Owner discovered two distinct organizations.' } })
    expect(await service.resolveEntity(source.id)).toMatchObject({ status: 'ok', value: { id: source.id, status: 'active', mergedIntoEntityId: null } })
    expect(await service.listMergeEvents({ sourceEntityId: source.id })).toHaveLength(1)
  })

  it('auto-transitions supporting evidence, records reasons, and rejects invalid owner transitions', async () => {
    const { service } = fixture()
    const subject = await entity(service, 'Claim Subject')
    const { version } = await sourceVersion(service)
    const created = await service.createClaim({ statement: 'The published value is 42.', claimType: 'statistics', entityIds: [subject.id] })
    expect(created.status).toBe('ok')
    if (created.status !== 'ok') return
    expect(await service.transitionClaim({ claimId: created.value.id, toStatus: 'independently_confirmed', reason: 'Too early.' })).toMatchObject({ status: 'rejected', code: 'INVALID_TRANSITION' })
    const evidence = await service.addEvidence({ claimId: created.value.id, sourceVersionId: version.id, relation: 'supports', locator: 'section-results', contentHash: HASH_A })
    expect(evidence.status).toBe('ok')
    expect(await service.listClaims({ status: 'source_backed' })).toEqual([expect.objectContaining({ id: created.value.id })])
    const events = await service.listClaimStatusEvents({ claimId: created.value.id })
    expect(events).toEqual([expect.objectContaining({ fromStatus: 'unverified', toStatus: 'source_backed', triggeredBy: 'system', reason: expect.stringContaining('Supporting evidence') })])
  })

  it('discovers shared-source contradictions, resolves without adjudicating, and retains full history', async () => {
    const { service } = fixture()
    const subject = await entity(service, 'Shared Claim Subject')
    const { version } = await sourceVersion(service)
    const supported = await service.createClaim({ statement: 'The value increased.', claimType: 'statistics', entityIds: [subject.id] })
    const contradicted = await service.createClaim({ statement: 'The value decreased.', claimType: 'statistics', entityIds: [subject.id] })
    expect(supported.status).toBe('ok')
    expect(contradicted.status).toBe('ok')
    if (supported.status !== 'ok' || contradicted.status !== 'ok') return
    await service.addEvidence({ claimId: supported.value.id, sourceVersionId: version.id, relation: 'supports', locator: 'table-1-row-2', contentHash: HASH_A })
    const result = await service.addEvidence({ claimId: contradicted.value.id, sourceVersionId: version.id, relation: 'contradicts', locator: 'table-1-row-3', contentHash: HASH_B })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.value.disputes).toHaveLength(1)
    expect(await service.listDisputes({ status: 'open' })).toEqual([expect.objectContaining({ claimAId: Math.min(supported.value.id, contradicted.value.id), claimBId: Math.max(supported.value.id, contradicted.value.id), detectionMethod: 'shared_source_conflict' })])
    expect((await service.listClaims({ status: 'disputed' })).map(item => item.id).sort()).toEqual([supported.value.id, contradicted.value.id].sort())

    const dispute = result.value.disputes[0]!
    const resolved = await service.resolveDispute({ disputeId: dispute.id, resolution: 'both_stand', resolutionNote: 'The claims describe different bounded interpretations.' })
    expect(resolved).toMatchObject({ status: 'ok', value: { status: 'resolved', resolution: 'both_stand' } })
    expect(await service.listClaims()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: supported.value.id, status: 'source_backed' }),
      expect.objectContaining({ id: contradicted.value.id, status: 'unverified' }),
    ]))
    expect((await service.listClaimStatusEvents({ claimId: contradicted.value.id })).map(item => item.toStatus)).toEqual(['disputed', 'unverified'])

    const redisputed = await service.createManualDispute({ claimAId: supported.value.id, claimBId: contradicted.value.id, reason: 'Owner requests a second review after new context.' })
    expect(redisputed).toMatchObject({ status: 'ok', value: { detectionMethod: 'manual', status: 'open' } })
    expect(await service.listDisputes()).toHaveLength(2)
  })

  it('records contradicting evidence without a partner claim as discoverable data, never a dead-end disputed status', async () => {
    const { service } = fixture()
    const subject = await entity(service, 'Lone Contradiction Subject')
    const { version } = await sourceVersion(service)
    const created = await service.createClaim({ statement: 'The reported adoption rate is 12%.', claimType: 'statistics', entityIds: [subject.id] })
    expect(created.status).toBe('ok')
    if (created.status !== 'ok') return
    const result = await service.addEvidence({ claimId: created.value.id, sourceVersionId: version.id, relation: 'contradicts', locator: 'footnote-3', contentHash: HASH_B })
    expect(result).toMatchObject({ status: 'ok', value: { disputes: [] } })
    expect(await service.getClaim(created.value.id)).toMatchObject({ status: 'unverified' })
    expect(await service.listDisputes()).toHaveLength(0)
    expect(await service.listClaimStatusEvents({ claimId: created.value.id })).toHaveLength(0)
    expect(await service.listClaimEvidence({ claimId: created.value.id })).toEqual([expect.objectContaining({ relation: 'contradicts', sourceVersionId: version.id })])
    expect(await service.transitionClaim({ claimId: created.value.id, toStatus: 'first_party_measured', reason: 'Owner measured the rate directly.' })).toMatchObject({ status: 'ok', value: { status: 'first_party_measured' } })
  })

  it('keeps contradicting evidence atomic and pairs nothing when the only shared-source claim is expired', async () => {
    const { service } = fixture()
    const subject = await entity(service, 'Expired Opponent Subject')
    const { version } = await sourceVersion(service)
    const supported = await service.createClaim({ statement: 'The 2025 figure was 10%.', claimType: 'statistics', entityIds: [subject.id] })
    const contradicted = await service.createClaim({ statement: 'The 2026 figure is 15%.', claimType: 'statistics', entityIds: [subject.id] })
    expect(supported.status).toBe('ok')
    expect(contradicted.status).toBe('ok')
    if (supported.status !== 'ok' || contradicted.status !== 'ok') return
    await service.addEvidence({ claimId: supported.value.id, sourceVersionId: version.id, relation: 'supports', locator: 'table-1', contentHash: HASH_A })
    expect(await service.transitionClaim({ claimId: supported.value.id, toStatus: 'expired', reason: 'Superseded by the 2026 report.' })).toMatchObject({ status: 'ok', value: { status: 'expired' } })

    const result = await service.addEvidence({ claimId: contradicted.value.id, sourceVersionId: version.id, relation: 'contradicts', locator: 'table-2', contentHash: HASH_B })
    expect(result).toMatchObject({ status: 'ok', value: { disputes: [] } })
    expect(await service.getClaim(contradicted.value.id)).toMatchObject({ status: 'unverified' })
    expect(await service.getClaim(supported.value.id)).toMatchObject({ status: 'expired' })
    expect(await service.listDisputes()).toHaveLength(0)

    const retry = await service.addEvidence({ claimId: contradicted.value.id, sourceVersionId: version.id, relation: 'contradicts', locator: 'table-2', contentHash: HASH_B })
    expect(retry).toMatchObject({ status: 'rejected', code: 'DUPLICATE_EVIDENCE' })
    expect(await service.listClaimEvidence({ claimId: contradicted.value.id })).toHaveLength(1)
  })

  it('rolls back all writes when a rejection is raised inside an atomic knowledge transaction', async () => {
    const { repository, service } = fixture()
    const source = await entity(service, 'Rollback Source Organization')
    const target = await entity(service, 'Rollback Target Organization')
    const merged = await service.mergeEntities({ sourceEntityId: source.id, targetEntityId: target.id, reason: 'Owner approved the merge.' })
    expect(merged.status).toBe('ok')
    if (merged.status !== 'ok') return
    vi.spyOn(repository, 'updateMergeEvent').mockResolvedValueOnce(null)
    const failed = await service.undoMerge({ mergeEventId: merged.value.id, reason: 'First undo attempt hits a storage fault.' })
    expect(failed).toMatchObject({ status: 'rejected', code: 'UNDO_NOT_LATEST' })
    expect(await service.resolveEntity(source.id)).toMatchObject({ status: 'ok', value: { id: target.id } })
    expect(await service.listMergeEvents({ sourceEntityId: source.id })).toEqual([expect.objectContaining({ id: merged.value.id, undoneAt: null })])
    const undone = await service.undoMerge({ mergeEventId: merged.value.id, reason: 'Owner separates the organizations.' })
    expect(undone).toMatchObject({ status: 'ok', value: { undoneAt: expect.any(Date) } })
    expect(await service.resolveEntity(source.id)).toMatchObject({ status: 'ok', value: { id: source.id, status: 'active', mergedIntoEntityId: null } })
  })

  it('creates manual disputes, preserves terminal retractions, and auto-numbers source versions', async () => {
    const { service } = fixture()
    const subject = await entity(service, 'Manual Dispute Subject')
    const first = await service.createClaim({ statement: 'Manual claim A.', claimType: 'research findings', entityIds: [subject.id] })
    const second = await service.createClaim({ statement: 'Manual claim B.', claimType: 'research findings', entityIds: [subject.id] })
    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    if (first.status !== 'ok' || second.status !== 'ok') return
    const dispute = await service.createManualDispute({ claimAId: first.value.id, claimBId: second.value.id, reason: 'Owner identified incompatible readings.' })
    expect(dispute).toMatchObject({ status: 'ok', value: { detectionMethod: 'manual' } })
    if (dispute.status !== 'ok') return
    await service.resolveDispute({ disputeId: dispute.value.id, resolution: 'kept_a', resolutionNote: 'Owner retracted claim B.', retractClaimId: second.value.id })
    expect(await service.listClaims({ status: 'retracted' })).toEqual([expect.objectContaining({ id: second.value.id })])
    expect(await service.transitionClaim({ claimId: second.value.id, toStatus: 'unverified', reason: 'Attempt reopen.' })).toMatchObject({ status: 'rejected', code: 'INVALID_TRANSITION' })

    const source = await service.registerSource({ canonicalUrl: 'https://example.org/manual-source', sourceClass: 'primary research' })
    expect(source.status).toBe('ok')
    if (source.status !== 'ok') return
    const v1 = await service.addSourceVersion({ sourceId: source.value.id, contentHash: HASH_A, retrievedAt: new Date('2026-08-01T00:00:00Z') })
    const v2 = await service.addSourceVersion({ sourceId: source.value.id, contentHash: HASH_B, retrievedAt: new Date('2026-08-02T00:00:00Z') })
    expect(v1).toMatchObject({ status: 'ok', value: { versionNumber: 1 } })
    expect(v2).toMatchObject({ status: 'ok', value: { versionNumber: 2 } })
  })

  it('derives missing author and publisher gaps from briefs with drafts', async () => {
    const repository = createInMemoryKnowledgeRepository([{
      ownerUserId: OWNER,
      briefId: 301,
      jobId: 401,
      draftId: 501,
      title: 'Unlinked draft',
      language: 'en',
      contentType: 'article',
      contentHash: HASH_A,
      draftCreatedAt: new Date('2026-08-01T00:00:00Z'),
    }])
    const service = createKnowledgeService({ ownerUserId: OWNER, repository })
    expect(await service.listContentKnowledgeGaps()).toEqual([{ type: 'missing_author', briefId: 301 }, { type: 'missing_publisher' }])
    const otherOwner = createKnowledgeService({ ownerUserId: OWNER + 1, repository })
    expect(await otherOwner.listContentKnowledgeGaps()).toEqual([{ type: 'missing_publisher' }])
  })
})

describe('knowledge Drizzle content anchor', () => {
  it('projects the existing brief/job/draft join without a real database', async () => {
    const anchor = { briefId: 11, jobId: 12, draftId: 13, title: 'Durable title', language: 'en' as const, contentType: 'article' as const, contentHash: HASH_A, draftCreatedAt: new Date('2026-08-03T00:00:00.000Z') }
    const builder = {
      from() { return this },
      innerJoin() { return this },
      where() { return this },
      orderBy() { return this },
      limit: async () => [anchor],
    }
    const database = { select: () => builder } as unknown as KnowledgeDrizzleDatabase
    const repository = new DrizzleKnowledgeRepository(database)
    await expect(repository.getContentAnchor({ ownerUserId: OWNER, draftId: anchor.draftId })).resolves.toEqual(anchor)
  })
})
