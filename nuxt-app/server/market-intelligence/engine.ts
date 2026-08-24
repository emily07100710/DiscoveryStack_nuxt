import {
  MARKET_SIGNAL_ENGINE_VERSION,
  MARKET_SIGNAL_POLICY_VERSION,
  MARKET_SIGNAL_LIMITATIONS,
  MARKET_SIGNAL_POLICIES,
  MAX_LIMITATION_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MIN_TREND_OBSERVATIONS,
} from './policy-catalog'
import { calculateMetaMetrics, calculateTrendMetrics } from './metrics'
import {
  fingerprint,
  isIsoDate,
  isIsoDateTime,
  isSha256Hex,
  isDateWithinWindow,
  normalizeRequest,
  normalizeText,
  stableStringify,
} from './normalization'
import type {
  DateWindow,
  GoogleTrendsSnapshot,
  MarketSignalAssessment,
  MarketSignalRequest,
  MetaAdSnapshot,
  RejectionReason,
  SignalProvider,
  SignalStatus,
} from './types'

const SORTED_CHECK_CODES: RejectionReason[] = [
  'DUPLICATE_OBSERVATION',
  'DUPLICATE_AD_ID',
  'INVALID_DATE',
  'INVALID_INPUT',
  'INVALID_NUMBER',
  'LOCALE_MISMATCH',
  'MISSING_REQUIRED_FIELD',
  'MISSING_SNAPSHOT_ID',
  'MISSING_SOURCE_HASH',
  'SNAPSHOT_OUTSIDE_WINDOW',
  'UNSUPPORTED_CLAIM_USE',
  'WINDOW_MISMATCH',
]

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right)) as T[]
}

function boundedLimitations(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .map((value) => value.length > MAX_LIMITATION_LENGTH ? `${value.slice(0, MAX_LIMITATION_LENGTH - 1)}…` : value)
}

function datesValid(window: DateWindow): boolean {
  return isIsoDate(window.start) && isIsoDate(window.end) && window.start <= window.end
}

function windowsOverlap(left: DateWindow, right: DateWindow): boolean {
  return left.start <= right.end && right.start <= left.end
}

function providerForSignalKind(signalKind: MarketSignalRequest['signalKind']): SignalProvider {
  return signalKind === 'competitive_activity' ? 'meta_ad_library' : 'google_trends'
}

function canonicalTrendSnapshot(snapshot: GoogleTrendsSnapshot): unknown {
  return {
    ...snapshot,
    observations: snapshot.observations.slice().sort((left, right) => left.date.localeCompare(right.date)),
    limitations: snapshot.limitations.slice().sort(),
  }
}

function canonicalMetaSnapshot(snapshot: MetaAdSnapshot): unknown {
  return {
    ...snapshot,
    ads: snapshot.ads.slice().sort((left, right) => left.adId.localeCompare(right.adId)),
    limitations: snapshot.limitations.slice().sort(),
  }
}

function baseAssessment(request: MarketSignalRequest): MarketSignalAssessment {
  return {
    requestId: request.requestId,
    status: 'not_ready',
    signalKind: request.signalKind,
    claimUse: request.claimUse,
    hypothesisOnly: true,
    trendMetrics: null,
    metaMetrics: null,
    acceptedSnapshotIds: [],
    rejectedSnapshotIds: [],
    rejectionReasons: [],
    missingEvidenceTypes: [],
    limitations: [...MARKET_SIGNAL_LIMITATIONS],
    deterministicFingerprint: '',
    policyVersion: MARKET_SIGNAL_POLICY_VERSION,
    engineVersion: MARKET_SIGNAL_ENGINE_VERSION,
  }
}

function finalizeAssessment(request: MarketSignalRequest, assessment: MarketSignalAssessment): MarketSignalAssessment {
  const final = {
    ...assessment,
    acceptedSnapshotIds: [...new Set(assessment.acceptedSnapshotIds)].sort(),
    rejectedSnapshotIds: [...new Set(assessment.rejectedSnapshotIds)].sort(),
    rejectionReasons: uniqueSorted(assessment.rejectionReasons),
    missingEvidenceTypes: uniqueSorted(assessment.missingEvidenceTypes),
    limitations: boundedLimitations(assessment.limitations),
  }
  const fingerprintInput = {
    request: {
      ...request,
      googleTrends: request.googleTrends?.map(canonicalTrendSnapshot),
      metaAdSnapshots: request.metaAdSnapshots?.map(canonicalMetaSnapshot),
    },
    result: { ...final, deterministicFingerprint: undefined },
  }
  return { ...final, deterministicFingerprint: fingerprint(fingerprintInput) }
}

function validateCommonSnapshot(snapshot: { snapshotId: string; locale: string; window: DateWindow; capturedAt: string; sourceHash: string }, request: MarketSignalRequest): RejectionReason[] {
  const reasons: RejectionReason[] = []
  if (!snapshot.snapshotId.trim()) reasons.push('MISSING_SNAPSHOT_ID')
  if (!snapshot.locale.trim() || normalizeText(snapshot.locale) !== normalizeText(request.locale)) reasons.push('LOCALE_MISMATCH')
  if (!datesValid(snapshot.window) || !isIsoDateTime(snapshot.capturedAt)) reasons.push('INVALID_DATE')
  if (!isSha256Hex(snapshot.sourceHash)) reasons.push(snapshot.sourceHash ? 'INVALID_SOURCE_HASH' : 'MISSING_SOURCE_HASH')
  if (!windowsOverlap(snapshot.window, request.window)) reasons.push('WINDOW_MISMATCH')
  return reasons
}

function validateTrendSnapshot(snapshot: GoogleTrendsSnapshot, request: MarketSignalRequest): RejectionReason[] {
  const reasons = validateCommonSnapshot(snapshot, request)
  const policy = MARKET_SIGNAL_POLICIES.google_trends
  if (snapshot.provider !== 'google_trends') reasons.push('UNKNOWN_PROVIDER')
  if (!Array.isArray(snapshot.observations) || snapshot.observations.length === 0) reasons.push('MISSING_REQUIRED_FIELD')
  if (snapshot.observations.length > policy.maxObservationsPerSnapshot) reasons.push('INVALID_INPUT')
  const seen = new Set<string>()
  snapshot.observations.forEach((observation) => {
    if (!isIsoDate(observation.date) || !isDateWithinWindow(observation.date, request.window)) reasons.push('INVALID_DATE')
    if (seen.has(observation.date)) reasons.push('DUPLICATE_OBSERVATION')
    if (!Number.isFinite(observation.value)) reasons.push('INVALID_NUMBER')
    if (observation.value < 0 || observation.value > 100) reasons.push('INVALID_NUMBER')
    seen.add(observation.date)
  })
  return reasons
}

function addMissingEvidenceForReasons(assessment: MarketSignalAssessment, reasons: readonly RejectionReason[]): void {
  if (reasons.some((reason) => reason === 'MISSING_SOURCE_HASH' || reason === 'INVALID_SOURCE_HASH')) assessment.missingEvidenceTypes.push('source_hash')
  if (reasons.some((reason) => reason === 'MISSING_PUBLISHER')) assessment.missingEvidenceTypes.push('publisher_identity')
  if (reasons.some((reason) => reason === 'LOCALE_MISMATCH')) assessment.missingEvidenceTypes.push('locale_alignment')
  if (reasons.some((reason) => reason === 'INVALID_DATE' || reason === 'WINDOW_MISMATCH' || reason === 'SNAPSHOT_OUTSIDE_WINDOW')) assessment.missingEvidenceTypes.push('observation_window')
}

function validateMetaSnapshot(snapshot: MetaAdSnapshot, request: MarketSignalRequest): RejectionReason[] {
  const reasons = validateCommonSnapshot(snapshot, request)
  const policy = MARKET_SIGNAL_POLICIES.meta_ad_library
  if (snapshot.provider !== 'meta_ad_library') reasons.push('UNKNOWN_PROVIDER')
  if (!snapshot.publisherIdentity.trim()) reasons.push('MISSING_PUBLISHER')
  if (!Array.isArray(snapshot.ads)) reasons.push('INVALID_INPUT')
  if (snapshot.ads.length > policy.maxAdsPerSnapshot) reasons.push('INVALID_INPUT')
  const seen = new Set<string>()
  snapshot.ads.forEach((ad) => {
    if (!ad.adId.trim()) reasons.push('MISSING_AD_ID')
    if (seen.has(ad.adId)) reasons.push('DUPLICATE_AD_ID')
    if (!isIsoDate(ad.startedAt) || !isIsoDate(ad.lastSeenAt) || ad.startedAt > ad.lastSeenAt) reasons.push('INVALID_DATE')
    if (!['active', 'inactive', 'unknown'].includes(ad.status)) reasons.push('UNKNOWN_STATUS')
    if (!ad.creativeHash.trim()) reasons.push('MISSING_REQUIRED_FIELD')
    seen.add(ad.adId)
  })
  return reasons
}

export function assessMarketSignal(input: MarketSignalRequest): MarketSignalAssessment {
  const request = normalizeRequest(input)
  const assessment = baseAssessment(request)
  const requestErrors: RejectionReason[] = []
  if (!request.requestId || request.requestId.length > MAX_REQUEST_ID_LENGTH) requestErrors.push('INVALID_INPUT')
  if (!datesValid(request.window) || !isIsoDate(request.window.start) || !isIsoDate(request.window.end)) requestErrors.push('INVALID_DATE')
  if (!request.locale.trim()) requestErrors.push('MISSING_REQUIRED_FIELD')
  if (!(['demand_interest', 'seasonality', 'competitive_activity'] as readonly string[]).includes(request.signalKind)) {
    requestErrors.push('UNKNOWN_SIGNAL_KIND')
    assessment.status = 'rejected'
    assessment.rejectionReasons.push(...requestErrors)
    assessment.missingEvidenceTypes.push('market_hypothesis_scope')
    return finalizeAssessment(request, assessment)
  }
  if (request.claimUse !== 'market_hypothesis') {
    requestErrors.push('UNSUPPORTED_CLAIM_USE')
    assessment.status = 'rejected'
    assessment.rejectionReasons.push(...requestErrors)
    assessment.missingEvidenceTypes.push('market_hypothesis_scope')
    assessment.limitations.push('本 engine 僅允許 market_hypothesis；不得把訊號輸出宣稱為 factual、ranking、investment 或其他事實性證據。')
    return finalizeAssessment(request, assessment)
  }
  if (requestErrors.length > 0) {
    assessment.status = 'rejected'
    assessment.rejectionReasons.push(...requestErrors)
    assessment.missingEvidenceTypes.push('observation_window')
    return finalizeAssessment(request, assessment)
  }

  const expectedProvider = providerForSignalKind(request.signalKind)
  if (expectedProvider === 'google_trends') {
    const snapshots = (request.googleTrends ?? []).slice().sort((left, right) => left.snapshotId.localeCompare(right.snapshotId))
    if (snapshots.length === 0) {
      assessment.missingEvidenceTypes.push('trend_observations')
      return finalizeAssessment(request, assessment)
    }
    const policy = MARKET_SIGNAL_POLICIES.google_trends
    const seenSnapshotIds = new Set<string>()
    snapshots.forEach((snapshot, index) => {
      const reasons = validateTrendSnapshot(snapshot, request)
      if (seenSnapshotIds.has(snapshot.snapshotId)) reasons.push('DUPLICATE_SNAPSHOT_ID')
      seenSnapshotIds.add(snapshot.snapshotId)
      if (index >= policy.maxSnapshots) reasons.push('INVALID_INPUT')
      if (reasons.length > 0) {
        assessment.rejectedSnapshotIds.push(snapshot.snapshotId)
        assessment.rejectionReasons.push(...reasons)
        assessment.acceptedSnapshotIds = assessment.acceptedSnapshotIds.filter((acceptedId) => acceptedId !== snapshot.snapshotId)
        addMissingEvidenceForReasons(assessment, reasons)
      } else {
        assessment.acceptedSnapshotIds.push(snapshot.snapshotId)
      }
    })
    const acceptedSnapshots = snapshots.filter((snapshot) => assessment.acceptedSnapshotIds.includes(snapshot.snapshotId)).slice(0, policy.maxSnapshots)
    assessment.trendMetrics = calculateTrendMetrics(acceptedSnapshots)
    if (acceptedSnapshots.length === 0) {
      assessment.status = 'rejected'
      assessment.missingEvidenceTypes.push('trend_observations')
    } else if (!assessment.trendMetrics || assessment.trendMetrics.pointCount < MIN_TREND_OBSERVATIONS) {
      assessment.status = 'not_ready'
      assessment.missingEvidenceTypes.push('trend_observations')
      assessment.limitations.push('目前有效 observation 不足以形成方向性比較；不得從單點或單日讀值推導市場趨勢。')
    } else {
      assessment.status = 'ready'
    }
    assessment.limitations.push(...acceptedSnapshots.flatMap((snapshot) => snapshot.limitations))
  } else {
    const snapshots = (request.metaAdSnapshots ?? []).slice().sort((left, right) => left.snapshotId.localeCompare(right.snapshotId))
    if (snapshots.length === 0) {
      assessment.missingEvidenceTypes.push('meta_snapshot')
      return finalizeAssessment(request, assessment)
    }
    const policy = MARKET_SIGNAL_POLICIES.meta_ad_library
    const seenSnapshotIds = new Set<string>()
    snapshots.forEach((snapshot, index) => {
      const reasons = validateMetaSnapshot(snapshot, request)
      if (seenSnapshotIds.has(snapshot.snapshotId)) reasons.push('DUPLICATE_SNAPSHOT_ID')
      seenSnapshotIds.add(snapshot.snapshotId)
      if (index >= policy.maxSnapshots) reasons.push('INVALID_INPUT')
      if (reasons.length > 0) {
        assessment.rejectedSnapshotIds.push(snapshot.snapshotId)
        assessment.rejectionReasons.push(...reasons)
        assessment.acceptedSnapshotIds = assessment.acceptedSnapshotIds.filter((acceptedId) => acceptedId !== snapshot.snapshotId)
        addMissingEvidenceForReasons(assessment, reasons)
      } else {
        assessment.acceptedSnapshotIds.push(snapshot.snapshotId)
      }
    })
    const acceptedSnapshots = snapshots.filter((snapshot) => assessment.acceptedSnapshotIds.includes(snapshot.snapshotId)).slice(0, policy.maxSnapshots)
    assessment.metaMetrics = calculateMetaMetrics(acceptedSnapshots)
    if (acceptedSnapshots.length === 0) {
      assessment.status = 'rejected'
      assessment.missingEvidenceTypes.push('meta_snapshot')
    } else {
      assessment.status = 'ready'
      if (assessment.metaMetrics?.activityDirection === 'insufficient_data') assessment.limitations.push('只有一個 snapshot，無法計算活動方向；輸出僅描述該 bounded snapshot。')
    }
    assessment.limitations.push(...acceptedSnapshots.flatMap((snapshot) => snapshot.limitations))
  }
  if (assessment.acceptedSnapshotIds.length > 0 && assessment.rejectionReasons.length > 0) assessment.limitations.push('部分輸入被拒絕；結果只涵蓋通過 validation 的 snapshots。')
  return finalizeAssessment(request, assessment)
}

export function assessmentFingerprint(assessment: MarketSignalAssessment): string {
  return assessment.deterministicFingerprint || fingerprint({ ...assessment, deterministicFingerprint: undefined })
}

export function isMarketSignalEnginePure(): boolean {
  return stableStringify({ network: false, crawler: false, providers: false, database: false, api: false, ui: false }) === '{"api":false,"crawler":false,"database":false,"network":false,"providers":false,"ui":false}'
}
