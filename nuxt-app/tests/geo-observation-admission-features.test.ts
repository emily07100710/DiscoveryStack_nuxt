import { afterEach, describe, expect, it, vi } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { getAdmissionFeatureProjection, projectExactAdmissionFeatures, unknownAdmissionFeatures } from '../server/geo-outcome-model/admission-feature-projection'
import * as contentRepository from '../server/content-operations/repository'
import { contentOperationPublicationAttempts } from '../server/database/schema'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
import { sha256Hex } from '../server/geo-outcome-model/canonical'

type Candidate = Parameters<typeof projectExactAdmissionFeatures>[1]
type Publication = NonNullable<Parameters<typeof projectExactAdmissionFeatures>[2]>
type Lineage = NonNullable<Parameters<typeof projectExactAdmissionFeatures>[3]>
function fixture(body = '# Public answer\n\nA bounded factual paragraph. [cite:public-source]\n\n## Details\n\n' + 'Readable evidence. '.repeat(35)) {
  const title = 'A public synthetic article', hash = contentFingerprint(title, body), receipt = 'a'.repeat(64), evidence = 'b'.repeat(64)
  const publication: Publication = { ownerUserId: 1, clientId: 2, entryId: 3, receiptFingerprint: receipt, mode: 'execute', status: 'delivered', contentHash: hash, publicationContentHash: hash, publicationUrl: 'https://public.acme.taipei/article', evidenceSnapshotHash: evidence, completedAt: new Date('2026-01-01T00:00:00Z') }
  const resolved = { authority: { publicationReceiptFingerprint: receipt, contentHash: hash, publicationEvidenceSnapshotHash: evidence, canonicalCandidateUrlHash: sha256Hex(publication.publicationUrl!) }, source: { query: { locale: 'en' }, run: { observedAt: new Date('2026-01-02T00:00:00Z') } } } as unknown as Candidate
  const lineage = { entry: { id: 3, ownerUserId: 1, draftId: 4, contentHash: hash, evidenceSnapshotHash: evidence, contentType: 'article' }, client: { id: 2, ownerUserId: 1 }, job: { id: 5, ownerUserId: 1 }, draft: { id: 4, jobId: 5, contentHash: hash, safetyStatus: 'passed', title, body } } as unknown as Lineage
  return { resolved, publication, lineage }
}
function project(f = fixture()) { return projectExactAdmissionFeatures(1, f.resolved, f.publication, f.lineage) }
type Database = Parameters<typeof getAdmissionFeatureProjection>[0]

afterEach(() => vi.restoreAllMocks())

describe('server-read exact publication admission feature projection', () => {
  it('derives only bounded observable structure and returns no draft text or authority', () => {
    const result = project()
    expect(result).toMatchObject({ featureOrigin: 'exact_publication_draft', features: { contentType: 'article', locale: 'en', contentLengthBucket: 's', headingHierarchy: 'structured', citationMarkerCount: 1, directAnswerPresence: 'unknown', structuredDataPresence: 'unknown', approvedAuthoritySourceCount: null } })
    expect(JSON.stringify(result)).not.toContain('Public answer')
    expect(JSON.stringify(result)).not.toContain('public-source')
    expect(Object.keys(result).sort()).toEqual(['featureOrigin', 'features'])
  })
  it('keeps external and unavailable drafts explicitly unknown, never accepting caller feature values', () => {
    const f = fixture()
    f.resolved.authority.publicationReceiptFingerprint = null
    expect(project(f)).toEqual({ featureOrigin: 'unknown_external', features: unknownAdmissionFeatures('en') })
    expect(projectExactAdmissionFeatures(1, fixture().resolved, null, fixture().lineage).featureOrigin).toBe('unknown_external')
    expect(projectExactAdmissionFeatures(1, fixture().resolved, fixture().publication, null).featureOrigin).toBe('unknown_external')
  })
  it.each(['publication-owner', 'entry-owner', 'client-owner', 'job-owner', 'client-id', 'entry-id', 'draft-id', 'draft-job'])(
    'does not project from mismatched %s provenance', key => {
      const f = fixture()
      if (key === 'publication-owner') f.publication.ownerUserId = 99
      if (key === 'entry-owner') f.lineage.entry.ownerUserId = 99
      if (key === 'client-owner') f.lineage.client.ownerUserId = 99
      if (key === 'job-owner') f.lineage.job!.ownerUserId = 99
      if (key === 'client-id') f.lineage.client.id = 99
      if (key === 'entry-id') f.lineage.entry.id = 99
      if (key === 'draft-id') f.lineage.draft!.id = 99
      if (key === 'draft-job') f.lineage.draft!.jobId = 99
      expect(project(f).featureOrigin).toBe('unknown_external')
    },
  )
  it.each(['dry-run', 'undelivered', 'receipt', 'content-hash', 'publication-hash', 'evidence', 'future-publication', 'url', 'draft-body', 'draft-hash', 'entry-hash', 'entry-evidence', 'safety'])(
    'does not project from %s drift even if other hashes look valid', key => {
      const f = fixture()
      if (key === 'dry-run') f.publication.mode = 'dry_run'
      if (key === 'undelivered') f.publication.status = 'blocked'
      if (key === 'receipt') f.publication.receiptFingerprint = 'c'.repeat(64)
      if (key === 'content-hash') f.publication.contentHash = 'c'.repeat(64)
      if (key === 'publication-hash') f.publication.publicationContentHash = 'c'.repeat(64)
      if (key === 'evidence') f.publication.evidenceSnapshotHash = 'c'.repeat(64)
      if (key === 'future-publication') f.publication.completedAt = new Date('2026-01-03T00:00:00Z')
      if (key === 'url') f.publication.publicationUrl = 'https://public.acme.taipei/other'
      if (key === 'draft-body') f.lineage.draft!.body = 'A different article body'
      if (key === 'draft-hash') f.lineage.draft!.contentHash = 'c'.repeat(64)
      if (key === 'entry-hash') f.lineage.entry.contentHash = 'c'.repeat(64)
      if (key === 'entry-evidence') f.lineage.entry.evidenceSnapshotHash = 'c'.repeat(64)
      if (key === 'safety') f.lineage.draft!.safetyStatus = 'needs_review'
      expect(project(f).featureOrigin).toBe('unknown_external')
    },
  )
  it('refuses detected sensitive text and oversized UTF-8 input without storing it', () => {
    for (const body of ['Contact synthetic@example.test for details', '測'.repeat(90_000)]) {
      const result = project(fixture(body))
      expect(result.featureOrigin).toBe('unknown_external')
      expect(result.features).toEqual(unknownAdmissionFeatures('en'))
    }
  })
  it('uses draft structure, not cited status, follow-up effects or a fabricated answer flag', () => {
    const f = fixture('A plain public paragraph. '.repeat(10))
    const result = project(f)
    expect(result.features.headingHierarchy).toBe('none')
    expect(result.features.citationMarkerCount).toBe(0)
    expect(result.features.queryPageLexicalOverlap).toBeNull()
    expect(result.features.directAnswerPresence).toBe('unknown')
    expect(result.features.entityCoverage).toBeNull()
  })

  it('does not query storage or load a draft for an external candidate without a receipt', async () => {
    const f = fixture()
    f.resolved.authority.publicationReceiptFingerprint = null
    const select = vi.fn(() => { throw new Error('Unexpected storage access') })
    const resolve = vi.spyOn(contentRepository, 'createContentOperationsRepositoryFromDatabase')
    expect(await getAdmissionFeatureProjection({ select } as unknown as Database, 1, f.resolved))
      .toEqual({ featureOrigin: 'unknown_external', features: unknownAdmissionFeatures('en') })
    expect(select).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('selects only bounded publication fields using the exact owner and receipt before resolving the exact entry', async () => {
    const f = fixture()
    const limit = vi.fn(async (_maximum: number) => [f.publication])
    const where = vi.fn((_predicate: SQL) => ({ limit }))
    const from = vi.fn((_table: typeof contentOperationPublicationAttempts) => ({ where }))
    const select = vi.fn((_projection: Record<string, unknown>) => ({ from }))
    const database = { select } as unknown as Database
    const resolveWorkspaceEntry = vi.fn(async () => f.lineage)
    const repository = vi.spyOn(contentRepository, 'createContentOperationsRepositoryFromDatabase')
      .mockReturnValue({ resolveWorkspaceEntry } as unknown as ReturnType<typeof contentRepository.createContentOperationsRepositoryFromDatabase>)
    expect(await getAdmissionFeatureProjection(database, 1, f.resolved)).toEqual(project(f))
    expect(from).toHaveBeenCalledWith(contentOperationPublicationAttempts)
    expect(limit).toHaveBeenCalledWith(2)
    const statement = new MySqlDialect().sqlToQuery(where.mock.calls[0]![0]!)
    expect(statement.sql).toContain('ownerUserId')
    expect(statement.sql).toContain('receiptFingerprint')
    expect(statement.params).toEqual([1, f.publication.receiptFingerprint])
    expect(Object.keys(select.mock.calls[0]![0]!)).not.toContain('body')
    expect(repository).toHaveBeenCalledWith(database)
    expect(resolveWorkspaceEntry).toHaveBeenCalledWith(1, 3)
  })

  it.each([0, 2])('treats %s matching publication receipts as unavailable, without loading a draft', async count => {
    const f = fixture()
    const limit = vi.fn(async () => Array.from({ length: count }, () => f.publication))
    const database = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } as unknown as Database
    const repository = vi.spyOn(contentRepository, 'createContentOperationsRepositoryFromDatabase')
    const result = await getAdmissionFeatureProjection(database, 1, f.resolved)
    expect(result.featureOrigin).toBe('unknown_external')
    expect(repository).not.toHaveBeenCalled()
  })

  it('propagates a storage failure instead of representing it as unknown external features', async () => {
    const database = { select: () => { throw new Error('synthetic-storage-failure') } } as unknown as Database
    await expect(getAdmissionFeatureProjection(database, 1, fixture().resolved)).rejects.toThrow('synthetic-storage-failure')
  })
})
