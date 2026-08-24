import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMaterializeInput, parseReplanInput } from '../server/content-operations/normalization'

const root = join(process.cwd(), 'server/api/content-operations')
const routes = [
  'workspace.get.ts',
  'clients.post.ts',
  'calendars.post.ts',
  'calendars/[id]/replan.post.ts',
  'calendars/[id]/materialize.post.ts',
  'outcomes.post.ts',
]

describe('Content Operations owner-only route contract', () => {
  it('requires owner authorization, resolves numeric owner identity, and disables caching on every route', () => {
    for (const route of routes) {
      const source = readFileSync(join(root, route), 'utf8')
      expect(source).toContain('requireOwner')
      expect(source).toContain('getOwnerDatabaseUserId')
      expect(source).toContain("'cache-control': 'no-store'")
      if (route !== 'workspace.get.ts') {
        expect(source).toContain('readBody')
        expect(source).toContain('parse')
      }
    }
  })

  it('accepts the actual 03 flat replan and materialize payloads at the parser boundary', () => {
    const fingerprint = 'a'.repeat(64)
    const replan = { expectedPlanFingerprint: fingerprint, planStartDate: '2026-02-01', planEndDate: '2026-04-30', publishLocalTime: '09:00', cadenceDays: 7, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: 10, catchUpPolicy: 'one_catch_up', idempotencyKey: 'replan-03' }
    expect(parseReplanInput(replan)).toEqual({ expectedPlanFingerprint: fingerprint, idempotencyKey: 'replan-03', request: { planStartDate: '2026-02-01', planEndDate: '2026-04-30', publishLocalTime: '09:00', cadenceDays: 7, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: 10, catchUpPolicy: 'one_catch_up' } })
    expect(parseMaterializeInput({ expectedPlanFingerprint: fingerprint, idempotencyKey: 'materialize-03' })).toEqual({ expectedPlanFingerprint: fingerprint, idempotencyKey: 'materialize-03' })
    for (const payload of [
      { ...replan, request: replan },
      { ...replan, clock: {} },
      { ...replan, ownerUserId: 1 },
      { ...replan, expectedPlanFingerprint: 'A'.repeat(64) },
      { expectedPlanFingerprint: fingerprint, idempotencyKey: 'materialize-03', leaseOwner: 'worker' },
      { expectedPlanFingerprint: fingerprint, idempotencyKey: '' },
    ]) expect(() => parseReplanInput(payload)).toThrow()
    expect(() => parseMaterializeInput({ expectedPlanFingerprint: fingerprint, idempotencyKey: 'materialize-03', clock: {} })).toThrow()
  })

  it('passes the original flat replan body to the service instead of reparsing the transformed shape', () => {
    const source = readFileSync(join(root, 'calendars/[id]/replan.post.ts'), 'utf8')
    expect(source).toContain('const body = await readBody(event)')
    expect(source).toContain('parseReplanInput(body)')
    expect(source).toContain('replanOwnerContentCalendar(ownerUserId, calendarId(event), body)')
    expect(source).not.toContain('replanOwnerContentCalendar(ownerUserId, calendarId(event), parsed)')
  })

  it('keeps the materialize route server-clock-only and keeps calendar opportunity construction server-side', () => {
    const materialize = readFileSync(join(root, 'calendars/[id]/materialize.post.ts'), 'utf8')
    const calendars = readFileSync(join(root, 'calendars.post.ts'), 'utf8')
    expect(materialize).toContain('parseMaterializeInput')
    expect(materialize).not.toContain('nowLocalDate')
    expect(materialize).not.toContain('clock')
    expect(calendars).not.toContain('opportunities')
    expect(calendars).not.toContain('evidenceSnapshotHash')
  })

  it('exposes truthful capability values only in the workspace service contract', () => {
    const source = readFileSync(join(process.cwd(), 'server/content-operations/service.ts'), 'utf8')
    expect(source).toContain('generationExecutorConfigured: false')
    expect(source).toContain('firstPartyPublisherConfigured: false')
    expect(source).toContain('outcomeCollectionConfigured: false')
  })
})
