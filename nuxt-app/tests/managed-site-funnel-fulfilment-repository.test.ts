import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { makeFunnelSessionRepository } from '../server/managed-sites/funnel/session-repository'
import { makeOrderingRepository } from '../server/managed-sites/ordering-repository'

describe('paid funnel scheduled repository authority', () => {
  it('uses a bounded ascending keyset with exact paid order, owner, release, and verified-domain joins', async () => {
    const recorded: { projection?: Record<string, unknown>; joins: unknown[]; where?: unknown; order?: unknown; limit?: number } = { joins: [] }
    const query = {
      from() { return query },
      innerJoin(_table: unknown, predicate: unknown) { recorded.joins.push(predicate); return query },
      leftJoin(_table: unknown, predicate: unknown) { recorded.joins.push(predicate); return query },
      where(predicate: unknown) { recorded.where = predicate; return query },
      orderBy(order: unknown) { recorded.order = order; return query },
      async limit(limit: number) { recorded.limit = limit; return [] },
    }
    const repository = makeFunnelSessionRepository({ select(projection: Record<string, unknown>) { recorded.projection = projection; return query } })
    await repository.listPaidBuildsForFulfilment(80, 5000)
    const dialect = new MySqlDialect()
    const conditions = recorded.joins.map(value => dialect.sqlToQuery(value as any).sql).join(' ')
    const where = dialect.sqlToQuery(recorded.where as any)
    expect(recorded.limit).toBe(50)
    expect(Object.keys(recorded.projection!)).toEqual(['id', 'projectId', 'releaseId', 'draftOrderId', 'previewId', 'quoteId', 'ownerUserId'])
    expect(conditions).toContain('`managedSiteDraftOrders`.`projectId` = `managedSiteFunnelSessions`.`projectId`')
    expect(conditions).toContain('`managedSiteReleaseProjections`.`ownerUserId` = `managedSiteDraftOrders`.`ownerUserId`')
    expect(conditions).toContain('`managedSiteReleaseProjections`.`draftOrderId` = `managedSiteDraftOrders`.`id`')
    expect(conditions).toContain('`managedSiteDomainClaims`.`ownerUserId` = `managedSiteDraftOrders`.`ownerUserId`')
    expect(conditions).toContain('`managedSiteDomainClaims`.`canonicalDomain` = `managedSiteReleaseProjections`.`canonicalDomain`')
    expect(dialect.sqlToQuery(recorded.joins[2] as any).params).toContain('verified')
    expect(where.sql).toContain('`managedSiteFunnelSessions`.`id` > ?')
    expect(where.params).toEqual([80, 'checkout_pending', 'converted', 'payment_verified', 'generated_site', 'payment_verified', 'provisioning', 'retry_wait', 'deployment_pending'])
    expect(dialect.sqlToQuery(recorded.order as any).sql).toBe('`managedSiteFunnelSessions`.`id` asc')
    expect(where.sql).not.toContain('expiresAt')
    expect(where.sql).toContain('$.domainRegistration.delegated')
    await expect(repository.listPaidBuildsForFulfilment(-1, 20)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('takes a FOR UPDATE lock on the exact order before a production acceptance transaction', async () => {
    const calls: unknown[] = []
    const query = { from() { return query }, where(predicate: unknown) { calls.push(predicate); return query }, limit(limit: number) { calls.push(limit); return query }, async for(mode: string) { calls.push(mode); return [{ id: 42, status: 'payment_verified' }] } }
    const repository = makeOrderingRepository({ select: () => query })
    await expect(repository.findDraftOrderByIdForUpdate(42)).resolves.toMatchObject({ id: 42, status: 'payment_verified' })
    const predicate = new MySqlDialect().sqlToQuery(calls[0] as any)
    expect(predicate.sql).toBe('`managedSiteDraftOrders`.`id` = ?')
    expect(predicate.params).toEqual([42])
    expect(calls.slice(1)).toEqual([1, 'update'])
  })
})
