import { describe, expect, it, vi } from 'vitest'
import { fingerprint } from '../server/geo-outcome-model/canonical'
import { assertDatasetKnowledgeAuthorityCurrent, assertValidDatasetKnowledgeAuthority, buildDatasetKnowledgeAuthority, summarizeDatasetDecision, summarizeDatasetKnowledgeAuthority } from '../server/geo-outcome-model/knowledge-authority'
import type { DatasetKnowledgeHead, DatasetKnowledgeState } from '../server/geo-outcome-model/knowledge-authority-types'
import type { DatasetDecision, DatasetManifest, GeoOutcomeRepositoryPort } from '../server/geo-outcome-model/types'

const hash = (value: string) => fingerprint(value)
const state = (heads: DatasetKnowledgeHead[] = []): DatasetKnowledgeState => ({ ownerUserId: 42, manifestId: 'geo-dataset-fixture', manifestFingerprint: hash('manifest'), nativeDatasetId: 77, heads })
const head = (id = 1): DatasetKnowledgeHead => ({ subjectKind: 'entity', subjectId: id, operation: 'bind', sequenceNumber: 1, bindingFingerprint: hash(`binding-${id}`), revisionNumber: 1, revisionContentHash: hash(`content-${id}`), revisionFingerprint: hash(`revision-${id}`), currentRevisionFingerprint: hash(`revision-${id}`) })
const dataset = { ownerUserId: 42, manifestId: 'geo-dataset-fixture', manifestFingerprint: hash('manifest'), status: 'approved' } as DatasetManifest
function repository(currentState = state(), decisions?: DatasetDecision[]) {
  const authority = buildDatasetKnowledgeAuthority(currentState, currentState.heads.some(row => row.operation === 'bind') ? 'pinned_v1' : 'declared_none_v1')
  const decision = { decisionId: 'geo-dataset-decision-fixture', ownerUserId: 42, manifestId: dataset.manifestId, manifestFingerprint: dataset.manifestFingerprint, previousStatus: 'ready_for_review', newStatus: 'approved', reviewerUserId: 42, reason: 'Synthetic explicit owner declaration.', createdAt: '2026-10-08T00:00:00.000Z', knowledgeAuthority: authority } satisfies DatasetDecision
  const repo = { listDatasetDecisions: vi.fn(async () => decisions || [decision]), readDatasetKnowledgeState: vi.fn(async () => structuredClone(currentState)), getDataset: vi.fn(async () => structuredClone(dataset)) } as unknown as GeoOutcomeRepositoryPort
  return { repo, decision, currentState }
}

describe('immutable dependency authority separate from dataset manifest', () => {
  it('requires an explicit mode and never interprets absent/empty pins as approval', () => {
    expect(() => buildDatasetKnowledgeAuthority(state(), undefined as never)).toThrow(/explicit_dependency_declaration/)
    expect(() => buildDatasetKnowledgeAuthority(state(), 'pinned_v1')).toThrow(/requires_active/)
    expect(() => buildDatasetKnowledgeAuthority(state([head()]), 'declared_none_v1')).toThrow(/active_dependencies/)
  })
  it('sorts exact pins, does not change the native manifest hash and rejects duplicates', () => {
    const first = buildDatasetKnowledgeAuthority(state([head(2), head(1)]), 'pinned_v1')
    expect(first).toEqual(buildDatasetKnowledgeAuthority(state([head(1), head(2)]), 'pinned_v1'))
    expect(first.manifestFingerprint).toBe(hash('manifest'))
    assertValidDatasetKnowledgeAuthority(first)
    expect(() => buildDatasetKnowledgeAuthority(state([head(), head()]), 'pinned_v1')).toThrow(/duplicate_dependency/)
  })
  it('records revoked tombstones without silently granting no-dependency authority', () => {
    const revoked = { ...head(), operation: 'revoke' as const, sequenceNumber: 2, bindingFingerprint: hash('revoked-binding'), currentRevisionFingerprint: null }
    const authority = buildDatasetKnowledgeAuthority(state([revoked]), 'declared_none_v1')
    expect(authority.heads).toHaveLength(1)
    expect(authority.authorityFingerprint).not.toBe(buildDatasetKnowledgeAuthority(state(), 'declared_none_v1').authorityFingerprint)
    expect(() => buildDatasetKnowledgeAuthority(state([revoked]), 'pinned_v1')).toThrow(/requires_active/)
  })
  it.each([null, hash('new-revision')])('rejects an active pin with current head %s', currentRevisionFingerprint => {
    expect(() => buildDatasetKnowledgeAuthority(state([{ ...head(), currentRevisionFingerprint }]), 'pinned_v1')).toThrow(/knowledge_revision_stale/)
  })
  it('rejects altered hashes, native identity, unknown fields and noncanonical persisted order', () => {
    const authority = buildDatasetKnowledgeAuthority(state([head(1), head(2)]), 'pinned_v1')
    for (const changed of [{ ...authority, nativeDatasetId: 78 }, { ...authority, authorityFingerprint: hash('forged') }, { ...authority, rawText: 'must not be accepted' }, { ...authority, heads: [...authority.heads].reverse() }]) expect(() => assertValidDatasetKnowledgeAuthority(changed)).toThrow()
  })
})

describe('current approval and execution authority', () => {
  it('projects a bounded historical receipt without private dependency graph or native identity', () => {
    const f = repository(state([head()]))
    const summary = summarizeDatasetDecision(f.decision)
    expect(summary.knowledgeAuthority).toEqual({ mode: 'pinned_v1', authorityFingerprint: f.decision.knowledgeAuthority!.authorityFingerprint, activePinCount: 1 })
    expect(JSON.stringify(summary)).not.toMatch(/nativeDatasetId|heads|subjectId|revisionContentHash/)
    expect(summarizeDatasetDecision({ ...f.decision, knowledgeAuthority: null }).knowledgeAuthority).toBeNull()
  })
  it('matches the exact latest owner decision and captures the native lock before reading decisions', async () => {
    const f = repository()
    const result = await assertDatasetKnowledgeAuthorityCurrent(42, dataset, f.repo, undefined, true)
    expect(result.reference).toEqual({ datasetDecisionId: f.decision.decisionId, knowledgeAuthorityFingerprint: f.decision.knowledgeAuthority!.authorityFingerprint })
    expect(f.repo.readDatasetKnowledgeState).toHaveBeenCalledWith(42, dataset.manifestId, true)
    expect(vi.mocked(f.repo.readDatasetKnowledgeState).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.repo.listDatasetDecisions).mock.invocationCallOrder[0]!)
  })
  it('legacy decisions and machine actors do not supply a human dependency declaration', async () => {
    const f = repository()
    for (const changed of [{ ...f.decision, knowledgeAuthority: null }, { ...f.decision, reviewerUserId: null }, { ...f.decision, ownerUserId: 43 }]) {
      const repo = repository(state(), [changed]).repo
      await expect(assertDatasetKnowledgeAuthorityCurrent(42, dataset, repo)).rejects.toThrow(/explicit_dependency_approval/)
    }
  })
  it('blocks new bindings, revision changes and revocation without converting to declared_none', async () => {
    const f = repository(state([head()]))
    for (const changed of [state([head(), head(2)]), state([{ ...head(), currentRevisionFingerprint: hash('revision-2') }]), state([{ ...head(), operation: 'revoke', sequenceNumber: 2, bindingFingerprint: hash('revoked'), currentRevisionFingerprint: null }])]) {
      vi.mocked(f.repo.readDatasetKnowledgeState).mockResolvedValueOnce(changed)
      await expect(assertDatasetKnowledgeAuthorityCurrent(42, dataset, f.repo)).rejects.toThrow()
    }
  })
  it('even unchanged dependency approval requires the exact newly approved decision', async () => {
    const f = repository()
    await expect(assertDatasetKnowledgeAuthorityCurrent(42, dataset, f.repo, { datasetDecisionId: 'geo-dataset-decision-old', knowledgeAuthorityFingerprint: f.decision.knowledgeAuthority!.authorityFingerprint })).rejects.toThrow(/dependency_approval_changed/)
  })
  it('storage failures show unavailable, never current or a fabricated no-dependency state', async () => {
    const f = repository()
    vi.mocked(f.repo.readDatasetKnowledgeState).mockRejectedValue(new Error('private database detail'))
    expect(await summarizeDatasetKnowledgeAuthority(42, dataset, f.repo)).toEqual({ status: 'unavailable', mode: null, authorityFingerprint: null, activePinCount: 0, reasonCodes: ['knowledge_authority_unavailable'] })
  })
})
