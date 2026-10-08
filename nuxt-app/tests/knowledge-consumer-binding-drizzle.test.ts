import { describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import { normalizedPromptHash } from '../server/llm-visibility/guards'
import { DrizzleKnowledgeConsumerBindingRepository } from '../server/knowledge/consumer-bindings-drizzle'
import type { KnowledgeDrizzleDatabase } from '../server/knowledge/repository-drizzle'
import { knowledgeRevisionCanonicalJson, knowledgeRevisionSha256 } from '../server/knowledge/revision-records'
import { knowledgeConsumerBindingFingerprint } from '../server/knowledge/consumer-bindings'
import type { KnowledgeConsumerBinding } from '../server/knowledge/consumer-binding-types'

const OWNER = 81
const HASH = 'a'.repeat(64)
const PROMPT = '  ＤＳ\tBest Website\nFor GEO  '

function transport(reply: (sql: string, parameters: readonly unknown[]) => unknown[][] = () => []) {
  const query = vi.fn(async (configuration: { sql: string }, parameters: readonly unknown[]) => [reply(configuration.sql, parameters), []])
  const database = drizzle({ query } as never) as unknown as KnowledgeDrizzleDatabase
  return { query, repository: new DrizzleKnowledgeConsumerBindingRepository(database) }
}
function binding(): KnowledgeConsumerBinding {
  const input = { consumerKind: 'benchmark_prompt' as const, consumerId: 9, subjectKind: 'entity' as const, subjectId: 1, operation: 'bind' as const, expectedRevisionFingerprint: HASH, expectedBindingFingerprint: null, idempotencyKey: 'Test-Command-81' }
  const record = { ownerUserId: OWNER, consumerKind: input.consumerKind, consumerId: input.consumerId, consumerVersion: '3', consumerContentHash: normalizedPromptHash(PROMPT), subjectKind: input.subjectKind, subjectId: 1, revisionId: 4, revisionNumber: 1, revisionContentHash: HASH, revisionFingerprint: HASH, operation: input.operation, sequenceNumber: 1, previousBindingFingerprint: null, requestFingerprint: knowledgeRevisionSha256(knowledgeRevisionCanonicalJson(input)), idempotencyKey: input.idempotencyKey, createdAt: new Date('2026-10-08T00:00:00Z'), bindingFingerprint: '' }
  return { ...record, id: 1, bindingFingerprint: knowledgeConsumerBindingFingerprint(record) }
}

describe('Knowledge consumer binding durable read contracts with a synthetic SQL transport', () => {
  it('reads current heads with owner-scoped left join and SQL sentinel, not a full-history aggregate', async () => {
    const { query, repository } = transport()
    expect(await repository.listBindingHeads(OWNER, 2_001)).toEqual([])
    expect(query).toHaveBeenCalledTimes(1)
    const [configuration, parameters] = query.mock.calls[0]!
    expect(configuration.sql).toContain('from `knowledgeConsumerBindingHeads`')
    expect(configuration.sql).toContain('left join `knowledgeConsumerBindings`')
    expect(configuration.sql).not.toMatch(/group by|max\(/iu)
    expect(configuration.sql).toMatch(/`knowledgeConsumerBindings`\.`ownerUserId` = \?/u)
    expect(configuration.sql).toMatch(/`knowledgeConsumerBindingHeads`\.`ownerUserId` = \?/u)
    expect(configuration.sql).toMatch(/limit \?$/u)
    expect(parameters).toEqual([OWNER, OWNER, 2_001])
  })

  it('uses an exact case-sensitive key digest for the owner command lookup', async () => {
    const { query, repository } = transport()
    await repository.getCommand(OWNER, 'Case-Key-81')
    await repository.getCommand(OWNER, 'case-key-81')
    const first = query.mock.calls[0]!
    const second = query.mock.calls[1]!
    expect(first[0].sql).toContain('`idempotencyKeyHash` = ?')
    expect(first[0].sql).toMatch(/limit \?$/u)
    expect(first[1]).toEqual([OWNER, knowledgeRevisionSha256('Case-Key-81'), 1])
    expect(second[1]).toEqual([OWNER, knowledgeRevisionSha256('case-key-81'), 1])
    expect(first[1][1]).not.toBe(second[1][1])
    expect(first[0].sql).not.toContain('Case-Key-81')
  })

  it('accepts native case and Unicode-normalized prompt hashes without returning text', async () => {
    const { query, repository } = transport(() => [[OWNER, 3, normalizedPromptHash(PROMPT), PROMPT, 7, 2]])
    const anchor = await repository.getNativeAnchor(OWNER, 'benchmark_prompt', 9)
    expect(anchor).toEqual({ ownerUserId: OWNER, consumerKind: 'benchmark_prompt', consumerId: 9, consumerVersion: '3', consumerContentHash: normalizedPromptHash(PROMPT) })
    expect(JSON.stringify(anchor)).not.toContain('Best Website')
    const sql = query.mock.calls[0]![0].sql
    expect(sql).toContain('left join `llmVisibilityQueries`')
    expect(sql).toContain('left join `llmVisibilityProjects`')
    expect(sql).not.toContain('SHA2')
  })

  it('rejects an immutable prompt hash that no longer matches its native normalization', async () => {
    const { repository } = transport(() => [[OWNER, 3, HASH, PROMPT, 7, 2]])
    await expect(repository.getNativeAnchor(OWNER, 'benchmark_prompt', 9)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })

  it('batch-loads prompt authority with the same normalization and exact scoped IDs', async () => {
    const { query, repository } = transport(sql => sql.includes('from `llmVisibilityPromptVersions`') ? [[9, 3, normalizedPromptHash(PROMPT), PROMPT, 7, 2]] : [])
    const result = await repository.loadAuthorities(OWNER, [binding()])
    expect(result.anchors.get('benchmark_prompt:9')).toEqual({ ownerUserId: OWNER, consumerKind: 'benchmark_prompt', consumerId: 9, consumerVersion: '3', consumerContentHash: normalizedPromptHash(PROMPT) })
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls.every(([, parameters]) => parameters.includes(OWNER))).toBe(true)
    expect(JSON.stringify([...result.anchors])).not.toContain('Best Website')
  })

  it('rejects bad owner and capacity before issuing SQL', async () => {
    const { query, repository } = transport()
    await expect(repository.listBindingHeads(0, 2_001)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(repository.listBindingHeads(OWNER, 2_002)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(repository.loadAuthorities(OWNER, Array.from({ length: 2_001 }, binding))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(query).not.toHaveBeenCalled()
  })

  it('does not misclassify a native prompt with broken parent ownership as missing', async () => {
    const { repository } = transport(() => [[OWNER, 3, normalizedPromptHash(PROMPT), PROMPT, null, 2]])
    await expect(repository.getNativeAnchor(OWNER, 'benchmark_prompt', 9)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    const batched = transport(sql => sql.includes('from `llmVisibilityPromptVersions`') ? [[9, 3, normalizedPromptHash(PROMPT), PROMPT, 7, null]] : []).repository
    await expect(batched.loadAuthorities(OWNER, [binding()])).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })

  it('pages the native prompt catalog by exact owner IDs and validates a single batch', async () => {
    const { query, repository } = transport((sql) => sql.startsWith('select `id` from')
      ? [[9], [10]] : [[10, 4, normalizedPromptHash(PROMPT), PROMPT, 7, 2], [9, 3, normalizedPromptHash(PROMPT), PROMPT, 7, 2]])
    const anchors = await repository.listNativeAnchors(OWNER, 'benchmark_prompt', 8, 26)
    expect(anchors.map(row => row.consumerId)).toEqual([9, 10])
    expect(anchors.map(row => row.consumerVersion)).toEqual(['3', '4'])
    expect(query).toHaveBeenCalledTimes(2)
    const [configuration, parameters] = query.mock.calls[0]!
    expect(configuration.sql).toContain('`llmVisibilityPromptVersions`.`ownerUserId` = ? and `llmVisibilityPromptVersions`.`id` > ?')
    expect(configuration.sql).toMatch(/order by `llmVisibilityPromptVersions`\.`id` limit \?$/u)
    expect(parameters).toEqual([OWNER, 8, 26])
    expect(query.mock.calls[1]![1]).toEqual([OWNER, OWNER, OWNER, 9, 10])
    expect(JSON.stringify(anchors)).not.toContain('Best Website')
  })

  it('rejects malformed catalog cursors or capacity without SQL and does not invent missing rows', async () => {
    const { query, repository } = transport()
    await expect(repository.listNativeAnchors(OWNER, 'benchmark_prompt', -1, 26)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(repository.listNativeAnchors(OWNER, 'benchmark_prompt', 0, 27)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(query).not.toHaveBeenCalled()
    const incomplete = transport(sql => sql.startsWith('select `id` from') ? [[9]] : []).repository
    await expect(incomplete.listNativeAnchors(OWNER, 'benchmark_prompt', 0, 26)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })
})
