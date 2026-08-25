import { isIP } from 'node:net'
import { contentQualityInputSchema } from './schemas'
import { CONTENT_QUALITY_CONTRACT_VERSION, type ApprovedEvidenceChunk, type AuthoritySource, type ContentQualityInput, type ProviderProvenance, type RetrievalPlan } from './types'
import type { ReasonCode } from './reason-codes'
import { SHA256_HEX, ISO_TIMESTAMP } from './schemas'

export type NormalizationResult =
  | { status: 'valid', input: ContentQualityInput, reasonCodes: [] }
  | { status: 'invalid', input: null, reasonCodes: ReasonCode[] }

export class NormalizationIssue extends Error {
  constructor(readonly reasonCode: ReasonCode) {
    super(reasonCode)
    this.name = 'NormalizationIssue'
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function ownKeys(value: unknown): (string | symbol)[] {
  if (!isRecord(value)) throw new NormalizationIssue('INVALID_INPUT')
  try { return Reflect.ownKeys(value) } catch { throw new NormalizationIssue('INVALID_INPUT') }
}

export function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  try {
    const keys = ownKeys(value)
    return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
  } catch { return false }
}

export function readField(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new NormalizationIssue('INVALID_INPUT')
  try { return value[key] } catch { throw new NormalizationIssue('INVALID_INPUT') }
}

export function codeUnitCompare(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    const leftCode = left.charCodeAt(index)
    const rightCode = right.charCodeAt(index)
    if (leftCode !== rightCode) return leftCode - rightCode
  }
  return left.length - right.length
}

export function uniqueSorted(values: readonly string[], reasonCode: ReasonCode = 'INVALID_INPUT'): string[] {
  const output = [...values].sort(codeUnitCompare)
  for (let index = 1; index < output.length; index += 1) if (output[index] === output[index - 1]) throw new NormalizationIssue(reasonCode)
  return output
}

export function normalizeSha256(value: unknown, reasonCode: ReasonCode = 'INVALID_HASH'): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) throw new NormalizationIssue(reasonCode)
  return value
}

export function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) throw new NormalizationIssue('INVALID_TIMESTAMP')
  const match = ISO_TIMESTAMP.exec(value)
  if (!match) throw new NormalizationIssue('INVALID_TIMESTAMP')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const millis = Number((match[7] || '0').padEnd(3, '0').slice(0, 3))
  const timezone = match[8]!
  const offsetHours = timezone === 'Z' ? 0 : Number(timezone.slice(0, 3))
  const offsetMinutes = timezone === 'Z' ? 0 : Number(timezone.slice(4))
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) throw new NormalizationIssue('INVALID_TIMESTAMP')
  const base = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millis))
  base.setUTCFullYear(year)
  const offset = timezone === 'Z' ? 0 : (offsetHours * 60 + offsetMinutes) * (timezone.startsWith('-') ? -1 : 1)
  const date = new Date(base.getTime() - offset * 60_000)
  if (!Number.isFinite(date.getTime())) throw new NormalizationIssue('INVALID_TIMESTAMP')
  const local = new Date(date.getTime() + offset * 60_000)
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second || local.getUTCMilliseconds() !== millis) throw new NormalizationIssue('INVALID_TIMESTAMP')
  return date.toISOString()
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new NormalizationIssue('INVALID_INPUT')
  return value
}

function normalizeText(value: unknown, maxLength: number, reasonCode: ReasonCode = 'INVALID_INPUT'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) throw new NormalizationIssue(value === undefined || value === null ? 'EMPTY_REQUIRED_FIELD' : reasonCode)
  return value
}

function isPublicHttps(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '0.0.0.0' || hostname === '::1') return false
    const ipVersion = isIP(hostname)
    if (ipVersion === 4) {
      const octets = hostname.split('.').map(Number)
      const first = octets[0] ?? -1
      const second = octets[1] ?? -1
      if (first === 10 || first === 127 || first === 0 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return false
    }
    if (ipVersion === 6 && (hostname === '::' || hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb') || hostname.startsWith('::ffff:10.') || hostname.startsWith('::ffff:127.') || hostname.startsWith('::ffff:192.168.') || hostname.startsWith('::ffff:172.'))) return false
    return true
  } catch { return false }
}

function normalizeLocator(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !isPublicHttps(value)) throw new NormalizationIssue('INVALID_INPUT')
  return value
}

function normalizePurposes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12 || value.some(item => typeof item !== 'string')) throw new NormalizationIssue('INVALID_INPUT')
  const purposes = uniqueSorted(value as string[])
  if (!purposes.includes('content_draft')) throw new NormalizationIssue('EVIDENCE_PURPOSE_NOT_ALLOWED')
  return purposes
}

export function normalizeApprovedEvidenceChunk(value: unknown, evidenceSnapshotHash: string): ApprovedEvidenceChunk {
  normalizeSha256(evidenceSnapshotHash)
  const expected = ['sourceId', 'artifactId', 'chunkId', 'sourceType', 'title', 'locator', 'artifactHash', 'chunkHash', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'reviewedText', 'approvedPurposes', 'capturedAt', 'reviewStatus'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  const sourceId = normalizeId(readField(value, 'sourceId'))
  const artifactId = normalizeId(readField(value, 'artifactId'))
  const chunkId = normalizeId(readField(value, 'chunkId'))
  const sourceType = readField(value, 'sourceType')
  if (!['first_party', 'authority', 'research', 'documentation', 'regulatory', 'other'].includes(sourceType as string)) throw new NormalizationIssue('INVALID_INPUT')
  const title = normalizeText(readField(value, 'title'), 10000)
  const locator = normalizeLocator(readField(value, 'locator'))
  const artifactHash = normalizeSha256(readField(value, 'artifactHash'))
  const chunkHash = normalizeSha256(readField(value, 'chunkHash'))
  const corpusSnapshotHash = normalizeSha256(readField(value, 'corpusSnapshotHash'))
  const chunkSnapshot = normalizeSha256(readField(value, 'evidenceSnapshotHash'))
  if (chunkSnapshot !== evidenceSnapshotHash) throw new NormalizationIssue('EVIDENCE_SNAPSHOT_MISMATCH')
  const reviewedText = normalizeText(readField(value, 'reviewedText'), 12000)
  const approvedPurposes = normalizePurposes(readField(value, 'approvedPurposes'))
  const capturedAt = normalizeTimestamp(readField(value, 'capturedAt'))
  if (readField(value, 'reviewStatus') !== 'approved') throw new NormalizationIssue(readField(value, 'reviewStatus') === 'stale' || readField(value, 'reviewStatus') === 'revoked' || readField(value, 'reviewStatus') === 'removed' ? 'STALE_EVIDENCE' : 'EVIDENCE_NOT_APPROVED')
  return { sourceId, artifactId, chunkId, sourceType: sourceType as ApprovedEvidenceChunk['sourceType'], title, locator, artifactHash, chunkHash, corpusSnapshotHash, evidenceSnapshotHash: chunkSnapshot, reviewedText, approvedPurposes, capturedAt, reviewStatus: 'approved' }
}

function normalizeAuthoritySource(value: unknown): AuthoritySource {
  const expected = ['sourceId', 'artifactId', 'title', 'locator', 'sourceHash', 'capturedAt', 'reviewStatus'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  const reviewStatus = readField(value, 'reviewStatus')
  if (reviewStatus !== 'approved') throw new NormalizationIssue('EVIDENCE_NOT_APPROVED')
  return {
    sourceId: normalizeId(readField(value, 'sourceId')),
    artifactId: normalizeId(readField(value, 'artifactId')),
    title: normalizeText(readField(value, 'title'), 10000),
    locator: normalizeLocator(readField(value, 'locator')),
    sourceHash: normalizeSha256(readField(value, 'sourceHash')),
    capturedAt: normalizeTimestamp(readField(value, 'capturedAt')),
    reviewStatus: 'approved',
  }
}

export function normalizeRetrievalPlan(value: unknown): RetrievalPlan {
  const expected = ['retrievalVersion', 'queryFingerprint', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'topK', 'allowedSourceIds', 'allowedArtifactIds', 'requiredPurposes'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  const topK = readField(value, 'topK')
  if (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 20) throw new NormalizationIssue('LIMIT_EXCEEDED')
  const normalizeIdList = (field: string, max: number): string[] => {
    const raw = readField(value, field)
    if (!Array.isArray(raw) || raw.length > max || raw.some(item => typeof item !== 'string')) throw new NormalizationIssue('INVALID_INPUT')
    return uniqueSorted(raw as string[], 'DUPLICATE_EVIDENCE')
  }
  const requiredPurposes = normalizePurposes(readField(value, 'requiredPurposes'))
  return {
    retrievalVersion: readField(value, 'retrievalVersion') === 'geo-content-quality-retrieval-v1' ? 'geo-content-quality-retrieval-v1' : (() => { throw new NormalizationIssue('INVALID_INPUT') })(),
    queryFingerprint: normalizeSha256(readField(value, 'queryFingerprint')),
    corpusSnapshotHash: normalizeSha256(readField(value, 'corpusSnapshotHash')),
    evidenceSnapshotHash: normalizeSha256(readField(value, 'evidenceSnapshotHash')),
    topK,
    allowedSourceIds: normalizeIdList('allowedSourceIds', 100),
    allowedArtifactIds: normalizeIdList('allowedArtifactIds', 100),
    requiredPurposes,
  }
}

function normalizeProvenance(value: unknown): ProviderProvenance {
  const expected = ['provider', 'model', 'providerVersion', 'generationMode', 'generatedAt'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  return {
    provider: normalizeId(readField(value, 'provider')),
    model: normalizeId(readField(value, 'model')),
    providerVersion: normalizeId(readField(value, 'providerVersion')),
    generationMode: normalizeId(readField(value, 'generationMode')),
    generatedAt: normalizeTimestamp(readField(value, 'generatedAt')),
  }
}

function mapSchemaIssue(error: unknown): ReasonCode {
  if (!isRecord(error) || !Array.isArray(error.issues)) return 'INVALID_INPUT'
  const issues = error.issues as Array<Record<string, unknown>>
  if (issues.some(issue => issue.code === 'unrecognized_keys')) return 'UNKNOWN_FIELD'
  if (issues.some(issue => issue.code === 'too_big')) return 'LIMIT_EXCEEDED'
  const paths = issues.map(issue => Array.isArray(issue.path) ? issue.path.map(String) : [])
  if (paths.some(path => path.some(segment => ['requestedAt', 'capturedAt', 'generatedAt'].includes(segment)))) return 'INVALID_TIMESTAMP'
  if (paths.some(path => path.some(segment => ['artifactHash', 'chunkHash', 'evidenceSnapshotHash', 'sourceHash'].includes(segment)))) return 'INVALID_HASH'
  return 'INVALID_INPUT'
}

export function normalizeContentQualityInput(value: unknown): NormalizationResult {
  try {
    if (isRecord(value)) {
      const chunksValue = value['approvedEvidenceChunks']
      if (Array.isArray(chunksValue)) {
        for (const chunk of chunksValue) {
          if (isRecord(chunk)) {
            const reviewStatus = readField(chunk, 'reviewStatus')
            if (reviewStatus === 'stale' || reviewStatus === 'revoked' || reviewStatus === 'removed') return { status: 'invalid', input: null, reasonCodes: ['STALE_EVIDENCE'] }
            if (reviewStatus !== 'approved') return { status: 'invalid', input: null, reasonCodes: ['EVIDENCE_NOT_APPROVED'] }
            const purposes = readField(chunk, 'approvedPurposes')
            if (Array.isArray(purposes) && !purposes.includes('content_draft')) return { status: 'invalid', input: null, reasonCodes: ['EVIDENCE_PURPOSE_NOT_ALLOWED'] }
          }
        }
      }
      const retrievalValue = value['retrievalPlan']
      if (isRecord(retrievalValue)) {
        const topK = readField(retrievalValue, 'topK')
        if (typeof topK === 'number' && (!Number.isInteger(topK) || topK < 1 || topK > 20)) return { status: 'invalid', input: null, reasonCodes: ['LIMIT_EXCEEDED'] }
      }
    }
    const parsed = contentQualityInputSchema.safeParse(value)
    if (!parsed.success) return { status: 'invalid', input: null, reasonCodes: [mapSchemaIssue(parsed.error)] }
    const expected = ['contractVersion', 'ownerUserId', 'clientId', 'briefId', 'jobId', 'contentType', 'language', 'industryRisk', 'audience', 'brandVoice', 'goals', 'constraints', 'selectedRuleIds', 'evidenceSnapshotHash', 'approvedEvidenceChunks', 'authoritySources', 'retrievalPlan', 'providerProvenance', 'requestedAt'] as const
    if (!hasExactKeys(value, expected)) return { status: 'invalid', input: null, reasonCodes: ['UNKNOWN_FIELD'] }
    const evidenceSnapshotHash = normalizeSha256(readField(value, 'evidenceSnapshotHash'))
    const chunksRaw = readField(value, 'approvedEvidenceChunks')
    if (!Array.isArray(chunksRaw)) throw new NormalizationIssue('INVALID_INPUT')
    const chunks = chunksRaw.map(chunk => normalizeApprovedEvidenceChunk(chunk, evidenceSnapshotHash))
    const identities = chunks.map(chunk => `${chunk.sourceId}|${chunk.artifactId}|${chunk.chunkId}`)
    if (new Set(identities).size !== identities.length) throw new NormalizationIssue('DUPLICATE_EVIDENCE')
    if (chunks.reduce((total, chunk) => total + chunk.reviewedText.length, 0) > 50000) throw new NormalizationIssue('LIMIT_EXCEEDED')
    const authorityRaw = readField(value, 'authoritySources')
    if (!Array.isArray(authorityRaw)) throw new NormalizationIssue('INVALID_INPUT')
    const authoritySources = authorityRaw.map(normalizeAuthoritySource)
    const authorityIdentities = authoritySources.map(source => `${source.sourceId}|${source.artifactId}`)
    if (new Set(authorityIdentities).size !== authorityIdentities.length) throw new NormalizationIssue('DUPLICATE_EVIDENCE')
    const retrievalPlan = normalizeRetrievalPlan(readField(value, 'retrievalPlan'))
    if (retrievalPlan.evidenceSnapshotHash !== evidenceSnapshotHash) throw new NormalizationIssue('EVIDENCE_SNAPSHOT_MISMATCH')
    const providerProvenance = normalizeProvenance(readField(value, 'providerProvenance'))
    const goals = [...(readField(value, 'goals') as string[])]
    const constraints = [...(readField(value, 'constraints') as string[])]
    const selectedRuleIds = uniqueSorted(readField(value, 'selectedRuleIds') as string[])
    const input: ContentQualityInput = {
      contractVersion: CONTENT_QUALITY_CONTRACT_VERSION,
      ownerUserId: normalizeId(readField(value, 'ownerUserId')),
      clientId: normalizeId(readField(value, 'clientId')),
      briefId: normalizeId(readField(value, 'briefId')),
      jobId: normalizeId(readField(value, 'jobId')),
      contentType: readField(value, 'contentType') as ContentQualityInput['contentType'],
      language: readField(value, 'language') as ContentQualityInput['language'],
      industryRisk: readField(value, 'industryRisk') as ContentQualityInput['industryRisk'],
      audience: normalizeText(readField(value, 'audience'), 10000),
      brandVoice: normalizeText(readField(value, 'brandVoice'), 10000),
      goals, constraints, selectedRuleIds, evidenceSnapshotHash,
      approvedEvidenceChunks: chunks.sort((left, right) => codeUnitCompare(`${left.sourceId}|${left.artifactId}|${left.chunkId}`, `${right.sourceId}|${right.artifactId}|${right.chunkId}`)),
      authoritySources: authoritySources.sort((left, right) => codeUnitCompare(`${left.sourceId}|${left.artifactId}`, `${right.sourceId}|${right.artifactId}`)),
      retrievalPlan,
      providerProvenance,
      requestedAt: normalizeTimestamp(readField(value, 'requestedAt')),
    }
    return { status: 'valid', input, reasonCodes: [] }
  } catch (error: unknown) {
    const reasonCode = error instanceof NormalizationIssue ? error.reasonCode : 'INVALID_INPUT'
    return { status: 'invalid', input: null, reasonCodes: [reasonCode] }
  }
}
