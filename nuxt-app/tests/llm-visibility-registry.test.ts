import { describe, expect, it } from 'vitest'
import { calculateVisibilityMetrics } from '../server/llm-visibility/metrics'
import { normalizedPromptHash } from '../server/llm-visibility/guards'
import {
  createCompetitor,
  activeCompetitorTerms,
  deactivateCompetitor,
  syncProjectRegistry,
  updateCompetitor,
  updateVisibilityQuery,
  type CompetitorRecord,
  type PromptVersionRecord,
  type VisibilityRegistryRepository,
} from '../server/llm-visibility/registry'
import type { ProjectRecord, QueryRecord } from '../server/llm-visibility/service'

class MemoryRegistry implements VisibilityRegistryRepository {
  projects: ProjectRecord[] = [{ id: 10, ownerUserId: 7, name: 'Monitor', canonicalWebsiteUrl: 'https://example.com/', canonicalDomain: 'example.com', locale: 'en', brandName: 'Acme Labs', brandAliases: ['Acme'], competitorBrands: ['Legacy Rival'], status: 'active' }]
  queries: QueryRecord[] = [
    { id: 20, ownerUserId: 7, projectId: 10, promptText: 'Which product fits?', promptHash: normalizedPromptHash('Which product fits?'), intent: 'comparison', locale: 'en', active: true },
    { id: 21, ownerUserId: 7, projectId: 10, promptText: 'Existing prompt', promptHash: normalizedPromptHash('Existing prompt'), intent: 'comparison', locale: 'en', active: true },
  ]
  promptVersions: PromptVersionRecord[] = []
  competitors: CompetitorRecord[] = []
  nextPromptVersionId = 100
  nextCompetitorId = 200

  async transaction<T>(work: (repository: VisibilityRegistryRepository) => Promise<T>): Promise<T> { return work(this) }
  async getProject(ownerUserId: number, projectId: number) { return this.projects.find(row => row.ownerUserId === ownerUserId && row.id === projectId) || null }
  async listProjectQueries(ownerUserId: number, projectId: number) { return this.queries.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) }
  async getQuery(ownerUserId: number, queryId: number) { return this.queries.find(row => row.ownerUserId === ownerUserId && row.id === queryId) || null }
  async findQueryByHash(ownerUserId: number, projectId: number, promptHash: string) { return this.queries.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId && row.promptHash === promptHash) || null }
  async updateQuery(ownerUserId: number, queryId: number, values: { promptText?: string, promptHash?: string, active?: boolean, updatedAt: Date }) {
    const query = await this.getQuery(ownerUserId, queryId)
    if (!query) throw new Error('missing query')
    Object.assign(query, values)
    return query
  }
  async getLatestPromptVersion(ownerUserId: number, queryId: number) { return this.promptVersions.filter(row => row.ownerUserId === ownerUserId && row.queryId === queryId).sort((left, right) => right.versionNumber - left.versionNumber)[0] || null }
  async insertPromptVersion(values: Omit<PromptVersionRecord, 'id' | 'createdAt'>) {
    const row = { id: this.nextPromptVersionId++, ...values }
    this.promptVersions.push(row)
    return row
  }
  async listCompetitors(ownerUserId: number, projectId: number, options: { activeOnly?: boolean, limit?: number } = {}) { return this.competitors.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId && (!options.activeOnly || row.active)).slice(0, options.limit || 500) }
  async getCompetitor(ownerUserId: number, competitorId: number) { return this.competitors.find(row => row.ownerUserId === ownerUserId && row.id === competitorId) || null }
  async findCompetitorByKey(ownerUserId: number, projectId: number, canonicalKey: string) { return this.competitors.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId && row.canonicalKey === canonicalKey) || null }
  async insertCompetitor(values: Omit<CompetitorRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    if (await this.findCompetitorByKey(values.ownerUserId, values.projectId, values.canonicalKey)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
    const row = { id: this.nextCompetitorId++, ...values }
    this.competitors.push(row)
    return row
  }
  async updateCompetitor(ownerUserId: number, competitorId: number, values: Partial<Pick<CompetitorRecord, 'name' | 'canonicalKey' | 'aliases' | 'domain' | 'active'>> & { updatedAt: Date }) {
    const row = await this.getCompetitor(ownerUserId, competitorId)
    if (!row) throw new Error('missing competitor')
    Object.assign(row, values)
    return row
  }
}

describe('LLM visibility prompt and competitor registries', () => {
  it('increments versions only when normalized prompt text changes and rejects project duplicates', async () => {
    const repository = new MemoryRegistry()
    const same = await updateVisibilityQuery(repository, 7, 20, { promptText: '  WHICH   product fits? ' })
    expect(same.versionChanged).toBe(false)
    expect(same.currentVersion.versionNumber).toBe(1)
    const changed = await updateVisibilityQuery(repository, 7, 20, { promptText: 'Which option fits best?' })
    expect(changed.versionChanged).toBe(true)
    expect(changed.currentVersion.versionNumber).toBe(2)
    await expect(updateVisibilityQuery(repository, 7, 20, { promptText: 'Existing prompt' })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('syncs legacy rows idempotently and returns identical registry state on the second run', async () => {
    const repository = new MemoryRegistry()
    const first = await syncProjectRegistry(repository, 7, 10)
    const second = await syncProjectRegistry(repository, 7, 10)
    expect(first).toMatchObject({ promptVersionsCreated: 2, competitorsCreated: 1 })
    expect(second).toMatchObject({ promptVersionsCreated: 0, competitorsCreated: 0 })
    expect(second.promptVersions).toEqual(first.promptVersions)
    expect(second.competitors).toEqual(first.competitors)
  })

  it('does not re-add a deactivated legacy competitor to provider plan terms', async () => {
    const repository = new MemoryRegistry()
    const synced = await syncProjectRegistry(repository, 7, 10)
    const legacy = synced.competitors.find(row => row.name === 'Legacy Rival')!
    await deactivateCompetitor(repository, 7, legacy.id)
    const again = await syncProjectRegistry(repository, 7, 10)
    expect(again.competitorsCreated).toBe(0)
    expect(activeCompetitorTerms(again.competitors)).not.toContain('Legacy Rival')
  })

  it('supports competitor create/update/deactivate while rejecting brand collisions and duplicate keys', async () => {
    const repository = new MemoryRegistry()
    const created = await createCompetitor(repository, 7, 10, { name: 'Rival Co', aliases: ['Rival'], domain: 'rival.example.org' })
    expect(created).toMatchObject({ canonicalKey: 'rival co', aliases: ['Rival'], domain: 'rival.example.org', active: true })
    await expect(createCompetitor(repository, 7, 10, { name: 'Ｒｉｖａｌ　Ｃｏ', aliases: [], domain: null })).rejects.toMatchObject({ statusCode: 409 })
    await expect(createCompetitor(repository, 7, 10, { name: 'Other', aliases: ['ＡＣＭＥ'], domain: null })).rejects.toMatchObject({ statusCode: 422 })
    const updated = await updateCompetitor(repository, 7, created.id, { aliases: ['Rival Brand'], domain: 'https://rival.example.org/path' })
    expect(updated).toMatchObject({ aliases: ['Rival Brand'], domain: 'rival.example.org' })
    expect(await deactivateCompetitor(repository, 7, created.id)).toMatchObject({ active: false })
    expect(activeCompetitorTerms(repository.competitors)).not.toContain('Rival Co')
    expect(activeCompetitorTerms(repository.competitors)).not.toContain('Rival Brand')
  })

  it('fails closed when a 31st active registry term would exceed the probe engine limit', async () => {
    const repository = new MemoryRegistry()
    await createCompetitor(repository, 7, 10, { name: 'Rival A', aliases: Array.from({ length: 20 }, (_, index) => `A alias ${index}`), domain: null })
    await createCompetitor(repository, 7, 10, { name: 'Rival B', aliases: Array.from({ length: 8 }, (_, index) => `B alias ${index}`), domain: null })
    expect(activeCompetitorTerms(repository.competitors)).toHaveLength(30)
    await expect(createCompetitor(repository, 7, 10, { name: 'Term thirty one', aliases: [], domain: null })).rejects.toMatchObject({ statusCode: 422, message: '此 project 的有效競品名稱與 alias 合計不可超過 30 筆（探測引擎上限）。' })
  })

  it('attributes registry aliases to listed competitors and preserves bounded unlisted names', () => {
    const metrics = calculateVisibilityMetrics({
      queries: [{ id: 20, locale: 'en', active: true }],
      observations: [{ queryId: 20, provider: 'chatgpt', observationMode: 'manual_verified', observedAt: '2026-08-15T00:00:00Z', brandMentioned: true, exactMentionCount: 2, firstMentionPosition: 1, citationUrls: [], competitorMentions: { Rival: 3, Mystery: 1 } }],
      canonicalDomain: 'example.com',
      currentStart: new Date('2026-08-01T00:00:00Z'),
      currentEnd: new Date('2026-09-01T00:00:00Z'),
      competitorRegistry: [{ id: 200, name: 'Rival Co', canonicalKey: 'rival co', aliases: ['Rival'] }],
    })
    expect(metrics.current.shareOfVoice).toMatchObject({ n: 6, brandMentions: 2, brandShare: 0.3333, listed: [{ competitorId: 200, mentions: 3, share: 0.5 }], unlistedMentions: 1, unlistedShare: 0.1667, unlistedNames: ['Mystery'] })
  })
})
