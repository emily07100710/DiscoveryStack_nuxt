import { describe, expect, it } from 'vitest'
import {
  assessmentFingerprint,
  assessMarketSignal,
  calculateMetaMetrics,
  calculateTrendMetrics,
  fingerprint,
  isMarketSignalEnginePure,
  normalizePublisherIdentity,
  parseGoogleTrendsCsv,
  parseMetaAdSnapshot,
  sha256,
} from '../server/market-intelligence'
import type {
  GoogleTrendsSnapshot,
  MarketSignalRequest,
  MetaAdSnapshot,
  MetaAdSnapshotInput,
} from '../server/market-intelligence'
import {
  SYNTHETIC_CSV,
  SYNTHETIC_HASH_A,
  SYNTHETIC_HASH_B,
  SYNTHETIC_HASH_C,
  SYNTHETIC_WINDOW,
  syntheticMetaInput,
  syntheticMetaSnapshot,
  syntheticTrendSnapshot,
} from './fixtures/market-intelligence/snapshots'

const requestBase: MarketSignalRequest = {
  requestId: 'request-synthetic-01',
  signalKind: 'demand_interest',
  claimUse: 'market_hypothesis',
  locale: 'en-us',
  window: SYNTHETIC_WINDOW,
}

function trendRequest(overrides: Partial<MarketSignalRequest> = {}): MarketSignalRequest {
  return { ...requestBase, googleTrends: [syntheticTrendSnapshot()], ...overrides }
}

function metaRequest(overrides: Partial<MarketSignalRequest> = {}): MarketSignalRequest {
  return {
    ...requestBase,
    signalKind: 'competitive_activity',
    googleTrends: undefined,
    metaAdSnapshots: [syntheticMetaSnapshot()],
    ...overrides,
  }
}

function metaInput(overrides: Partial<MetaAdSnapshotInput> = {}): MetaAdSnapshotInput {
  return syntheticMetaInput(overrides)
}

function metaSnapshot(overrides: Partial<MetaAdSnapshot> = {}): MetaAdSnapshot {
  return syntheticMetaSnapshot(overrides)
}

describe('Google Trends parser', () => {
  it('parses a bounded synthetic time series and preserves metadata-only limitations', () => {
    const result = parseGoogleTrendsCsv(SYNTHETIC_CSV, {
      snapshotId: 'csv-synthetic-01',
      keyword: 'synthetic topic',
      locale: 'en-US',
      window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z',
      sourceHash: sha256(SYNTHETIC_CSV),
    })
    expect(result.ok).toBe(true)
    expect(result.value?.observations).toHaveLength(4)
    expect(result.value?.limitations[0]).toContain('relative-interest')
  })

  it('normalizes suppressed <1 values without treating them as missing network data', () => {
    const result = parseGoogleTrendsCsv('date,value\n2026-01-01,<1\n2026-01-02,2', {
      snapshotId: 'csv-synthetic-02', keyword: 'synthetic topic', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: SYNTHETIC_HASH_A,
    })
    expect(result.ok).toBe(true)
    expect(result.value?.observations[0]).toMatchObject({ value: 0, suppressedBelowOne: true })
    expect(result.warnings[0]?.code).toBe('SUPPRESSED_VALUE')
  })

  it('rejects a missing or wrong CSV header', () => {
    const result = parseGoogleTrendsCsv('day,interest\n2026-01-01,10', {
      snapshotId: 'csv-synthetic-03', keyword: 'synthetic topic', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: SYNTHETIC_HASH_A,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('MISSING_TIME_SERIES_HEADER')
  })

  it('rejects invalid dates and out-of-window observations', () => {
    const result = parseGoogleTrendsCsv('date,value\n2026-02-30,10\n2026-01-05,20', {
      snapshotId: 'csv-synthetic-04', keyword: 'synthetic topic', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: SYNTHETIC_HASH_A,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.filter((error) => error.code === 'INVALID_DATE')).toHaveLength(1)
    expect(result.errors.map((error) => error.code)).toContain('SNAPSHOT_OUTSIDE_WINDOW')
  })

  it('rejects duplicate observations rather than silently overwriting them', () => {
    const result = parseGoogleTrendsCsv('date,value\n2026-01-01,10\n2026-01-01,20', {
      snapshotId: 'csv-synthetic-05', keyword: 'synthetic topic', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: SYNTHETIC_HASH_A,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('DUPLICATE_OBSERVATION')
  })

  it('rejects malformed and non-numeric rows', () => {
    const result = parseGoogleTrendsCsv('date,value\n2026-01-01,ten\n2026-01-02,10,extra', {
      snapshotId: 'csv-synthetic-06', keyword: 'synthetic topic', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: SYNTHETIC_HASH_A,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['INVALID_NUMBER', 'MALFORMED_CSV']))
  })

  it('requires a SHA-256 source hash', () => {
    const result = parseGoogleTrendsCsv(SYNTHETIC_CSV, {
      snapshotId: 'csv-synthetic-07', keyword: 'synthetic topic', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: 'not-a-hash',
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.code).toBe('INVALID_SOURCE_HASH')
  })
})

describe('Meta snapshot parser', () => {
  it('normalizes publisher identity and sorts ad IDs', () => {
    const result = parseMetaAdSnapshot(metaInput({ publisher: '  Synthetic Example Ltd.  ', ads: [
      { adId: 'z-ad', startedAt: '2026-01-01', lastSeenAt: '2026-01-02', status: 'active', creativeHash: SYNTHETIC_HASH_C },
      { adId: 'a-ad', startedAt: '2026-01-01', lastSeenAt: '2026-01-02', status: 'inactive', creativeHash: SYNTHETIC_HASH_A },
    ] }))
    expect(result.ok).toBe(true)
    expect(result.value?.publisherIdentity).toBe('synthetic example')
    expect(result.value?.ads.map((ad) => ad.adId)).toEqual(['a-ad', 'z-ad'])
  })

  it('rejects duplicate ad IDs', () => {
    const result = parseMetaAdSnapshot(metaInput({ ads: [
      { adId: 'same', startedAt: '2026-01-01', lastSeenAt: '2026-01-02', status: 'active', creativeHash: SYNTHETIC_HASH_A },
      { adId: 'same', startedAt: '2026-01-02', lastSeenAt: '2026-01-03', status: 'inactive', creativeHash: SYNTHETIC_HASH_B },
    ] }))
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('DUPLICATE_AD_ID')
  })

  it('rejects unknown statuses and non-overlapping ads', () => {
    const result = parseMetaAdSnapshot(metaInput({ ads: [
      { adId: 'bad-status', startedAt: '2026-01-01', lastSeenAt: '2026-01-02', status: 'unknown-value' as 'unknown', creativeHash: SYNTHETIC_HASH_A },
      { adId: 'outside', startedAt: '2025-01-01', lastSeenAt: '2025-01-02', status: 'inactive', creativeHash: SYNTHETIC_HASH_B },
    ] }))
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['UNKNOWN_STATUS', 'SNAPSHOT_OUTSIDE_WINDOW']))
  })

  it('requires snapshot identity, publisher, date window, and hash', () => {
    const result = parseMetaAdSnapshot(metaInput({ snapshotId: '', publisher: '', sourceHash: '' }))
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['MISSING_SNAPSHOT_ID', 'MISSING_PUBLISHER', 'MISSING_SOURCE_HASH']))
  })
})

describe('deterministic metrics', () => {
  it('calculates a rising trend with stable rounded values', () => {
    const metrics = calculateTrendMetrics([syntheticTrendSnapshot()])
    expect(metrics).toMatchObject({ pointCount: 4, firstValue: 20, latestValue: 50, direction: 'rising', slopePerObservation: 10 })
    expect(metrics?.changePercent).toBe(150)
  })

  it('aggregates duplicate dates deterministically across snapshots', () => {
    const first = syntheticTrendSnapshot({ snapshotId: 'b', observations: [{ date: '2026-01-01', value: 20 }, { date: '2026-01-02', value: 30 }] })
    const second = syntheticTrendSnapshot({ snapshotId: 'a', observations: [{ date: '2026-01-01', value: 40 }, { date: '2026-01-02', value: 50 }] })
    expect(calculateTrendMetrics([first, second])).toEqual(calculateTrendMetrics([second, first]))
    expect(calculateTrendMetrics([first, second])?.firstValue).toBe(30)
  })

  it('returns insufficient_data for a single trend observation', () => {
    const metrics = calculateTrendMetrics([syntheticTrendSnapshot({ observations: [{ date: '2026-01-01', value: 20 }] })])
    expect(metrics?.direction).toBe('insufficient_data')
    expect(metrics?.slopePerObservation).toBe(0)
  })

  it('does not fabricate a percentage when the baseline is zero', () => {
    const metrics = calculateTrendMetrics([syntheticTrendSnapshot({ observations: [{ date: '2026-01-01', value: 0 }, { date: '2026-01-02', value: 20 }] })])
    expect(metrics?.changePercent).toBeNull()
    expect(metrics?.direction).toBe('rising')
  })

  it('calculates bounded meta metrics and deduplicates publisher-ad identities', () => {
    const first = metaSnapshot({ snapshotId: 'meta-01', capturedAt: '2026-01-05T00:00:00.000Z' })
    const second = metaSnapshot({ snapshotId: 'meta-02', capturedAt: '2026-01-06T00:00:00.000Z', ads: [
      { adId: 'ad-01', startedAt: '2026-01-02', lastSeenAt: '2026-01-06', status: 'active', creativeHash: SYNTHETIC_HASH_A },
      { adId: 'ad-03', startedAt: '2026-01-06', lastSeenAt: '2026-01-06', status: 'active', creativeHash: SYNTHETIC_HASH_A },
    ] })
    expect(calculateMetaMetrics([second, first])).toMatchObject({ snapshotCount: 2, publisherCount: 1, totalAdCount: 4, uniqueAdCount: 3, activeAdCount: 2, uniqueCreativeCount: 2, newAdCount: 1, activityDirection: 'increasing' })
  })

  it('returns insufficient_data activity direction for one meta snapshot', () => {
    expect(calculateMetaMetrics([metaSnapshot()])?.activityDirection).toBe('insufficient_data')
  })

  it('returns null metrics for empty sources', () => {
    expect(calculateTrendMetrics([])).toBeNull()
    expect(calculateMetaMetrics([])).toBeNull()
  })

  it('normalizes publisher identity without treating a URL substring as an identity', () => {
    expect(normalizePublisherIdentity('https://WWW.Example.com/path')).toBe('example com')
    expect(normalizePublisherIdentity('Example Corporation')).toBe('example')
  })
})

describe('market signal assessment policy', () => {
  it('accepts relevant trend observations as a market hypothesis only', () => {
    const assessment = assessMarketSignal(trendRequest())
    expect(assessment).toMatchObject({ status: 'ready', signalKind: 'demand_interest', hypothesisOnly: true })
    expect(assessment.acceptedSnapshotIds).toEqual(['trend-synthetic-01'])
    expect(assessment.rejectionReasons).toEqual([])
  })

  it('accepts competitive activity metadata but keeps the output bounded', () => {
    const assessment = assessMarketSignal(metaRequest())
    expect(assessment).toMatchObject({ status: 'ready', signalKind: 'competitive_activity', hypothesisOnly: true })
    expect(assessment.metaMetrics?.uniqueAdCount).toBe(2)
    expect(assessment.limitations.join(' ')).toContain('Meta Ad Library')
  })

  it('returns not_ready with missing trend evidence when no trend snapshots exist', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: undefined }))
    expect(assessment.status).toBe('not_ready')
    expect(assessment.missingEvidenceTypes).toContain('trend_observations')
  })

  it('returns not_ready with missing meta evidence when no meta snapshots exist', () => {
    const assessment = assessMarketSignal(metaRequest({ metaAdSnapshots: undefined }))
    expect(assessment.status).toBe('not_ready')
    expect(assessment.missingEvidenceTypes).toContain('meta_snapshot')
  })

  it('rejects factual, ranking, and investment uses instead of silently reinterpreting them', () => {
    for (const claimUse of ['factual_claim', 'ranking_claim', 'investment_claim'] as const) {
      const assessment = assessMarketSignal(trendRequest({ claimUse }))
      expect(assessment.status).toBe('rejected')
      expect(assessment.rejectionReasons).toContain('UNSUPPORTED_CLAIM_USE')
      expect(assessment.missingEvidenceTypes).toContain('market_hypothesis_scope')
    }
  })

  it('rejects an unknown signal kind at runtime', () => {
    const assessment = assessMarketSignal(trendRequest({ signalKind: 'not-a-kind' as MarketSignalRequest['signalKind'] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('UNKNOWN_SIGNAL_KIND')
  })

  it('rejects a trend snapshot with a provider mismatch', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [{ ...syntheticTrendSnapshot(), provider: 'meta_ad_library' as 'google_trends' }] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('UNKNOWN_PROVIDER')
  })

  it('rejects locale mismatch and reports the missing alignment evidence', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [syntheticTrendSnapshot({ locale: 'zh-tw' })] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('LOCALE_MISMATCH')
    expect(assessment.missingEvidenceTypes).toContain('locale_alignment')
  })

  it('rejects a window mismatch instead of treating stale observations as current', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [syntheticTrendSnapshot({ window: { start: '2025-01-01', end: '2025-01-04' }, observations: [{ date: '2025-01-01', value: 1 }, { date: '2025-01-02', value: 2 }] })] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('WINDOW_MISMATCH')
  })

  it('rejects malformed snapshot hashes and never claims source completeness', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [syntheticTrendSnapshot({ sourceHash: 'bad' })] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('INVALID_SOURCE_HASH')
    expect(assessment.missingEvidenceTypes).toContain('source_hash')
  })

  it('bounds trend snapshots and rejects the overflow instead of expanding the request', () => {
    const snapshots = Array.from({ length: 13 }, (_, index) => syntheticTrendSnapshot({ snapshotId: `trend-${String(index).padStart(2, '0')}` }))
    const assessment = assessMarketSignal(trendRequest({ googleTrends: snapshots }))
    expect(assessment.acceptedSnapshotIds).toHaveLength(12)
    expect(assessment.rejectedSnapshotIds).toContain('trend-12')
    expect(assessment.rejectionReasons).toContain('INVALID_INPUT')
  })

  it('returns not_ready rather than declaring direction from a single point', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [syntheticTrendSnapshot({ observations: [{ date: '2026-01-01', value: 30 }] })] }))
    expect(assessment.status).toBe('not_ready')
    expect(assessment.trendMetrics?.direction).toBe('insufficient_data')
  })

  it('keeps stable ordering and deterministic fingerprints for equivalent input order', () => {
    const first = trendRequest({ googleTrends: [syntheticTrendSnapshot({ snapshotId: 'b' }), syntheticTrendSnapshot({ snapshotId: 'a' })] })
    const second = trendRequest({ googleTrends: [syntheticTrendSnapshot({ snapshotId: 'a' }), syntheticTrendSnapshot({ snapshotId: 'b' })] })
    const firstAssessment = assessMarketSignal(first)
    const secondAssessment = assessMarketSignal(second)
    expect(firstAssessment.deterministicFingerprint).toBe(secondAssessment.deterministicFingerprint)
    expect(firstAssessment.acceptedSnapshotIds).toEqual(['a', 'b'])
    expect(assessmentFingerprint(firstAssessment)).toBe(firstAssessment.deterministicFingerprint)
  })

  it('rejects duplicate snapshot IDs as ambiguous bounded evidence', () => {
    const duplicate = syntheticTrendSnapshot({ snapshotId: 'same' })
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [duplicate, duplicate] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('DUPLICATE_SNAPSHOT_ID')
  })

  it('rejects invalid request dates and oversized request IDs', () => {
    const dateAssessment = assessMarketSignal(trendRequest({ window: { start: '2026-02-30', end: '2026-01-01' } }))
    const idAssessment = assessMarketSignal(trendRequest({ requestId: 'x'.repeat(121) }))
    expect(dateAssessment.status).toBe('rejected')
    expect(dateAssessment.rejectionReasons).toContain('INVALID_DATE')
    expect(idAssessment.rejectionReasons).toContain('INVALID_INPUT')
  })

  it('does not fabricate quotes, DOI values, page numbers, or conclusions', () => {
    const serialized = JSON.stringify(assessMarketSignal(trendRequest()))
    expect(serialized).not.toMatch(/\b(quote|doi|page(number)?|conclusion)\b/i)
  })

  it('exposes the pure-engine boundary as no network, crawler, provider, database, API, or UI behavior', () => {
    expect(isMarketSignalEnginePure()).toBe(true)
  })

  it('produces a stable SHA-256 fingerprint for canonical data', () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }))
    expect(fingerprint({ a: 1 })).toHaveLength(64)
  })

  it('uses a versioned policy and truthful governance limitations', () => {
    const assessment = assessMarketSignal(trendRequest())
    expect(assessment.policyVersion).toBe('market-intelligence-signal-policy-v1.0.0')
    expect(assessment.engineVersion).toBe('market-intelligence-signal-engine-v1.0.0')
    expect(assessment.limitations.some((limitation) => limitation.includes('truth score'))).toBe(true)
  })

  it('keeps output status not_ready when all supplied snapshots are rejected', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [syntheticTrendSnapshot({ sourceHash: 'bad' }), syntheticTrendSnapshot({ locale: 'zh-tw', snapshotId: 'bad-locale' })] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.acceptedSnapshotIds).toEqual([])
    expect(assessment.rejectedSnapshotIds).toEqual(['bad-locale', 'trend-synthetic-01'])
  })

  it('retains partial-result limitations when one snapshot is rejected and one is accepted', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [syntheticTrendSnapshot(), syntheticTrendSnapshot({ snapshotId: 'bad', sourceHash: 'bad' })] }))
    expect(assessment.status).toBe('ready')
    expect(assessment.rejectedSnapshotIds).toEqual(['bad'])
    expect(assessment.limitations.join(' ')).toContain('部分輸入被拒絕')
  })
})
