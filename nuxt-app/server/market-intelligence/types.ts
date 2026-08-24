export const MARKET_SIGNAL_ENGINE_VERSION = 'market-intelligence-signal-engine-v1.0.0' as const
export const MARKET_SIGNAL_POLICY_VERSION = 'market-intelligence-signal-policy-v1.0.0' as const

export const SIGNAL_PROVIDERS = ['google_trends', 'meta_ad_library'] as const
export type SignalProvider = (typeof SIGNAL_PROVIDERS)[number]

export const SIGNAL_KINDS = ['demand_interest', 'seasonality', 'competitive_activity'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

export const SIGNAL_STATUSES = ['ready', 'not_ready', 'rejected'] as const
export type SignalStatus = (typeof SIGNAL_STATUSES)[number]

export const CLAIM_USES = ['market_hypothesis', 'factual_claim', 'ranking_claim', 'investment_claim'] as const
export type ClaimUse = (typeof CLAIM_USES)[number]

export const REJECTION_REASONS = [
  'INVALID_INPUT',
  'INVALID_DATE',
  'INVALID_NUMBER',
  'INVALID_SOURCE_HASH',
  'MISSING_REQUIRED_FIELD',
  'DUPLICATE_OBSERVATION',
  'DUPLICATE_SNAPSHOT_ID',
  'INSUFFICIENT_OBSERVATIONS',
  'OUT_OF_RANGE_VALUE',
  'UNSUPPORTED_CLAIM_USE',
  'UNKNOWN_PROVIDER',
  'UNKNOWN_SIGNAL_KIND',
  'UNKNOWN_STATUS',
  'MISSING_SNAPSHOT_ID',
  'MISSING_SOURCE_HASH',
  'MISSING_PUBLISHER',
  'MISSING_AD_ID',
  'DUPLICATE_AD_ID',
  'UNSUPPORTED_FORMAT',
  'MALFORMED_CSV',
  'MISSING_TIME_SERIES_HEADER',
  'MISSING_TIME_SERIES_VALUE',
  'SUPPRESSED_VALUE',
  'SUSPICIOUS_VALUE',
  'SNAPSHOT_OUTSIDE_WINDOW',
  'LOCALE_MISMATCH',
  'LOCALE_ALIGNMENT_REQUIRED',
  'WINDOW_MISMATCH',
] as const
export type RejectionReason = (typeof REJECTION_REASONS)[number]

export const MISSING_EVIDENCE_TYPES = [
  'trend_observations',
  'meta_snapshot',
  'source_hash',
  'publisher_identity',
  'observation_window',
  'market_hypothesis_scope',
  'locale_alignment',
] as const
export type MissingEvidenceType = (typeof MISSING_EVIDENCE_TYPES)[number]

export interface DateWindow {
  start: string
  end: string
}

export interface GoogleTrendsObservation {
  date: string
  value: number
  suppressedBelowOne?: boolean
}

export interface GoogleTrendsSnapshot {
  provider: 'google_trends'
  snapshotId: string
  keyword: string
  locale: string
  window: DateWindow
  capturedAt: string
  sourceHash: string
  observations: GoogleTrendsObservation[]
  limitations: string[]
}

export interface GoogleTrendsParseOptions {
  snapshotId: string
  keyword: string
  locale: string
  window: DateWindow
  capturedAt: string
  sourceHash?: string
}

export interface ParseResult<T> {
  ok: boolean
  value?: T
  errors: ParseIssue[]
  warnings: ParseIssue[]
}

export interface ParseIssue {
  code: RejectionReason
  message: string
  line?: number
}

export type MetaAdStatus = 'active' | 'inactive' | 'unknown'

export interface MetaAdRecord {
  adId: string
  startedAt: string
  lastSeenAt: string
  status: MetaAdStatus
  creativeHash: string
  landingDomain?: string
}

export interface MetaAdSnapshot {
  provider: 'meta_ad_library'
  snapshotId: string
  publisher: string
  publisherIdentity: string
  locale: string
  window: DateWindow
  capturedAt: string
  sourceHash: string
  ads: MetaAdRecord[]
  limitations: string[]
}

export interface MetaAdSnapshotInput {
  provider?: 'meta_ad_library'
  snapshotId: string
  publisher: string
  locale: string
  window: DateWindow
  capturedAt: string
  sourceHash?: string
  ads: MetaAdRecord[]
}

export interface TrendMetrics {
  pointCount: number
  firstValue: number
  latestValue: number
  mean: number
  minimum: number
  maximum: number
  changePercent: number | null
  slopePerObservation: number
  volatilityPercent: number
  peakDate: string | null
  peakValue: number | null
  direction: 'rising' | 'falling' | 'stable' | 'insufficient_data'
  coverageRatio: number
}

export interface MetaMetrics {
  snapshotCount: number
  publisherCount: number
  totalAdCount: number
  uniqueAdCount: number
  activeAdCount: number
  uniqueCreativeCount: number
  newAdCount: number
  averageAdAgeDays: number | null
  activityDirection: 'increasing' | 'decreasing' | 'stable' | 'insufficient_data'
}

export interface MarketSignalAssessment {
  requestId: string
  status: SignalStatus
  signalKind: SignalKind
  claimUse: ClaimUse
  hypothesisOnly: true
  trendMetrics: TrendMetrics | null
  metaMetrics: MetaMetrics | null
  acceptedSnapshotIds: string[]
  rejectedSnapshotIds: string[]
  rejectionReasons: RejectionReason[]
  missingEvidenceTypes: MissingEvidenceType[]
  limitations: string[]
  deterministicFingerprint: string
  policyVersion: string
  engineVersion: string
}

export interface MarketSignalRequest {
  requestId: string
  signalKind: SignalKind
  claimUse: ClaimUse
  locale: string
  window: DateWindow
  googleTrends?: GoogleTrendsSnapshot[]
  metaAdSnapshots?: MetaAdSnapshot[]
}

export interface MarketSignalPolicy {
  provider: SignalProvider
  allowedClaimUses: readonly ['market_hypothesis']
  maxSnapshots: number
  maxObservationsPerSnapshot: number
  maxAdsPerSnapshot: number
}
