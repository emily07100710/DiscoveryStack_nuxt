import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'
import { DrizzleOutcomeModelRepository } from '../server/learning-loop/effect-repository'

function fixture() {
  const clauses: Array<{ kind: 'select' | 'update'; clause: unknown }> = [], patches: Record<string, unknown>[] = [], limits: number[] = [], offsets: number[] = []
  const row = { id: 123, ownerUserId: 7, leaseVersion: 4, status: 'training' }
  const builder = (count: boolean) => ({
    from() { return this }, where(clause: unknown) { clauses.push({ kind: 'select', clause }); return this }, orderBy() { return this },
    limit(value: number) { limits.push(value); return this }, offset(value: number) { offsets.push(value); return this },
    then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(resolve(count ? [{ count: 250 }] : [row])) },
  })
  const database = { select: (fields?: unknown) => builder(Boolean(fields)), update: () => ({ set(patch: Record<string, unknown>) { patches.push(patch); return { where: async (clause: unknown) => { clauses.push({ kind: 'update', clause }); return [{ affectedRows: 1 }] } } } }) }
  const repository = new DrizzleOutcomeModelRepository(database as never), dialect = new MySqlDialect()
  return { repository, clauses, patches, limits, offsets, query: (clause: unknown) => dialect.sqlToQuery(clause as never) }
}

describe('outcome model SQL authority and fencing', () => {
  it('keeps owner, exact lease, expiry and revocation predicates in every durable write', async () => {
    const f = fixture(), now = new Date('2026-10-07T00:00:00Z')
    await f.repository.claim(7, 123, 3, 'new-worker', now, new Date(now.getTime() + 60000))
    await f.repository.finalize({ ownerUserId: 7, id: 123, leaseToken: 'new-worker', leaseVersion: 4 }, now, { status: 'completed', artifact: {}, artifactHash: 'a'.repeat(64), metrics: {}, reasonCode: null })
    await f.repository.revoke(7, 123, 4, now, 'OWNER_REVOKED')
    const writes = f.clauses.filter(item => item.kind === 'update').map(item => f.query(item.clause))
    expect(writes).toHaveLength(3)
    for (const query of writes) { expect(query.sql).toContain('ownerUserId'); expect(query.sql).toContain('leaseVersion'); expect(query.sql).toContain('revokedAt'); expect(query.sql).toMatch(/is null/); expect(query.params).toContain(7); expect(query.params).toContain(123) }
    expect(writes[0]?.sql).toContain('leaseExpiresAt'); expect(writes[0]?.params).toContain(3)
    expect(writes[1]?.sql).toMatch(/leaseExpiresAt.*>/); expect(writes[1]?.params).toContain('new-worker'); expect(writes[1]?.params).toContain(4)
    expect(f.patches[2]).toMatchObject({ artifact: null, artifactHash: null, metrics: null, leaseToken: null, leaseExpiresAt: null, leaseVersion: 5, status: 'revoked' })
  })
  it('bounds UI and rotated retention reads while selecting queued work independently of old completed rows', async () => {
    const f = fixture(), now = new Date('2026-10-07T00:00:00Z')
    await f.repository.list(7); expect(await f.repository.countLive(7)).toBe(250)
    await f.repository.listLive(7, 200); await f.repository.nextPending(7, now)
    expect(f.limits).toEqual([100, 100, 1]); expect(f.offsets).toEqual([200])
    for (const query of f.clauses.map(item => f.query(item.clause))) { expect(query.sql).toContain('ownerUserId'); expect(query.params).toContain(7) }
    const pending = f.query(f.clauses.at(-1)!.clause)
    expect(pending.params).toContain('queued'); expect(pending.params).toContain('training'); expect(pending.sql).toContain('leaseExpiresAt'); expect(pending.sql).toContain('revokedAt')
  })
})
