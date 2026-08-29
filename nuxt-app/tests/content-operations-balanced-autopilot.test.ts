import { describe, expect, it } from 'vitest'
import { buildMachineAuthorization, buildRepairContract, decideBalancedAutopilot, detectKeywordStuffing, normalizeEntityStrategyProfile, normalizeQueryOwnership } from '../server/content-operations/balanced-autopilot'
import type { AutopilotPolicySnapshot } from '../server/content-operations/balanced-autopilot'
import { evaluateCanonicalGeoContentQuality } from '../server/content-operations/quality-evaluation'
import { autonomousRiskSnapshotMatches, canonicalAutonomousRiskSnapshot, canonicalBusinessRiskClass, canonicalRiskSeverity } from '../server/content-operations/autonomous-risk'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'

const NOW = new Date('2026-08-28T12:00:00.000Z')
const HASH = 'a'.repeat(64)

function policy(overrides: Partial<AutopilotPolicySnapshot> = {}): AutopilotPolicySnapshot {
  return {
    policyId: 'policy-1', policyVersion: 'governed-autopilot-policy-v3', ownerUserId: 1, clientId: 2, websiteId: 'website-1', mode: 'balanced', status: 'enabled', allowedContentTypes: ['article'], allowedLocales: ['en'], allowedDestinations: ['primary'], allowedCadences: [3], allowedRiskClasses: ['low', 'general'], entityStrategyProfileId: 'entity-1', maximumRepairAttempts: 3, maximumTopicSubstitutions: 2, generationBudget: 10, publicationBudget: 10, evidenceFreshnessHours: 720, allowedProviderModels: ['bailian:qwen-plus'], configurationFingerprint: HASH, activatedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-12-31T00:00:00.000Z', revokedAt: null, ...overrides,
  }
}

function input(overrides: Partial<Parameters<typeof decideBalancedAutopilot>[0]> = {}) {
  return {
    policy: policy(), candidateId: 'candidate-1', contentType: 'article', locale: 'en', destinationId: 'primary', cadenceDays: 3, riskClass: 'general' as const, qualityStatus: 'passed' as const, reasonCodes: [], contentHash: HASH, evidenceSnapshotHash: HASH, evidenceStatus: 'approved_fresh' as const, providerProvenanceComplete: true, providerModel: 'bailian:qwen-plus', targetIdentityVerified: true, lineageVerified: true, repairAttempts: 0, topicSubstitutions: 0, candidateSafeTopics: ['supporting topic'], entityProfile: null, queryOwnership: null, contentText: 'Acme explains a useful service for an audience.', primaryQuery: 'useful service', now: NOW, ...overrides,
  }
}

function authorizationInput(decision: ReturnType<typeof decideBalancedAutopilot>) {
  const riskSnapshot = canonicalAutonomousRiskSnapshot({ gateId: 9, gateVersion: 'content-risk-gate-v1', gateStatus: 'passed', riskLevel: 'low', findings: [], draftId: 11, contentHash: HASH, evidenceSnapshotHash: HASH })
  return { decision, policy: policy(), candidateId: 'candidate-1', contentHash: HASH, contentType: 'article', locale: 'en', evidenceSnapshotHash: HASH, evidenceCapturedAt: '2026-08-28T10:00:00.000Z', riskSeverity: riskSnapshot.severity, businessRiskClass: riskSnapshot.businessClass, riskReasonCodes: [], riskSnapshot, qualityEvaluation: { status: 'passed' as const, reasonCodes: [], engineVersion: 'geo-content-quality-evaluation-v1', fingerprint: HASH }, entryId: 1, jobId: 2, draftId: '11', entityProfileFingerprint: HASH, queryOwnershipFingerprint: HASH, providerModel: 'bailian:qwen-plus', repairAttempts: 0, substitutionCount: 0, targetRowId: 3, targetConfigurationFingerprint: HASH, destinationId: 'primary', now: NOW.toISOString() }
}

describe('balanced autonomous GEO decision engine', () => {
  it('publishes only after all server-side gates pass and creates truthful machine authorization', () => {
    const decision = decideBalancedAutopilot(input())
    expect(decision.action).toBe('publish')
    expect(decision.machineAuthorized).toBe(true)
    const authorization = buildMachineAuthorization(authorizationInput(decision))
    expect(authorization.target.identityVerified).toBe(true)
    expect(authorization.quality.status).toBe('passed')
    expect(authorization.authorizationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('repairs soft quality issues before considering substitution', () => {
    const decision = decideBalancedAutopilot(input({ qualityStatus: 'needs_repair', reasonCodes: ['DIRECT_ANSWER_MISSING', 'INTERNAL_LINK_MISSING'] }))
    expect(decision.action).toBe('repair')
    expect(decision.code).toBe('REPAIR_REQUIRED')
    expect(decision.machineAuthorized).toBe(false)
    expect(decision.repairInstructions.map(item => item.code)).toEqual(expect.arrayContaining(['DIRECT_ANSWER_MISSING', 'INTERNAL_LINK_MISSING']))
  })

  it('uses bounded topic substitution after repair budget exhaustion and then skips', () => {
    const substitute = decideBalancedAutopilot(input({ qualityStatus: 'needs_repair', reasonCodes: ['CONTENT_TOPIC_MISMATCH'], repairAttempts: 3 }))
    expect(substitute.action).toBe('substitute')
    expect(substitute.nextTopic).toBe('supporting topic')
    const skipped = decideBalancedAutopilot(input({ qualityStatus: 'needs_repair', reasonCodes: ['CONTENT_TOPIC_MISMATCH'], repairAttempts: 3, topicSubstitutions: 2 }))
    expect(skipped.action).toBe('skip')
    expect(skipped.code).toBe('SKIPPED_AFTER_BOUNDED_REPAIR')
  })

  it('hard-blocks dangerous or stale inputs but does not classify ordinary wellness language as medical', () => {
    const dangerous = decideBalancedAutopilot(input({ reasonCodes: ['content mentions investment return guarantee'] }))
    expect(dangerous.action).toBe('hard_block')
    expect(dangerous.code).toBe('INVESTMENT_OR_RETURN_GUARANTEE')
    const wellness = decideBalancedAutopilot(input({ contentText: 'A general wellness article describes a calm morning routine.', reasonCodes: ['BRAND_TONE_INCONSISTENT'] }))
    expect(wellness.action).toBe('repair')
    expect(wellness.code).toBe('REPAIR_REQUIRED')
  })

  it('fails closed unless provider provenance is exact true and the provider/model is owner-allowed', () => {
    expect(decideBalancedAutopilot(input({ providerProvenanceComplete: false })).code).toBe('PROVIDER_PROVENANCE_INCOMPLETE')
    expect(decideBalancedAutopilot(input({ providerProvenanceComplete: undefined as never })).code).toBe('PROVIDER_PROVENANCE_INCOMPLETE')
    expect(decideBalancedAutopilot(input({ providerModel: 'bailian:qwen-max' })).code).toBe('PROVIDER_MODEL_NOT_ALLOWED')
  })

  it('detects exact phrase stuffing and validates entity/query ownership fingerprints', () => {
    const stuffing = detectKeywordStuffing({ text: 'local service local service local service local service', primaryQuery: 'local service' })
    expect(stuffing.detected).toBe(true)
    const entity = normalizeEntityStrategyProfile({ canonicalBrandName: 'Acme', brandAliases: ['ACME'], canonicalWebsiteOrigin: 'https://acme.example', businessType: 'services', primaryLocale: 'en', secondaryLocales: [], primaryLocations: ['Taipei'], serviceAreas: ['Taipei'], primaryServices: ['consulting'], secondaryServices: [], targetAudience: ['owners'], primaryQueryClusters: ['local consulting'], supportingQueryClusters: [], canonicalPillarPages: ['/consulting'], servicePageBindings: { consulting: '/consulting' }, approvedBrandFacts: ['Acme is a service business.'], approvedDifferentiators: [], prohibitedClaims: ['guaranteed ranking'], preferredTone: 'clear', requiredDisclosures: [], internalLinkPolicy: 'link to canonical pages only', structuredDataIdentity: { name: 'Acme' }, evidenceSnapshotHash: HASH, version: 1, status: 'active', effectiveAt: NOW.toISOString(), revokedAt: null })
    expect(entity.profileFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const ownership = normalizeQueryOwnership({ ownerPageId: '/consulting', normalizedQuery: ' local consulting ', queryCluster: 'Local Consulting', supportingArticleIds: ['article-1'], evidenceSnapshotHash: HASH, status: 'active' })
    expect(ownership.normalizedQuery).toBe('local consulting')
    expect(ownership.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects machine authorization for a repair or blocked decision', () => {
    const decision = decideBalancedAutopilot(input({ qualityStatus: 'needs_repair', reasonCodes: ['BRAND_MISSING'] }))
    expect(() => buildMachineAuthorization(authorizationInput(decision))).toThrow(/allowed publish decision/)
    const contract = buildRepairContract({ originalDraftId: 'draft-1', originalContentHash: HASH, repairAttempt: 1, reasonCodes: ['BRAND_MISSING'], requestedRepairs: decision.repairInstructions, candidateId: 'candidate-1', evidenceSnapshotHash: HASH, createdAt: NOW.toISOString() })
    expect(contract.parentLineage.contentHash).toBe(HASH)
    expect(contract.repairFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('emits a canonical content-quality evaluation independent from raw risk findings', () => {
    const evaluation = evaluateCanonicalGeoContentQuality({ content: '# Answer\n\nEvidence-bound content for the canonical owner page and its audience.'.repeat(3), contentHash: HASH, evidenceSnapshotHash: HASH, riskGateStatus: 'passed', riskGateVersion: 'content-risk-gate-v1', riskFindings: [], entityProfileFingerprint: HASH, queryOwnershipFingerprint: HASH })
    expect(evaluation).toMatchObject({ evaluationVersion: 'geo-content-quality-evaluation-v1', status: 'passed', metrics: { evidenceAuthorityBound: true, entityAuthorityBound: true, queryAuthorityBound: true } })
    expect(evaluation.evaluationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('separates canonical risk severity from business class and detects payload tampering', () => {
    expect(['low', 'moderate', 'high', 'critical'].map(riskLevel => canonicalRiskSeverity({ gateStatus: 'passed', riskLevel }))).toEqual(['low', 'moderate', 'high', 'critical'])
    expect(canonicalRiskSeverity({ gateStatus: 'passed', riskLevel: 'general' })).toBe('moderate')
    expect(canonicalRiskSeverity({ gateStatus: 'passed', riskLevel: 'low', findings: [{ severity: 'blocking' }] })).toBe('high')
    expect(canonicalRiskSeverity({ gateStatus: 'blocked', riskLevel: 'low', findings: [] })).toBe('high')
    expect(['medical diagnosis', 'legal lawsuit', 'financial investment', 'political election', 'PII personal data', 'ordinary service'].map(id => canonicalBusinessRiskClass([{ id }]))).toEqual(['medical', 'legal', 'financial', 'political', 'sensitive_personal_data', 'general'])
    const snapshot = canonicalAutonomousRiskSnapshot({ gateId: 9, gateVersion: 'content-risk-gate-v1', gateStatus: 'passed', riskLevel: 'low', findings: [{ id: 'ordinary_service', severity: 'info' }], draftId: 11, contentHash: HASH, evidenceSnapshotHash: HASH })
    expect(autonomousRiskSnapshotMatches(snapshot, snapshot)).toBe(true)
    expect(autonomousRiskSnapshotMatches(snapshot, { ...snapshot, severity: 'moderate', fingerprint: 'b'.repeat(64) })).toBe(false)
    expect(autonomousRiskSnapshotMatches(snapshot, { ...snapshot, businessClass: 'medical', fingerprint: snapshot.fingerprint })).toBe(false)
    expect(autonomousRiskSnapshotMatches(snapshot, { ...snapshot, reasonCodes: ['TAMPERED'], fingerprint: snapshot.fingerprint })).toBe(false)
  })

  it('blocks or repairs adversarial autonomous quality while keeping 0/0 metrics not applicable', () => {
    const title = 'Acme local consulting guide'
    const body = '# Acme local consulting guide\n\nAcme provides a bounded local consulting answer based only on approved evidence. [cite:source-1]\n\n## Evidence boundary\n\nThe approved source supports this limited explanation without a performance promise.'
    const base = { strictAutonomous: true, title, content: body, contentHash: contentFingerprint(title, body), evidenceSnapshotHash: HASH, evidenceRefs: [{ sourceId: 'source-1' }], evidenceCurrent: true, riskGateStatus: 'passed', riskGateVersion: 'content-risk-gate-v1', riskFindings: [], entityProfileFingerprint: HASH, entityCanonicalName: 'Acme', queryOwnershipFingerprint: HASH, primaryQuery: 'local consulting', selectedRuleIds: [], appliedRuleIds: [], providerProvenance: { stage: 'optimized', evidenceSnapshotHash: HASH, providerExecution: true, providerProvenance: { providerExecution: true } } }
    const passed = evaluateCanonicalGeoContentQuality(base)
    expect(passed).toMatchObject({ status: 'passed', metrics: { selectedRuleCoverage: null, unsupportedClaimCount: 0 } })
    expect(evaluateCanonicalGeoContentQuality({ ...base, content: 'No heading and no bounded structure.', contentHash: contentFingerprint(title, 'No heading and no bounded structure.') }).reasonCodes).toContain('INVALID_HEADING_HIERARCHY')
    expect(evaluateCanonicalGeoContentQuality({ ...base, evidenceCurrent: false }).reasonCodes).toContain('STALE_CITATION_EVIDENCE')
    const stuffed = body.replace('local consulting answer', 'local consulting local consulting local consulting local consulting answer')
    expect(evaluateCanonicalGeoContentQuality({ ...base, content: stuffed, contentHash: contentFingerprint(title, stuffed) }).reasonCodes).toContain('KEYWORD_STUFFING')
    expect(evaluateCanonicalGeoContentQuality({ ...base, unsupportedFactualClaim: true }).reasonCodes).toContain('UNSUPPORTED_CLAIM')
  })
})
