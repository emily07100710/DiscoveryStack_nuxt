import { sha256 } from '../../../server/market-intelligence'
import type {
  GoogleTrendsSnapshot,
  MetaAdSnapshot,
  MetaAdSnapshotInput,
} from '../../../server/market-intelligence'

export const SYNTHETIC_HASH_A = 'a'.repeat(64)
export const SYNTHETIC_HASH_B = 'b'.repeat(64)
export const SYNTHETIC_HASH_C = 'c'.repeat(64)

export const SYNTHETIC_WINDOW = { start: '2026-01-01', end: '2026-01-04' } as const

export function syntheticTrendSnapshot(overrides: Partial<GoogleTrendsSnapshot> = {}): GoogleTrendsSnapshot {
  return {
    provider: 'google_trends',
    snapshotId: 'trend-synthetic-01',
    keyword: 'synthetic topic',
    locale: 'en-us',
    window: SYNTHETIC_WINDOW,
    capturedAt: '2026-01-05T00:00:00.000Z',
    sourceHash: SYNTHETIC_HASH_A,
    observations: [
      { date: '2026-01-01', value: 20 },
      { date: '2026-01-02', value: 30 },
      { date: '2026-01-03', value: 40 },
      { date: '2026-01-04', value: 50 },
    ],
    limitations: ['synthetic trend fixture; not real search data'],
    ...overrides,
  }
}

export function syntheticMetaInput(overrides: Partial<MetaAdSnapshotInput> = {}): MetaAdSnapshotInput {
  return {
    provider: 'meta_ad_library',
    snapshotId: 'meta-synthetic-01',
    publisher: 'Synthetic Example Ltd.',
    locale: 'en-us',
    window: SYNTHETIC_WINDOW,
    capturedAt: '2026-01-05T00:00:00.000Z',
    sourceHash: SYNTHETIC_HASH_B,
    ads: [
      { adId: 'ad-02', startedAt: '2025-12-31', lastSeenAt: '2026-01-04', status: 'inactive', creativeHash: SYNTHETIC_HASH_C },
      { adId: 'ad-01', startedAt: '2026-01-02', lastSeenAt: '2026-01-04', status: 'active', creativeHash: SYNTHETIC_HASH_A },
    ],
    ...overrides,
  }
}

export function syntheticMetaSnapshot(overrides: Partial<MetaAdSnapshot> = {}): MetaAdSnapshot {
  const input = syntheticMetaInput(overrides)
  return {
    ...input,
    provider: 'meta_ad_library',
    publisherIdentity: 'synthetic example',
    sourceHash: input.sourceHash ?? SYNTHETIC_HASH_B,
    limitations: ['synthetic Meta snapshot; not real advertising data'],
  }
}

export const SYNTHETIC_CSV = `date,value
2026-01-01,20
2026-01-02,30
2026-01-03,40
2026-01-04,50`

export const SYNTHETIC_CSV_HASH = sha256(SYNTHETIC_CSV)
