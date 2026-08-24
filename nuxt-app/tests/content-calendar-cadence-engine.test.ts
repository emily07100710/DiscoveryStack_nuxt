import { describe, expect, it } from 'vitest'
import {
  CONTENT_CALENDAR_ENGINE_VERSION,
  buildContentCalendar,
  canonicalJson,
  fingerprintCanonical,
  materializeDueContentWork as materializeDueContentWorkEngine,
  normalizeContentCalendarRequest,
  replanContentCalendar as replanContentCalendarEngine,
} from '../server/content-calendar'
import type { CalendarReasonCode, ContentCalendarEntry, ContentCalendarRequest, ContentCalendarResult } from '../server/content-calendar'
import { manySyntheticOpportunities, SYNTHETIC_EVIDENCE_HASH, syntheticOpportunity, syntheticRequest } from './fixtures/content-calendar/plans'

const BASE = syntheticRequest()

function request(overrides: Partial<ContentCalendarRequest> = {}): ContentCalendarRequest {
  return { ...BASE, ...overrides }
}

function materializeDueContentWork(input: unknown) {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const calendar = record.calendar as { planFingerprint?: unknown } | null | undefined
    if (calendar && record.expectedPlanFingerprint === undefined) return materializeDueContentWorkEngine({ ...record, expectedPlanFingerprint: calendar.planFingerprint })
  }
  return materializeDueContentWorkEngine(input)
}

function replanContentCalendar(input: unknown) {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const calendar = record.calendar as { planFingerprint?: unknown } | null | undefined
    if (calendar && record.expectedPlanFingerprint === undefined) return replanContentCalendarEngine({ ...record, expectedPlanFingerprint: calendar.planFingerprint })
  }
  return replanContentCalendarEngine(input)
}

function expectBlocked(input: unknown, reasonCode?: string) {
  const result = buildContentCalendar(input)
  expect(result.status).toBe('blocked')
  if (reasonCode) expect(result.reasonCodes).toContain(reasonCode)
  return result
}

function plannedEntries(overrides: Partial<ContentCalendarRequest> = {}): ContentCalendarEntry[] {
  return buildContentCalendar(request(overrides)).entries
}

function canonicalCalendarFingerprint(calendar: ReturnType<typeof buildContentCalendar>, entries = calendar.entries, unscheduled = calendar.unscheduledOpportunities, reasonCodes = calendar.reasonCodes): string {
  const normalized = calendar.normalizedRequest as NonNullable<typeof calendar.normalizedRequest>
  const acceptedOpportunities = normalized.opportunities.filter(opportunity => opportunity.status === 'selected').map(opportunity => ({ id: opportunity.id, strategyRecommendationId: opportunity.strategyRecommendationId, title: opportunity.title, contentType: opportunity.contentType, language: opportunity.language, priority: opportunity.priority, topicCluster: opportunity.topicCluster, evidenceSnapshotHash: opportunity.evidenceSnapshotHash, estimatedCostUnits: opportunity.estimatedCostUnits, ruleIds: opportunity.ruleIds, authoritySourceIds: opportunity.authoritySourceIds })).sort((left, right) => {
    const l = `${left.strategyRecommendationId}|${left.id}`
    const r = `${right.strategyRecommendationId}|${right.id}`
    return l < r ? -1 : l > r ? 1 : 0
  })
  const canonicalEntries = [...entries].sort((left, right) => left.plannedLocalDate < right.plannedLocalDate ? -1 : left.plannedLocalDate > right.plannedLocalDate ? 1 : left.scheduleKey < right.scheduleKey ? -1 : left.scheduleKey > right.scheduleKey ? 1 : 0).map(entry => ({ entryId: entry.entryId, scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, opportunityId: entry.opportunityId, strategyRecommendationId: entry.strategyRecommendationId, contentType: entry.contentType, language: entry.language, topicCluster: entry.topicCluster, evidenceSnapshotHash: entry.evidenceSnapshotHash, estimatedCostUnits: entry.estimatedCostUnits, status: entry.status, idempotencyKey: entry.idempotencyKey }))
  const canonicalUnscheduled = [...unscheduled].sort((left, right) => left.opportunityId < right.opportunityId ? -1 : left.opportunityId > right.opportunityId ? 1 : left.reasonCode < right.reasonCode ? -1 : left.reasonCode > right.reasonCode ? 1 : 0)
  const canonicalReasons = [...new Set(reasonCodes)].sort()
  return fingerprintCanonical({
    engineVersion: CONTENT_CALENDAR_ENGINE_VERSION,
    revision: calendar.revision,
    previousPlanFingerprint: calendar.previousPlanFingerprint,
    settings: { clientScopeKey: normalized.clientScopeKey, planStartDate: normalized.planStartDate, planEndDate: normalized.planEndDate, timeZone: normalized.timeZone, publishLocalTime: normalized.publishLocalTime, cadenceDays: normalized.cadenceDays, monthlyBudgetUnits: normalized.monthlyBudgetUnits, defaultCostUnits: normalized.defaultCostUnits, maxItemsPerCalendarMonth: normalized.maxItemsPerCalendarMonth, maximumTotalItems: normalized.maximumTotalItems, catchUpPolicy: normalized.catchUpPolicy, evidenceSnapshotHash: normalized.evidenceSnapshotHash },
    acceptedOpportunities,
    entries: canonicalEntries,
    unscheduled: canonicalUnscheduled,
    reasonCodes: canonicalReasons,
  })
}

describe('Content Calendar V1 public contract and normalization', () => {
  it('exports the fixed engine version and normalizes every supported cadence', () => {
    expect(CONTENT_CALENDAR_ENGINE_VERSION).toBe('content-calendar-cadence-engine-v1')
    for (const cadenceDays of [3, 7, 15, 30] as const) {
      expect(normalizeContentCalendarRequest(request({ cadenceDays })).cadenceDays).toBe(cadenceDays)
    }
  })

  it('accepts all supported content types, languages, priorities, and catch-up policies', () => {
    const normalized = normalizeContentCalendarRequest(request({
      catchUpPolicy: 'one_catch_up',
      opportunities: [
        syntheticOpportunity({ contentType: 'article', language: 'en', priority: 'high' }),
        syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, contentType: 'faq', language: 'zh-hant', priority: 'medium' }),
        syntheticOpportunity({ id: 'opp-c', strategyRecommendationId: 3, contentType: 'service_page', language: 'en', priority: 'low' }),
      ],
    }))
    expect(normalized.catchUpPolicy).toBe('one_catch_up')
    expect(normalized.opportunities.map(opportunity => opportunity.contentType)).toEqual(['article', 'faq', 'service_page'])
  })

  it('trims and preserves an opaque client scope key without PII characters', () => {
    expect(normalizeContentCalendarRequest(request({ clientScopeKey: '  scope_01:alpha  ' })).clientScopeKey).toBe('scope_01:alpha')
    expectBlocked(request({ clientScopeKey: 'scope@example.com' }))
    expectBlocked(request({ clientScopeKey: 'https://synthetic' }))
    expectBlocked(request({ clientScopeKey: 'company-acme' }))
  })

  it('fails closed for null, undefined, primitive, and malformed array requests', () => {
    for (const value of [null, undefined, 42, 'calendar', true, []]) expectBlocked(value)
  })

  it('fails closed when nested objects are missing or not objects', () => {
    expectBlocked(request({ opportunities: [null as unknown as ReturnType<typeof syntheticOpportunity>] }))
    expectBlocked(request({ opportunities: [42 as unknown as ReturnType<typeof syntheticOpportunity>] }))
    expectBlocked({ ...request(), opportunities: [{ ...syntheticOpportunity(), ruleIds: null }] })
  })

  it('fails closed for getter exceptions and proxy exceptions', () => {
    const getterRequest = { ...request() } as Record<string, unknown>
    Object.defineProperty(getterRequest, 'timeZone', { get() { throw new Error('synthetic getter failure') } })
    expectBlocked(getterRequest)
    const revoked = Proxy.revocable({ ...request() }, {})
    revoked.revoke()
    expectBlocked(revoked.proxy)
  })

  it('rejects NaN, Infinity, negative, zero, fractional, and over-limit numeric values', () => {
    expectBlocked(request({ monthlyBudgetUnits: Number.NaN }), 'INVALID_INPUT')
    expectBlocked(request({ monthlyBudgetUnits: Number.POSITIVE_INFINITY }), 'INVALID_INPUT')
    expectBlocked(request({ monthlyBudgetUnits: 0 }), 'INVALID_INPUT')
    expectBlocked(request({ monthlyBudgetUnits: 1.5 }), 'INVALID_INPUT')
    expectBlocked(request({ monthlyBudgetUnits: 100_001 }), 'INVALID_INPUT')
    expectBlocked(request({ maximumTotalItems: 101 }), 'INVALID_INPUT')
  })

  it('rejects malformed dates including JavaScript rollover dates', () => {
    expectBlocked(request({ planStartDate: '2026-02-31' }), 'INVALID_DATE')
    expectBlocked(request({ planStartDate: '2026/02/01' }), 'INVALID_DATE')
    expectBlocked(request({ planStartDate: '2026-2-1' }), 'INVALID_DATE')
  })

  it('rejects reversed and overlong planning horizons', () => {
    expectBlocked(request({ planStartDate: '2026-03-01', planEndDate: '2026-02-28' }), 'INVALID_DATE')
    expectBlocked(request({ planStartDate: '2026-01-01', planEndDate: '2027-01-03' }), 'INVALID_DATE')
  })

  it('accepts a leap-year horizon and rejects a non-leap-year February 29', () => {
    expect(normalizeContentCalendarRequest(request({ planStartDate: '2024-02-28', planEndDate: '2024-02-29' })).planEndDate).toBe('2024-02-29')
    expectBlocked(request({ planStartDate: '2026-02-01', planEndDate: '2026-02-29' }), 'INVALID_DATE')
  })

  it('validates IANA timezone without silently falling back to UTC', () => {
    expect(normalizeContentCalendarRequest(request({ timeZone: 'America/New_York' })).timeZone).toBe('America/New_York')
    expectBlocked(request({ timeZone: 'Not/A_Timezone' }), 'INVALID_TIMEZONE')
    expectBlocked(request({ timeZone: 'UTC+8' }), 'INVALID_TIMEZONE')
  })

  it('validates strict local HH:mm and never converts it to an instant', () => {
    expect(normalizeContentCalendarRequest(request({ publishLocalTime: '23:59' })).publishLocalTime).toBe('23:59')
    expectBlocked(request({ publishLocalTime: '24:00' }), 'INVALID_TIME')
    expectBlocked(request({ publishLocalTime: '9:30' }), 'INVALID_TIME')
    expectBlocked(request({ publishLocalTime: '12:60' }), 'INVALID_TIME')
    const entry = plannedEntries({ timeZone: 'America/New_York', publishLocalTime: '09:30' })[0]
    expect(entry).toMatchObject({ plannedLocalDate: '2026-01-01', publishLocalTime: '09:30', timeZone: 'America/New_York' })
  })

  it('rejects unsupported cadence and malformed evidence hashes', () => {
    expectBlocked(request({ cadenceDays: 2 as ContentCalendarRequest['cadenceDays'] }), 'UNSUPPORTED_CADENCE')
    expectBlocked(request({ evidenceSnapshotHash: 'not-a-hash' }), 'INVALID_HASH')
    expectBlocked(request({ evidenceSnapshotHash: 'A'.repeat(63) }), 'INVALID_HASH')
    expectBlocked(request({ evidenceSnapshotHash: 'A'.repeat(65) }), 'INVALID_HASH')
  })

  it('rejects mixed evidence snapshots before scheduling', () => {
    const mixed = { ...syntheticOpportunity({ id: 'mixed', evidenceSnapshotHash: '2'.repeat(64) }) }
    expectBlocked(request({ opportunities: [mixed] }), 'EVIDENCE_SNAPSHOT_MISMATCH')
  })

  it('validates monthly item cap, default cost, and opportunity cost bounds independently', () => {
    expectBlocked(request({ maxItemsPerCalendarMonth: 0 }), 'INVALID_INPUT')
    expectBlocked(request({ maxItemsPerCalendarMonth: 32 }), 'INVALID_INPUT')
    expectBlocked(request({ defaultCostUnits: 100_001 }), 'INVALID_INPUT')
    expectBlocked(request({ opportunities: [syntheticOpportunity({ estimatedCostUnits: 100_001 })] }), 'INVALID_INPUT')
  })

  it('rejects bounded identifier, title, and set-array overflow before planning', () => {
    expectBlocked(request({ opportunities: [syntheticOpportunity({ id: 'x'.repeat(129) })] }))
    expectBlocked(request({ opportunities: [syntheticOpportunity({ title: 'x'.repeat(513) })] }))
    expectBlocked(request({ opportunities: [syntheticOpportunity({ topicCluster: 'x'.repeat(129) })] }))
    expectBlocked(request({ opportunities: [syntheticOpportunity({ ruleIds: Array.from({ length: 65 }, (_, index) => `rule-${index}`) })] }))
  })

  it('rejects an opportunity hash that is malformed even when request evidence is valid', () => {
    expectBlocked(request({ opportunities: [syntheticOpportunity({ evidenceSnapshotHash: 'not-a-hash' })] }), 'INVALID_HASH')
  })

  it('rejects duplicate opportunity ids and duplicate strategy/opportunity identity pairs', () => {
    expectBlocked(request({ opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-a' })] }), 'DUPLICATE_OPPORTUNITY')
    expectBlocked(request({ opportunities: [syntheticOpportunity({ id: 'opp-a' }), syntheticOpportunity({ id: 'opp-a' })] }), 'DUPLICATE_OPPORTUNITY')
  })

  it('normalizes ruleIds and authoritySourceIds as deduplicated stable sets', () => {
    const normalized = normalizeContentCalendarRequest(request({ opportunities: [syntheticOpportunity({ ruleIds: ['rule-z', 'rule-a'], authoritySourceIds: ['authority-z', 'authority-a'] })] }))
    expect(normalized.opportunities[0]?.ruleIds).toEqual(['rule-a', 'rule-z'])
    expect(normalized.opportunities[0]?.authoritySourceIds).toEqual(['authority-a', 'authority-z'])
    expect(normalized.opportunities[0]?.ruleIds).not.toContain('rule-zrule-a')
  })

  it('accepts exactly 200 opportunities but blocks 201 before per-item processing', () => {
    const twoHundred = manySyntheticOpportunities(200)
    expect(normalizeContentCalendarRequest(request({ opportunities: twoHundred, maximumTotalItems: 1 })).opportunities).toHaveLength(200)
    expectBlocked(request({ opportunities: manySyntheticOpportunities(201) }))
  })

  it('rejects unsupported opportunity status values and only selected opportunities are schedulable', () => {
    expectBlocked(request({ opportunities: [syntheticOpportunity({ status: 'draft' as never })] }))
    const result = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ status: 'proposed' }), syntheticOpportunity({ id: 'rejected', strategyRecommendationId: 2, status: 'rejected' })] }))
    expect(result.status).toBe('blocked')
    expect(result.entries).toHaveLength(0)
    expect(result.unscheduledOpportunities).toEqual([{ opportunityId: 'opp-a', reasonCode: 'OPPORTUNITY_NOT_SELECTED' }, { opportunityId: 'rejected', reasonCode: 'OPPORTUNITY_NOT_SELECTED' }])
  })
})

describe('Content Calendar V1 deterministic slot and budget planning', () => {
  it('creates the first slot on planStartDate and increments by exactly three calendar days', () => {
    const entries = plannedEntries({ cadenceDays: 3, planStartDate: '2026-01-01', planEndDate: '2026-01-12' })
    expect(entries.map(entry => entry.plannedLocalDate)).toEqual(['2026-01-01', '2026-01-04', '2026-01-07'])
  })

  it('creates seven-day cadence slots without using system time', () => {
    const entries = plannedEntries({ cadenceDays: 7, planStartDate: '2026-01-03', planEndDate: '2026-01-31' })
    expect(entries.map(entry => entry.plannedLocalDate)).toEqual(['2026-01-03', '2026-01-10', '2026-01-17'])
  })

  it('creates fifteen-day cadence slots and stops after planEndDate', () => {
    const entries = plannedEntries({ cadenceDays: 15, planStartDate: '2026-01-10', planEndDate: '2026-02-28' })
    expect(entries.map(entry => entry.plannedLocalDate)).toEqual(['2026-01-10', '2026-01-25', '2026-02-09'])
  })

  it('creates thirty-day cadence slots at month boundaries by calendar date', () => {
    const entries = plannedEntries({ cadenceDays: 30, planStartDate: '2026-01-31', planEndDate: '2026-04-30' })
    expect(entries.map(entry => entry.plannedLocalDate)).toEqual(['2026-01-31', '2026-03-02', '2026-04-01'])
  })

  it('handles leap-year calendar-day addition without JavaScript date rollover', () => {
    const entries = plannedEntries({ cadenceDays: 3, planStartDate: '2024-02-27', planEndDate: '2024-03-08' })
    expect(entries.map(entry => entry.plannedLocalDate)).toEqual(['2024-02-27', '2024-03-01', '2024-03-04'])
  })

  it('sorts high priority, then numeric strategyRecommendationId, then normalized id', () => {
    const entries = plannedEntries({ opportunities: [
      syntheticOpportunity({ id: 'z-id', strategyRecommendationId: 10, priority: 'high', topicCluster: 'z' }),
      syntheticOpportunity({ id: 'a-id', strategyRecommendationId: 2, priority: 'high', topicCluster: 'a' }),
      syntheticOpportunity({ id: 'medium', strategyRecommendationId: 1, priority: 'medium', topicCluster: 'm' }),
      syntheticOpportunity({ id: 'low', strategyRecommendationId: 4, priority: 'low', topicCluster: 'l' }),
    ] })
    expect(entries.map(entry => entry.opportunityId)).toEqual(['a-id', 'z-id', 'medium', 'low'])
  })

  it('avoids consecutive topicCluster when another candidate is available', () => {
    const entries = plannedEntries({ opportunities: [
      syntheticOpportunity({ id: 'opp-a', strategyRecommendationId: 1, priority: 'high', topicCluster: 'same' }),
      syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, priority: 'high', topicCluster: 'same' }),
      syntheticOpportunity({ id: 'opp-c', strategyRecommendationId: 3, priority: 'medium', topicCluster: 'different' }),
    ], planStartDate: '2026-01-01', planEndDate: '2026-01-15', cadenceDays: 3 })
    expect(entries.map(entry => entry.opportunityId)).toEqual(['opp-a', 'opp-c', 'opp-b'])
  })

  it('resets monthly budget at each calendar month', () => {
    const opportunities = [1, 2, 3].map(index => syntheticOpportunity({ id: `opp-${index}`, strategyRecommendationId: index, estimatedCostUnits: 60, topicCluster: `cluster-${index}` }))
    const result = buildContentCalendar(request({ opportunities, planStartDate: '2026-01-30', planEndDate: '2026-02-10', cadenceDays: 3, monthlyBudgetUnits: 100, maximumTotalItems: 10 }))
    expect(result.entries.map(entry => entry.plannedLocalDate)).toEqual(['2026-01-30', '2026-02-02'])
    expect(result.unscheduledOpportunities).toEqual([{ opportunityId: 'opp-3', reasonCode: 'MONTHLY_BUDGET_EXHAUSTED' }])
  })

  it('enforces maxItemsPerCalendarMonth independently from budget', () => {
    const result = buildContentCalendar(request({ opportunities: manySyntheticOpportunities(5), planStartDate: '2026-01-01', planEndDate: '2026-01-20', cadenceDays: 3, maxItemsPerCalendarMonth: 1, maximumTotalItems: 5 }))
    expect(result.entries).toHaveLength(1)
    expect(result.unscheduledOpportunities.every(item => item.reasonCode === 'MONTHLY_ITEM_CAP_REACHED')).toBe(true)
  })

  it('enforces maximumTotalItems across the whole plan', () => {
    const result = buildContentCalendar(request({ opportunities: manySyntheticOpportunities(5), maximumTotalItems: 2, planStartDate: '2026-01-01', planEndDate: '2026-01-31', cadenceDays: 3 }))
    expect(result.entries).toHaveLength(2)
    expect(result.unscheduledOpportunities.slice(-3).every(item => item.reasonCode === 'PLAN_ITEM_CAP_REACHED')).toBe(true)
  })

  it('skips an unaffordable expensive candidate and schedules an affordable later candidate', () => {
    const result = buildContentCalendar(request({ monthlyBudgetUnits: 10, opportunities: [
      syntheticOpportunity({ id: 'expensive', strategyRecommendationId: 1, priority: 'high', estimatedCostUnits: 100, topicCluster: 'expensive' }),
      syntheticOpportunity({ id: 'cheap', strategyRecommendationId: 2, priority: 'medium', estimatedCostUnits: 10, topicCluster: 'cheap' }),
    ] }))
    expect(result.entries.map(entry => entry.opportunityId)).toEqual(['cheap'])
    expect(result.unscheduledOpportunities).toEqual([{ opportunityId: 'expensive', reasonCode: 'OPPORTUNITY_COST_EXCEEDS_BUDGET' }])
  })

  it('falls back to an affordable same-topic candidate when a different-topic candidate is unaffordable', () => {
    const result = buildContentCalendar(request({
      planStartDate: '2026-01-01',
      planEndDate: '2026-01-04',
      cadenceDays: 3,
      monthlyBudgetUnits: 20,
      opportunities: [
        syntheticOpportunity({ id: 'first', strategyRecommendationId: 1, priority: 'high', topicCluster: 'same', estimatedCostUnits: 10 }),
        syntheticOpportunity({ id: 'different-expensive', strategyRecommendationId: 2, priority: 'high', topicCluster: 'different', estimatedCostUnits: 100 }),
        syntheticOpportunity({ id: 'same-cheap', strategyRecommendationId: 3, priority: 'medium', topicCluster: 'same', estimatedCostUnits: 10 }),
      ],
    }))
    expect(result.entries.map(entry => entry.opportunityId)).toEqual(['first', 'same-cheap'])
    expect(result.unscheduledOpportunities).toEqual([{ opportunityId: 'different-expensive', reasonCode: 'OPPORTUNITY_COST_EXCEEDS_BUDGET' }])
  })

  it('does not oversell budget and reports selected items that cannot fit any slot', () => {
    const result = buildContentCalendar(request({ monthlyBudgetUnits: 10, opportunities: [syntheticOpportunity({ estimatedCostUnits: 11 })] }))
    expect(result.entries).toHaveLength(0)
    expect(result.status).toBe('blocked')
    expect(result.unscheduledOpportunities[0]).toEqual({ opportunityId: 'opp-a', reasonCode: 'OPPORTUNITY_COST_EXCEEDS_BUDGET' })
  })

  it('returns partial when some selected opportunities cannot be scheduled', () => {
    const result = buildContentCalendar(request({ maximumTotalItems: 1, opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2 })] }))
    expect(result.status).toBe('partial')
    expect(result.entries).toHaveLength(1)
    expect(result.unscheduledOpportunities).toHaveLength(2 - 1)
  })

  it('returns blocked when no selected opportunity is available', () => {
    const result = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ status: 'rejected' })] }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('OPPORTUNITY_NOT_SELECTED')
  })

  it('keeps entry status planned and preserves local date/time/timezone tuple', () => {
    const entry = plannedEntries({ timeZone: 'Europe/Berlin', publishLocalTime: '08:15' })[0]
    expect(entry?.status).toBe('planned')
    expect(entry).toMatchObject({ plannedLocalDate: '2026-01-01', publishLocalTime: '08:15', timeZone: 'Europe/Berlin' })
    expect(entry?.plannedLocalDate).not.toContain('T')
  })

  it('creates deterministic scheduleKey, entryId, and idempotencyKey', () => {
    const first = plannedEntries()
    const second = plannedEntries()
    expect(first).toEqual(second)
    expect(first[0]?.scheduleKey).toContain('scope_01|2026-01-01|slot-0000')
    expect(first[0]?.entryId).toMatch(/^entry-[0-9a-f]{64}$/)
    expect(first[0]?.idempotencyKey).toMatch(/^content-calendar-[0-9a-f]{64}$/)
  })

  it('keeps planFingerprint stable when request object keys and set-array orders change', () => {
    const first = buildContentCalendar(request())
    const opportunity = syntheticOpportunity({ ruleIds: ['rule-b', 'rule-a'], authoritySourceIds: ['authority-a'] })
    const second = buildContentCalendar({
      opportunities: [opportunity],
      evidenceSnapshotHash: SYNTHETIC_EVIDENCE_HASH,
      maximumTotalItems: 100,
      maxItemsPerCalendarMonth: 31,
      defaultCostUnits: 10,
      monthlyBudgetUnits: 100,
      cadenceDays: 7,
      publishLocalTime: '09:30',
      timeZone: 'Asia/Taipei',
      planEndDate: '2026-02-28',
      planStartDate: '2026-01-01',
      clientScopeKey: 'scope_01',
      catchUpPolicy: 'skip_missed',
    })
    const expected = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ ruleIds: ['rule-a', 'rule-b'], authoritySourceIds: ['authority-a'] })] }))
    expect(second.planFingerprint).toBe(expected.planFingerprint)
    expect(first.planFingerprint).not.toBe('')
  })

  it('canonicalJson sorts object keys and rejects undefined instead of converting it to null', () => {
    expect(canonicalJson({ z: 1, a: { d: true, c: 2 } })).toBe('{"a":{"c":2,"d":true},"z":1}')
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/)
    expect(fingerprintCanonical({ a: 1, b: ['x'] })).toBe(fingerprintCanonical({ b: ['x'], a: 1 }))
  })

  it('does not include performance guarantee language in result limitations or findings', () => {
    const resultText = JSON.stringify(buildContentCalendar(request()))
    expect(resultText).not.toMatch(/guarantee ranking|guarantee traffic|guarantee LLM citation|guarantee conversion/i)
    expect(resultText).not.toMatch(/保證排名|保證流量|保證 LLM 引用|保證轉換/)
  })
})

describe('Content Calendar V1 due work and catch-up', () => {
  it('skip_missed marks every past planned entry skipped and never materializes provider work', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-20', cadenceDays: 3, catchUpPolicy: 'skip_missed' }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-10' })
    expect(result.dueWork).toEqual([])
    expect(result.skippedEntryIds).toHaveLength(3)
    expect(result.calendar?.entries.filter(entry => entry.status === 'skipped')).toHaveLength(3)
  })

  it('one_catch_up materializes at most one earliest due entry', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-20', cadenceDays: 3 }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-10' })
    expect(result.dueWork).toHaveLength(1)
    expect(result.dueWork[0]?.plannedLocalDate).toBe('2026-01-01')
    expect(result.calendar?.entries.filter(entry => entry.status === 'materialized')).toHaveLength(1)
    expect(result.calendar?.entries.filter(entry => entry.status === 'planned')).toHaveLength(0)
    expect(result.calendar?.entries.filter(entry => entry.status === 'skipped')).toHaveLength(2)
  })

  it('one_catch_up materializes today and only one historical entry', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-07', cadenceDays: 3 }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-07' })
    expect(result.dueWork).toHaveLength(2)
    expect(result.dueWork.map(work => work.plannedLocalDate)).toEqual(['2026-01-01', '2026-01-07'])
    expect(result.skippedEntryIds).toHaveLength(1)
  })

  it('never materializes a future entry and reports no due work', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up' }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2025-12-31' })
    expect(result.dueWork).toEqual([])
    expect(result.reasonCodes).toEqual(['NO_DUE_WORK'])
    expect(result.calendar?.entries.every(entry => entry.status === 'planned')).toBe(true)
  })

  it('does not redo completed or cancelled entries and only transitions from materialized', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' })] }))
    const first = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    const materializedIds = first.dueWork.map(work => work.entryId)
    const result = materializeDueContentWork({ calendar: first.calendar, nowLocalDate: '2026-01-04', completedEntryIds: [materializedIds[0] as string], cancelledEntryIds: [materializedIds[1] as string] })
    expect(first.dueWork).toHaveLength(2)
    expect(result.dueWork).toEqual([])
    expect(result.calendar?.entries.find(entry => entry.entryId === materializedIds[0])?.status).toBe('completed')
    expect(result.calendar?.entries.find(entry => entry.entryId === materializedIds[1])?.status).toBe('cancelled')
  })

  it('is idempotent after materializing the same calendar state', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up' }))
    const first = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const second = materializeDueContentWork({ calendar: first.calendar, nowLocalDate: '2026-01-01' })
    expect(first.dueWork).toHaveLength(1)
    expect(second.dueWork).toEqual([])
    expect(second.reasonCodes).toEqual(['NO_DUE_WORK'])
  })

  it('fails closed for malformed due input and malformed completed/cancelled arrays', () => {
    expect(materializeDueContentWork(null).reasonCodes).toEqual(['INVALID_INPUT'])
    expect(materializeDueContentWork({ calendar: null, nowLocalDate: '2026-01-01' }).reasonCodes).toEqual(['INVALID_INPUT'])
    const calendar = buildContentCalendar(request())
    expect(materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01', completedEntryIds: 'entry' as never }).reasonCodes).toEqual(['INVALID_INPUT'])
    expect(materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01', completedEntryIds: [null] as never }).reasonCodes).toEqual(['INVALID_INPUT'])
    expect(materializeDueContentWork({ calendar, nowLocalDate: '2026-99-99' }).reasonCodes).toEqual(['INVALID_INPUT'])
  })

  it('produces deterministic due work identity without provider, DB, queue, or HTTP fields', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up' }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    expect(result.dueWork[0]?.workId).toMatch(/^work-[0-9a-f]{64}$/)
    expect(JSON.stringify(result.dueWork)).not.toMatch(/provider|database|queue|http/i)
  })
})

describe('Content Calendar V1 replan preservation and safety', () => {
  it('preserves completed identity and does not overwrite its date or scheduleKey', () => {
    const original = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up' }))
    const first = materializeDueContentWork({ calendar: original, nowLocalDate: '2026-01-01' })
    const completed = first.calendar?.entries.find(entry => entry.status === 'materialized') as ContentCalendarEntry
    const completedSnapshot = { entryId: completed.entryId, scheduleKey: completed.scheduleKey, plannedLocalDate: completed.plannedLocalDate, evidenceSnapshotHash: completed.evidenceSnapshotHash }
    const replanned = replanContentCalendar({ calendar: first.calendar, request: request({ planStartDate: '2026-01-05', planEndDate: '2026-02-28', cadenceDays: 15 }) })
    const preserved = replanned.entries.find(entry => entry.entryId === completed.entryId)
    expect(preserved).toMatchObject(completedSnapshot)
    expect(preserved?.status).toBe('materialized')
    expect(replanned.unscheduledOpportunities).toEqual([])
    expect(replanned.reasonCodes).toContain('REPLAN_PRESERVED_EXECUTED')
    expect(replanned.status).toBe('ready')
  })

  it('only replans planned entries and never schedules the same opportunity twice', () => {
    const original = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up' }))
    const first = materializeDueContentWork({ calendar: original, nowLocalDate: '2026-01-01' })
    const replanned = replanContentCalendar({ calendar: first.calendar, request: request({ planStartDate: '2026-01-10', planEndDate: '2026-02-28', cadenceDays: 7 }) })
    const opportunityIds = replanned.entries.map(entry => entry.opportunityId)
    expect(new Set(opportunityIds).size).toBe(opportunityIds.length)
    expect(replanned.entries.find(entry => entry.status === 'materialized')?.plannedLocalDate).toBe('2026-01-01')
    expect(replanned.entries.filter(entry => entry.status === 'planned').every(entry => entry.plannedLocalDate >= '2026-01-10')).toBe(true)
  })

  it('blocks replan when the new request evidence snapshot is stale or mixed', () => {
    const calendar = buildContentCalendar(request())
    const stale = replanContentCalendar({ calendar, request: request({ evidenceSnapshotHash: '2'.repeat(64), opportunities: [syntheticOpportunity({ evidenceSnapshotHash: '2'.repeat(64) })] }) })
    expect(stale.status).toBe('blocked')
    expect(stale.reasonCodes).toContain('EVIDENCE_SNAPSHOT_MISMATCH')
    const mixed = replanContentCalendar({ calendar, request: request({ opportunities: [syntheticOpportunity({ evidenceSnapshotHash: '2'.repeat(64) })] }) })
    expect(mixed.status).toBe('blocked')
    expect(mixed.reasonCodes).toContain('EVIDENCE_SNAPSHOT_MISMATCH')
  })

  it('blocks malformed calendar entries instead of silently repairing them', () => {
    const calendar = buildContentCalendar(request())
    const malformed = { ...calendar, entries: [{ ...calendar.entries[0], status: 'planned', entryId: undefined }] }
    const result = replanContentCalendar({ calendar: malformed as never, request: request() })
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  })

  it('rejects a forged blocked-entry snapshot when the original trusted fingerprint is supplied', () => {
    const calendar = buildContentCalendar(request())
    const blockedEntries = calendar.entries.map(entry => ({ ...entry, status: 'blocked' as const }))
    const blockedCalendar = { ...calendar, entries: blockedEntries, planFingerprint: canonicalCalendarFingerprint(calendar, blockedEntries) }
    const result = materializeDueContentWorkEngine({ calendar: blockedCalendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-12-31' })
    expect(result.calendar).toBeNull()
    expect(result.dueWork).toEqual([])
    expect(result.reasonCodes).toEqual(['INVALID_INPUT'])
  })

  it('preserves cancelled identity during replan and does not schedule its opportunity twice', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-10', cadenceDays: 3 }))
    const cancelledEntry = calendar.entries[0] as ContentCalendarEntry
    const cancelled = materializeDueContentWork({ calendar, nowLocalDate: '2025-12-31', cancelledEntryIds: [cancelledEntry.entryId] })
    const replanned = replanContentCalendar({ calendar: cancelled.calendar, request: request({ planStartDate: '2026-01-05', opportunities: BASE.opportunities }) })
    expect(replanned.entries.find(entry => entry.entryId === cancelledEntry.entryId)).toMatchObject({ entryId: cancelledEntry.entryId, scheduleKey: cancelledEntry.scheduleKey, plannedLocalDate: cancelledEntry.plannedLocalDate, status: 'cancelled' })
    expect(replanned.entries.filter(entry => entry.opportunityId === cancelledEntry.opportunityId)).toHaveLength(1)
    expect(replanned.unscheduledOpportunities).toEqual([])
  })

  it('returns stable replan fingerprints for equivalent inputs', () => {
    const calendar = buildContentCalendar(request())
    const first = replanContentCalendar({ calendar, request: request() })
    const second = replanContentCalendar({ calendar: { ...calendar, entries: [...calendar.entries].reverse() }, request: request() })
    expect(first).toEqual(second)
    expect(first.planFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps all results bounded and preserves explicit limitations', () => {
    const result = replanContentCalendar({ calendar: buildContentCalendar(request()), request: request({ maximumTotalItems: 1 }) })
    expect(result.entries.length).toBeLessThanOrEqual(1)
    expect(result.limitations).toContain('DST dispatch resolution belongs to the integration layer')
    expect(result.limitations).toContain('no ranking, traffic, LLM citation, or conversion guarantee')
  })
})


describe('Content Calendar V1 revision blockers - skip_missed and bounded catch-up', () => {
  it('skip_missed skips yesterday, materializes today, and keeps tomorrow planned', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'skip_missed', planStartDate: '2026-01-01', planEndDate: '2026-01-07', cadenceDays: 3 }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    expect(result.dueWork.map(work => work.plannedLocalDate)).toEqual(['2026-01-04'])
    expect(result.skippedEntryIds).toHaveLength(1)
    expect(result.calendar?.entries.find(entry => entry.plannedLocalDate === '2026-01-01')?.status).toBe('skipped')
    expect(result.calendar?.entries.find(entry => entry.plannedLocalDate === '2026-01-04')?.status).toBe('materialized')
    expect(result.calendar?.entries.find(entry => entry.plannedLocalDate === '2026-01-07')?.status).toBe('planned')
    expect(result.skippedEntryIds).not.toContain(result.dueWork[0]?.entryId)
  })

  it('skip_missed materializes an entry when today is the only planned date', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'skip_missed', planStartDate: '2026-01-04', planEndDate: '2026-01-04', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    expect(result.dueWork).toHaveLength(1)
    expect(result.dueWork[0]?.plannedLocalDate).toBe('2026-01-04')
    expect(result.skippedEntryIds).toEqual([])
  })

  it('skip_missed with only missed entries skips them and produces no work', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'skip_missed', planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-02' })
    expect(result.dueWork).toEqual([])
    expect(result.skippedEntryIds).toHaveLength(1)
    expect(result.calendar?.entries[0]?.status).toBe('skipped')
  })

  it('skip_missed rerun of the updated calendar does not materialize the same entry again', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'skip_missed', planStartDate: '2026-01-01', planEndDate: '2026-01-07', cadenceDays: 3 }))
    const first = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    const second = materializeDueContentWork({ calendar: first.calendar, nowLocalDate: '2026-01-04' })
    expect(first.dueWork).toHaveLength(1)
    expect(second.dueWork).toEqual([])
    expect(second.skippedEntryIds).toEqual([])
    expect(second.reasonCodes).toEqual(['NO_DUE_WORK'])
  })

  it('fails closed when a calendar carries multiple planned entries on one date', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' })], planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3 }))
    const duplicateDate = { ...calendar, entries: calendar.entries.map((entry, index) => index === 1 ? { ...entry, plannedLocalDate: calendar.entries[0]?.plannedLocalDate } : entry) }
    const result = materializeDueContentWork({ calendar: duplicateDate as never, nowLocalDate: '2026-01-04' })
    expect(result.calendar).toBeNull()
    expect(result.dueWork).toEqual([])
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  })

  it('one_catch_up materializes today plus at most one earliest missed entry', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-10', cadenceDays: 3, opportunities: manySyntheticOpportunities(4) }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-10' })
    expect(result.dueWork.map(work => work.plannedLocalDate)).toEqual(['2026-01-01', '2026-01-10'])
    expect(result.dueWork).toHaveLength(2)
    expect(result.skippedEntryIds).toHaveLength(2)
  })

  it('one_catch_up with no today entry materializes only one earliest missed entry', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-07', cadenceDays: 3, opportunities: manySyntheticOpportunities(3) }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-06' })
    expect(result.dueWork).toHaveLength(1)
    expect(result.dueWork[0]?.plannedLocalDate).toBe('2026-01-01')
    expect(result.skippedEntryIds).toEqual([calendar.entries[1]?.entryId])
  })

  it('one_catch_up skips every remaining missed entry so same-day rerun cannot drain backlog', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-10', cadenceDays: 3, opportunities: manySyntheticOpportunities(4) }))
    const first = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-10' })
    const second = materializeDueContentWork({ calendar: first.calendar, nowLocalDate: '2026-01-10' })
    expect(first.dueWork).toHaveLength(2)
    expect(first.skippedEntryIds).toHaveLength(2)
    expect(second.dueWork).toEqual([])
    expect(second.skippedEntryIds).toEqual([])
    expect(second.reasonCodes).toEqual(['NO_DUE_WORK'])
  })

  it('one_catch_up never materializes future entries', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-04', planEndDate: '2026-01-10', cadenceDays: 3, opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2 })] }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-03' })
    expect(result.dueWork).toEqual([])
    expect(result.calendar?.entries.every(entry => entry.status === 'planned')).toBe(true)
  })

  it('does not redo materialized or skipped entries', () => {
    const one = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWork({ calendar: one, nowLocalDate: '2026-01-01' })
    const rerunMaterialized = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01' })
    const skippedCalendar = buildContentCalendar(request({ catchUpPolicy: 'skip_missed', planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const skipped = materializeDueContentWork({ calendar: skippedCalendar, nowLocalDate: '2026-01-02' })
    const rerunSkipped = materializeDueContentWork({ calendar: skipped.calendar, nowLocalDate: '2026-01-02' })
    expect(rerunMaterialized.dueWork).toEqual([])
    expect(rerunSkipped.dueWork).toEqual([])
    expect(rerunSkipped.skippedEntryIds).toEqual([])
  })
})

describe('Content Calendar V1 revision blockers - complete calendar integrity', () => {
  function expectInvalidCalendar(calendar: unknown, extra: Record<string, unknown> = {}) {
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01', ...extra } as never)
    expect(result.calendar).toBeNull()
    expect(result.dueWork).toEqual([])
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  }

  it('rejects an entry evidence hash mutation', () => {
    const calendar = buildContentCalendar(request())
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], evidenceSnapshotHash: '2'.repeat(64) }, ...calendar.entries.slice(1)] })
  })

  it('rejects entry contentType, strategyRecommendationId, and estimatedCostUnits mutations', () => {
    const calendar = buildContentCalendar(request())
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], contentType: 'faq' }, ...calendar.entries.slice(1)] })
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], strategyRecommendationId: 999 }, ...calendar.entries.slice(1)] })
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], estimatedCostUnits: 99 }, ...calendar.entries.slice(1)] })
  })

  it('rejects entry timezone, unknown status, and idempotencyKey mutations', () => {
    const calendar = buildContentCalendar(request())
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], timeZone: 'UTC' }, ...calendar.entries.slice(1)] })
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], status: 'unknown' }, ...calendar.entries.slice(1)] })
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], idempotencyKey: `content-calendar-${'2'.repeat(64)}` }, ...calendar.entries.slice(1)] })
  })

  it('rejects planFingerprint and normalizedRequest catchUpPolicy/evidence mutations', () => {
    const calendar = buildContentCalendar(request())
    expectInvalidCalendar({ ...calendar, planFingerprint: '2'.repeat(64) })
    expectInvalidCalendar({ ...calendar, normalizedRequest: { ...calendar.normalizedRequest, catchUpPolicy: 'one_catch_up' } })
    expectInvalidCalendar({ ...calendar, normalizedRequest: { ...calendar.normalizedRequest, evidenceSnapshotHash: '2'.repeat(64) } })
  })

  it('rejects extra sensitive fields in calendar and normalizedRequest', () => {
    const calendar = buildContentCalendar(request())
    expectInvalidCalendar({ ...calendar, secret: 'synthetic' })
    expectInvalidCalendar({ ...calendar, normalizedRequest: { ...calendar.normalizedRequest, rawArticleBody: 'synthetic body' } })
  })

  it('rejects unknown, duplicate, overlapping, and oversized completed/cancelled ID arrays', () => {
    const calendar = buildContentCalendar(request())
    const entryId = calendar.entries[0]?.entryId as string
    expectInvalidCalendar(calendar, { completedEntryIds: ['missing-entry'] })
    expectInvalidCalendar(calendar, { cancelledEntryIds: ['missing-entry'] })
    expectInvalidCalendar(calendar, { completedEntryIds: [entryId], cancelledEntryIds: [entryId] })
    expectInvalidCalendar(calendar, { completedEntryIds: [entryId, entryId] })
    expectInvalidCalendar(calendar, { cancelledEntryIds: [entryId, entryId] })
    expectInvalidCalendar(calendar, { completedEntryIds: Array.from({ length: calendar.entries.length + 1 }, () => entryId) })
  })

  it('rejects malformed calendar top-level status, missing request, and entry fields', () => {
    const calendar = buildContentCalendar(request())
    expectInvalidCalendar({ ...calendar, status: 'unknown' })
    expectInvalidCalendar({ ...calendar, normalizedRequest: null })
    expectInvalidCalendar({ ...calendar, entries: [{ ...calendar.entries[0], topicCluster: undefined }, ...calendar.entries.slice(1)] })
  })
})

describe('Content Calendar V1 revision blockers - title identity, replan cap, and ASCII order', () => {
  it('changes planFingerprint when a selected opportunity title changes', () => {
    const first = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ title: 'Topic A' })] }))
    const second = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ title: 'Topic B' })] }))
    expect(first.planFingerprint).not.toBe(second.planFingerprint)
  })

  it('treats NFKC and trim-equivalent titles as the same normalized fingerprint', () => {
    const first = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ title: 'Café' })] }))
    const second = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ title: '  Cafe\u0301  ' })] }))
    expect(first.normalizedRequest?.opportunities[0]?.title).toBe('Café')
    expect(second.normalizedRequest?.opportunities[0]?.title).toBe('Café')
    expect(first.planFingerprint).toBe(second.planFingerprint)
  })

  it('uses explicit ASCII identifier ordering independent of locale', () => {
    const result = buildContentCalendar(request({
      planStartDate: '2026-01-01',
      planEndDate: '2026-01-07',
      cadenceDays: 3,
      opportunities: [
        syntheticOpportunity({ id: 'a-id', strategyRecommendationId: 1, topicCluster: 'topic-a' }),
        syntheticOpportunity({ id: 'B-id', strategyRecommendationId: 1, topicCluster: 'topic-b' }),
        syntheticOpportunity({ id: 'A-id', strategyRecommendationId: 1, topicCluster: 'topic-c' }),
      ],
    }))
    expect(result.entries.map(entry => entry.opportunityId)).toEqual(['A-id', 'B-id', 'a-id'])
  })

  it('blocks replan when two fixed completed entries exceed the new total cap with no entries returned', () => {
    const opportunities = [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' })]
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    const completed = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-04', completedEntryIds: materialized.dueWork.map(work => work.entryId) })
    const result = replanContentCalendar({ calendar: completed.calendar, request: request({ maximumTotalItems: 1, opportunities }) })
    expect(result.status).toBe('blocked')
    expect(result.entries).toEqual([])
    expect(result.reasonCodes).toContain('PLAN_ITEM_CAP_REACHED')
  })

  it('blocks replan when two fixed materialized entries exceed the new total cap', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' })] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    const result = replanContentCalendar({ calendar: materialized.calendar, request: request({ maximumTotalItems: 1, opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' })] }) })
    expect(result.status).toBe('blocked')
    expect(result.entries).toEqual([])
    expect(result.reasonCodes).toContain('PLAN_ITEM_CAP_REACHED')
  })

  it('keeps fixed entries when fixed count equals cap and creates no new entry', () => {
    const opportunities = [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' }), syntheticOpportunity({ id: 'opp-c', strategyRecommendationId: 3, topicCluster: 'cluster-c' })]
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-07', cadenceDays: 3, opportunities }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    const result = replanContentCalendar({ calendar: materialized.calendar, request: request({ maximumTotalItems: 2, opportunities }) })
    expect(result.entries).toHaveLength(2)
    expect(result.entries.filter(entry => entry.status === 'planned')).toHaveLength(0)
  })

  it('when cap is greater than fixed entries, schedules only the remaining capacity', () => {
    const opportunities = [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' }), syntheticOpportunity({ id: 'opp-c', strategyRecommendationId: 3, topicCluster: 'cluster-c' })]
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-07', cadenceDays: 3, opportunities }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-04' })
    const result = replanContentCalendar({ calendar: materialized.calendar, request: request({ maximumTotalItems: 3, opportunities }) })
    expect(result.entries).toHaveLength(3)
    expect(new Set(result.entries.map(entry => entry.opportunityId)).size).toBe(3)
  })

  it('does not mark a preserved completed entry as unscheduled or partial', () => {
    const opportunity = syntheticOpportunity()
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'one_catch_up', planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [opportunity] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const result = replanContentCalendar({ calendar: materialized.calendar, request: request({ opportunities: [opportunity] }) })
    expect(result.entries).toHaveLength(1)
    expect(result.unscheduledOpportunities).toEqual([])
    expect(result.status).toBe('ready')
    expect(result.reasonCodes).toContain('REPLAN_PRESERVED_EXECUTED')
  })

  it('preserves cancelled identity without claiming execution or scheduling a duplicate', () => {
    const opportunity = syntheticOpportunity()
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [opportunity] }))
    const cancelled = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    const result = replanContentCalendar({ calendar: cancelled.calendar, request: request({ opportunities: [opportunity] }) })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.status).toBe('cancelled')
    expect(result.entries[0]?.opportunityId).toBe(opportunity.id)
    expect(result.unscheduledOpportunities).toEqual([])
  })
})


function rekeyEntry(entry: ContentCalendarEntry, patch: Partial<ContentCalendarEntry>): ContentCalendarEntry {
  const candidate = { ...entry, ...patch }
  const identity = { engineVersion: CONTENT_CALENDAR_ENGINE_VERSION, scheduleKey: candidate.scheduleKey, plannedLocalDate: candidate.plannedLocalDate, opportunityId: candidate.opportunityId, evidenceSnapshotHash: candidate.evidenceSnapshotHash }
  const idempotency = { scheduleKey: candidate.scheduleKey, opportunityId: candidate.opportunityId, strategyRecommendationId: candidate.strategyRecommendationId, evidenceSnapshotHash: candidate.evidenceSnapshotHash }
  return { ...candidate, entryId: `entry-${fingerprintCanonical(identity)}`, idempotencyKey: `content-calendar-${fingerprintCanonical(idempotency)}` }
}

describe('Content Calendar V1 second revision - exact runtime input boundary', () => {
  it('blocks request extra rawArticleBody', () => {
    expectBlocked({ ...request(), rawArticleBody: 'synthetic body' })
  })

  it('blocks request extra secret', () => {
    expectBlocked({ ...request(), secret: 'synthetic-secret' })
  })

  it('blocks opportunity extra customerEmail', () => {
    const opportunity = { ...syntheticOpportunity(), customerEmail: 'customer@example.com' }
    expectBlocked({ ...request(), opportunities: [opportunity] })
  })

  it('blocks opportunity extra unknown field', () => {
    const opportunity = { ...syntheticOpportunity(), unknownField: 'synthetic' }
    expectBlocked({ ...request(), opportunities: [opportunity] })
  })

  it('blocks a request with one missing required key', () => {
    const malformed = { ...request() } as Record<string, unknown>
    delete malformed.evidenceSnapshotHash
    expectBlocked(malformed)
  })

  it('blocks an opportunity with one missing required key', () => {
    const malformed = { ...syntheticOpportunity() } as Record<string, unknown>
    delete malformed.title
    expectBlocked({ ...request(), opportunities: [malformed] })
  })

  it('fails closed when Object.keys throws on a request Proxy', () => {
    const proxy = new Proxy(request(), { ownKeys() { throw new Error('synthetic ownKeys failure') } })
    expectBlocked(proxy)
  })
})

describe('Content Calendar V1 second revision - lifecycle state machine', () => {
  it('allows planned to materialized', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    expect(result.calendar?.entries[0]?.status).toBe('materialized')
  })

  it('allows materialized to completed', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const completed = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(completed.calendar?.entries[0]?.status).toBe('completed')
  })

  it('allows materialized to cancelled', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const cancelled = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(cancelled.calendar?.entries[0]?.status).toBe('cancelled')
  })

  it('allows completed to completed idempotently', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const completed = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    const repeated = materializeDueContentWork({ calendar: completed.calendar, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(repeated.calendar?.entries[0]?.status).toBe('completed')
    expect(repeated.dueWork).toEqual([])
  })

  it('allows cancelled to cancelled idempotently', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const cancelled = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    const repeated = materializeDueContentWork({ calendar: cancelled.calendar, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(repeated.calendar?.entries[0]?.status).toBe('cancelled')
    expect(repeated.dueWork).toEqual([])
  })

  it('blocks planned to completed instead of skipping materialized', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks completed to cancelled', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const completed = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    const result = materializeDueContentWork({ calendar: completed.calendar, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks cancelled to completed', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const cancelled = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    const result = materializeDueContentWork({ calendar: cancelled.calendar, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks skipped to completed', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'skip_missed', planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const skipped = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-02' })
    const result = materializeDueContentWork({ calendar: skipped.calendar, nowLocalDate: '2026-01-02', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  })

  it('rejects forged blocked status before any lifecycle operation', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const blockedEntries = calendar.entries.map(entry => ({ ...entry, status: 'blocked' as const }))
    const blocked = { ...calendar, entries: blockedEntries, planFingerprint: canonicalCalendarFingerprint(calendar, blockedEntries) }
    const result = materializeDueContentWorkEngine({ calendar: blocked, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-02', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toContain('INVALID_INPUT')
  })

  it('does not emit duplicate due work for materialized or completed entries', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const completed = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01' }).dueWork).toEqual([])
    expect(materializeDueContentWork({ calendar: completed.calendar, nowLocalDate: '2026-01-01' }).dueWork).toEqual([])
  })

  it('preserves immutable identity across materialized to completed', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const before = calendar.entries[0] as ContentCalendarEntry
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const completed = materializeDueContentWork({ calendar: materialized.calendar, nowLocalDate: '2026-01-01', completedEntryIds: [before.entryId] })
    expect(completed.calendar?.entries[0]).toMatchObject({ entryId: before.entryId, scheduleKey: before.scheduleKey, idempotencyKey: before.idempotencyKey, plannedLocalDate: before.plannedLocalDate, evidenceSnapshotHash: before.evidenceSnapshotHash })
  })

  it('changes plan fingerprint when lifecycle status changes', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    expect(materialized.calendar?.planFingerprint).not.toBe(calendar.planFingerprint)
  })
})

describe('Content Calendar V1 second revision - semantic reconstruction', () => {
  it('blocks a non-cadence date even when entry identity and calendar fingerprint are recomputed', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities: [syntheticOpportunity()] }))
    const tamperedEntries = [rekeyEntry(calendar.entries[0] as ContentCalendarEntry, { plannedLocalDate: '2026-01-02', scheduleKey: 'scope_01|2026-01-02|slot-0000' })]
    const tampered = { ...calendar, entries: tamperedEntries, planFingerprint: canonicalCalendarFingerprint(calendar, tamperedEntries) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-02' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a recomputed entry with the wrong schedule clientScopeKey', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity()] }))
    const tamperedEntries = [rekeyEntry(calendar.entries[0] as ContentCalendarEntry, { scheduleKey: 'other_scope|2026-01-01|slot-0000' })]
    const tampered = { ...calendar, entries: tamperedEntries, planFingerprint: canonicalCalendarFingerprint(calendar, tamperedEntries) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a recomputed entry whose schedule date disagrees with plannedLocalDate', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity()] }))
    const tamperedEntries = [rekeyEntry(calendar.entries[0] as ContentCalendarEntry, { scheduleKey: 'scope_01|2026-01-02|slot-0000' })]
    const tampered = { ...calendar, entries: tamperedEntries, planFingerprint: canonicalCalendarFingerprint(calendar, tamperedEntries) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a recomputed entry with the wrong slot ordinal', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity()] }))
    const tamperedEntries = [rekeyEntry(calendar.entries[0] as ContentCalendarEntry, { scheduleKey: 'scope_01|2026-01-01|slot-0001' })]
    const tampered = { ...calendar, entries: tamperedEntries, planFingerprint: canonicalCalendarFingerprint(calendar, tamperedEntries) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a recomputed calendar with opportunity/date assignment swapped', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' })] }))
    const first = calendar.entries[0] as ContentCalendarEntry
    const second = calendar.entries[1] as ContentCalendarEntry
    const swapped = [rekeyEntry(first, { opportunityId: second.opportunityId }), second]
    const tampered = { ...calendar, entries: swapped, planFingerprint: canonicalCalendarFingerprint(calendar, swapped) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a recomputed calendar with a false unscheduled reason code', () => {
    const rejected = syntheticOpportunity({ status: 'rejected' })
    const calendar = buildContentCalendar(request({ opportunities: [rejected] }))
    const unscheduled = [{ opportunityId: rejected.id, reasonCode: 'MONTHLY_BUDGET_EXHAUSTED' as const }]
    const tampered = { ...calendar, unscheduledOpportunities: unscheduled, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, unscheduled) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })
})

describe('Content Calendar V1 second revision - budget and cap reconstruction', () => {
  it('blocks a recomputed calendar with a monthly budget violation', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity()] }))
    const normalizedRequest = { ...calendar.normalizedRequest as NonNullable<typeof calendar.normalizedRequest>, monthlyBudgetUnits: 1 }
    const tampered = { ...calendar, normalizedRequest, planFingerprint: canonicalCalendarFingerprint({ ...calendar, normalizedRequest } as ReturnType<typeof buildContentCalendar>) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a recomputed calendar with a monthly item cap violation', () => {
    const calendar = buildContentCalendar(request())
    const normalizedRequest = { ...calendar.normalizedRequest as NonNullable<typeof calendar.normalizedRequest>, maxItemsPerCalendarMonth: 1 }
    const tampered = { ...calendar, normalizedRequest, planFingerprint: canonicalCalendarFingerprint({ ...calendar, normalizedRequest } as ReturnType<typeof buildContentCalendar>) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a recomputed calendar with a whole-plan cap violation', () => {
    const calendar = buildContentCalendar(request())
    const normalizedRequest = { ...calendar.normalizedRequest as NonNullable<typeof calendar.normalizedRequest>, maximumTotalItems: 1 }
    const tampered = { ...calendar, normalizedRequest, planFingerprint: canonicalCalendarFingerprint({ ...calendar, normalizedRequest } as ReturnType<typeof buildContentCalendar>) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('preserves an over-budget historical fixed entry without adding a worsening planned entry', () => {
    const opportunities = [syntheticOpportunity(), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b' })]
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const result = replanContentCalendar({ calendar: materialized.calendar, request: request({ monthlyBudgetUnits: 5, opportunities }) })
    expect(result.entries.some(entry => entry.status === 'materialized')).toBe(true)
    expect(result.entries.filter(entry => entry.status === 'planned')).toHaveLength(0)
    expect(result.reasonCodes).toContain('HISTORICAL_FIXED_OVER_BUDGET')
  })
})

describe('Content Calendar V1 second revision - unscheduled and reason integrity', () => {
  it('blocks two unscheduled reasons for one opportunity', () => {
    const opportunity = syntheticOpportunity({ estimatedCostUnits: 10 })
    const calendar = buildContentCalendar(request({ monthlyBudgetUnits: 1, opportunities: [opportunity] }))
    const unscheduled = [{ opportunityId: opportunity.id, reasonCode: 'OPPORTUNITY_COST_EXCEEDS_BUDGET' as const }, { opportunityId: opportunity.id, reasonCode: 'NO_AVAILABLE_SLOT' as const }]
    const tampered = { ...calendar, unscheduledOpportunities: unscheduled, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, unscheduled) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a rejected opportunity carrying a budget reason', () => {
    const opportunity = syntheticOpportunity({ status: 'rejected' })
    const calendar = buildContentCalendar(request({ opportunities: [opportunity] }))
    const unscheduled = [{ opportunityId: opportunity.id, reasonCode: 'MONTHLY_BUDGET_EXHAUSTED' as const }]
    const tampered = { ...calendar, unscheduledOpportunities: unscheduled, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, unscheduled) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a selected opportunity carrying OPPORTUNITY_NOT_SELECTED', () => {
    const opportunity = syntheticOpportunity()
    const calendar = buildContentCalendar(request({ opportunities: [opportunity] }))
    const unscheduled = [{ opportunityId: opportunity.id, reasonCode: 'OPPORTUNITY_NOT_SELECTED' as const }]
    const tampered = { ...calendar, entries: [], unscheduledOpportunities: unscheduled, status: 'blocked' as const, planFingerprint: canonicalCalendarFingerprint(calendar, [], unscheduled) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks an opportunity present in both entries and unscheduled', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity()] }))
    const unscheduled = [{ opportunityId: calendar.entries[0]?.opportunityId as string, reasonCode: 'NO_AVAILABLE_SLOT' as const }]
    const tampered = { ...calendar, unscheduledOpportunities: unscheduled, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, unscheduled) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks an opportunity missing from both entries and unscheduled', () => {
    const calendar = buildContentCalendar(request())
    const entries = calendar.entries.slice(0, 1)
    const tampered = { ...calendar, entries, planFingerprint: canonicalCalendarFingerprint(calendar, entries) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks a selected opportunity with a caller-chosen wrong unscheduled reason', () => {
    const opportunity = syntheticOpportunity({ estimatedCostUnits: 10 })
    const calendar = buildContentCalendar(request({ monthlyBudgetUnits: 1, opportunities: [opportunity] }))
    const unscheduled = [{ opportunityId: opportunity.id, reasonCode: 'MONTHLY_BUDGET_EXHAUSTED' as const }]
    const tampered = { ...calendar, unscheduledOpportunities: unscheduled, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, unscheduled) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('blocks REPLAN_PRESERVED_EXECUTED on an initial calendar', () => {
    const calendar = buildContentCalendar(request())
    const reasonCodes = ['REPLAN_PRESERVED_EXECUTED' as const]
    const tampered = { ...calendar, reasonCodes, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, calendar.unscheduledOpportunities, reasonCodes) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })

  it('does not permanently add NO_DUE_WORK to calendar planning reasonCodes', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-10', planEndDate: '2026-01-10', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    expect(result.reasonCodes).toEqual(['NO_DUE_WORK'])
    expect(result.calendar?.reasonCodes).not.toContain('NO_DUE_WORK')
  })

  it('accepts REPLAN_PRESERVED_EXECUTED only after true executed preservation', () => {
    const opportunity = syntheticOpportunity()
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [opportunity] }))
    const materialized = materializeDueContentWork({ calendar, nowLocalDate: '2026-01-01' })
    const replanned = replanContentCalendar({ calendar: materialized.calendar, request: request({ opportunities: [opportunity] }) })
    expect(replanned.reasonCodes).toContain('REPLAN_PRESERVED_EXECUTED')
    expect(materializeDueContentWork({ calendar: replanned, nowLocalDate: '2026-01-01' }).reasonCodes).toEqual(['NO_DUE_WORK'])
  })

  it('blocks duplicate or unsorted reason codes even with a recomputed fingerprint', () => {
    const calendar = buildContentCalendar(request({ opportunities: [syntheticOpportunity({ estimatedCostUnits: 10 }), syntheticOpportunity({ id: 'opp-b', strategyRecommendationId: 2, topicCluster: 'cluster-b', estimatedCostUnits: 10 })], monthlyBudgetUnits: 10 }))
    const reasonCodes = ['OPPORTUNITY_COST_EXCEEDS_BUDGET', 'OPPORTUNITY_COST_EXCEEDS_BUDGET'] as CalendarReasonCode[]
    const tampered = { ...calendar, reasonCodes, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, calendar.unscheduledOpportunities, reasonCodes) }
    expect(materializeDueContentWork({ calendar: tampered, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
    const unsorted = ['PLAN_ITEM_CAP_REACHED', 'MONTHLY_BUDGET_EXHAUSTED'] as CalendarReasonCode[]
    const tamperedUnsorted = { ...calendar, reasonCodes: unsorted, planFingerprint: canonicalCalendarFingerprint(calendar, calendar.entries, calendar.unscheduledOpportunities, unsorted) }
    expect(materializeDueContentWork({ calendar: tamperedUnsorted, nowLocalDate: '2026-01-01' }).reasonCodes).toContain('INVALID_INPUT')
  })
})


function forgeCalendarEntry(calendar: ContentCalendarResult, patch: Partial<ContentCalendarEntry>): ContentCalendarResult {
  const first = calendar.entries[0]
  if (!first) throw new Error('synthetic calendar has no entry to forge')
  const entries = [rekeyEntry(first, patch), ...calendar.entries.slice(1)]
  return { ...calendar, entries, planFingerprint: canonicalCalendarFingerprint(calendar, entries) }
}

describe('Content Calendar V1 third revision - trusted expected fingerprint boundary', () => {
  it('blocks materialize when expectedPlanFingerprint is missing', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWorkEngine({ calendar, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toEqual(['INVALID_INPUT'])
  })

  it('blocks materialize when expectedPlanFingerprint is null', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: null, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
  })

  it('blocks uppercase expectedPlanFingerprint without normalization', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint.toUpperCase(), nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
  })

  it('blocks malformed expectedPlanFingerprint length and characters', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    expect(materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: '0'.repeat(63), nowLocalDate: '2026-01-01' }).calendar).toBeNull()
    expect(materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: `${'0'.repeat(63)}g`, nowLocalDate: '2026-01-01' }).calendar).toBeNull()
  })

  it('blocks a valid but different expectedPlanFingerprint', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const different = fingerprintCanonical({ synthetic: 'different trusted state' })
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: different, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
  })

  it('allows materialize with the exact matching expectedPlanFingerprint', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar?.entries[0]?.status).toBe('materialized')
  })

  it('blocks replan when expectedPlanFingerprint is missing', () => {
    const calendar = buildContentCalendar(request())
    const result = replanContentCalendarEngine({ calendar, request: request() })
    expect(result.status).toBe('blocked')
    expect(result.revision).toBe(0)
  })

  it('blocks replan when expectedPlanFingerprint is different', () => {
    const calendar = buildContentCalendar(request())
    const result = replanContentCalendarEngine({ calendar, expectedPlanFingerprint: fingerprintCanonical({ different: true }), request: request() })
    expect(result.status).toBe('blocked')
    expect(result.entries).toEqual([])
  })

  it('rejects reuse of the old fingerprint after a state-changing operation', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const first = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    const next = first.calendar as ContentCalendarResult
    const replayWithOld = materializeDueContentWorkEngine({ calendar: next, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(replayWithOld.calendar).toBeNull()
  })

  it('accepts the newest returned fingerprint on the next operation', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const first = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    const next = first.calendar as ContentCalendarResult
    const second = materializeDueContentWorkEngine({ calendar: next, expectedPlanFingerprint: next.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(second.calendar).not.toBeNull()
    expect(second.reasonCodes).toEqual(['NO_DUE_WORK'])
  })
})

describe('Content Calendar V1 third revision - lifecycle forgery and transitions', () => {
  it.each(['completed', 'materialized', 'cancelled', 'skipped', 'blocked'] as const)('rejects forged planned -> %s when the original trusted fingerprint is supplied', status => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const forged = forgeCalendarEntry(calendar, { status })
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toEqual(['INVALID_INPUT'])
  })

  it('rejects planned to completed through completedEntryIds', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toEqual(['INVALID_INPUT'])
  })

  it('allows the legitimate planned -> materialized -> completed chain', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    const materializedCalendar = materialized.calendar as ContentCalendarResult
    const completed = materializeDueContentWorkEngine({ calendar: materializedCalendar, expectedPlanFingerprint: materializedCalendar.planFingerprint, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(completed.calendar?.entries[0]?.status).toBe('completed')
  })

  it('keeps completed idempotent replay at the same revision', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    const materializedCalendar = materialized.calendar as ContentCalendarResult
    const completed = materializeDueContentWorkEngine({ calendar: materializedCalendar, expectedPlanFingerprint: materializedCalendar.planFingerprint, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    const completedCalendar = completed.calendar as ContentCalendarResult
    const replay = materializeDueContentWorkEngine({ calendar: completedCalendar, expectedPlanFingerprint: completedCalendar.planFingerprint, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(replay.calendar?.revision).toBe(completedCalendar.revision)
  })

  it('keeps cancelled idempotent replay at the same revision', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const cancelled = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    const cancelledCalendar = cancelled.calendar as ContentCalendarResult
    const replay = materializeDueContentWorkEngine({ calendar: cancelledCalendar, expectedPlanFingerprint: cancelledCalendar.planFingerprint, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] })
    expect(replay.calendar?.revision).toBe(cancelledCalendar.revision)
  })
})

describe('Content Calendar V1 third revision - historical date and slot binding', () => {
  it('rejects a materialized entry moved to a non-cadence date after all public hashes are recomputed', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' }).calendar as ContentCalendarResult
    const forged = forgeCalendarEntry(materialized, { plannedLocalDate: '2026-01-02', scheduleKey: 'scope_01|2026-01-02|slot-0000' })
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: materialized.planFingerprint, nowLocalDate: '2026-01-02' })
    expect(result.calendar).toBeNull()
  })

  it('rejects a completed entry with a recomputed wrong slot ordinal', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' }).calendar as ContentCalendarResult
    const completed = materializeDueContentWorkEngine({ calendar: materialized, expectedPlanFingerprint: materialized.planFingerprint, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] }).calendar as ContentCalendarResult
    const forged = forgeCalendarEntry(completed, { scheduleKey: 'scope_01|2026-01-01|slot-0099' })
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: completed.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
  })

  it('rejects a cancelled entry moved to a different date after hashes are recomputed', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities: [syntheticOpportunity()] }))
    const cancelled = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] }).calendar as ContentCalendarResult
    const forged = forgeCalendarEntry(cancelled, { plannedLocalDate: '2026-01-02', scheduleKey: 'scope_01|2026-01-02|slot-0000' })
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: cancelled.planFingerprint, nowLocalDate: '2026-01-02' })
    expect(result.calendar).toBeNull()
  })

  it('rejects a skipped entry with a recomputed wrong schedule scope', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const skipped = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-02' }).calendar as ContentCalendarResult
    const forged = forgeCalendarEntry(skipped, { scheduleKey: 'other_scope|2026-01-01|slot-0000' })
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: skipped.planFingerprint, nowLocalDate: '2026-01-02' })
    expect(result.calendar).toBeNull()
  })

  it('rejects the first slot paired with slot-0099', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const forged = forgeCalendarEntry(calendar, { scheduleKey: 'scope_01|2026-01-01|slot-0099' })
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
  })

  it('accepts a legal cadence date with its exact deterministic ordinal', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-04', cadenceDays: 3, opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar?.entries[0]?.scheduleKey).toBe('scope_01|2026-01-01|slot-0000')
  })
})

describe('Content Calendar V1 third revision - revision continuity', () => {
  it('initial successful build starts at revision one with null previous fingerprint', () => {
    const calendar = buildContentCalendar(request())
    expect(calendar.revision).toBe(1)
    expect(calendar.previousPlanFingerprint).toBeNull()
  })

  it('initial blocked build starts at revision zero with null previous fingerprint', () => {
    const calendar = buildContentCalendar(null)
    expect(calendar.status).toBe('blocked')
    expect(calendar.revision).toBe(0)
    expect(calendar.previousPlanFingerprint).toBeNull()
  })

  it('increments revision and points previous fingerprint at materialization input', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar?.revision).toBe(calendar.revision + 1)
    expect(result.calendar?.previousPlanFingerprint).toBe(calendar.planFingerprint)
  })

  it('increments revision when materialized becomes completed', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' }).calendar as ContentCalendarResult
    const completed = materializeDueContentWorkEngine({ calendar: materialized, expectedPlanFingerprint: materialized.planFingerprint, nowLocalDate: '2026-01-01', completedEntryIds: [calendar.entries[0]?.entryId as string] }).calendar as ContentCalendarResult
    expect(completed.revision).toBe(materialized.revision + 1)
    expect(completed.previousPlanFingerprint).toBe(materialized.planFingerprint)
  })

  it('increments revision when cancellation changes planned state', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const cancelled = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01', cancelledEntryIds: [calendar.entries[0]?.entryId as string] }).calendar as ContentCalendarResult
    expect(cancelled.revision).toBe(calendar.revision + 1)
    expect(cancelled.previousPlanFingerprint).toBe(calendar.planFingerprint)
  })

  it('increments revision when skip_missed changes planned state', () => {
    const calendar = buildContentCalendar(request({ catchUpPolicy: 'skip_missed', planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const skipped = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-02' }).calendar as ContentCalendarResult
    expect(skipped.revision).toBe(calendar.revision + 1)
    expect(skipped.previousPlanFingerprint).toBe(calendar.planFingerprint)
  })

  it('does not increment revision for no-due-work or an idempotent materialized replay', () => {
    const noDueCalendar = buildContentCalendar(request({ planStartDate: '2026-01-10', planEndDate: '2026-01-10', opportunities: [syntheticOpportunity()] }))
    const noDue = materializeDueContentWorkEngine({ calendar: noDueCalendar, expectedPlanFingerprint: noDueCalendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(noDue.calendar?.revision).toBe(noDueCalendar.revision)
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' }).calendar as ContentCalendarResult
    const replay = materializeDueContentWorkEngine({ calendar: materialized, expectedPlanFingerprint: materialized.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(replay.calendar?.revision).toBe(materialized.revision)
  })

  it('increments revision on a real replan and points to the old calendar fingerprint', () => {
    const calendar = buildContentCalendar(request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }))
    const materialized = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' }).calendar as ContentCalendarResult
    const replanned = replanContentCalendarEngine({ calendar: materialized, expectedPlanFingerprint: materialized.planFingerprint, request: request({ planStartDate: '2026-01-01', planEndDate: '2026-01-01', opportunities: [syntheticOpportunity()] }) })
    expect(replanned.revision).toBe(materialized.revision + 1)
    expect(replanned.previousPlanFingerprint).toBe(materialized.planFingerprint)
  })

  it('rejects a forged revision after recomputing its public fingerprint with the old trusted value', () => {
    const calendar = buildContentCalendar(request())
    const forged = { ...calendar, revision: 99, planFingerprint: canonicalCalendarFingerprint({ ...calendar, revision: 99 }) }
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
  })

  it('rejects a forged previousPlanFingerprint after recomputing its public fingerprint with the old trusted value', () => {
    const calendar = buildContentCalendar(request())
    const forged = { ...calendar, previousPlanFingerprint: '0'.repeat(64), planFingerprint: canonicalCalendarFingerprint({ ...calendar, previousPlanFingerprint: '0'.repeat(64) }) }
    const result = materializeDueContentWorkEngine({ calendar: forged, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' })
    expect(result.calendar).toBeNull()
  })
})

describe('Content Calendar V1 third revision - malformed boundary containment', () => {
  it('fails closed when expectedPlanFingerprint getter throws', () => {
    const calendar = buildContentCalendar(request())
    const input = { calendar, nowLocalDate: '2026-01-01' } as Record<string, unknown>
    Object.defineProperty(input, 'expectedPlanFingerprint', { get() { throw new Error('synthetic fingerprint getter failure') } })
    const result = materializeDueContentWorkEngine(input)
    expect(result.calendar).toBeNull()
    expect(result.reasonCodes).toEqual(['INVALID_INPUT'])
  })

  it('fails closed when the materialize input Proxy ownKeys throws', () => {
    const calendar = buildContentCalendar(request())
    const proxy = new Proxy({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01' }, { ownKeys() { throw new Error('synthetic ownKeys failure') } })
    const result = materializeDueContentWorkEngine(proxy)
    expect(result.calendar).toBeNull()
  })

  it('blocks an unknown materialize input key', () => {
    const calendar = buildContentCalendar(request())
    const result = materializeDueContentWorkEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: '2026-01-01', unknown: 'synthetic' })
    expect(result.calendar).toBeNull()
  })

  it('blocks an unknown replan input key', () => {
    const calendar = buildContentCalendar(request())
    const result = replanContentCalendarEngine({ calendar, expectedPlanFingerprint: calendar.planFingerprint, request: request(), unknown: 'synthetic' })
    expect(result.status).toBe('blocked')
  })

  it('does not return raw malicious input, stack, or secret fields in blocked output', () => {
    const result = materializeDueContentWorkEngine({ calendar: { secret: 'raw-secret', stack: 'raw-stack' }, expectedPlanFingerprint: 'bad', nowLocalDate: '2026-01-01', secret: 'customer-secret' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('raw-secret')
    expect(serialized).not.toContain('raw-stack')
    expect(serialized).not.toContain('customer-secret')
    expect(serialized).not.toContain('Error:')
  })
})
