import {
  AUTHORITY_POLICY_LIMITATIONS,
  AUTHORITY_POLICY_VERSION,
  AUTHORITY_REVIEW_LIMITATIONS,
  AUTHORITY_TIER_BY_SOURCE_TYPE,
  AUTHORITY_TIER_ORDER,
  HIGH_RISK_AUTHORITY_SECTORS,
} from './policy-catalog'
import {
  authoritySourceHash,
  isAuthorityPurpose,
  normalizeAuthorityComparison,
  normalizeAuthorityDateTime,
  normalizeAuthorityDomain,
  normalizeAuthoritySourceCandidate,
  normalizeAuthoritySourceUrl,
  normalizeAuthorityText,
  normalizeAuthorityTopicList,
  sha256Authority,
  stableAuthorityStringify,
  validateAuthoritySourceCandidate,
} from './normalization'
import {
  authorityDecisionStatuses,
  authorityPurposes,
  authoritySourceTypes,
  type AuthorityPolicyDecision,
  type AuthorityPolicyRequest,
  type AuthoritySelectionResult,
  type AuthoritySourceCandidate,
  type AuthoritySourceSelectionRequest,
  type AuthorityTier,
} from './types'

const STATUS_ORDER: readonly AuthorityPolicyDecision['status'][] = ['approved', 'review_required', 'not_ready', 'blocked']
const MAX_CANDIDATES = 50
const MIN_MAX_SELECTED = 1
const MAX_MAX_SELECTED = 10
const HIGH_RISK_SET = new Set<string>(HIGH_RISK_AUTHORITY_SECTORS)
const TIER_INDEX = new Map(AUTHORITY_TIER_ORDER.map((tier, index) => [tier, index]))

function isArxivDomain(domain: string): boolean {
  return domain === 'arxiv.org' || domain.endsWith('.arxiv.org')
}

const SOURCE_ALLOWED_PURPOSES: Record<Exclude<AuthorityTier, 'ineligible'>, readonly (typeof authorityPurposes[number])[]> = {
  primary: ['research_reference', 'content_citation', 'evidence_support', 'model_evaluation'],
  high: ['research_reference', 'content_citation', 'evidence_support', 'model_evaluation'],
  contextual: ['research_reference', 'content_citation', 'model_evaluation'],
  weak: ['research_reference', 'content_citation'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? normalizeAuthorityText(value).slice(0, 256) : ''
}

function safeHash(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value.trim()) ? value.trim().toLocaleLowerCase('en-US') : ''
}

function safeStringList(value: unknown): string[] {
  return Array.isArray(value) ? uniqueSorted(value.filter((item): item is string => typeof item === 'string').map(normalizeAuthorityComparison)) : []
}

function requestContext(input: unknown): Omit<AuthorityPolicyRequest, 'candidate'> | null {
  if (!isRecord(input)) return null
  const purpose = input.purpose
  const clientSector = typeof input.clientSector === 'string' ? normalizeAuthorityComparison(input.clientSector) : ''
  const contentTopics = normalizeAuthorityTopicList(input.contentTopics)
  const targetLocale = input.targetLocale
  const targetJurisdiction = input.targetJurisdiction === null ? null : typeof input.targetJurisdiction === 'string' ? normalizeAuthorityComparison(input.targetJurisdiction) : ''
  const workflowMode = input.workflowMode
  const asOf = normalizeAuthorityDateTime(input.asOf)
  if (!isAuthorityPurpose(purpose) || !clientSector || !Array.isArray(input.contentTopics) || input.contentTopics.length === 0 || contentTopics.length !== input.contentTopics.length || (targetLocale !== 'en' && targetLocale !== 'zh-hant') || input.targetJurisdiction !== null && !targetJurisdiction || (workflowMode !== 'manual_review' && workflowMode !== 'automated_ingestion') || !asOf) return null
  return { purpose, clientSector, contentTopics, targetLocale, targetJurisdiction, workflowMode, asOf }
}

function sourceTypeFromInput(input: unknown): AuthoritySourceCandidate['sourceType'] | null {
  if (!isRecord(input) || typeof input.sourceType !== 'string') return null
  return (authoritySourceTypes as readonly string[]).includes(input.sourceType) ? input.sourceType as AuthoritySourceCandidate['sourceType'] : null
}

function tierForSource(input: unknown): AuthorityTier {
  const sourceType = sourceTypeFromInput(input)
  return sourceType ? AUTHORITY_TIER_BY_SOURCE_TYPE[sourceType] : 'ineligible'
}

function matchedValues(candidate: AuthoritySourceCandidate | null, context: Omit<AuthorityPolicyRequest, 'candidate'> | null): { sectors: string[]; topics: string[] } {
  if (!candidate || !context) return { sectors: [], topics: [] }
  const sectors = candidate.sectors.filter((sector) => sector === context.clientSector)
  const topics = candidate.topics.filter((topic) => context.contentTopics.includes(topic))
  return { sectors: uniqueSorted(sectors), topics: uniqueSorted(topics) }
}

function isHighRiskSector(value: string): boolean {
  return HIGH_RISK_SET.has(normalizeAuthorityComparison(value))
}

function allowedPurposesFor(candidate: AuthoritySourceCandidate | null, requestedPurpose: unknown): Array<typeof authorityPurposes[number]> {
  if (!candidate || !isAuthorityPurpose(requestedPurpose) || requestedPurpose === 'model_training') return []
  const tier = AUTHORITY_TIER_BY_SOURCE_TYPE[candidate.sourceType]
  if (tier === 'ineligible') return []
  const tierPurposes = SOURCE_ALLOWED_PURPOSES[tier]
  if (candidate.termsStatus === 'unknown') return []
  if (candidate.termsStatus === 'allows_research') return tierPurposes.filter((purpose) => purpose === 'research_reference' || purpose === 'model_evaluation') as Array<typeof authorityPurposes[number]>
  if (candidate.termsStatus === 'allows_citation') return tierPurposes.filter((purpose) => purpose === 'content_citation' || purpose === 'evidence_support') as Array<typeof authorityPurposes[number]>
  if (candidate.termsStatus === 'prohibits_automation') return [...tierPurposes]
  return [...tierPurposes]
}

function decisionLimitations(candidate: AuthoritySourceCandidate | null, context: Omit<AuthorityPolicyRequest, 'candidate'> | null, matchedTopics: string[]): string[] {
  const limitations: string[] = [...AUTHORITY_POLICY_LIMITATIONS]
  if (candidate?.sourceType === 'preprint_repository' || (candidate?.publisherDomain ? isArxivDomain(candidate.publisherDomain) : false)) limitations.push('preprint_not_peer_reviewed')
  if (candidate && context && matchedTopics.length === 0) limitations.push('來源沒有與目標 contentTopics 的直接相符項目。')
  if (candidate?.copyrightRisk === 'high' || candidate?.copyrightRisk === 'unreviewed') limitations.push('著作權風險 metadata 尚未達到自動核准所需的確定性。')
  if (candidate?.piiStatus === 'possible' || candidate?.piiStatus === 'unreviewed') limitations.push('來源可能含有個人資料；使用前需要人工確認。')
  if (context?.targetJurisdiction && candidate?.jurisdiction !== context.targetJurisdiction) limitations.push(AUTHORITY_REVIEW_LIMITATIONS.jurisdiction)
  return uniqueSorted(limitations)
}

function decisionFingerprint(input: { context: Omit<AuthorityPolicyRequest, 'candidate'> | null; candidate: AuthoritySourceCandidate | null; status: AuthorityPolicyDecision['status']; authorityTier: AuthorityTier; allowedPurposes: string[]; matchedSectors: string[]; matchedTopics: string[]; reasonCodes: string[]; limitations: string[]; sourceId: string; sourceHash: string }): string {
  return sha256Authority(stableAuthorityStringify({
    policyVersion: AUTHORITY_POLICY_VERSION,
    context: input.context,
    candidate: input.candidate,
    status: input.status,
    authorityTier: input.authorityTier,
    allowedPurposes: input.allowedPurposes,
    matchedSectors: input.matchedSectors,
    matchedTopics: input.matchedTopics,
    reasonCodes: input.reasonCodes,
    limitations: input.limitations,
    sourceId: input.sourceId,
    sourceHash: input.sourceHash,
  }))
}

function buildDecision(input: unknown, context: Omit<AuthorityPolicyRequest, 'candidate'> | null, reasonCodes: string[], status: AuthorityPolicyDecision['status'], candidate: AuthoritySourceCandidate | null = null): AuthorityPolicyDecision {
  const sourceId = candidate?.sourceId ?? (isRecord(input) ? safeString(input.sourceId) : '')
  const sourceHash = candidate?.sourceHash ?? (isRecord(input) ? safeHash(input.sourceHash) : '')
  const matched = matchedValues(candidate, context)
  const authorityTier = candidate ? AUTHORITY_TIER_BY_SOURCE_TYPE[candidate.sourceType] : tierForSource(input)
  const allowedPurposes = allowedPurposesFor(candidate, context?.purpose)
  const finalAllowedPurposes = status === 'approved' ? allowedPurposes : []
  const limitations = decisionLimitations(candidate, context, matched.topics)
  const normalizedReasonCodes = uniqueSorted(reasonCodes)
  const fingerprint = decisionFingerprint({ context, candidate, status, authorityTier, allowedPurposes: finalAllowedPurposes, matchedSectors: matched.sectors, matchedTopics: matched.topics, reasonCodes: normalizedReasonCodes, limitations, sourceId, sourceHash })
  return {
    status,
    authorityTier,
    allowedPurposes: finalAllowedPurposes,
    matchedSectors: matched.sectors,
    matchedTopics: matched.topics,
    reasonCodes: normalizedReasonCodes,
    limitations,
    policyVersion: AUTHORITY_POLICY_VERSION,
    sourceId,
    sourceHash,
    decisionFingerprint: fingerprint,
  }
}

export function evaluateAuthoritySource(input: unknown): AuthorityPolicyDecision {
  try {
    const context = requestContext(input)
    const rawCandidate = isRecord(input) ? input.candidate : null
    const validation = validateAuthoritySourceCandidate(rawCandidate, context?.asOf ?? null)
    const candidate = validation.candidate
    const reasonCodes = [...validation.reasonCodes]
    if (!context) reasonCodes.push('INVALID_INPUT')

    if (candidate && context) {
      const matched = matchedValues(candidate, context)
      const relevant = matched.sectors.length > 0 || matched.topics.length > 0
      if (!relevant) reasonCodes.push('NO_RELEVANCE_MATCH')
      if (candidate.copyrightRisk === 'blocked') reasonCodes.push('COPYRIGHT_BLOCKED')
      if (candidate.piiStatus === 'restricted') reasonCodes.push('PII_RESTRICTED')
      if (context.purpose === 'model_training') reasonCodes.push('MODEL_TRAINING_NOT_SUPPORTED_V1')
      if (context.workflowMode === 'automated_ingestion' && candidate.termsStatus === 'prohibits_automation') reasonCodes.push('AUTOMATION_PROHIBITED')
      if (context.workflowMode === 'automated_ingestion' && candidate.robotsStatus === 'reviewed_restrict') reasonCodes.push('ROBOTS_RESTRICT_AUTOMATION')
      if (candidate.licenceStatus === 'unknown' || candidate.licenceStatus === 'verified_restricted') reasonCodes.push('LICENCE_REVIEW_REQUIRED')
      if (candidate.termsStatus === 'unknown') reasonCodes.push('TERMS_REVIEW_REQUIRED')
      if (!allowedPurposesFor(candidate, context.purpose).includes(context.purpose)) reasonCodes.push('PURPOSE_REVIEW_REQUIRED')
      if (candidate.copyrightRisk === 'high' || candidate.copyrightRisk === 'unreviewed') reasonCodes.push('COPYRIGHT_REVIEW_REQUIRED')
      if (candidate.piiStatus === 'possible' || candidate.piiStatus === 'unreviewed') reasonCodes.push('PII_REVIEW_REQUIRED')
      if ((context.workflowMode === 'automated_ingestion' && candidate.robotsStatus === 'unreviewed') || (context.workflowMode === 'manual_review' && candidate.robotsStatus === 'reviewed_restrict')) reasonCodes.push('ROBOTS_REVIEW_REQUIRED')
      if (candidate.sourceType === 'preprint_repository' && isHighRiskSector(context.clientSector) && (context.purpose === 'content_citation' || context.purpose === 'evidence_support')) reasonCodes.push('PREPRINT_REQUIRES_EXPERT_REVIEW')
      if ((candidate.sourceType === 'commercial_blog' || candidate.sourceType === 'community' || candidate.sourceType === 'social') && context.purpose === 'evidence_support') reasonCodes.push('WEAK_SOURCE_FOR_EVIDENCE')
      if (context.targetJurisdiction && candidate.jurisdiction !== context.targetJurisdiction && (context.purpose === 'content_citation' || context.purpose === 'evidence_support')) reasonCodes.push('JURISDICTION_REVIEW_REQUIRED')
      if ((context.purpose === 'content_citation' || context.purpose === 'evidence_support') && !candidate.publishedAt && !candidate.updatedAt) reasonCodes.push('RECENCY_REVIEW_REQUIRED')
      if (isArxivDomain(candidate.publisherDomain) && candidate.sourceType !== 'preprint_repository') reasonCodes.push('ARXIV_SOURCE_TYPE_REQUIRED')
      if (candidate.locale !== 'multilingual' && candidate.locale !== context.targetLocale) reasonCodes.push('LOCALE_REVIEW_REQUIRED')
    }

    const blockedCodes = new Set([
      'INVALID_INPUT',
      'INVALID_SOURCE_URL',
      'SOURCE_DOMAIN_MISMATCH',
      'INVALID_SOURCE_HASH',
      'SOURCE_HASH_MISMATCH',
      'COPYRIGHT_BLOCKED',
      'PII_RESTRICTED',
      'MODEL_TRAINING_NOT_SUPPORTED_V1',
      'AUTOMATION_PROHIBITED',
      'ROBOTS_RESTRICT_AUTOMATION',
      'NO_RELEVANCE_MATCH',
      'ARXIV_SOURCE_TYPE_REQUIRED',
    ])
    const hasBlocked = reasonCodes.some((code) => blockedCodes.has(code))
    const reviewCodes = new Set([
      'LICENCE_REVIEW_REQUIRED',
      'TERMS_REVIEW_REQUIRED',
      'COPYRIGHT_REVIEW_REQUIRED',
      'PII_REVIEW_REQUIRED',
      'ROBOTS_REVIEW_REQUIRED',
      'PREPRINT_REQUIRES_EXPERT_REVIEW',
      'WEAK_SOURCE_FOR_EVIDENCE',
      'JURISDICTION_REVIEW_REQUIRED',
      'RECENCY_REVIEW_REQUIRED',
      'LOCALE_REVIEW_REQUIRED',
      'PURPOSE_REVIEW_REQUIRED',
    ])
    const hasReview = reasonCodes.some((code) => reviewCodes.has(code))
    const status: AuthorityPolicyDecision['status'] = hasBlocked ? 'blocked' : hasReview ? 'review_required' : candidate && context ? 'approved' : 'blocked'
    return buildDecision(rawCandidate, context, reasonCodes, status, candidate)
  } catch {
    return buildDecision(null, null, ['INVALID_INPUT'], 'blocked')
  }
}

function selectionContext(input: unknown): Omit<AuthoritySourceSelectionRequest, 'candidates' | 'maxSelected'> | null {
  if (!isRecord(input)) return null
  return requestContext(input)
}

function candidateSortKey(candidate: unknown): string {
  if (!isRecord(candidate)) return '0|'
  const sourceId = safeString(candidate.sourceId).toLocaleLowerCase('en-US')
  const sourceHash = safeHash(candidate.sourceHash)
  const sourceUrl = normalizeAuthoritySourceUrl(candidate.sourceUrl) ?? ''
  return `${sourceId}|${sourceHash}|${sourceUrl}|${stableAuthorityStringify(candidate)}`
}

function compareDecisions(left: AuthorityPolicyDecision, right: AuthorityPolicyDecision): number {
  const statusDifference = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status)
  if (statusDifference !== 0) return statusDifference
  const leftTier = TIER_INDEX.get(left.authorityTier) ?? AUTHORITY_TIER_ORDER.length
  const rightTier = TIER_INDEX.get(right.authorityTier) ?? AUTHORITY_TIER_ORDER.length
  if (leftTier !== rightTier) return leftTier - rightTier
  const topicDifference = right.matchedTopics.length - left.matchedTopics.length
  if (topicDifference !== 0) return topicDifference
  return left.sourceId.localeCompare(right.sourceId)
}

function duplicateDecision(decision: AuthorityPolicyDecision): AuthorityPolicyDecision {
  const reasonCodes = uniqueSorted([...decision.reasonCodes, 'DUPLICATE_SOURCE'])
  const limitations = uniqueSorted([...decision.limitations, AUTHORITY_REVIEW_LIMITATIONS.duplicate])
  const nextStatus: AuthorityPolicyDecision['status'] = 'blocked'
  return { ...decision, status: nextStatus, allowedPurposes: [], reasonCodes, limitations, decisionFingerprint: decisionFingerprint({ context: null, candidate: null, status: nextStatus, authorityTier: decision.authorityTier, allowedPurposes: [], matchedSectors: decision.matchedSectors, matchedTopics: decision.matchedTopics, reasonCodes, limitations, sourceId: decision.sourceId, sourceHash: decision.sourceHash }) }
}

function selectionFingerprint(context: Omit<AuthoritySourceSelectionRequest, 'candidates' | 'maxSelected'> | null, maxSelected: number, ordered: readonly AuthorityPolicyDecision[]): string {
  return sha256Authority(stableAuthorityStringify({
    policyVersion: AUTHORITY_POLICY_VERSION,
    request: context,
    maxSelected,
    decisionFingerprints: ordered.map((decision) => decision.decisionFingerprint),
  }))
}

export function selectAuthoritySources(input: unknown): AuthoritySelectionResult {
  try {
    const record = isRecord(input) ? input : null
    const context = selectionContext(input)
    const candidates = record && Array.isArray(record.candidates) ? record.candidates : null
    const maxSelected = record && typeof record.maxSelected === 'number' && Number.isInteger(record.maxSelected) ? record.maxSelected : 0
    const baseLimitations = [...AUTHORITY_POLICY_LIMITATIONS]
    if (!context || !candidates || maxSelected < MIN_MAX_SELECTED || maxSelected > MAX_MAX_SELECTED) {
      const limitations = uniqueSorted([...baseLimitations, 'selection_request_invalid'])
      return { status: 'rejected', selected: [], reviewRequired: [], blocked: [], limitations, policyVersion: AUTHORITY_POLICY_VERSION, selectionFingerprint: selectionFingerprint(context, maxSelected, []) }
    }

    if (candidates.length > MAX_CANDIDATES) {
      const limitations: string[] = [...baseLimitations, 'MAX_CANDIDATES_EXCEEDED']
      return { status: 'rejected', selected: [], reviewRequired: [], blocked: [], limitations: uniqueSorted(limitations), policyVersion: AUTHORITY_POLICY_VERSION, selectionFingerprint: selectionFingerprint(context, maxSelected, []) }
    }

    const orderedInputs = candidates.slice().sort((left, right) => candidateSortKey(left).localeCompare(candidateSortKey(right)))
    const decisions: AuthorityPolicyDecision[] = []
    const seenIds = new Set<string>()
    const seenHashes = new Set<string>()
    for (const candidate of orderedInputs) {
      const decision = evaluateAuthoritySource({ ...context, candidate })
      const normalizedDecisionId = normalizeAuthorityComparison(decision.sourceId)
      const duplicate = (normalizedDecisionId && seenIds.has(normalizedDecisionId)) || (decision.sourceHash && seenHashes.has(decision.sourceHash))
      const finalDecision = duplicate ? duplicateDecision(decision) : decision
      decisions.push(finalDecision)
      if (normalizedDecisionId) seenIds.add(normalizedDecisionId)
      if (decision.sourceHash) seenHashes.add(decision.sourceHash)
    }

    const sortedDecisions = decisions.slice().sort(compareDecisions)
    const selected = sortedDecisions.filter((decision) => decision.status === 'approved').slice(0, maxSelected)
    const reviewRequired = sortedDecisions.filter((decision) => decision.status === 'review_required' || decision.status === 'not_ready')
    const blocked = sortedDecisions.filter((decision) => decision.status === 'blocked')
    const limitations: string[] = [...baseLimitations]
    if (selected.length < Math.min(maxSelected, candidates.length)) limitations.push(AUTHORITY_REVIEW_LIMITATIONS.insufficientApproved)
    if (decisions.some((decision) => decision.reasonCodes.includes('DUPLICATE_SOURCE'))) limitations.push(AUTHORITY_REVIEW_LIMITATIONS.duplicate)
    if (blocked.length > 0) limitations.push('一個或多個候選來源未通過本 V1 的 fail-closed 規則。')
    const status: AuthoritySelectionResult['status'] = candidates.length > MAX_CANDIDATES ? 'rejected' : selected.length > 0 ? (reviewRequired.length > 0 || blocked.length > 0 ? 'not_ready' : 'ready') : reviewRequired.length > 0 ? 'not_ready' : 'rejected'
    return { status, selected, reviewRequired, blocked, limitations: uniqueSorted(limitations), policyVersion: AUTHORITY_POLICY_VERSION, selectionFingerprint: selectionFingerprint(context, maxSelected, sortedDecisions) }
  } catch {
    return { status: 'rejected', selected: [], reviewRequired: [], blocked: [], limitations: [...AUTHORITY_POLICY_LIMITATIONS, 'selection_request_invalid'], policyVersion: AUTHORITY_POLICY_VERSION, selectionFingerprint: selectionFingerprint(null, 0, []) }
  }
}

export function isAuthorityPolicyEnginePure(): boolean {
  return authoritySourceHash({}) === '' && authorityDecisionStatuses.length === 4
}
