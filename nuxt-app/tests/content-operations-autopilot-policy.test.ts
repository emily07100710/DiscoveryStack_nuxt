import { describe, expect, it } from 'vitest'
import { enableOwnerAutopilotPolicy, evaluateOwnerAutopilotPolicy, revokeOwnerAutopilotPolicy } from '../server/content-operations/autopilot-policy'

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

function policy() { return enableOwnerAutopilotPolicy(basePolicyInput) }
function evaluation(overrides: Record<string, unknown> = {}) {
  return evaluateOwnerAutopilotPolicy({ policy: policy(), ownerUserId: 7, clientId: 11, targetRowId: 13, targetId: 'target-1', targetStatus: 'active', targetExecutionEnabled: true, entry: { status: 'ready_to_publish', contentType: 'article', language: 'zh-hant' }, entryCadenceDays: 3, reviewDecision: 'approved_for_delivery', riskGateStatus: 'passed', qualityGateVersion: 'content-risk-gate-v1', evidenceApproved: true, evidenceCapturedAt: '2026-01-10T09:00:00.000Z', providerExecution: true, providerModel: 'bailian:qwen-plus', providerProvenanceComplete: true, unsupportedFactualClaim: false, contentHashMatchesDraft: true, now: new Date('2026-01-10T10:00:00.000Z'), ...overrides })
}

describe('governed owner autopilot policy', () => {
  it('creates a deterministic owner-scoped policy without credential material', () => {
    const first = policy()
    const second = policy()
    expect(first).toEqual(second)
    expect(first.policyVersion).toBe('governed-autopilot-policy-v2')
    expect(first.policyId).toMatch(/^autopilot-[a-f0-9]{32}$/)
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
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: { ...policy(), requireApprovedForDelivery: true }, reviewDecision: 'approved_for_preview' }).code).toBe('AUTOPILOT_REVIEW_REQUIRED')
    expect(evaluation({ riskGateStatus: 'needs_review' }).code).toBe('AUTOPILOT_RISK_GATE_REQUIRED')
  })

  it('denies missing, paused, expired, future, and revoked policies fail-closed', () => {
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: null }).code).toBe('AUTOPILOT_NOT_AUTHORIZED')
    expect(evaluation({ now: new Date('2026-01-12T00:00:00.000Z') }).code).toBe('AUTOPILOT_POLICY_EXPIRED')
    expect(evaluation({ now: new Date('2026-01-10T08:00:00.000Z') }).code).toBe('AUTOPILOT_POLICY_NOT_YET_ACTIVE')
    const paused = { ...policy(), status: 'paused' as const }
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: paused }).code).toBe('AUTOPILOT_POLICY_PAUSED')
    const revoked = revokeOwnerAutopilotPolicy(policy(), 7, '2026-01-10T11:00:00.000Z')
    expect(evaluateOwnerAutopilotPolicy({ ...evaluationInput(), policy: revoked }).code).toBe('AUTOPILOT_POLICY_REVOKED')
    expect(() => revokeOwnerAutopilotPolicy(policy(), 8, '2026-01-10T11:00:00.000Z')).toThrow(/authorized owner/)
  })

  it('requires publication-ready durable state and self-authorization', () => {
    expect(evaluation({ entry: { status: 'awaiting_review', contentType: 'article', language: 'zh-hant' } }).code).toBe('AUTOPILOT_ENTRY_NOT_READY')
    expect(() => enableOwnerAutopilotPolicy({ ...basePolicyInput, authorizedByOwnerUserId: 8 })).toThrow(/self-authorized/)
    expect(() => enableOwnerAutopilotPolicy({ ...basePolicyInput, expiresAt: basePolicyInput.authorizedAt })).toThrow(/expire/)
  })
})

function evaluationInput() {
  return { ownerUserId: 7, clientId: 11, targetRowId: 13, targetId: 'target-1', targetStatus: 'active' as const, targetExecutionEnabled: true, entry: { status: 'ready_to_publish' as const, contentType: 'article' as const, language: 'zh-hant' as const }, entryCadenceDays: 3, reviewDecision: 'approved_for_delivery', riskGateStatus: 'passed', qualityGateVersion: 'content-risk-gate-v1', evidenceApproved: true, evidenceCapturedAt: '2026-01-10T09:00:00.000Z', providerExecution: true, providerModel: 'bailian:qwen-plus', providerProvenanceComplete: true, unsupportedFactualClaim: false, contentHashMatchesDraft: true, now: new Date('2026-01-10T10:00:00.000Z') }
}
