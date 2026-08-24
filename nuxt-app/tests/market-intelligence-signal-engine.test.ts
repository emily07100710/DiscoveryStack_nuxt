import { describe, expect, it } from 'vitest'
import {
  assessmentFingerprint,
  assessMarketSignal,
  canonicalMetaAdPayload,
  calculateMetaMetrics,
  calculateTrendMetrics,
  fingerprint,
  isMarketSignalEnginePure,
  normalizeIsoDateTime,
  normalizeKeyword,
  normalizePublisherIdentity,
  parseGoogleTrendsCsv,
  parseMetaAdSnapshot,
  metaSnapshotSourceHash,
  sha256,
  stableStringify,
} from '../server/market-intelligence'
import type {
  GoogleTrendsSnapshot,
  MarketSignalRequest,
  MetaAdSnapshot,
  MetaAdSnapshotInput,
} from '../server/market-intelligence'
import {
  SYNTHETIC_CSV,
  SYNTHETIC_CSV_HASH,
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
      scaleKey: 'web-search-us-2026-01',
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
    const csv = 'date,value\n2026-01-01,<1\n2026-01-02,2'
    const result = parseGoogleTrendsCsv(csv, {
      snapshotId: 'csv-synthetic-02', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: sha256(csv),
    })
    expect(result.ok).toBe(true)
    expect(result.value?.observations[0]).toMatchObject({ value: 0, suppressedBelowOne: true })
    expect(result.warnings[0]?.code).toBe('SUPPRESSED_VALUE')
  })

  it('rejects a missing or wrong CSV header', () => {
    const csv = 'day,interest\n2026-01-01,10'
    const result = parseGoogleTrendsCsv(csv, {
      snapshotId: 'csv-synthetic-03', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: sha256(csv),
    })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('MISSING_TIME_SERIES_HEADER')
  })

  it('rejects invalid dates and out-of-window observations', () => {
    const csv = 'date,value\n2026-02-30,10\n2026-01-05,20'
    const result = parseGoogleTrendsCsv(csv, {
      snapshotId: 'csv-synthetic-04', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: sha256(csv),
    })
    expect(result.ok).toBe(false)
    expect(result.errors.filter((error) => error.code === 'INVALID_DATE')).toHaveLength(1)
    expect(result.errors.map((error) => error.code)).toContain('SNAPSHOT_OUTSIDE_WINDOW')
  })

  it('rejects duplicate observations rather than silently overwriting them', () => {
    const csv = 'date,value\n2026-01-01,10\n2026-01-01,20'
    const result = parseGoogleTrendsCsv(csv, {
      snapshotId: 'csv-synthetic-05', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: sha256(csv),
    })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('DUPLICATE_OBSERVATION')
  })

  it('rejects malformed and non-numeric rows', () => {
    const csv = 'date,value\n2026-01-01,ten\n2026-01-02,10,extra'
    const result = parseGoogleTrendsCsv(csv, {
      snapshotId: 'csv-synthetic-06', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00.000Z', sourceHash: sha256(csv),
    })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['INVALID_NUMBER', 'MALFORMED_CSV']))
  })

  it('requires a SHA-256 source hash', () => {
    const result = parseGoogleTrendsCsv(SYNTHETIC_CSV, {
      snapshotId: 'csv-synthetic-07', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
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


describe('evidence integrity hardening', () => {
  it('rejects a valid-looking Google hash when the CSV content changes', () => {
    const csv = 'date,value\n2026-01-01,20\n2026-01-02,30'
    const result = parseGoogleTrendsCsv(`${csv}\n`, {
      snapshotId: 'hash-synthetic-01', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00Z', sourceHash: sha256(csv),
    })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('INVALID_SOURCE_HASH')
  })

  it('accepts Google Trends only with the exact UTF-8 CSV hash, case normalized', () => {
    const csv = 'date,value\n2026-01-01,20\n2026-01-02,30'
    const result = parseGoogleTrendsCsv(csv, {
      snapshotId: 'hash-synthetic-02', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00+00:00', sourceHash: sha256(csv).toUpperCase(),
    })
    expect(result.ok).toBe(true)
    expect(result.value?.sourceHash).toBe(sha256(csv))
    expect(result.value?.capturedAt).toBe('2026-01-05T00:00:00.000Z')
  })

  it('hashes Meta canonical payload without sourceHash or derived limitations', () => {
    const input = metaInput()
    const payload = canonicalMetaAdPayload(input)
    expect(payload).not.toHaveProperty('sourceHash')
    expect(payload).not.toHaveProperty('limitations')
    expect(metaSnapshotSourceHash(input)).toBe(sha256(stableStringify(payload)))
  })

  it('accepts a Meta snapshot only with its canonical bounded metadata hash', () => {
    const input = metaInput()
    const result = parseMetaAdSnapshot({ ...input, sourceHash: metaSnapshotSourceHash(input).toUpperCase() })
    expect(result.ok).toBe(true)
    expect(result.value?.sourceHash).toBe(metaSnapshotSourceHash(input))
  })

  it('rejects a valid-looking Meta hash when an ad field changes', () => {
    const input = metaInput()
    const result = parseMetaAdSnapshot({ ...input, ads: input.ads.map((ad, index) => index === 0 ? { ...ad, status: 'active' } : ad) })
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('INVALID_SOURCE_HASH')
  })

  it('rejects non-SHA-256 creative hashes instead of treating non-empty text as valid', () => {
    const result = parseMetaAdSnapshot(metaInput({ ads: [{ adId: 'creative-bad', startedAt: '2026-01-01', lastSeenAt: '2026-01-02', status: 'active', creativeHash: 'not-a-hash' }] }))
    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('INVALID_SOURCE_HASH')
  })

  it('normalizes equivalent keyword case, whitespace, and full-width text', () => {
    expect(normalizeKeyword('  Synthetic　Topic  ')).toBe(normalizeKeyword('synthetic topic'))
    const first = syntheticTrendSnapshot({ keyword: 'Synthetic Topic' })
    const second = syntheticTrendSnapshot({ snapshotId: 'equivalent', keyword: ' synthetic　topic ' })
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [first, second] }))
    expect(assessment.status).toBe('ready')
    expect(assessment.rejectionReasons).not.toContain('KEYWORD_MISMATCH')
  })

  it('rejects apple and banana snapshots as a keyword conflict', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [
      syntheticTrendSnapshot({ snapshotId: 'apple', keyword: 'apple' }),
      syntheticTrendSnapshot({ snapshotId: 'banana', keyword: 'banana' }),
    ] }))
    expect(assessment.status).toBe('not_ready')
    expect(assessment.rejectionReasons).toContain('KEYWORD_MISMATCH')
    expect(assessment.rejectedSnapshotIds).toContain('banana')
  })

  it('rejects different normalization scales rather than averaging incompatible numbers', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [
      syntheticTrendSnapshot({ snapshotId: 'scale-a', scaleKey: 'web-search-us-2026-01' }),
      syntheticTrendSnapshot({ snapshotId: 'scale-b', scaleKey: 'web-search-world-2026-01' }),
    ] }))
    expect(assessment.status).toBe('not_ready')
    expect(assessment.rejectionReasons).toContain('SCALE_MISMATCH')
  })

  it('rejects a partially overlapping request window', () => {
    const assessment = assessMarketSignal(trendRequest({ window: { start: '2026-01-02', end: '2026-01-05' } }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('WINDOW_MISMATCH')
  })

  it('rejects an observation outside its snapshot window even when it is inside the request window', () => {
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [syntheticTrendSnapshot({
      window: { start: '2026-01-01', end: '2026-01-02' },
      observations: [{ date: '2026-01-01', value: 20 }, { date: '2026-01-03', value: 30 }],
    })] }))
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('INVALID_DATE')
  })

  it('requires explicit timezone on parser datetimes and canonicalizes equivalent offsets', () => {
    expect(normalizeIsoDateTime('2026-01-01T00:00:00')).toBeNull()
    expect(normalizeIsoDateTime('2026-01-01T08:00:00+08:00')).toBe('2026-01-01T00:00:00.000Z')
    const utc = parseGoogleTrendsCsv(SYNTHETIC_CSV, {
      snapshotId: 'time-utc', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00Z', sourceHash: SYNTHETIC_CSV_HASH,
    })
    const offset = parseGoogleTrendsCsv(SYNTHETIC_CSV, {
      snapshotId: 'time-offset', keyword: 'synthetic topic', scaleKey: 'web-search-us-2026-01', locale: 'en-US', window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T08:00:00+08:00', sourceHash: SYNTHETIC_CSV_HASH,
    })
    expect(utc.value?.capturedAt).toBe(offset.value?.capturedAt)
  })

  it('orders Meta snapshots by epoch rather than offset string', () => {
    const earlier = metaSnapshot({ snapshotId: 'earlier', capturedAt: '2026-01-05T00:00:00Z' })
    const later = metaSnapshot({ snapshotId: 'later', capturedAt: '2026-01-05T08:00:00+08:00' })
    const metrics = calculateMetaMetrics([later, earlier])
    expect(metrics?.snapshotCount).toBe(2)
    expect(metrics?.publisherDirections['synthetic example']).toBe('stable')
  })

  it('gives equivalent offset snapshots the same assessment fingerprint', () => {
    const first = trendRequest({ googleTrends: [syntheticTrendSnapshot({ capturedAt: '2026-01-05T00:00:00Z' })] })
    const second = trendRequest({ googleTrends: [syntheticTrendSnapshot({ capturedAt: '2026-01-05T08:00:00+08:00' })] })
    expect(assessMarketSignal(first).deterministicFingerprint).toBe(assessMarketSignal(second).deterministicFingerprint)
  })

  it('uses each publisher latest snapshot when summing active Meta ads', () => {
    const alphaOld = metaSnapshot({ publisher: 'Alpha Ltd.', publisherIdentity: 'alpha', snapshotId: 'alpha-old', capturedAt: '2026-01-01T00:00:00Z', ads: [{ adId: 'a1', startedAt: '2026-01-01', lastSeenAt: '2026-01-02', status: 'active', creativeHash: SYNTHETIC_HASH_A }] })
    const alphaNew = metaSnapshot({ publisher: 'Alpha Ltd.', publisherIdentity: 'alpha', snapshotId: 'alpha-new', capturedAt: '2026-01-04T00:00:00Z', ads: [{ adId: 'a1', startedAt: '2026-01-01', lastSeenAt: '2026-01-04', status: 'inactive', creativeHash: SYNTHETIC_HASH_A }] })
    const betaOnly = metaSnapshot({ publisher: 'Beta LLC', publisherIdentity: 'beta', snapshotId: 'beta-only', capturedAt: '2026-01-03T00:00:00Z', ads: [{ adId: 'b1', startedAt: '2026-01-02', lastSeenAt: '2026-01-03', status: 'active', creativeHash: SYNTHETIC_HASH_B }] })
    const metrics = calculateMetaMetrics([alphaNew, betaOnly, alphaOld])
    expect(metrics?.activeAdCount).toBe(1)
    expect(metrics?.publisherCount).toBe(2)
    expect(metrics?.publisherDirections).toEqual({ alpha: 'decreasing', beta: 'insufficient_data' })
    expect(metrics?.activityDirection).toBe('insufficient_data')
  })

  it('preserves Limited as a brand word while stripping only terminal company suffixes', () => {
    expect(normalizePublisherIdentity('Limited Run Games')).toBe('limited run games')
    expect(normalizePublisherIdentity('Synthetic Example Ltd.')).toBe('synthetic example')
    expect(normalizePublisherIdentity('https://WWW.Example.com/path')).toBe('example com')
  })

  it('fails closed for null, wrong-type, malformed-array, and missing-nested-object parser input', () => {
    expect(() => parseGoogleTrendsCsv(null, null)).not.toThrow()
    expect(parseGoogleTrendsCsv(null, null).errors.map((error) => error.code)).toContain('INVALID_INPUT')
    expect(parseGoogleTrendsCsv(123, {})).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_INPUT' })]) })
    expect(() => parseMetaAdSnapshot(null)).not.toThrow()
    expect(parseMetaAdSnapshot(null).errors.map((error) => error.code)).toContain('INVALID_INPUT')
    expect(parseMetaAdSnapshot({ ...metaInput(), ads: [null as unknown as never] }).errors.map((error) => error.code)).toContain('INVALID_INPUT')
    expect(parseMetaAdSnapshot({ ...metaInput(), window: undefined }).errors.map((error) => error.code)).toContain('INVALID_DATE')
    const malformedAssessment = assessMarketSignal({ ...trendRequest(), googleTrends: 'not-an-array' as unknown as GoogleTrendsSnapshot[] })
    expect(malformedAssessment.status).toBe('rejected')
    expect(malformedAssessment.rejectionReasons).toContain('INVALID_INPUT')
  })

  it('fails closed for malformed assessment input without exposing raw input or stack data', () => {
    const assessment = assessMarketSignal(null)
    expect(assessment.status).toBe('rejected')
    expect(assessment.rejectionReasons).toContain('INVALID_INPUT')
    expect(JSON.stringify(assessment)).not.toContain('TypeError')
    expect(JSON.stringify(assessment)).not.toContain('stack')
  })

  it('keeps equal endpoints stable even when the middle trend swings sharply', () => {
    const metrics = calculateTrendMetrics([syntheticTrendSnapshot({ observations: [
      { date: '2026-01-01', value: 10 },
      { date: '2026-01-02', value: 100 },
      { date: '2026-01-03', value: 0 },
      { date: '2026-01-04', value: 10 },
    ] })])
    expect(metrics?.firstValue).toBe(10)
    expect(metrics?.latestValue).toBe(10)
    expect(metrics?.direction).toBe('stable')
  })
})


describe('Google Trends scaleKey provenance regression', () => {
  function parseScale(scaleKey: unknown, snapshotId: string) {
    return parseGoogleTrendsCsv(SYNTHETIC_CSV, {
      snapshotId,
      keyword: 'synthetic topic',
      scaleKey: scaleKey as string,
      locale: 'en-US',
      window: SYNTHETIC_WINDOW,
      capturedAt: '2026-01-05T00:00:00Z',
      sourceHash: SYNTHETIC_CSV_HASH,
    })
  }

  it('preserves normalized scaleKey in parser output', () => {
    const result = parseScale(' Web-Search-US-2026-01 ', 'scale-preserve')
    expect(result.ok).toBe(true)
    expect(result.value?.scaleKey).toBe('web-search-us-2026-01')
  })

  it('rejects missing, null, non-string, empty, and whitespace-only scaleKey', () => {
    for (const scaleKey of [undefined, null, 42, '', '   ']) {
      const result = parseScale(scaleKey, `scale-missing-${String(scaleKey)}`)
      expect(result.ok).toBe(false)
      expect(result.value).toBeUndefined()
      expect(result.errors.map((error) => error.code)).toContain('MISSING_REQUIRED_FIELD')
    }
  })

  it('keeps the CSV source hash contract independent from scaleKey', () => {
    const us = parseScale('web-search-us-2026-01', 'scale-hash-us')
    const world = parseScale('web-search-world-2026-01', 'scale-hash-world')
    expect(us.value?.sourceHash).toBe(SYNTHETIC_CSV_HASH)
    expect(world.value?.sourceHash).toBe(SYNTHETIC_CSV_HASH)
  })

  it('does not produce SCALE_MISMATCH for normalized-equivalent parser scales', () => {
    const first = parseScale(' Web-Search-US-2026-01 ', 'scale-equivalent-a')
    const second = parseScale('web-search-us-2026-01', 'scale-equivalent-b')
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [first.value!, second.value!] }))
    expect(assessment.status).toBe('ready')
    expect(assessment.rejectionReasons).not.toContain('SCALE_MISMATCH')
  })

  it('rejects different parser scales without merging them into ready metrics', () => {
    const us = parseScale('web-search-us-2026-01', 'scale-different-us')
    const world = parseScale('web-search-world-2026-01', 'scale-different-world')
    expect(us.ok).toBe(true)
    expect(world.ok).toBe(true)
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [us.value!, world.value!] }))
    expect(['not_ready', 'rejected']).toContain(assessment.status)
    expect(assessment.rejectionReasons).toContain('SCALE_MISMATCH')
    expect(assessment.rejectedSnapshotIds).toContain('scale-different-world')
  })

  it('rejects direct snapshots with missing or malformed scaleKey before metrics', () => {
    for (const scaleKey of [undefined, null, 42, '', '   ']) {
      const snapshot = { ...syntheticTrendSnapshot({ snapshotId: `direct-scale-${String(scaleKey)}` }), scaleKey: scaleKey as string }
      const assessment = assessMarketSignal(trendRequest({ googleTrends: [snapshot] }))
      expect(['not_ready', 'rejected']).toContain(assessment.status)
      expect(assessment.acceptedSnapshotIds).toEqual([])
      expect(assessment.trendMetrics).toBeNull()
      expect(assessment.rejectionReasons).toContain('MISSING_REQUIRED_FIELD')
    }
  })

  it('does not let missing scaleKey silently become default during alignment', () => {
    const missing = { ...syntheticTrendSnapshot({ snapshotId: 'scale-no-default' }), scaleKey: undefined as unknown as string }
    const assessment = assessMarketSignal(trendRequest({ googleTrends: [missing] }))
    expect(assessment.rejectionReasons).not.toContain('SCALE_MISMATCH')
    expect(assessment.acceptedSnapshotIds).not.toContain('scale-no-default')
    expect(assessment.status).toBe('rejected')
  })
})
