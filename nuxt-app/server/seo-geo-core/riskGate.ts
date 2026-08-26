import { createHash } from 'node:crypto'
import { AutoGeoUnsafeOutputError, assertSourceBoundRewrite } from '../geo/output-safety'
import type { GeoDocumentInput } from '../geo/contracts'
import { CONTENT_RISK_GATE_VERSION, type ContentRiskGateResult, type RiskFinding } from './contracts'

const prohibitedPromise = /(?:保證|保證會|一定能|必然|guarantee(?:d)?|will definitely|assured results?)/iu
const prohibitedMeasurementClaim = /(?:排名第[一1]|第一名|top\s?\d+|流量提升|轉換提升|營收提升|roi\s?(?:提升|improvement)|ranked?\s?(?:#?1|top))/iu

export function contentFingerprint(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex')
}

export function evaluateContentRisk(input: { source: GeoDocumentInput, candidateTitle: string, candidateBody: string, evidenceCount: number }): ContentRiskGateResult {
  const findings: RiskFinding[] = []
  if (!input.candidateTitle.trim() || !input.candidateBody.trim()) {
    findings.push({ id: 'empty_candidate', severity: 'blocking', message: '候選內容缺少標題或正文，不能預覽或交付。' })
  }
  if (!input.evidenceCount) {
    findings.push({ id: 'missing_evidence', severity: 'blocking', message: '沒有已核准 evidence reference，不能將草稿視為可交付內容。', evidenceRequired: true })
  }
  try {
    assertSourceBoundRewrite(input.source, input.candidateTitle, input.candidateBody)
  } catch (error) {
    if (error instanceof AutoGeoUnsafeOutputError) {
      findings.push({ id: 'source_bound_claim_rejected', severity: 'blocking', message: `草稿含有原文未支持的商業或客戶成效主張：${error.findingIds.join(', ')}。`, evidenceRequired: true })
    } else {
      findings.push({ id: 'source_bound_validation_failed', severity: 'blocking', message: '無法完成來源約束驗證，因此安全地阻擋此草稿。' })
    }
  }
  const candidate = `${input.candidateTitle}\n${input.candidateBody}`
  if (prohibitedPromise.test(candidate)) findings.push({ id: 'guaranteed_outcome', severity: 'blocking', message: '草稿包含保證性結果語言，不能交付。' })
  if (prohibitedMeasurementClaim.test(candidate)) findings.push({ id: 'unsupported_performance_measurement', severity: 'blocking', message: '草稿包含排名、流量、轉換或 ROI 成效語言；必須移除，或在審核中提供明確可驗證來源。', evidenceRequired: true })
  if (input.candidateBody.length < 180) findings.push({ id: 'thin_content_candidate', severity: 'review', message: '候選稿偏短，請人工確認是否足以回應既定受眾與問題。' })
  const hasBlocking = findings.some(finding => finding.severity === 'blocking')
  const hasReview = findings.some(finding => finding.severity === 'review')
  const riskLevel = hasBlocking ? 'high' : hasReview ? 'general' : 'low'
  return {
    gateVersion: CONTENT_RISK_GATE_VERSION,
    status: hasBlocking ? 'blocked' : hasReview ? 'needs_human_review' : 'passed',
    riskLevel,
    findings,
    publicationNotice: '通過本 gate 不等於自動核准、發布或外部成效；仍須人工 review、明確核准與受控 delivery adapter。',
  }
}
