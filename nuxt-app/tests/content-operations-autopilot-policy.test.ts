import { describe, expect, it } from 'vitest'
import { enableOwnerAutopilotPolicy, evaluateOwnerAutopilotPolicy, revokeOwnerAutopilotPolicy, validateOwnerAutopilotPolicyIntegrity } from '../server/content-operations/autopilot-policy'

const basePolicyInput = {
  ownerUserId: 7,
  clientId: 11,
  targetRowId: 13,
  targetId: 'target-1',
  authorizedByOwnerUserId: 7,
  authorizedAt: '2026-01-10T09:00:00.000Z',
  expiresAt: '2026-01-11T09:00:00.000Z',
  allowedContentTypes: ['article', 'faq'],
  allowedLanguages: ['en', 'zh-hant'],
}

function policy(maximumRiskLevel: 'low' | 'general' | 'high' = 'general') { return enableOwnerAutopilotPolicy({ ...basePolicyInput, maximumRiskLevel }) }
function evaluation(overrides: Record<string, unknown> = {}) {
  return evaluateOwnerAutopilotPolicy({ policy: policy(), ownerUserId: 7, clientId: 11, targetRowId: 13, targetId: 'target-1', targetStatus: 'active', targetExecutionEnabled: true, entry: { status: 'ready_to_publish', contentType: 'article', language: 'zh-hant' }, entryCadenceDays: 3, reviewDecision: 'approved_for_delivery', riskGateStatus: 'passed', riskLevel: 'general', qualityGateVersion: 'content-risk-gate-v1', evidenceApproved: true, evidenceCapturedAt: '2026-01-10T09:00:00.000Z', providerExecution: true, providerModel: 'bailian:qwen-plus', providerProvenanceComplete: true, unsupportedFactualClaim: false, contentHashMatchesDraft: true, now: new Date('2026-01-10T10:00:00.000Z'), ...overrides })
}

function evaluationInput() {
  return { ownerUserId: 7, clientId: 11, targetRowId: 13, targetId: 'target-1', targetStatus: 'active' as const, targetExecutionEnabled: true, entry: { status: 'ready_to_publish' as const, contentType: 'article' as const, language: 'zh-hant' as const }, entryCadenceDays: 3, reviewDecision: 'approved_for_delivery', riskGateStatus: 'passed', riskLevel: 'general', qualityGateVersion: 'content-risk-gate-v1', evidenceApproved: true, evidenceCapturedAt: '2026-01-10T09:00:00.000Z', providerExecution: true, providerModel: 'bailian:qwen-plus', providerProvenanceComplete: true, unsupportedFactualClaim: false, contentHashMatchesDraft: true, now: new Date('2026-01-10T10:00:00.000Z') }
}

describe('governed owner autopilot policy', () => {
  it('creates a deterministic v3 owner-scoped policy without credential material', () => {
    const first = policy()
    const second = policy()
    expect(first).toEqual(second)
    expect(first.policyVersion).toBe('governed-autopilot-policy-v3')
    expect(first.policyId).toMatch(/^autopilot-[a-f0-9]{32}$/)
    expect(validateOwnerAutopilotPolicyIntegrity(first)).toBe(true)
    expect(JSON.stringify(first)).not.toMatch(/secret|token|password|api[_-]?key/i)
  })

  it('allows only the exact owner, client, target, review, risk, status, and allowlists', () => {
    expect(evaluation()).toMatchObject({ allowed: true, code: 'AUTOPILOT_ALLOWED' })
    expect(evaluation({ ownerUserId: 8 }).code).toBe('AUTOPILOT_OWNER_SCOPE_MISMATCH')
    expect(evaluation({ clientId: 12 }).code).toBe('AUTOPILOT_CLIENT_SCOPE_MISMATCH')
    expect(evaluation({ targetRowId: 14 }).code).toBe('AUTOPILOT_TARGET_SCOPE_MISMATCH')
    expect(evaluation({ targetExecutionEnabled: false }).code).toBe('AUTOPILOT_EXECUTION_DISABLED')
    expect(evaluation({ entry: { status: 'ready_to_publish', contentType: 'landing_page', language: 'zh-hant' } }).code).toBe('AUTOPILOT_CONTENT_TYPE_NOT_ALLOWED')
    expect(evaluation({ entry: { status: 'ready_to_publish', contentType: 'article', language: 'ja' } }).code).toBe('AUTOPILOT_LANGUAGE_NOT_ALLOWED')
    expect(evaluation({ reviewDecision: 'approved_for_preview' })).toMatchObject({ allowed: true, code: 'AUTOPILOT_ALLOWED' })
    const reviewRequiredPolicy = enableOwnerAutopilotPolicy({ ...basePolicyInput, requireApprovedForDelivery: true })
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: reviewRequiredPolicy, reviewDecision: 'approved_for_preview' }).code).toBe('AUTOPILOT_REVIEW_REQUIRED')
    expect(evaluation({ riskGateStatus: 'needs_review' }).code).toBe('AUTOPILOT_RISK_GATE_REQUIRED')
  })

  it('enforces the complete 3x3 maximum risk matrix and rejects unknown risk values', () => {
    for (const [maximum, expected] of [['low', ['low']], ['general', ['low', 'general']], ['high', ['low', 'general', 'high']] as const]) {
      for (const candidate of ['low', 'general', 'high'] as const) {
        const allowed = expected.includes(candidate)
        expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: policy(maximum as 'low' | 'general' | 'high'), riskLevel: candidate }).allowed).toBe(allowed)
      }
    }
    expect(evaluation({ riskLevel: null }).code).toBe('AUTOPILOT_RISK_LEVEL_NOT_ALLOWED')
    expect(evaluation({ riskLevel: 'critical' }).code).toBe('AUTOPILOT_RISK_LEVEL_NOT_ALLOWED')
    expect(evaluation({ riskLevel: { value: 'low' } }).code).toBe('AUTOPILOT_RISK_LEVEL_NOT_ALLOWED')
  })

  it('keeps V3 exact compatibility while V4 separates severity from business class in its fingerprint', () => {
    expect(evaluation({ riskLevel: 'low' })).toMatchObject({ allowed: true, code: 'AUTOPILOT_ALLOWED' })
    const v4 = enableOwnerAutopilotPolicy({ ...basePolicyInput, policyVersion: 'governed-autopilot-policy-v4', entityStrategyProfileId: 'profile-1', allowedDestinations: ['target-1'], allowedCadences: [3], maximumRiskSeverity: 'moderate', allowedBusinessRiskClasses: ['general'], allowedRiskClasses: ['general'] })
    expect(v4).toMatchObject({ policyVersion: 'governed-autopilot-policy-v4', riskSemanticsVersion: 'risk-severity-and-business-class-v1', maximumRiskSeverity: 'moderate', allowedBusinessRiskClasses: ['general'] })
    expect(v4.configurationFingerprint).not.toBe(policy().configurationFingerprint)
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: v4, riskLevel: 'low', riskSeverity: 'low', businessRiskClass: 'general' })).toMatchObject({ allowed: true, code: 'AUTOPILOT_ALLOWED' })
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: v4, riskLevel: 'low', riskSeverity: 'high', businessRiskClass: 'general' }).allowed).toBe(false)
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: v4, riskLevel: 'low', riskSeverity: 'low', businessRiskClass: 'medical' }).allowed).toBe(false)
  })

  it('denies missing, stale, future, paused, expired, and revoked policies fail-closed', () => {
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: null }).code).toBe('AUTOPILOT_NOT_AUTHORIZED')
    expect(evaluation({ evidenceApproved: false }).code).toBe('AUTOPILOT_EVIDENCE_NOT_APPROVED')
    expect(evaluation({ evidenceCapturedAt: null }).code).toBe('AUTOPILOT_EVIDENCE_FRESHNESS_UNKNOWN')
    expect(evaluation({ evidenceCapturedAt: '2025-11-01T00:00:00.000Z' }).code).toBe('AUTOPILOT_EVIDENCE_STALE')
    expect(evaluation({ evidenceCapturedAt: '2026-01-10T11:00:00.000Z' }).code).toBe('AUTOPILOT_EVIDENCE_FRESHNESS_UNKNOWN')
    expect(evaluation({ now: new Date('2026-01-12T00:00:00.000Z') }).code).toBe('AUTOPILOT_POLICY_EXPIRED')
    expect(evaluation({ now: new Date('2026-01-10T08:00:00.000Z') }).code).toBe('AUTOPILOT_POLICY_NOT_YET_ACTIVE')
    const paused = { ...policy(), status: 'paused' as const }
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: paused }).code).toBe('AUTOPILOT_POLICY_PAUSED')
    const revoked = revokeOwnerAutopilotPolicy(policy(), 7, '2026-01-10T11:00:00.000Z')
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: revoked }).code).toBe('AUTOPILOT_POLICY_REVOKED')
    expect(() => revokeOwnerAutopilotPolicy(policy(), 8, '2026-01-10T11:00:00.000Z')).toThrow(/authorized owner/)
  })

  it('requires publication-ready durable state, provider evidence, and self-authorization', () => {
    expect(evaluation({ entry: { status: 'awaiting_review', contentType: 'article', language: 'zh-hant' } }).code).toBe('AUTOPILOT_ENTRY_NOT_READY')
    expect(evaluation({ providerExecution: false }).code).toBe('AUTOPILOT_PROVIDER_PROVENANCE_INCOMPLETE')
    expect(evaluation({ providerProvenanceComplete: false }).code).toBe('AUTOPILOT_PROVIDER_PROVENANCE_INCOMPLETE')
    expect(evaluation({ contentHashMatchesDraft: false }).code).toBe('AUTOPILOT_HASH_MISMATCH')
    expect(() => enableOwnerAutopilotPolicy({ ...basePolicyInput, authorizedByOwnerUserId: 8 })).toThrow(/self-authorized/)
    expect(() => enableOwnerAutopilotPolicy({ ...basePolicyInput, expiresAt: basePolicyInput.authorizedAt })).toThrow(/expire/)
  })

  it('rejects tampering with every hashed configuration field while status and revokedAt remain DB authority', () => {
    const original = policy()
    const mutations: Array<[string, (value: typeof original) => typeof original]> = [
      ['policyVersion', value => ({ ...value, policyVersion: 'governed-autopilot-policy-v2' as never })],
      ['authorizedByOwnerUserId', value => ({ ...value, authorizedByOwnerUserId: 8 })],
      ['clientId', value => ({ ...value, clientId: 12 })],
      ['targetRowId', value => ({ ...value, targetRowId: 14 })],
      ['targetId', value => ({ ...value, targetId: 'target-tampered' })],
      ['authorizedAt', value => ({ ...value, authorizedAt: '2026-01-10T09:01:00.000Z' })],
      ['expiresAt', value => ({ ...value, expiresAt: '2026-01-12T09:00:00.000Z' })],
      ['activatedAt', value => ({ ...value, activatedAt: '2026-01-10T10:00:00.000Z' })],
      ['allowedContentTypes', value => ({ ...value, allowedContentTypes: ['faq'] })],
      ['allowedLanguages', value => ({ ...value, allowedLanguages: ['en'] })],
      ['cadenceDays', value => ({ ...value, cadenceDays: 7 as const })],
      ['allowedTargetIds', value => ({ ...value, allowedTargetIds: ['other-target'] })],
      ['evidenceFreshnessHours', value => ({ ...value, evidenceFreshnessHours: 24 })],
      ['maximumRiskLevel', value => ({ ...value, maximumRiskLevel: 'low' as const })],
      ['requiredQualityGateVersion', value => ({ ...value, requiredQualityGateVersion: 'other-gate' })],
      ['allowedProviderModels', value => ({ ...value, allowedProviderModels: ['other:model'] })],
      ['requireApprovedForDelivery', value => ({ ...value, requireApprovedForDelivery: !value.requireApprovedForDelivery })],
      ['requirePassedRiskGate', value => ({ ...value, requirePassedRiskGate: false as never })],
    ]
    for (const [field, mutate] of mutations) {
      const tampered = mutate(original)
      expect(validateOwnerAutopilotPolicyIntegrity(tampered), field).toBe(false)
      expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: tampered }).code, field).toBe('AUTOPILOT_POLICY_INVALID')
    }
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: { ...original, status: 'paused' } }).code).toBe('AUTOPILOT_POLICY_PAUSED')
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: { ...original, status: 'revoked', revokedAt: '2026-01-10T11:00:00.000Z' } }).code).toBe('AUTOPILOT_POLICY_REVOKED')
  })
})
