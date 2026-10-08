import { drizzle } from 'drizzle-orm/mysql2'
import { describe, expect, it, vi } from 'vitest'
import { createInMemoryKnowledgeRepository } from '../server/knowledge/repository'
import { DrizzleKnowledgeRepository, type KnowledgeDrizzleDatabase } from '../server/knowledge/repository-drizzle'
import { knowledgeReadLimit } from '../server/knowledge/read-bounds'
import type { KnowledgeRepository } from '../server/knowledge/types'

const OWNER = 41
const SENTINEL = 2_001

function reads(repository: KnowledgeRepository, limit: number | undefined) {
  return [
    () => repository.listEntities(OWNER, limit),
    () => repository.listEntityAliases(OWNER, undefined, limit),
    () => repository.listEntityExternalIds(OWNER, undefined, limit),
    () => repository.listSources(OWNER, limit),
    () => repository.listSourceVersions(OWNER, undefined, limit),
    () => repository.listClaims(OWNER, undefined, limit),
    () => repository.listClaimEntityLinks(OWNER, undefined, limit),
    () => repository.listClaimEvidence(OWNER, undefined, limit),
    () => repository.listContentEntityLinks(OWNER, undefined, limit),
    () => repository.listContentAnchors(OWNER, limit),
    () => repository.listRevisionHeads(OWNER, limit),
  ]
}

function sqlFixture() {
  const query = vi.fn(async (_sql: unknown, _parameters: unknown) => [[], []])
  // Real Drizzle SQL generation with a fully local fake MySQL transport, not a database connection.
  const database = drizzle({ query } as never) as unknown as KnowledgeDrizzleDatabase
  return { query, repository: new DrizzleKnowledgeRepository(database) }
}

describe('Knowledge bounded impact reads', () => {
  it('validates bounded sentinel limits without changing legacy unbounded reads', () => {
    expect(knowledgeReadLimit(undefined)).toBeUndefined()
    expect(knowledgeReadLimit(1)).toBe(1)
    expect(knowledgeReadLimit(SENTINEL)).toBe(SENTINEL)
    for (const invalid of [0, -1, 2_002, 1.5, NaN, Infinity]) expect(() => knowledgeReadLimit(invalid)).toThrow('bounded range')
  })

  it('generates SQL LIMIT for every impact collection with authenticated owner predicates', async () => {
    const { query, repository } = sqlFixture()
    for (const read of reads(repository, SENTINEL)) expect(await read()).toEqual([])
    expect(query).toHaveBeenCalledTimes(11)
    for (const [configuration, parameters] of query.mock.calls) {
      const sql = (configuration as { sql: string }).sql
      expect(sql).toMatch(/where .*`ownerUserId` = \?/u)
      expect(sql).toMatch(/order by /u)
      expect(sql).toMatch(/limit \?$/u)
      expect(parameters).toEqual(expect.arrayContaining([OWNER, SENTINEL]))
    }
  })

  it('keeps existing list calls unbounded when no optional limit was requested', async () => {
    const { query, repository } = sqlFixture()
    for (const read of reads(repository, undefined)) await read()
    for (const [configuration] of query.mock.calls) expect((configuration as { sql: string }).sql).not.toContain('limit')
  })

  it('rejects invalid limits before any SQL transport can run', async () => {
    const { query, repository } = sqlFixture()
    for (const read of reads(repository, 2_002)) await expect(read()).rejects.toThrow('bounded range')
    expect(query).not.toHaveBeenCalled()
  })

  it('requests a repeatable-read, consistent, read-only transaction only for impact previews', async () => {
    const transaction = vi.fn(async (work: (tx: KnowledgeDrizzleDatabase) => Promise<unknown>, _config?: unknown) => work({} as KnowledgeDrizzleDatabase))
    const repository = new DrizzleKnowledgeRepository({ transaction } as unknown as KnowledgeDrizzleDatabase)
    await repository.transaction(async () => 'preview', { consistentReadOnly: true })
    expect(transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' })
    await repository.transaction(async () => 'existing write')
    expect(transaction.mock.calls[1]?.[1]).toBeUndefined()
  })

  it('filters owner before limiting the in-memory repository and preserves no-limit callers', async () => {
    const repository = createInMemoryKnowledgeRepository()
    const at = new Date('2026-10-08T00:00:00Z')
    for (const ownerUserId of [99, OWNER, OWNER, OWNER]) {
      await repository.insertSource({ ownerUserId, canonicalUrl: `https://fixture.example/${ownerUserId}/${(await repository.listSources(ownerUserId)).length}`, urlHash: 'a'.repeat(64), title: null, sourceClass: 'unknown', status: 'active', notes: null, createdAt: at, updatedAt: at })
    }
    expect(await repository.listSources(OWNER)).toHaveLength(3)
    expect(await repository.listSources(OWNER, 2)).toEqual((await repository.listSources(OWNER)).slice(0, 2))
    for (const read of reads(repository, 0)) await expect(read()).rejects.toThrow('bounded range')
    expect(await repository.listSources(99)).toHaveLength(1)
  })
})
