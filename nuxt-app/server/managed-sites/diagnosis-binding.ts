import { createError } from 'h3'
import { and, eq } from 'drizzle-orm'
import { requireAuditDatabase } from '../audit/repository'
import { seoGeoDiagnoses } from '../database/schema'
import { resolveApprovedEvidenceSnapshot, type EvidenceSnapshot } from '../seo-geo-core/repository'
import type { DiagnosisFinding, DiagnosisResult, EvidenceRef } from '../seo-geo-core/contracts'
import { assertExistingSiteUrl } from './site-spec'

export type ExistingSiteDiagnosisInput = {
  existingSiteUrl: string
  diagnosisId: number
  findingIds?: string[]
}

export type ExistingSiteDiagnosisResolution = {
  diagnosisId: number
  normalizedSiteUrl: string
  findings: DiagnosisFinding[]
  limitations: string[]
  engine: DiagnosisResult['engine']
  evidenceSnapshot: EvidenceSnapshot
}

export type ExistingSiteDiagnosisResolver = {
  resolve(ownerUserId: number, input: ExistingSiteDiagnosisInput): Promise<ExistingSiteDiagnosisResolution>
}

export const FAIL_CLOSED_EXISTING_SITE_DIAGNOSIS_RESOLVER: ExistingSiteDiagnosisResolver = {
  async resolve() {
    throw createError({ statusCode: 503, statusMessage: 'Existing-site Diagnosis is not configured for this runtime.' })
  },
}

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function normalizeFindingIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) invalid('Diagnosis finding IDs are invalid.')
  const ids = value.map(item => item.trim())
  if (new Set(ids).size !== ids.length) invalid('Diagnosis finding IDs must be unique.')
  return ids
}

function diagnosisResult(value: unknown): DiagnosisResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Stored Diagnosis result is invalid.')
  const result = value as Partial<DiagnosisResult>
  if (!['completed', 'needs_human_review'].includes(result.status || '') || !['deterministic-diagnosis-v1', 'approved-model-not-ready'].includes(result.engine || '') || !Array.isArray(result.findings)) conflict('Stored Diagnosis is stale, blocked, or not ready for existing-site generation.')
  if (result.engine === 'approved-model-not-ready') conflict('Stored Diagnosis has no approved model or deterministic result.')
  return result as DiagnosisResult
}

function diagnosisEvidence(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0) invalid('Stored Diagnosis has no canonical evidence references.')
  const refs = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(`Stored Diagnosis evidence reference ${index + 1} is invalid.`)
    const ref = item as EvidenceRef
    if (!Number.isSafeInteger(ref.sourceId) || (ref.sourceId as number) < 1 || (ref.artifactId !== undefined && (!Number.isSafeInteger(ref.artifactId) || (ref.artifactId as number) < 1)) || typeof ref.reason !== 'string') invalid(`Stored Diagnosis evidence reference ${index + 1} is invalid.`)
    return { sourceId: ref.sourceId, artifactId: ref.artifactId, locator: ref.locator, artifactHash: ref.artifactHash, reason: ref.reason }
  })
  const identities = refs.map(ref => `${ref.sourceId}:${ref.artifactId ?? 'none'}`)
  if (new Set(identities).size !== identities.length) conflict('Stored Diagnosis contains duplicate evidence identity.')
  return refs
}

function findingUrlMatches(findings: DiagnosisFinding[], normalizedSiteUrl: string): boolean {
  return findings.some(finding => finding.affectedUrls.some(url => {
    try { return assertExistingSiteUrl(url) === normalizedSiteUrl } catch { return false }
  }))
}

export const databaseExistingSiteDiagnosisResolver: ExistingSiteDiagnosisResolver = {
  async resolve(ownerUserId, input) {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) invalid('Diagnosis owner identity is invalid.')
    if (!Number.isSafeInteger(input.diagnosisId) || input.diagnosisId < 1) invalid('Diagnosis ID is invalid.')
    const normalizedSiteUrl = assertExistingSiteUrl(input.existingSiteUrl)
    const findingIds = normalizeFindingIds(input.findingIds)
    const database = requireAuditDatabase()
    const [diagnosis] = await database.select().from(seoGeoDiagnoses).where(and(eq(seoGeoDiagnoses.id, input.diagnosisId), eq(seoGeoDiagnoses.ownerUserId, ownerUserId))).limit(1)
    if (!diagnosis) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped Diagnosis was not found.' })
    const result = diagnosisResult(diagnosis.result)
    const findings = result.findings
    if (!findingUrlMatches(findings, normalizedSiteUrl)) conflict('Stored Diagnosis URL does not match the requested existing site URL.')
    const selectedFindings = findingIds ? findingIds.map(id => findings.find(finding => finding.id === id)).filter((finding): finding is DiagnosisFinding => Boolean(finding)) : findings
    if (findingIds && selectedFindings.length !== findingIds.length) conflict('Requested Diagnosis finding IDs do not belong to the stored Diagnosis.')
    const evidenceRefs = diagnosisEvidence(diagnosis.evidenceRefs)
    const evidenceSnapshot = await resolveApprovedEvidenceSnapshot(ownerUserId, evidenceRefs, ['diagnosis', 'recommendation', 'content_draft'], { requireArtifact: true })
    return { diagnosisId: diagnosis.id, normalizedSiteUrl, findings: selectedFindings, limitations: [...result.limitations, ...selectedFindings.flatMap(finding => finding.limitations)].filter((value, index, list) => typeof value === 'string' && value.trim() && list.indexOf(value) === index).slice(0, 24), engine: result.engine, evidenceSnapshot }
  },
}
