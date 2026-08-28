import { stableFingerprint } from './normalization'
import { V4_RISK_SEMANTICS_VERSION, type AutopilotBusinessRiskClass, type AutopilotRiskSeverity } from './balanced-autopilot'

export const AUTONOMOUS_RISK_SNAPSHOT_VERSION = 'autonomous-risk-snapshot-v1' as const

export type CanonicalAutonomousRiskSnapshot = {
  contractVersion: typeof AUTONOMOUS_RISK_SNAPSHOT_VERSION
  semanticsVersion: typeof V4_RISK_SEMANTICS_VERSION
  gateId: number
  gateVersion: string
  gateStatus: 'passed' | 'needs_human_review' | 'blocked'
  severity: AutopilotRiskSeverity
  businessClass: AutopilotBusinessRiskClass
  reasonCodes: string[]
  findingFingerprints: string[]
  draftId: number
  contentHash: string
  evidenceSnapshotHash: string
  fingerprint: string
}

type RiskFinding = { id?: unknown; severity?: unknown; message?: unknown; evidenceRequired?: unknown }

function record(value: unknown): RiskFinding { return value && typeof value === 'object' && !Array.isArray(value) ? value as RiskFinding : {} }
function text(value: unknown): string { return typeof value === 'string' ? value.normalize('NFKC').trim() : '' }
function reasonCode(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 120)
}

export function canonicalRiskSeverity(input: { gateStatus: unknown; riskLevel?: unknown; findings?: unknown }): AutopilotRiskSeverity {
  const legacy = text(input.riskLevel).toLowerCase()
  const findings = Array.isArray(input.findings) ? input.findings.map(record) : []
  const candidates: AutopilotRiskSeverity[] = [
    legacy === 'critical' ? 'critical' : legacy === 'high' ? 'high' : legacy === 'general' || legacy === 'moderate' ? 'moderate' : 'low',
    findings.some(finding => text(finding.severity).toLowerCase() === 'blocking') ? 'high' : findings.some(finding => text(finding.severity).toLowerCase() === 'review') ? 'moderate' : 'low',
    input.gateStatus === 'blocked' ? 'high' : input.gateStatus === 'needs_human_review' ? 'moderate' : 'low',
  ]
  const order: Record<AutopilotRiskSeverity, number> = { low: 0, moderate: 1, high: 2, critical: 3 }
  return candidates.sort((left, right) => order[right] - order[left])[0]!
}

export function canonicalBusinessRiskClass(findings: unknown): AutopilotBusinessRiskClass {
  const source = (Array.isArray(findings) ? findings : []).map(item => {
    const finding = record(item)
    return `${text(finding.id)} ${text(finding.message)}`
  }).join(' ').toLowerCase()
  if (/personal.?data|sensitive.?data|credential|secret|password|pii|個資|隱私|憑證/iu.test(source)) return 'sensitive_personal_data'
  if (/politic|election|campaign|選舉|政治/iu.test(source)) return 'political'
  if (/medical|diagnos|treat|health claim|醫療|診斷|治療/iu.test(source)) return 'medical'
  if (/legal|lawsuit|litigation|attorney|法律|訴訟/iu.test(source)) return 'legal'
  if (/financ|invest|securit|insurance|return guarantee|金融|投資|證券|保險|報酬/iu.test(source)) return 'financial'
  return 'general'
}

export function canonicalAutonomousRiskSnapshot(input: {
  gateId: unknown
  gateVersion: unknown
  gateStatus: unknown
  riskLevel?: unknown
  findings: unknown
  draftId: unknown
  contentHash: unknown
  evidenceSnapshotHash: unknown
}): CanonicalAutonomousRiskSnapshot {
  const gateId = Number(input.gateId)
  const draftId = Number(input.draftId)
  const gateVersion = text(input.gateVersion)
  const contentHash = text(input.contentHash)
  const evidenceSnapshotHash = text(input.evidenceSnapshotHash)
  if (!Number.isSafeInteger(gateId) || gateId < 1 || !Number.isSafeInteger(draftId) || draftId < 1 || !gateVersion || !['passed', 'needs_human_review', 'blocked'].includes(String(input.gateStatus)) || !/^[a-f0-9]{64}$/u.test(contentHash) || !/^[a-f0-9]{64}$/u.test(evidenceSnapshotHash)) throw new Error('Persisted autonomous risk lineage is malformed.')
  const findings = Array.isArray(input.findings) ? input.findings.map(record) : []
  const reasonCodes = [...new Set(findings.map(finding => reasonCode(finding.id)).filter(Boolean))].sort()
  const findingFingerprints = findings.map(finding => stableFingerprint({ id: text(finding.id), severity: text(finding.severity).toLowerCase(), message: text(finding.message), evidenceRequired: finding.evidenceRequired === true })).sort()
  const base = {
    contractVersion: AUTONOMOUS_RISK_SNAPSHOT_VERSION,
    semanticsVersion: V4_RISK_SEMANTICS_VERSION,
    gateId,
    gateVersion,
    gateStatus: input.gateStatus as CanonicalAutonomousRiskSnapshot['gateStatus'],
    severity: canonicalRiskSeverity({ gateStatus: input.gateStatus, riskLevel: input.riskLevel, findings }),
    businessClass: canonicalBusinessRiskClass(findings),
    reasonCodes,
    findingFingerprints,
    draftId,
    contentHash,
    evidenceSnapshotHash,
  }
  return { ...base, fingerprint: stableFingerprint(base) }
}

export function autonomousRiskSnapshotMatches(left: CanonicalAutonomousRiskSnapshot, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const right = value as Record<string, unknown>
  return right.contractVersion === left.contractVersion
    && right.semanticsVersion === left.semanticsVersion
    && right.gateId === left.gateId
    && right.gateVersion === left.gateVersion
    && right.gateStatus === left.gateStatus
    && right.severity === left.severity
    && right.businessClass === left.businessClass
    && JSON.stringify(right.reasonCodes) === JSON.stringify(left.reasonCodes)
    && JSON.stringify(right.findingFingerprints) === JSON.stringify(left.findingFingerprints)
    && right.draftId === left.draftId
    && right.contentHash === left.contentHash
    && right.evidenceSnapshotHash === left.evidenceSnapshotHash
    && right.fingerprint === left.fingerprint
}
