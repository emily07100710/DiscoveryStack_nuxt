import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { managedSiteProjects } from '../server/database/schema'
import { makeFunnelSessionRepository, MANAGED_SITE_FUNNEL_BUILD_RESERVATION_ACTION } from '../server/managed-sites/funnel/session-repository'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'

const unavailable = { statusCode: 503, statusMessage: 'Managed site funnel is temporarily unavailable.' }

function repositoryFor(rows: ReadonlyArray<{ count: unknown }>) {
  const recordedClauses: unknown[] = []
  const recordedTables: unknown[] = []
  const database = {
    select: () => ({
      from: (table: unknown) => {
        recordedTables.push(table)
        return {
        where: async (clause: unknown) => {
          recordedClauses.push(clause)
          return rows
        },
        }
      },
    }),
  }
  return { repository: makeFunnelSessionRepository(database), recordedClauses, recordedTables }
}

describe('funnel session repository', () => {
  it('counts new projects or matching durable retry reservations from the inclusive time window', async () => {
    const since = new Date('2030-01-01T00:00:00.000Z')
    const { repository, recordedClauses, recordedTables } = repositoryFor([{ count: '3' }])
    await expect(repository.countBuildReservationsSince(since)).resolves.toBe(3)
    expect(recordedTables[0]).toBe(managedSiteProjects)
    const query = new MySqlDialect().sqlToQuery(recordedClauses[0] as any)
    expect(query.sql).toContain('`managedSiteProjects`.`createdAt` >= ? or exists (select 1 from `managedSiteAuditEvents`')
    expect(query.sql).toContain('`managedSiteAuditEvents`.`projectId` = `managedSiteProjects`.`id`')
    expect(query.sql).toContain('`managedSiteAuditEvents`.`ownerUserId` = `managedSiteProjects`.`ownerUserId`')
    expect(query.sql).toContain('`managedSiteAuditEvents`.`action` = ? and `managedSiteAuditEvents`.`occurredAt` >= ?')
    expect(query.params).toHaveLength(3)
    expect(String(query.params[0])).toContain('2030-01-01')
    expect(query.params[1]).toBe(MANAGED_SITE_FUNNEL_BUILD_RESERVATION_ACTION)
    expect(query.params[2]).toBe(query.params[0])
  })

  it('counts a renewed project once and excludes expired, unrelated, or wrong-owner audit events', async () => {
    const since = new Date('2030-01-02T00:00:00.000Z')
    const old = new Date(since.getTime() - 1)
    const projects = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, ownerUserId: 1, createdAt: index === 0 ? since : old }))
    const event = (projectId: number, patch = {}) => ({ projectId, ownerUserId: 1, action: MANAGED_SITE_FUNNEL_BUILD_RESERVATION_ACTION, occurredAt: since, ...patch })
    const audits = [event(1), event(2), event(2), event(3, { occurredAt: old }), event(4, { ownerUserId: 2 }), event(5, { action: 'project_created' })]
    const { repository } = createFunnelSessionMemoryRepository({ projects: () => projects, audits: () => audits })
    await expect(repository.countBuildReservationsSince(since)).resolves.toBe(2)
  })

  it('accepts a numeric zero count', async () => {
    const { repository } = repositoryFor([{ count: 0 }])
    await expect(repository.countBuildReservationsSince(new Date('2030-01-01T00:00:00.000Z'))).resolves.toBe(0)
  })

  it.each([[[]], [[{ count: -1 }]], [[{ count: 'abc' }]], [[{ count: 1.5 }]]])('fails closed for invalid count rows: %#', async rows => {
    const { repository } = repositoryFor(rows)
    await expect(repository.countBuildReservationsSince(new Date('2030-01-01T00:00:00.000Z'))).rejects.toMatchObject(unavailable)
  })
})
