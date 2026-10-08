import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/mysql2'
import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeImpactPreview } from '../server/knowledge/impact-preview'
import { createInMemoryKnowledgeRepository } from '../server/knowledge/repository'
import { createKnowledgeService } from '../server/knowledge/service'
import { DrizzleKnowledgeRepository, type KnowledgeDrizzleDatabase } from '../server/knowledge/repository-drizzle'
import type { KnowledgeRepository } from '../server/knowledge/types'

const OWNER = 71
const OTHER_OWNER = 72
const SENTINEL = 2_001
const now = new Date('2026-10-08T00:00:00.000Z')

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

async function createSubjectFixture() {
  const repository = createInMemoryKnowledgeRepository()
  const service = createKnowledgeService({ ownerUserId: OWNER, repository, now: () => now, entityUid: () => 'revision-head-entity' })
  const entity = await service.createEntity({ entityType: 'Organization', canonicalName: 'Revision Head Entity' })
  if (entity.status !== 'ok') throw new Error(entity.reason)
  return { repository, service, entityId: entity.value.entity.id }
}

describe('Knowledge impact revision head reads', () => {
  it('queries bounded latest-head summaries with SQL-only snapshot checks and paired owner events', async () => {
    const query = vi.fn(async (_sql: unknown, _parameters: unknown) => [[], []])
    const database = drizzle({ query } as never) as unknown as KnowledgeDrizzleDatabase
    const repository = new DrizzleKnowledgeRepository(database)

    expect(await repository.listRevisionHeads(OWNER, SENTINEL)).toEqual([])

    expect(query).toHaveBeenCalledTimes(1)
    const [configuration, parameters] = query.mock.calls[0]!
    const sql = (configuration as { sql: string }).sql
    expect(sql).toMatch(/max\s*\(/iu)
    expect(sql).toMatch(/group by .*subjectKind.*subjectId/iu)
    expect(sql).toMatch(/inner join/iu)
    expect(sql).toMatch(/sha2\(\s*`knowledgeSubjectRevisions`\.`canonicalSnapshot`\s*,\s*256\s*\)/iu)
    expect(sql).toMatch(/octet_length\(\s*`knowledgeSubjectRevisions`\.`canonicalSnapshot`\s*\)/iu)
    expect(sql).toMatch(/left join `knowledgeMutationEvents`/iu)
    expect(sql).toMatch(/`knowledgeMutationEvents`\.`ownerUserId`\s*=\s*`knowledgeSubjectRevisions`\.`ownerUserId`/iu)
    expect(sql).toMatch(/`knowledgeMutationEvents`\.`revisionId`\s*=\s*`knowledgeSubjectRevisions`\.`id`/iu)
    expect((sql.match(/`ownerUserId`\s*=\s*\?/giu) ?? []).length).toBe(2)
    expect(sql).toMatch(/order by .*subjectKind.*subjectId/iu)
    expect(sql).toMatch(/limit \?$/u)
    expect(parameters).toEqual(expect.arrayContaining([OWNER, SENTINEL]))
    if (!Array.isArray(parameters)) throw new Error('Synthetic SQL transport must receive a parameter array.')
    expect(parameters.filter(parameter => parameter === OWNER)).toHaveLength(2)
    const projection = sql.slice(0, sql.toLowerCase().indexOf(' from '))
    expect(projection).not.toMatch(/(?:^|,)\s*`knowledgeSubjectRevisions`\.`canonicalSnapshot`(?:\s*(?:,|as|$))/iu)
  })

  it('returns sorted owner-isolated heads, including the newest revision after long histories', async () => {
    const { repository, service, entityId } = await createSubjectFixture()
    for (let index = 0; index < 30; index += 1) {
      const result = await service.addAlias({ entityId, alias: `Head alias ${index}` })
      if (result.status !== 'ok') throw new Error(result.reason)
    }
    const claim = await service.createClaim({ statement: 'A pinned claim', claimType: 'product capabilities', entityIds: [entityId] })
    if (claim.status !== 'ok') throw new Error(claim.reason)
    const source = await service.registerSource({ canonicalUrl: 'https://example.test/revision-head', sourceClass: 'official documentation' })
    if (source.status !== 'ok') throw new Error(source.reason)
    const sourceVersion = await service.addSourceVersion({ sourceId: source.value.id, contentHash: sha256('source version'), retrievedAt: now })
    if (sourceVersion.status !== 'ok') throw new Error(sourceVersion.reason)

    const heads = await repository.listRevisionHeads(OWNER)
    expect(heads.map(({ subjectKind, subjectId }) => `${subjectKind}:${subjectId}`)).toEqual([
      `claim:${claim.value.id}`,
      `entity:${entityId}`,
      `source:${source.value.id}`,
    ])
    const entityHead = heads.find(head => head.subjectKind === 'entity' && head.subjectId === entityId)
    expect(entityHead?.revisionNumber).toBe(32)
    const entityHistory = await repository.listRevisions(OWNER, { kind: 'entity', id: entityId })
    expect(entityHistory).toHaveLength(26)
    expect(entityHistory[0]?.revisionNumber).toBe(32)
    expect(heads).toHaveLength(3)
    expect(heads[0]).not.toHaveProperty('canonicalSnapshot')
    expect(await repository.listRevisionHeads(OWNER, 1)).toEqual(heads.slice(0, 1))
    expect(await repository.listRevisionHeads(OTHER_OWNER)).toEqual([])
  })

  it('reads revision heads once in the preview read-only transaction and rejects sentinel overflow', async () => {
    const { repository: base, service, entityId } = await createSubjectFixture()
    const created = await service.addAlias({ entityId, alias: 'Preview head' })
    if (created.status !== 'ok') throw new Error(created.reason)

    let transactionCount = 0
    let headReadCount = 0
    let inTransaction = false
    const instrument = (overflow: boolean): KnowledgeRepository => new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (work: (tx: KnowledgeRepository) => Promise<unknown>, options?: unknown) => {
            transactionCount += 1
            expect(options).toEqual({ consistentReadOnly: true })
            return target.transaction(async tx => {
              inTransaction = true
              try {
                const scoped = new Proxy(tx, {
                  get(inner, key, innerReceiver) {
                    if (key === 'listRevisionHeads') {
                      return async (ownerUserId: number, limit?: number) => {
                        expect(inTransaction).toBe(true)
                        expect(ownerUserId).toBe(OWNER)
                        expect(limit).toBe(SENTINEL)
                        headReadCount += 1
                        if (overflow) return Array.from({ length: SENTINEL }, (_, index) => ({ ownerUserId: OWNER, subjectKind: 'entity', subjectId: index + 1, revisionNumber: 1, contentHash: 'a'.repeat(64), revisionFingerprint: 'b'.repeat(64) }))
                        return Reflect.get(inner, key, innerReceiver).call(inner, ownerUserId, limit)
                      }
                    }
                    const value = Reflect.get(inner, key, innerReceiver) as unknown
                    return typeof value === 'function' ? value.bind(inner) : value
                  },
                }) as KnowledgeRepository
                return await work(scoped)
              } finally {
                inTransaction = false
              }
            }, options as never)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const report = await createKnowledgeImpactPreview(OWNER, { kind: 'entity', id: entityId }, instrument(false))
    expect(report.subject).toEqual({ kind: 'entity', id: entityId })
    expect(transactionCount).toBe(1)
    expect(headReadCount).toBe(1)
    expect(JSON.stringify(report)).not.toContain('canonicalSnapshot')

    transactionCount = 0
    headReadCount = 0
    await expect(createKnowledgeImpactPreview(OWNER, { kind: 'entity', id: entityId }, instrument(true)))
      .rejects.toMatchObject({ code: 'SNAPSHOT_LIMIT_EXCEEDED' })
    expect(transactionCount).toBe(1)
    expect(headReadCount).toBe(1)
  })
})
