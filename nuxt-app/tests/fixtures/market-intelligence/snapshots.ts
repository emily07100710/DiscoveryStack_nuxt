import {
  metaSnapshotSourceHash,
  normalizePublisherIdentity,
  sha256,
} from '../../../server/market-intelligence'
import type {
  GoogleTrendsObservation,
  GoogleTrendsSnapshot,
  MetaAdSnapshot,
  MetaAdSnapshotInput,
} from '../../../server/market-intelligence'

export const SYNTHETIC_HASH_A = 'a'.repeat(64)
export const SYNTHETIC_HASH_B = 'b'.repeat(64)
export const SYNTHETIC_HASH_C = 'c'.repeat(64)

export const SYNTHETIC_WINDOW = { start: '2026-01-01', end: '2026-01-04' } as const

function trendCsv(observations: readonly GoogleTrendsObservation[]): string {
  return ['date,value', ...observations.map((observation) => `${observation.date},${observation.value}`)].join('\n')
}

export function syntheticTrendSnapshot(overrides: Partial<GoogleTrendsSnapshot> = {}): GoogleTrendsSnapshot {
  const observations: GoogleTrendsObservation[] = [
    { date: '2026-01-01', value: 20 },
    { date: '2026-01-02', value: 30 },
    { date: '2026-01-03', value: 40 },
    { date: '2026-01-04', value: 50 },
  ]
  const base: GoogleTrendsSnapshot = {
    provider: 'google_trends',
    snapshotId: 'trend-synthetic-01',
    keyword: 'synthetic topic',
    locale: 'en-us',
    window: SYNTHETIC_WINDOW,
    capturedAt: '2026-01-05T00:00:00.000Z',
    sourceHash: sha256(trendCsv(observations)),
    scaleKey: 'default',
    observations,
    limitations: ['synthetic trend fixture; not real search data'],
  }
  const merged = { ...base, ...overrides }
  return {
    ...merged,
    sourceHash: overrides.sourceHash ?? sha256(trendCsv(merged.observations)),
  }
}

export function syntheticMetaInput(overrides: Partial<MetaAdSnapshotInput> = {}): MetaAdSnapshotInput {
  const base = {
    provider: 'meta_ad_library' as const,
    snapshotId: 'meta-synthetic-01',
    publisher: 'Synthetic Example Ltd.',
    locale: 'en-us',
    window: SYNTHETIC_WINDOW,
    capturedAt: '2026-01-05T00:00:00.000Z',
    ads: [
      { adId: 'ad-02', startedAt: '2025-12-31', lastSeenAt: '2026-01-04', status: 'inactive' as const, creativeHash: SYNTHETIC_HASH_C },
      { adId: 'ad-01', startedAt: '2026-01-02', lastSeenAt: '2026-01-04', status: 'active' as const, creativeHash: SYNTHETIC_HASH_A },
    ],
  }
  const merged = {
    ...base,
    ...overrides,
    provider: overrides.provider ?? base.provider,
    snapshotId: overrides.snapshotId ?? base.snapshotId,
    publisher: overrides.publisher ?? base.publisher,
    locale: overrides.locale ?? base.locale,
    window: overrides.window ?? base.window,
    capturedAt: overrides.capturedAt ?? base.capturedAt,
    ads: overrides.ads ?? base.ads,
  }
  return {
    ...merged,
    sourceHash: overrides.sourceHash ?? metaSnapshotSourceHash(merged),
  }
}

export function syntheticMetaSnapshot(overrides: Partial<MetaAdSnapshot> = {}): MetaAdSnapshot {
  const input = syntheticMetaInput({
    provider: overrides.provider,
    snapshotId: overrides.snapshotId,
    publisher: overrides.publisher,
    locale: overrides.locale,
    window: overrides.window,
    capturedAt: overrides.capturedAt,
    sourceHash: overrides.sourceHash,
    ads: overrides.ads,
  })
  return {
    ...input,
    provider: 'meta_ad_library',
    publisher: input.publisher,
    publisherIdentity: overrides.publisherIdentity ?? normalizePublisherIdentity(input.publisher),
    sourceHash: input.sourceHash!,
    limitations: overrides.limitations ?? ['synthetic Meta snapshot; not real advertising data'],
  }
}

export const SYNTHETIC_CSV = `date,value
2026-01-01,20
2026-01-02,30
2026-01-03,40
2026-01-04,50`

export const SYNTHETIC_CSV_HASH = sha256(SYNTHETIC_CSV)
