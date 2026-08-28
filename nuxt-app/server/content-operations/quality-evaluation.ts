import { contentFingerprint } from '../seo-geo-core/riskGate'
import { parseMarkdownStructure, prohibitedClaimReasonCodes } from '../geo-content-quality'
import { detectKeywordStuffing } from './balanced-autopilot'
import { stableFingerprint } from './normalization'

export const GEO_CONTENT_QUALITY_EVALUATION_VERSION = 'geo-content-quality-autonomous-evaluation-v2' as const
export const LEGACY_GEO_CONTENT_QUALITY_EVALUATION_VERSION = 'geo-content-quality-evaluation-v1' as const

type QualityEvidenceRef = { sourceId?: unknown; artifactId?: unknown; chunkId?: unknown }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function ratio(numerator: number, denominator: number): number | null { return denominator === 0 ? null : numerator / denominator }

export function evaluateCanonicalGeoContentQuality(input: {
  strictAutonomous?: boolean
  title?: string
  content: string
  contentHash: string
  evidenceSnapshotHash: string
  evidenceRefs?: unknown
  evidenceCurrent?: boolean
  riskGateStatus: string | null
  riskGateVersion: string | null
  riskFindings: unknown[]
  entityProfileFingerprint: string | null
  entityCanonicalName?: string | null
  queryOwnershipFingerprint: string | null
  primaryQuery?: string | null
  selectedRuleIds?: unknown
  appliedRuleIds?: unknown
  providerProvenance?: unknown
  unsupportedFactualClaim?: boolean
}) {
  const normalized = input.content.normalize('NFKC').trim()
  if (input.strictAutonomous !== true) {
    const metrics = {
      characterCount: normalized.length,
      hasHeading: /^#{1,3}\s+\S+/mu.test(normalized),
      hasDirectAnswer: normalized.replace(/^#{1,3}[^\n]*\n*/u, '').trim().length >= 80,
      evidenceAuthorityBound: /^[a-f0-9]{64}$/u.test(input.evidenceSnapshotHash),
      entityAuthorityBound: Boolean(input.entityProfileFingerprint),
      queryAuthorityBound: Boolean(input.queryOwnershipFingerprint),
    }
    const reasonCodes = [
      ...(input.riskGateStatus === 'passed' ? [] : ['RISK_GATE_NOT_PASSED']),
      ...(metrics.evidenceAuthorityBound ? [] : ['EVIDENCE_AUTHORITY_MISSING']),
      ...(metrics.entityAuthorityBound ? [] : ['ENTITY_AUTHORITY_MISSING']),
      ...(metrics.queryAuthorityBound ? [] : ['QUERY_AUTHORITY_MISSING']),
    ]
    const base = { evaluationVersion: LEGACY_GEO_CONTENT_QUALITY_EVALUATION_VERSION, status: reasonCodes.length ? 'needs_repair' as const : 'passed' as const, reasonCodes, metrics, contentHash: input.contentHash, evidenceSnapshotHash: input.evidenceSnapshotHash, riskGateVersion: input.riskGateVersion, riskFindingsFingerprint: stableFingerprint(input.riskFindings) }
    return { ...base, evaluationFingerprint: stableFingerprint(base) }
  }
  const structure = parseMarkdownStructure(normalized)
  const report = structure.report
  const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map(record) as QualityEvidenceRef[] : []
  const citationIds = [...normalized.matchAll(/\[cite:([A-Za-z0-9._:-]{1,160})\]/gu)].map(match => match[1]!)
  const knownCitationIds = new Set(evidenceRefs.flatMap(ref => [ref.sourceId, ref.artifactId, ref.chunkId].filter(value => typeof value === 'string' || typeof value === 'number').map(String)))
  const validCitationCount = citationIds.filter(id => knownCitationIds.has(id)).length
  const selectedRules = strings(input.selectedRuleIds).sort()
  const appliedRules = new Set(strings(input.appliedRuleIds))
  const appliedSelectedRules = selectedRules.filter(rule => appliedRules.has(rule)).length
  const provider = record(input.providerProvenance)
  const providerNested = record(provider.providerProvenance)
  const providerLineageBound = provider.stage === 'optimized'
    && provider.evidenceSnapshotHash === input.evidenceSnapshotHash
    && provider.providerExecution === true
    && providerNested.providerExecution === true
  const primaryQuery = input.primaryQuery?.normalize('NFKC').toLowerCase().trim() || ''
  const entityName = input.entityCanonicalName?.normalize('NFKC').toLowerCase().trim() || ''
  const lowerContent = normalized.toLowerCase()
  const stuffing = detectKeywordStuffing({ text: normalized, primaryQuery })
  const publicClaimReasons = prohibitedClaimReasonCodes(normalized)
  const riskFindingReasons = input.riskFindings.map(item => String(record(item).id || '')).filter(Boolean)
  const unsupportedClaimCount = publicClaimReasons.length + riskFindingReasons.filter(value => /unsupported|fabricated|source_bound|guarantee|performance/iu.test(value)).length + (input.unsupportedFactualClaim ? 1 : 0)
  const exactContentHash = input.title === undefined || contentFingerprint(input.title, input.content) === input.contentHash
  const metrics = {
    characterCount: normalized.length,
    headingCount: report.headingLevels.length,
    hasHeading: report.titleHeading ? 1 : 0,
    hasDirectAnswer: report.directAnswerFirst ? 1 : 0,
    headingHierarchyValid: !report.headingLevelJump && report.headingLevels[0] === 1 ? 1 : 0,
    emptySectionCount: report.emptySection ? 1 : 0,
    evidenceReferenceCount: evidenceRefs.length,
    citationCoverage: ratio(validCitationCount, citationIds.length),
    entityAuthorityBound: input.entityProfileFingerprint ? 1 : 0,
    entityMentioned: entityName ? Number(lowerContent.includes(entityName)) : null,
    queryAuthorityBound: input.queryOwnershipFingerprint ? 1 : 0,
    queryMentioned: primaryQuery ? Number(lowerContent.includes(primaryQuery)) : null,
    selectedRuleCoverage: ratio(appliedSelectedRules, selectedRules.length),
    unsupportedClaimCount,
    providerLineageBound: providerLineageBound ? 1 : 0,
    exactContentHash: exactContentHash ? 1 : 0,
    keywordStuffingDetected: stuffing.detected ? 1 : 0,
  }
  const hardReasons = [
    ...(!normalized ? ['EMPTY_CONTENT'] : []),
    ...(input.riskGateStatus === 'passed' ? [] : ['RISK_GATE_NOT_PASSED']),
    ...(/^[a-f0-9]{64}$/u.test(input.evidenceSnapshotHash) && evidenceRefs.length ? [] : ['EVIDENCE_AUTHORITY_MISSING']),
    ...(input.evidenceCurrent === false ? ['STALE_CITATION_EVIDENCE'] : []),
    ...(exactContentHash ? [] : ['CONTENT_HASH_MISMATCH']),
    ...(unsupportedClaimCount ? ['UNSUPPORTED_CLAIM'] : []),
    ...(providerLineageBound ? [] : ['PROVIDER_DRAFT_EVIDENCE_LINEAGE_MISMATCH']),
  ]
  const repairReasons = [
    ...structure.reasonCodes,
    ...(report.titleHeading ? [] : ['INVALID_HEADING_HIERARCHY']),
    ...(report.directAnswerFirst ? [] : ['DIRECT_ANSWER_MISSING']),
    ...(!report.emptySection ? [] : ['EMPTY_SECTION']),
    ...(evidenceRefs.length > 0 && (citationIds.length === 0 || validCitationCount !== citationIds.length) ? ['CITATION_INCOMPLETE'] : []),
    ...(input.entityProfileFingerprint ? [] : ['ENTITY_AUTHORITY_MISSING']),
    ...(entityName && !lowerContent.includes(entityName) ? ['BRAND_MISSING'] : []),
    ...(input.queryOwnershipFingerprint ? [] : ['QUERY_AUTHORITY_MISSING']),
    ...(primaryQuery && !lowerContent.includes(primaryQuery) ? ['CONTENT_TOPIC_MISMATCH'] : []),
    ...(selectedRules.length && appliedSelectedRules !== selectedRules.length ? ['AUTOGEO_RULE_COVERAGE_INCOMPLETE'] : []),
    ...stuffing.reasonCodes,
  ]
  const reasonCodes = [...new Set([...hardReasons, ...repairReasons])].sort()
  const status = hardReasons.length ? 'blocked' as const : repairReasons.length ? 'needs_repair' as const : 'passed' as const
  const base = { evaluationVersion: GEO_CONTENT_QUALITY_EVALUATION_VERSION, publicContractVersion: 'geo-content-quality-v1', status, reasonCodes, metrics, contentHash: input.contentHash, evidenceSnapshotHash: input.evidenceSnapshotHash, riskGateVersion: input.riskGateVersion, riskFindingsFingerprint: stableFingerprint(input.riskFindings), structureFingerprint: stableFingerprint(report), providerLineageFingerprint: stableFingerprint({ stage: provider.stage || null, evidenceSnapshotHash: provider.evidenceSnapshotHash || null, providerExecution: provider.providerExecution === true, nestedProviderExecution: providerNested.providerExecution === true }), selectedRuleIds: selectedRules, appliedRuleIds: [...appliedRules].sort() }
  return { ...base, evaluationFingerprint: stableFingerprint(base) }
}
