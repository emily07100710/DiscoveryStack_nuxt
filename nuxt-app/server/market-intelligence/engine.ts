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
  isDateWithinWindow,
  isIsoDate,
  isIsoDateTime,
  isSha256Hex,
  metaSnapshotSourceHash,
  normalizeIsoDateTime,
  normalizeKeyword,
  normalizePublisherIdentity,
  normalizeRequest,
  normalizeText,
  stableStringify,
} from './normalization'
import type {
  DateWindow,
  GoogleTrendsObservation,
  GoogleTrendsSnapshot,
  MarketSignalAssessment,
  MarketSignalRequest,
  MetaAdRecord,
  MetaAdSnapshot,
  RejectionReason,
  SignalProvider,
} from './types'

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right)) as T[]
}

function boundedLimitations(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .map((value) => value.length > MAX_LIMITATION_LENGTH ? `${value.slice(0, MAX_LIMITATION_LENGTH - 1)}…` : value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function datesValid(window: DateWindow): boolean {
  return isIsoDate(window.start) && isIsoDate(window.end) && window.start <= window.end
}

function windowsEqual(left: unknown, right: DateWindow): boolean {
  return isRecord(left) && left.start === right.start && left.end === right.end
}

function providerForSignalKind(signalKind: MarketSignalRequest['signalKind']): SignalProvider | null {
  if (signalKind === 'competitive_activity') return 'meta_ad_library'
  if (signalKind === 'demand_interest' || signalKind === 'seasonality') return 'google_trends'
  return null
}

function normalizedSnapshotId(value: unknown): string {
  return typeof value === 'string' ? normalizeText(value) : ''
}

function canonicalTrendSnapshot(input: unknown): GoogleTrendsSnapshot {
  const snapshot = isRecord(input) ? input : {}
  const rawWindow = isRecord(snapshot.window) ? snapshot.window : {}
  const rawObservations = Array.isArray(snapshot.observations) ? snapshot.observations : []
  const observations: GoogleTrendsObservation[] = rawObservations.filter(isRecord).map((observation) => ({
    date: typeof observation.date === 'string' ? observation.date : '',
    value: typeof observation.value === 'number' && Number.isFinite(observation.value) ? observation.value : 0,
    ...(observation.suppressedBelowOne === true ? { suppressedBelowOne: true } : {}),
  })).sort((left, right) => left.date.localeCompare(right.date))
  const rawLimitations = Array.isArray(snapshot.limitations) ? snapshot.limitations : []
  return {
    provider: snapshot.provider === 'google_trends' ? 'google_trends' : 'google_trends',
    snapshotId: normalizedSnapshotId(snapshot.snapshotId),
    keyword: typeof snapshot.keyword === 'string' ? normalizeKeyword(snapshot.keyword) : '',
    locale: typeof snapshot.locale === 'string' ? normalizeText(snapshot.locale) : '',
    window: { start: typeof rawWindow.start === 'string' ? rawWindow.start : '', end: typeof rawWindow.end === 'string' ? rawWindow.end : '' },
    capturedAt: typeof snapshot.capturedAt === 'string' ? normalizeIsoDateTime(snapshot.capturedAt) ?? snapshot.capturedAt : '',
    sourceHash: typeof snapshot.sourceHash === 'string' ? snapshot.sourceHash.trim().toLocaleLowerCase('en-US') : '',
    scaleKey: typeof snapshot.scaleKey === 'string' ? normalizeText(snapshot.scaleKey) : '',
    observations,
    limitations: rawLimitations.filter((value): value is string => typeof value === 'string').slice().sort(),
  }
}

function canonicalMetaSnapshot(input: unknown): MetaAdSnapshot {
  const snapshot = isRecord(input) ? input : {}
  const rawWindow = isRecord(snapshot.window) ? snapshot.window : {}
  const rawAds = Array.isArray(snapshot.ads) ? snapshot.ads : []
  const ads: MetaAdRecord[] = rawAds.filter(isRecord).map((ad) => ({
    adId: typeof ad.adId === 'string' ? normalizeText(ad.adId) : '',
    startedAt: typeof ad.startedAt === 'string' ? ad.startedAt : '',
    lastSeenAt: typeof ad.lastSeenAt === 'string' ? ad.lastSeenAt : '',
    status: (ad.status === 'active' || ad.status === 'inactive' || ad.status === 'unknown' ? ad.status : 'unknown') as MetaAdRecord['status'],
    creativeHash: typeof ad.creativeHash === 'string' ? ad.creativeHash.trim().toLocaleLowerCase('en-US') : '',
    ...(typeof ad.landingDomain === 'string' && ad.landingDomain.trim() ? { landingDomain: normalizeText(ad.landingDomain) } : {}),
  })).sort((left, right) => left.adId.localeCompare(right.adId))
  const rawLimitations = Array.isArray(snapshot.limitations) ? snapshot.limitations : []
  const publisher = typeof snapshot.publisher === 'string' ? snapshot.publisher.normalize('NFKC').trim() : ''
  return {
    provider: snapshot.provider === 'meta_ad_library' ? 'meta_ad_library' : 'meta_ad_library',
    snapshotId: normalizedSnapshotId(snapshot.snapshotId),
    publisher,
    publisherIdentity: publisher ? normalizePublisherIdentity(publisher) : '',
    locale: typeof snapshot.locale === 'string' ? normalizeText(snapshot.locale) : '',
    window: { start: typeof rawWindow.start === 'string' ? rawWindow.start : '', end: typeof rawWindow.end === 'string' ? rawWindow.end : '' },
    capturedAt: typeof snapshot.capturedAt === 'string' ? normalizeIsoDateTime(snapshot.capturedAt) ?? snapshot.capturedAt : '',
    sourceHash: typeof snapshot.sourceHash === 'string' ? snapshot.sourceHash.trim().toLocaleLowerCase('en-US') : '',
    ads,
    limitations: rawLimitations.filter((value): value is string => typeof value === 'string').slice().sort(),
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

function addMissingEvidenceForReasons(assessment: MarketSignalAssessment, reasons: readonly RejectionReason[]): void {
  if (reasons.some((reason) => reason === 'MISSING_SOURCE_HASH' || reason === 'INVALID_SOURCE_HASH')) assessment.missingEvidenceTypes.push('source_hash')
  if (reasons.some((reason) => reason === 'MISSING_PUBLISHER')) assessment.missingEvidenceTypes.push('publisher_identity')
  if (reasons.some((reason) => reason === 'LOCALE_MISMATCH')) assessment.missingEvidenceTypes.push('locale_alignment')
  if (reasons.some((reason) => reason === 'INVALID_DATE' || reason === 'WINDOW_MISMATCH' || reason === 'SNAPSHOT_OUTSIDE_WINDOW')) assessment.missingEvidenceTypes.push('observation_window')
  if (reasons.some((reason) => reason === 'KEYWORD_MISMATCH' || reason === 'SCALE_MISMATCH')) assessment.missingEvidenceTypes.push('trend_observations')
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
      googleTrends: request.googleTrends?.map(canonicalTrendSnapshot).sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
      metaAdSnapshots: request.metaAdSnapshots?.map(canonicalMetaSnapshot).sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
    },
    result: { ...final, deterministicFingerprint: undefined },
  }
  return { ...final, deterministicFingerprint: fingerprint(fingerprintInput) }
}

function validateCommonSnapshot(snapshot: Record<string, unknown>, request: MarketSignalRequest): RejectionReason[] {
  const reasons: RejectionReason[] = []
  if (typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId.trim()) reasons.push('MISSING_SNAPSHOT_ID')
  if (typeof snapshot.locale !== 'string' || !snapshot.locale.trim()) reasons.push('MISSING_REQUIRED_FIELD')
  else if (normalizeText(snapshot.locale) !== normalizeText(request.locale)) reasons.push('LOCALE_MISMATCH')
  if (!isRecord(snapshot.window) || !datesValid(snapshot.window as unknown as DateWindow) || typeof snapshot.capturedAt !== 'string' || !isIsoDateTime(snapshot.capturedAt)) reasons.push('INVALID_DATE')
  if (typeof snapshot.sourceHash !== 'string' || !isSha256Hex(snapshot.sourceHash)) reasons.push(typeof snapshot.sourceHash === 'string' && String(snapshot.sourceHash).trim() ? 'INVALID_SOURCE_HASH' : 'MISSING_SOURCE_HASH')
  if (!windowsEqual(snapshot.window, request.window)) reasons.push('WINDOW_MISMATCH')
  return reasons
}

function validateTrendSnapshot(snapshot: unknown, request: MarketSignalRequest): RejectionReason[] {
  if (!isRecord(snapshot)) return ['INVALID_INPUT']
  const reasons = validateCommonSnapshot(snapshot, request)
  const policy = MARKET_SIGNAL_POLICIES.google_trends
  if (snapshot.provider !== 'google_trends') reasons.push('UNKNOWN_PROVIDER')
  if (typeof snapshot.keyword !== 'string' || !snapshot.keyword.trim()) reasons.push('MISSING_REQUIRED_FIELD')
  if (typeof snapshot.scaleKey !== 'string' || !normalizeText(snapshot.scaleKey)) reasons.push('MISSING_REQUIRED_FIELD')
  if (!Array.isArray(snapshot.observations) || snapshot.observations.length === 0) reasons.push('MISSING_REQUIRED_FIELD')
  else if (snapshot.observations.length > policy.maxObservationsPerSnapshot) reasons.push('INVALID_INPUT')
  if (Array.isArray(snapshot.observations)) {
    const seen = new Set<string>()
    snapshot.observations.forEach((observation) => {
      if (!isRecord(observation) || typeof observation.date !== 'string' || typeof observation.value !== 'number') {
        reasons.push('INVALID_INPUT')
        return
      }
      const snapshotWindow = isRecord(snapshot.window) ? snapshot.window as unknown as DateWindow : null
      if (!isIsoDate(observation.date) || !snapshotWindow || !isDateWithinWindow(observation.date, snapshotWindow) || !isDateWithinWindow(observation.date, request.window)) reasons.push('INVALID_DATE')
      if (seen.has(observation.date)) reasons.push('DUPLICATE_OBSERVATION')
      if (!Number.isFinite(observation.value) || observation.value < 0 || observation.value > 100) reasons.push('INVALID_NUMBER')
      seen.add(observation.date)
    })
  }
  return reasons
}

function validateMetaSnapshot(snapshot: unknown, request: MarketSignalRequest): RejectionReason[] {
  if (!isRecord(snapshot)) return ['INVALID_INPUT']
  const reasons = validateCommonSnapshot(snapshot, request)
  const policy = MARKET_SIGNAL_POLICIES.meta_ad_library
  if (snapshot.provider !== 'meta_ad_library') reasons.push('UNKNOWN_PROVIDER')
  if (typeof snapshot.publisher !== 'string' || !snapshot.publisher.trim() || !normalizePublisherIdentity(snapshot.publisher)) reasons.push('MISSING_PUBLISHER')
  if (typeof snapshot.publisherIdentity !== 'string' || !snapshot.publisherIdentity.trim() || (typeof snapshot.publisher === 'string' && normalizeText(snapshot.publisherIdentity) !== normalizePublisherIdentity(snapshot.publisher))) reasons.push('MISSING_PUBLISHER')
  if (!Array.isArray(snapshot.ads)) reasons.push('INVALID_INPUT')
  else if (snapshot.ads.length > policy.maxAdsPerSnapshot) reasons.push('INVALID_INPUT')
  if (Array.isArray(snapshot.ads)) {
    const seen = new Set<string>()
    snapshot.ads.forEach((ad) => {
      if (!isRecord(ad)) {
        reasons.push('INVALID_INPUT')
        return
      }
      const adId = typeof ad.adId === 'string' ? normalizeText(ad.adId) : ''
      if (!adId) reasons.push('MISSING_AD_ID')
      if (seen.has(adId)) reasons.push('DUPLICATE_AD_ID')
      const startedAt = typeof ad.startedAt === 'string' ? ad.startedAt : ''
      const lastSeenAt = typeof ad.lastSeenAt === 'string' ? ad.lastSeenAt : ''
      if (!isIsoDate(startedAt) || !isIsoDate(lastSeenAt) || startedAt > lastSeenAt) reasons.push('INVALID_DATE')
      const snapshotWindow = isRecord(snapshot.window) ? snapshot.window as unknown as DateWindow : null
      if (isIsoDate(startedAt) && isIsoDate(lastSeenAt) && (!snapshotWindow || lastSeenAt < snapshotWindow.start || startedAt > snapshotWindow.end || lastSeenAt < request.window.start || startedAt > request.window.end)) reasons.push('SNAPSHOT_OUTSIDE_WINDOW')
      if (!['active', 'inactive', 'unknown'].includes(ad.status as string)) reasons.push('UNKNOWN_STATUS')
      if (typeof ad.creativeHash !== 'string' || !isSha256Hex(ad.creativeHash)) reasons.push(typeof ad.creativeHash === 'string' && String(ad.creativeHash).trim() ? 'INVALID_SOURCE_HASH' : 'MISSING_REQUIRED_FIELD')
      seen.add(adId)
    })
  }
  if (reasons.length === 0) {
    try {
      const canonicalInput = {
        provider: 'meta_ad_library' as const,
        snapshotId: String(snapshot.snapshotId),
        publisher: String(snapshot.publisher),
        locale: String(snapshot.locale),
        window: snapshot.window as unknown as DateWindow,
        capturedAt: String(snapshot.capturedAt),
        sourceHash: String(snapshot.sourceHash),
        ads: snapshot.ads as MetaAdRecord[],
      }
      if (canonicalInput.sourceHash.trim().toLocaleLowerCase('en-US') !== metaSnapshotSourceHash(canonicalInput)) reasons.push('INVALID_SOURCE_HASH')
    } catch {
      reasons.push('INVALID_INPUT')
    }
  }
  return reasons
}

export function assessMarketSignal(input: unknown): MarketSignalAssessment {
  const request = normalizeRequest(input)
  const assessment = baseAssessment(request)
  const requestErrors: RejectionReason[] = []
  if (!request.requestId || request.requestId.length > MAX_REQUEST_ID_LENGTH) requestErrors.push('INVALID_INPUT')
  if (!datesValid(request.window)) requestErrors.push('INVALID_DATE')
  if (!request.locale.trim()) requestErrors.push('MISSING_REQUIRED_FIELD')
  if (isRecord(input)) {
    if (input.googleTrends !== undefined && !Array.isArray(input.googleTrends)) requestErrors.push('INVALID_INPUT')
    if (input.metaAdSnapshots !== undefined && !Array.isArray(input.metaAdSnapshots)) requestErrors.push('INVALID_INPUT')
  }
  const expectedProvider = providerForSignalKind(request.signalKind)
  if (!expectedProvider) requestErrors.push('UNKNOWN_SIGNAL_KIND')
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

  if (expectedProvider === 'google_trends') {
    const snapshots = (request.googleTrends ?? []).slice().sort((left, right) => normalizedSnapshotId(left?.snapshotId).localeCompare(normalizedSnapshotId(right?.snapshotId)))
    if (snapshots.length === 0) {
      assessment.missingEvidenceTypes.push('trend_observations')
      return finalizeAssessment(request, assessment)
    }
    const policy = MARKET_SIGNAL_POLICIES.google_trends
    const seenSnapshotIds = new Set<string>()
    let referenceKeyword: string | null = null
    let referenceScale: string | null = null
    snapshots.forEach((snapshot, index) => {
      const reasons = validateTrendSnapshot(snapshot, request)
      const snapshotId = normalizedSnapshotId(isRecord(snapshot) ? snapshot.snapshotId : '')
      const keyword = isRecord(snapshot) && typeof snapshot.keyword === 'string' ? normalizeKeyword(snapshot.keyword) : ''
      const scale = isRecord(snapshot) && typeof snapshot.scaleKey === 'string' ? normalizeText(snapshot.scaleKey) : ''
      if (seenSnapshotIds.has(snapshotId)) reasons.push('DUPLICATE_SNAPSHOT_ID')
      seenSnapshotIds.add(snapshotId)
      if (referenceKeyword === null) referenceKeyword = keyword
      else if (keyword.length > 0 && referenceKeyword !== keyword) reasons.push('KEYWORD_MISMATCH')
      if (referenceScale === null) referenceScale = scale
      else if (referenceScale.length > 0 && scale.length > 0 && referenceScale !== scale) reasons.push('SCALE_MISMATCH')
      if (index >= policy.maxSnapshots) reasons.push('INVALID_INPUT')
      if (reasons.length > 0) {
        assessment.rejectedSnapshotIds.push(snapshotId)
        assessment.rejectionReasons.push(...reasons)
        assessment.acceptedSnapshotIds = assessment.acceptedSnapshotIds.filter((acceptedId) => acceptedId !== snapshotId)
        addMissingEvidenceForReasons(assessment, reasons)
      } else {
        assessment.acceptedSnapshotIds.push(snapshotId)
      }
    })
    const acceptedSnapshots = snapshots.filter((snapshot) => assessment.acceptedSnapshotIds.includes(normalizedSnapshotId(snapshot?.snapshotId))).slice(0, policy.maxSnapshots).map(canonicalTrendSnapshot)
    assessment.trendMetrics = calculateTrendMetrics(acceptedSnapshots)
    const alignmentConflict = assessment.rejectionReasons.some((reason) => reason === 'KEYWORD_MISMATCH' || reason === 'SCALE_MISMATCH')
    if (acceptedSnapshots.length === 0) {
      assessment.status = 'rejected'
      assessment.missingEvidenceTypes.push('trend_observations')
    } else if (alignmentConflict) {
      assessment.status = 'not_ready'
      assessment.missingEvidenceTypes.push('trend_observations')
      assessment.limitations.push('Google Trends snapshots 的 keyword 或 normalization scale 不一致；不得以部分輸入宣告 ready。')
    } else if (!assessment.trendMetrics || assessment.trendMetrics.pointCount < MIN_TREND_OBSERVATIONS) {
      assessment.status = 'not_ready'
      assessment.missingEvidenceTypes.push('trend_observations')
      assessment.limitations.push('目前有效 observation 不足以形成方向性比較；不得從單點或單日讀值推導市場趨勢。')
    } else {
      assessment.status = 'ready'
    }
    assessment.limitations.push(...acceptedSnapshots.flatMap((snapshot) => snapshot.limitations))
  } else {
    const snapshots = (request.metaAdSnapshots ?? []).slice().sort((left, right) => normalizedSnapshotId(left?.snapshotId).localeCompare(normalizedSnapshotId(right?.snapshotId)))
    if (snapshots.length === 0) {
      assessment.missingEvidenceTypes.push('meta_snapshot')
      return finalizeAssessment(request, assessment)
    }
    const policy = MARKET_SIGNAL_POLICIES.meta_ad_library
    const seenSnapshotIds = new Set<string>()
    snapshots.forEach((snapshot, index) => {
      const reasons = validateMetaSnapshot(snapshot, request)
      const snapshotId = normalizedSnapshotId(isRecord(snapshot) ? snapshot.snapshotId : '')
      if (seenSnapshotIds.has(snapshotId)) reasons.push('DUPLICATE_SNAPSHOT_ID')
      seenSnapshotIds.add(snapshotId)
      if (index >= policy.maxSnapshots) reasons.push('INVALID_INPUT')
      if (reasons.length > 0) {
        assessment.rejectedSnapshotIds.push(snapshotId)
        assessment.rejectionReasons.push(...reasons)
        assessment.acceptedSnapshotIds = assessment.acceptedSnapshotIds.filter((acceptedId) => acceptedId !== snapshotId)
        addMissingEvidenceForReasons(assessment, reasons)
      } else {
        assessment.acceptedSnapshotIds.push(snapshotId)
      }
    })
    const acceptedSnapshots = snapshots.filter((snapshot) => assessment.acceptedSnapshotIds.includes(normalizedSnapshotId(snapshot?.snapshotId))).slice(0, policy.maxSnapshots).map(canonicalMetaSnapshot)
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
