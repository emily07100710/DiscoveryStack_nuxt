import { createHash } from 'node:crypto'

export const BALANCED_AUTOPILOT_POLICY_VERSION = 'balanced-autopilot-policy-v1' as const
export const BALANCED_AUTOPILOT_ENGINE_VERSION = 'balanced-autopilot-decision-engine-v1' as const

export type AutopilotMode = 'balanced' | 'aggressive_growth' | 'conservative_brand'
export type AutopilotAction = 'publish' | 'repair' | 'substitute' | 'skip' | 'hard_block'
export type AutopilotRiskClass = 'low' | 'general' | 'high'

export type EntityStrategyProfile = {
  canonicalBrandName: string
  brandAliases: string[]
  canonicalWebsiteOrigin: string
  businessType: string
  primaryLocale: string
  secondaryLocales: string[]
  primaryLocations: string[]
  serviceAreas: string[]
  primaryServices: string[]
  secondaryServices: string[]
  targetAudience: string[]
  primaryQueryClusters: string[]
  supportingQueryClusters: string[]
  canonicalPillarPages: string[]
  servicePageBindings: Record<string, string>
  approvedBrandFacts: string[]
  approvedDifferentiators: string[]
  prohibitedClaims: string[]
  preferredTone: string
  requiredDisclosures: string[]
  internalLinkPolicy: string
  structuredDataIdentity: Record<string, string>
  evidenceSnapshotHash: string
  profileFingerprint: string
  version: number
  status: 'active' | 'revoked'
  effectiveAt: string
  revokedAt: string | null
}

export type QueryOwnership = {
  ownerPageId: string
  normalizedQuery: string
  queryCluster: string
  supportingArticleIds: string[]
  evidenceSnapshotHash: string
  fingerprint: string
  status: 'active' | 'revoked'
}

export type AutopilotPolicySnapshot = {
  policyId: string
  policyVersion: string
  ownerUserId: number
  clientId: number
  websiteId: string
  mode: AutopilotMode
  status: 'enabled' | 'paused' | 'revoked'
  allowedContentTypes: string[]
  allowedLocales: string[]
  allowedDestinations: string[]
  allowedCadences: number[]
  allowedRiskClasses: AutopilotRiskClass[]
  entityStrategyProfileId: string
  maximumRepairAttempts: number
  maximumTopicSubstitutions: number
  generationBudget: number
  publicationBudget: number
  configurationFingerprint: string
  activatedAt: string
  expiresAt: string | null
  revokedAt: string | null
}

export type BalancedAutopilotInput = {
  policy: AutopilotPolicySnapshot | null | undefined
  candidateId: string
  contentType: string
  locale: string
  destinationId: string
  cadenceDays: number
  riskClass: AutopilotRiskClass
  qualityStatus: 'passed' | 'needs_repair' | 'blocked'
  reasonCodes: string[]
  contentHash: string
  evidenceSnapshotHash: string
  evidenceStatus: 'approved_fresh' | 'stale' | 'missing' | 'revoked'
  providerProvenanceComplete?: boolean
  targetIdentityVerified: boolean
  lineageVerified: boolean
  repairAttempts: number
  topicSubstitutions: number
  candidateSafeTopics: string[]
  entityProfile?: EntityStrategyProfile | null
  queryOwnership?: QueryOwnership | null
  contentText?: string
  primaryQuery?: string | null
  now: Date
}

export type RepairInstruction = {
  code: string
  instruction: string
  locations: string[]
  severity: 'soft' | 'high'
}

export type BalancedAutopilotDecision = {
  engineVersion: typeof BALANCED_AUTOPILOT_ENGINE_VERSION
  action: AutopilotAction
  code: string
  reasons: string[]
  repairInstructions: RepairInstruction[]
  nextTopic: string | null
  machineAuthorized: boolean
  policyId: string | null
  policyVersion: string | null
  decisionFingerprint: string
}

export type RepairContract = {
  contractVersion: 'repair-contract-v1'
  originalDraftId: string
  originalContentHash: string
  repairAttempt: number
  reasonCodes: string[]
  failingMetrics: Record<string, number | string | null>
  evidenceDeficiencies: string[]
  entityCoverageDeficiencies: string[]
  prohibitedClaimLocations: string[]
  citationDeficiencies: string[]
  keywordStuffingLocations: string[]
  internalLinkDeficiencies: string[]
  requestedRepairs: RepairInstruction[]
  providerModel: string | null
  parentLineage: { candidateId: string; evidenceSnapshotHash: string; contentHash: string }
  repairedDraftId: string | null
  repairedContentHash: string | null
  repairFingerprint: string
  createdAt: string
}

export type MachineAuthorization = {
  authorizationVersion: 'machine-authorization-v1'
  authorizationId: string
  policy: { policyId: string; policyVersion: string; configurationFingerprint: string; ownerUserId: number; clientId: number; websiteId: string; mode: AutopilotMode }
  candidate: { candidateId: string; contentHash: string; contentType: string; locale: string }
  evidence: { snapshotHash: string; status: 'approved_fresh'; capturedAt: string }
  risk: { class: AutopilotRiskClass; reasonCodes: string[] }
  quality: { status: 'passed'; reasonCodes: string[]; engineVersion: string }
  content: { draftId: string; contentHash: string; providerModel: string; repairAttempts: number; substitutionCount: number }
  target: { websiteId: string; destinationId: string; identityVerified: true }
  decision: { action: 'publish'; decidedAt: string; decisionFingerprint: string }
  authorizationFingerprint: string
}

const SOFT_REASON_INSTRUCTIONS: Record<string, RepairInstruction> = {
  BRAND_MISSING: { code: 'BRAND_MISSING', instruction: '自然識別一次 canonical brand name；不要以 exact phrase 重複填塞。', locations: ['title_or_intro'], severity: 'soft' },
  LOCATION_MISSING: { code: 'LOCATION_MISSING', instruction: '在與 query 相關的段落自然補充已核准服務地區。', locations: ['intro_or_service_section'], severity: 'soft' },
  SERVICE_MISSING: { code: 'SERVICE_MISSING', instruction: '清楚說明已核准的服務 entity 與適用對象。', locations: ['intro_or_service_section'], severity: 'soft' },
  DIRECT_ANSWER_MISSING: { code: 'DIRECT_ANSWER_MISSING', instruction: '將核心問題的直接、有限定回答移至開頭。', locations: ['intro'], severity: 'soft' },
  CONTENT_TOPIC_MISMATCH: { code: 'CONTENT_TOPIC_MISMATCH', instruction: '使 title、H1、intro 與 primary query cluster 對齊；不要硬塞不相關 query。', locations: ['title_h1_intro'], severity: 'soft' },
  CONTENT_LENGTH_OUT_OF_BOUNDS: { code: 'CONTENT_LENGTH_OUT_OF_BOUNDS', instruction: '依 content type 與 locale 調整內容長度，保留獨立使用價值。', locations: ['body'], severity: 'soft' },
  FAQ_INCOMPLETE: { code: 'FAQ_INCOMPLETE', instruction: '補足可由 approved evidence 支持的 FAQ question/answer pairs。', locations: ['faq'], severity: 'soft' },
  CITATION_INCOMPLETE: { code: 'CITATION_INCOMPLETE', instruction: '將可用 approved evidence 綁定到相應 factual claims，移除未使用或錯誤 citation。', locations: ['claims_and_citations'], severity: 'soft' },
  INTERNAL_LINK_MISSING: { code: 'INTERNAL_LINK_MISSING', instruction: '補上指向正確 canonical pillar/service page 的自然 internal link。', locations: ['body'], severity: 'soft' },
  STRUCTURED_DATA_INCOMPLETE: { code: 'STRUCTURED_DATA_INCOMPLETE', instruction: '使用同一個已核准 structured data identity 補齊安全欄位。', locations: ['structured_data'], severity: 'soft' },
  BRAND_TONE_INCONSISTENT: { code: 'BRAND_TONE_INCONSISTENT', instruction: '依 preferred tone 改寫語氣，避免過度促銷與無證據承諾。', locations: ['body'], severity: 'soft' },
  KEYWORD_STUFFING: { code: 'KEYWORD_STUFFING', instruction: '刪除不自然 exact phrase repetition 與地區清單，改用自然同義表達。', locations: ['repeated_phrases'], severity: 'soft' },
  QUERY_CANNIBALIZATION: { code: 'QUERY_CANNIBALIZATION', instruction: '保留本頁獨立問題與價值，連回唯一 canonical owner page，避免近似頁。', locations: ['title_h1_body_links'], severity: 'soft' },
  OVERPROMOTIONAL: { code: 'OVERPROMOTIONAL', instruction: '降低促銷性陳述，保留可驗證的服務資訊與限制。', locations: ['claims'], severity: 'soft' },
  CLAIM_WORDING_TOO_STRONG: { code: 'CLAIM_WORDING_TOO_STRONG', instruction: '將過強 factual wording 改為有證據且有限定的表述。', locations: ['claims'], severity: 'soft' },
  EVIDENCE_UTILIZATION_INCOMPLETE: { code: 'EVIDENCE_UTILIZATION_INCOMPLETE', instruction: '提高 approved evidence 的相關利用率，不得新增未核准事實。', locations: ['claims_and_citations'], severity: 'soft' },
  AUTOGEO_RULE_COVERAGE_INCOMPLETE: { code: 'AUTOGEO_RULE_COVERAGE_INCOMPLETE', instruction: '依既有 selected AutoGEO rules 補強結構、回答性與可引用性。', locations: ['body'], severity: 'soft' },
}

const HARD_REASON_PATTERNS: Array<[RegExp, string]> = [
  [/illegal|unlawful|違法/iu, 'EXPLICIT_ILLEGAL_CONTENT'],
  [/malicious|malware|scam|phishing|惡意程式|詐騙/iu, 'MALICIOUS_OR_DANGEROUS_OPERATION'],
  [/credential|api[_ -]?key|secret|password|個資|秘密|憑證洩漏/iu, 'SECRET_OR_PERSONAL_DATA_LEAK'],
  [/copyright|protected|licensed content|授權不足/iu, 'UNAUTHORIZED_PROTECTED_CONTENT'],
  [/diagnos(?:e|is)|treat(?:ment)?|治療|診斷/iu, 'EXPLICIT_MEDICAL_DIAGNOSIS_OR_TREATMENT'],
  [/legal advice|法律個案|訴訟建議/iu, 'EXPLICIT_LEGAL_CASE_ADVICE'],
  [/investment|securities|guaranteed return|投資|證券|保證報酬/iu, 'INVESTMENT_OR_RETURN_GUARANTEE'],
  [/insurance claim guarantee|保險理賠保證/iu, 'INSURANCE_GUARANTEE'],
  [/election manipulation|political persuasion|選舉操弄|政治操弄/iu, 'POLITICAL_MANIPULATION'],
  [/ranking guarantee|traffic guarantee|revenue guarantee|roi guarantee|排名保證|流量保證|收入保證|ROI保證/iu, 'UNSUPPORTED_PERFORMANCE_GUARANTEE'],
]

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function hash(value: unknown): string { return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex') }
function normalized(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() }
function list(value: readonly string[]): string[] { return [...new Set(value.map(normalized).filter(Boolean))].sort() }
function hasIso(value: string): boolean { return Number.isFinite(Date.parse(value)) }

export function defaultAutopilotMode(mode: AutopilotMode): Pick<AutopilotPolicySnapshot, 'mode' | 'maximumRepairAttempts' | 'maximumTopicSubstitutions' | 'allowedRiskClasses'> {
  if (mode === 'aggressive_growth') return { mode, maximumRepairAttempts: 3, maximumTopicSubstitutions: 2, allowedRiskClasses: ['low', 'general'] }
  if (mode === 'conservative_brand') return { mode, maximumRepairAttempts: 3, maximumTopicSubstitutions: 2, allowedRiskClasses: ['low', 'general'] }
  return { mode: 'balanced', maximumRepairAttempts: 3, maximumTopicSubstitutions: 2, allowedRiskClasses: ['low', 'general'] }
}

export function normalizeEntityStrategyProfile(input: Omit<EntityStrategyProfile, 'profileFingerprint'> & { profileFingerprint?: string }): EntityStrategyProfile {
  if (!input.canonicalBrandName.trim() || !input.canonicalWebsiteOrigin.trim() || !input.businessType.trim() || !input.primaryLocale.trim() || !input.evidenceSnapshotHash.match(/^[a-f0-9]{64}$/u)) throw new Error('Entity Strategy Profile identity or evidence snapshot is invalid.')
  if (!hasIso(input.effectiveAt) || (input.revokedAt !== null && !hasIso(input.revokedAt))) throw new Error('Entity Strategy Profile timestamps are invalid.')
  const normalizedProfile = { ...input, canonicalBrandName: input.canonicalBrandName.normalize('NFKC').trim(), brandAliases: list(input.brandAliases), primaryLocations: list(input.primaryLocations), serviceAreas: list(input.serviceAreas), primaryServices: list(input.primaryServices), secondaryServices: list(input.secondaryServices), targetAudience: list(input.targetAudience), primaryQueryClusters: list(input.primaryQueryClusters), supportingQueryClusters: list(input.supportingQueryClusters), canonicalPillarPages: [...new Set(input.canonicalPillarPages.map(value => value.trim()).filter(Boolean))].sort(), approvedBrandFacts: list(input.approvedBrandFacts), approvedDifferentiators: list(input.approvedDifferentiators), prohibitedClaims: list(input.prohibitedClaims), requiredDisclosures: list(input.requiredDisclosures), version: input.version, status: input.status } as EntityStrategyProfile
  if (!Number.isSafeInteger(normalizedProfile.version) || normalizedProfile.version < 1 || normalizedProfile.status === 'revoked' && !normalizedProfile.revokedAt) throw new Error('Entity Strategy Profile version or status is invalid.')
  const { profileFingerprint: _ignored, ...fingerprinted } = normalizedProfile
  const profileFingerprint = hash(fingerprinted)
  if (input.profileFingerprint && input.profileFingerprint !== profileFingerprint) throw new Error('Entity Strategy Profile fingerprint mismatch.')
  return { ...normalizedProfile, profileFingerprint }
}

export function normalizeQueryOwnership(input: Omit<QueryOwnership, 'fingerprint'> & { fingerprint?: string }): QueryOwnership {
  const normalizedQuery = normalized(input.normalizedQuery)
  if (!input.ownerPageId.trim() || !normalizedQuery || !input.queryCluster.trim() || !input.evidenceSnapshotHash.match(/^[a-f0-9]{64}$/u)) throw new Error('Query ownership identity is invalid.')
  const next = { ...input, normalizedQuery, queryCluster: normalized(input.queryCluster), supportingArticleIds: [...new Set(input.supportingArticleIds.map(value => value.trim()).filter(Boolean))].sort() }
  const { fingerprint: _ignored, ...fingerprinted } = next
  const fingerprint = hash(fingerprinted)
  if (input.fingerprint && input.fingerprint !== fingerprint) throw new Error('Query ownership fingerprint mismatch.')
  return { ...next, fingerprint }
}

export function detectKeywordStuffing(input: { text: string; primaryQuery?: string | null; locations?: string[] }): { detected: boolean; reasonCodes: string[]; locations: string[] } {
  const text = normalized(input.text)
  const query = normalized(input.primaryQuery || '')
  const reasons: string[] = []
  const locations = [...(input.locations || [])]
  if (query) {
    const occurrences = text.split(query).length - 1
    if (occurrences >= 4 || occurrences >= 3 && text.length / Math.max(1, query.length) < 80) { reasons.push('KEYWORD_STUFFING'); locations.push('exact_phrase_repetition') }
  }
  if (/(?:台北|台中|高雄|新北|桃園|臺北|臺中|高雄)(?:\s*[,、/|]\s*(?:台北|台中|高雄|新北|桃園|臺北|臺中|高雄)){3,}/u.test(text)) { reasons.push('KEYWORD_STUFFING'); locations.push('location_list') }
  return { detected: reasons.length > 0, reasonCodes: [...new Set(reasons)], locations: [...new Set(locations)] }
}

function hardBlockReason(reason: string): string | null {
  const value = normalized(reason)
  for (const [pattern, code] of HARD_REASON_PATTERNS) if (pattern.test(value)) return code
  if (/^(?:stale|revoked|missing)_evidence$/iu.test(value)) return 'STALE_OR_MISSING_EVIDENCE'
  if (/publication.*identity.*(?:unverified|mismatch)|lineage.*(?:invalid|mismatch|failure)/iu.test(value)) return 'UNVERIFIED_PUBLICATION_LINEAGE'
  if (/policy.*(?:revoked|paused|expired)|credential.*(?:unavailable|mismatch)|target.*suspend/iu.test(value)) return 'AUTHORITY_OR_TARGET_STOP'
  if (/major.*factual.*error|重大事實錯誤/iu.test(value)) return 'UNRESOLVED_MAJOR_FACTUAL_ERROR'
  return null
}

export function repairInstructionsFor(reasonCodes: readonly string[], profile?: EntityStrategyProfile | null, stuffing?: ReturnType<typeof detectKeywordStuffing>): RepairInstruction[] {
  const instructions = reasonCodes.map(code => SOFT_REASON_INSTRUCTIONS[code] || { code, instruction: `依 server-side quality/risk finding 修復 ${code}，不得新增未核准事實。`, locations: ['server-derived-finding'], severity: 'soft' as const })
  if (stuffing?.detected) instructions.push(...stuffing.reasonCodes.map(code => SOFT_REASON_INSTRUCTIONS[code]!))
  if (profile && !profile.canonicalBrandName.trim()) instructions.push(SOFT_REASON_INSTRUCTIONS.BRAND_MISSING!)
  const deduped = new Map(instructions.map(instruction => [instruction.code, instruction]))
  return [...deduped.values()]
}

export function buildRepairContract(input: { originalDraftId: string; originalContentHash: string; repairAttempt: number; reasonCodes: string[]; failingMetrics?: Record<string, number | string | null>; evidenceDeficiencies?: string[]; entityCoverageDeficiencies?: string[]; prohibitedClaimLocations?: string[]; citationDeficiencies?: string[]; keywordStuffingLocations?: string[]; internalLinkDeficiencies?: string[]; requestedRepairs: RepairInstruction[]; providerModel?: string | null; candidateId: string; evidenceSnapshotHash: string; createdAt: string }): RepairContract {
  if (!Number.isSafeInteger(input.repairAttempt) || input.repairAttempt < 1 || input.repairAttempt > 3) throw new Error('Repair attempt must be 1-3.')
  if (!input.originalContentHash.match(/^[a-f0-9]{64}$/u) || !input.evidenceSnapshotHash.match(/^[a-f0-9]{64}$/u) || !hasIso(input.createdAt)) throw new Error('Repair contract hash or timestamp is invalid.')
  const base = { contractVersion: 'repair-contract-v1' as const, originalDraftId: input.originalDraftId, originalContentHash: input.originalContentHash, repairAttempt: input.repairAttempt, reasonCodes: [...new Set(input.reasonCodes)].sort(), failingMetrics: input.failingMetrics || {}, evidenceDeficiencies: [...new Set(input.evidenceDeficiencies || [])], entityCoverageDeficiencies: [...new Set(input.entityCoverageDeficiencies || [])], prohibitedClaimLocations: [...new Set(input.prohibitedClaimLocations || [])], citationDeficiencies: [...new Set(input.citationDeficiencies || [])], keywordStuffingLocations: [...new Set(input.keywordStuffingLocations || [])], internalLinkDeficiencies: [...new Set(input.internalLinkDeficiencies || [])], requestedRepairs: input.requestedRepairs, providerModel: input.providerModel || null, parentLineage: { candidateId: input.candidateId, evidenceSnapshotHash: input.evidenceSnapshotHash, contentHash: input.originalContentHash }, repairedDraftId: null, repairedContentHash: null, createdAt: new Date(input.createdAt).toISOString() }
  return { ...base, repairFingerprint: hash(base) }
}

export function decideBalancedAutopilot(input: BalancedAutopilotInput): BalancedAutopilotDecision {
  const reasons = [...new Set(input.reasonCodes.map(value => value.trim()).filter(Boolean))]
  const policy = input.policy || null
  const now = input.now.getTime()
  const common = (action: AutopilotAction, code: string, extraReasons = reasons, repairInstructions: RepairInstruction[] = [], nextTopic: string | null = null, machineAuthorized = false): BalancedAutopilotDecision => {
    const payload = { engineVersion: BALANCED_AUTOPILOT_ENGINE_VERSION, action, code, reasons: extraReasons, repairInstructions, nextTopic, machineAuthorized, policyId: policy?.policyId || null, policyVersion: policy?.policyVersion || null, candidateId: input.candidateId, contentHash: input.contentHash, evidenceSnapshotHash: input.evidenceSnapshotHash }
    return { engineVersion: BALANCED_AUTOPILOT_ENGINE_VERSION, action, code, reasons: extraReasons, repairInstructions, nextTopic, machineAuthorized, policyId: policy?.policyId || null, policyVersion: policy?.policyVersion || null, decisionFingerprint: hash(payload) }
  }
  if (!Number.isFinite(now)) return common('hard_block', 'INVALID_DECISION_TIME', ['scheduler time is invalid'])
  if (!policy) return common('hard_block', 'POLICY_NOT_AUTHORIZED', ['owner autopilot policy is missing'])
  if (policy.status !== 'enabled') return common('hard_block', policy.status === 'revoked' ? 'POLICY_REVOKED' : 'POLICY_PAUSED', [`owner autopilot policy is ${policy.status}`])
  if (policy.expiresAt && (!hasIso(policy.expiresAt) || Date.parse(policy.expiresAt) <= now)) return common('hard_block', 'POLICY_EXPIRED', ['owner autopilot policy is expired'])
  if (!hasIso(policy.activatedAt) || Date.parse(policy.activatedAt) > now) return common('hard_block', 'POLICY_NOT_ACTIVE', ['owner autopilot policy is not active'])
  if (policy.ownerUserId < 1 || policy.clientId < 1 || !policy.websiteId.trim() || !policy.entityStrategyProfileId.trim()) return common('hard_block', 'POLICY_SCOPE_INVALID', ['policy scope is incomplete'])
  if (!policy.allowedContentTypes.map(normalized).includes(normalized(input.contentType))) return common('hard_block', 'CONTENT_TYPE_NOT_ALLOWED', ['content type is outside policy allowlist'])
  if (!policy.allowedLocales.map(normalized).includes(normalized(input.locale))) return common('hard_block', 'LOCALE_NOT_ALLOWED', ['locale is outside policy allowlist'])
  if (!policy.allowedDestinations.map(normalized).includes(normalized(input.destinationId))) return common('hard_block', 'DESTINATION_NOT_ALLOWED', ['destination is outside policy allowlist'])
  if (!policy.allowedCadences.includes(input.cadenceDays)) return common('hard_block', 'CADENCE_NOT_ALLOWED', ['cadence is outside policy allowlist'])
  if (!policy.allowedRiskClasses.includes(input.riskClass)) return common('hard_block', 'RISK_CLASS_NOT_ALLOWED', ['risk class is outside policy allowlist'])
  if (!input.targetIdentityVerified) return common('hard_block', 'TARGET_IDENTITY_UNVERIFIED', ['publication target identity is not verified'])
  if (!input.lineageVerified) return common('hard_block', 'LINEAGE_UNVERIFIED', ['content/evidence/policy lineage is not verified'])
  if (input.evidenceStatus !== 'approved_fresh') return common('hard_block', 'EVIDENCE_NOT_CURRENT', [`evidence status is ${input.evidenceStatus}`])
  if (input.providerProvenanceComplete === false) return common('hard_block', 'PROVIDER_PROVENANCE_INCOMPLETE', ['provider/model provenance is incomplete'])
  const explicitHardBlock = reasons.map(hardBlockReason).find(Boolean)
  if (explicitHardBlock) return common('hard_block', explicitHardBlock, reasons)
  const stuffing = input.contentText ? detectKeywordStuffing({ text: input.contentText, primaryQuery: input.primaryQuery }) : undefined
  const entityDeficiencies: string[] = []
  if (input.entityProfile) {
    const text = normalized(input.contentText || '')
    if (!text.includes(normalized(input.entityProfile.canonicalBrandName))) entityDeficiencies.push('BRAND_MISSING')
    if (input.primaryQuery && input.entityProfile.primaryQueryClusters.map(normalized).includes(normalized(input.primaryQuery)) && !input.entityProfile.primaryLocations.some(location => text.includes(normalized(location)))) entityDeficiencies.push('LOCATION_MISSING')
    if (input.primaryQuery && !input.entityProfile.primaryServices.some(service => text.includes(normalized(service)))) entityDeficiencies.push('SERVICE_MISSING')
  }
  const repairReasons = [...new Set([...reasons, ...entityDeficiencies, ...(stuffing?.reasonCodes || [])])]
  const instructions = repairInstructionsFor(repairReasons, input.entityProfile, stuffing)
  const hasSoftDeficiency = input.qualityStatus !== 'passed' || repairReasons.length > 0
  if (!hasSoftDeficiency) return common('publish', 'AUTOPILOT_AUTHORIZED', ['quality, risk, evidence, target and lineage gates passed'], [], null, true)
  if (input.repairAttempts < policy.maximumRepairAttempts) return common('repair', 'REPAIR_REQUIRED', repairReasons, instructions)
  if (input.topicSubstitutions < policy.maximumTopicSubstitutions) {
    const nextTopic = input.candidateSafeTopics.find(topic => topic.trim() && normalized(topic) !== normalized(input.primaryQuery || '')) || null
    if (nextTopic) return common('substitute', 'TOPIC_SUBSTITUTION_REQUIRED', [...repairReasons, 'repair budget exhausted'], instructions, nextTopic)
  }
  return common('skip', 'SKIPPED_AFTER_BOUNDED_REPAIR', [...repairReasons, 'repair and substitution budgets exhausted'], instructions)
}

export function buildMachineAuthorization(input: { decision: BalancedAutopilotDecision; policy: AutopilotPolicySnapshot; candidateId: string; contentHash: string; contentType: string; locale: string; evidenceSnapshotHash: string; evidenceCapturedAt: string; riskClass: AutopilotRiskClass; riskReasonCodes: string[]; draftId: string; providerModel: string; repairAttempts: number; substitutionCount: number; destinationId: string; now: string }): MachineAuthorization {
  if (input.decision.action !== 'publish' || !input.decision.machineAuthorized) throw new Error('Only an allowed publish decision can create machine authorization.')
  if (!hasIso(input.evidenceCapturedAt) || !hasIso(input.now) || Date.parse(input.evidenceCapturedAt) > Date.parse(input.now)) throw new Error('Machine authorization timestamps are invalid.')
  const base = { authorizationVersion: 'machine-authorization-v1' as const, authorizationId: `machine-auth-${hash({ policyId: input.policy.policyId, candidateId: input.candidateId, contentHash: input.contentHash, evidenceSnapshotHash: input.evidenceSnapshotHash }).slice(0, 32)}`, policy: { policyId: input.policy.policyId, policyVersion: input.policy.policyVersion, configurationFingerprint: input.policy.configurationFingerprint, ownerUserId: input.policy.ownerUserId, clientId: input.policy.clientId, websiteId: input.policy.websiteId, mode: input.policy.mode }, candidate: { candidateId: input.candidateId, contentHash: input.contentHash, contentType: input.contentType, locale: input.locale }, evidence: { snapshotHash: input.evidenceSnapshotHash, status: 'approved_fresh' as const, capturedAt: new Date(input.evidenceCapturedAt).toISOString() }, risk: { class: input.riskClass, reasonCodes: [...new Set(input.riskReasonCodes)] }, quality: { status: 'passed' as const, reasonCodes: [], engineVersion: BALANCED_AUTOPILOT_ENGINE_VERSION }, content: { draftId: input.draftId, contentHash: input.contentHash, providerModel: input.providerModel, repairAttempts: input.repairAttempts, substitutionCount: input.substitutionCount }, target: { websiteId: input.policy.websiteId, destinationId: input.destinationId, identityVerified: true as const }, decision: { action: 'publish' as const, decidedAt: new Date(input.now).toISOString(), decisionFingerprint: input.decision.decisionFingerprint } }
  return { ...base, authorizationFingerprint: hash(base) }
}

export function balancedAutopilotModeMatrix(): Record<AutopilotMode, { intent: string; qualityHandling: string; safetyHandling: string; defaultRepairAttempts: number; defaultTopicSubstitutions: number }> {
  return {
    balanced: { intent: '一般低風險內容以 repair-first 維持穩定品質與品牌一致性。', qualityHandling: '一般品質缺陷先修稿，再有限 topic substitution；正常內容不需逐篇 owner review。', safetyHandling: '只允許 approved fresh evidence、通過 risk gate 與完整 lineage；危險內容 hard block。', defaultRepairAttempts: 3, defaultTopicSubstitutions: 2 },
    aggressive_growth: { intent: '在相同安全邊界內提高安全主題覆蓋與替代排程速度。', qualityHandling: '使用相同 repair-first 規則，允許 bounded substitution，不以關鍵字密度或模型分數放寬。', safetyHandling: '不得繞過 evidence、risk、credential、target 或 publication authority。', defaultRepairAttempts: 3, defaultTopicSubstitutions: 2 },
    conservative_brand: { intent: '優先保護品牌語氣、approved facts 與 canonical entity identity。', qualityHandling: '品牌、語氣、entity 或 query ownership 缺陷優先修稿；無法修復則 skip，不偽造核准。', safetyHandling: '可比 balanced 更早 skip 品牌不一致內容，但不把一般 wellness 詞彙誤判成醫療風險。', defaultRepairAttempts: 3, defaultTopicSubstitutions: 2 },
  }
}
