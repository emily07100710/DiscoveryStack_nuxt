import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { contentQualityInputSchema } from './schemas'
import { CONTENT_QUALITY_CONTRACT_VERSION, type ApprovedEvidenceChunk, type AuthoritySource, type ContentQualityInput, type ProviderProvenance, type RetrievalPlan } from './types'
import type { ReasonCode } from './reason-codes'
import { SHA256_HEX, ISO_TIMESTAMP } from './schemas'
import { resolveCanonicalGeoRules } from '../geo/rules'

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
    const delta = left.charCodeAt(index) - right.charCodeAt(index)
    if (delta !== 0) return delta
  }
  return left.length - right.length
}

export function uniqueSorted(values: readonly string[], reasonCode: ReasonCode = 'INVALID_INPUT'): string[] {
  const output = [...values].sort(codeUnitCompare)
  for (let index = 1; index < output.length; index += 1) if (output[index] === output[index - 1]) throw new NormalizationIssue(reasonCode)
  return output
}

export function dedupeSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(codeUnitCompare) }

export function sha256Utf8(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

export function normalizeSha256(value: unknown, reasonCode: ReasonCode = 'INVALID_HASH'): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value.toLowerCase())) throw new NormalizationIssue(reasonCode)
  return value.toLowerCase()
}

export function normalizeWhitespaceText(value: unknown, maxLength: number, reasonCode: ReasonCode = 'INVALID_INPUT'): string {
  if (typeof value !== 'string') throw new NormalizationIssue(value === undefined || value === null ? 'EMPTY_REQUIRED_FIELD' : reasonCode)
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (!normalized || normalized.length > maxLength) throw new NormalizationIssue(value.trim() ? reasonCode : 'EMPTY_REQUIRED_FIELD')
  return normalized
}

function parseTimestamp(value: string): Date {
  if (!ISO_TIMESTAMP.test(value)) throw new NormalizationIssue('INVALID_TIMESTAMP')
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
  const offsetSign = timezone === 'Z' ? 1 : timezone[0] === '-' ? -1 : 1
  const offsetHours = timezone === 'Z' ? 0 : Number(timezone.slice(1, 3))
  const offsetMinutes = timezone === 'Z' ? 0 : Number(timezone.slice(4, 6))
  const offsetTotalMinutes = offsetHours * 60 + offsetMinutes
  if (year < 0 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) throw new NormalizationIssue('INVALID_TIMESTAMP')
  const base = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millis))
  base.setUTCFullYear(year)
  const offset = timezone === 'Z' ? 0 : offsetTotalMinutes * offsetSign
  const date = new Date(base.getTime() - offset * 60_000)
  if (!Number.isFinite(date.getTime())) throw new NormalizationIssue('INVALID_TIMESTAMP')
  const local = new Date(date.getTime() + offset * 60_000)
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second || local.getUTCMilliseconds() !== millis) throw new NormalizationIssue('INVALID_TIMESTAMP')
  return date
}

export function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new NormalizationIssue('INVALID_TIMESTAMP')
  return parseTimestamp(value).toISOString()
}

function isForbiddenQueryName(name: string): boolean { return ['token', 'secret', 'key', 'api_key', 'apikey', 'access_token', 'signature', 'sig', 'credential', 'password'].includes(name.normalize('NFKC').toLowerCase()) }

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const first = octets[0]!
  const second = octets[1]!
  const third = octets[2]!
  return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 0 && (third === 0 || third === 2)) || (first === 192 && second === 168) || (first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)) || (first === 203 && second === 0 && third === 113) || first >= 224
}

function isPublicHttps(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return false
    for (const key of url.searchParams.keys()) {
      let decoded = key
      try { decoded = decodeURIComponent(key) } catch { return false }
      if (isForbiddenQueryName(decoded)) return false
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname === 'internal' || hostname.endsWith('.onion') || hostname === 'onion' || hostname === '0.0.0.0' || (!hostname.includes('.') && isIP(hostname) === 0)) return false
    const ipVersion = isIP(hostname)
    if (ipVersion === 4 && isPrivateIpv4(hostname)) return false
    if (ipVersion === 6 && (hostname.startsWith('::ffff:') || hostname === '::' || hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb') || hostname.startsWith('ff') || hostname.startsWith('2001:db8') || hostname.startsWith('2001:0000') || hostname.startsWith('2001:2:') || hostname.startsWith('100:'))) return false
    return true
  } catch { return false }
}

function normalizeLocator(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !isPublicHttps(value)) throw new NormalizationIssue('INVALID_INPUT')
  return value
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new NormalizationIssue('INVALID_INPUT')
  return value
}

function normalizeIdList(value: unknown, max: number, duplicateReason: ReasonCode = 'DUPLICATE_EVIDENCE'): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string')) throw new NormalizationIssue('INVALID_INPUT')
  return uniqueSorted(value as string[], duplicateReason)
}

function normalizeOrderedIdList(value: unknown, max: number, duplicateReason: ReasonCode): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string')) throw new NormalizationIssue('INVALID_INPUT')
  const ids = (value as unknown[]).map(normalizeId)
  if (new Set(ids).size !== ids.length) throw new NormalizationIssue(duplicateReason)
  return ids
}

function normalizePurposes(value: unknown): string[] {
  const purposes = normalizeIdList(value, 12)
  if (!purposes.includes('content_draft')) throw new NormalizationIssue('EVIDENCE_PURPOSE_NOT_ALLOWED')
  return purposes
}

export function normalizeApprovedEvidenceChunk(value: unknown, evidenceSnapshotHash: string): ApprovedEvidenceChunk {
  const normalizedSnapshot = normalizeSha256(evidenceSnapshotHash)
  const expected = ['sourceId', 'artifactId', 'chunkId', 'sourceType', 'title', 'locator', 'artifactHash', 'chunkHash', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'reviewedText', 'approvedPurposes', 'capturedAt', 'reviewStatus'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  const reviewStatus = readField(value, 'reviewStatus')
  if (reviewStatus === 'stale' || reviewStatus === 'revoked' || reviewStatus === 'removed') throw new NormalizationIssue('STALE_EVIDENCE')
  if (reviewStatus !== 'approved') throw new NormalizationIssue('EVIDENCE_NOT_APPROVED')
  const reviewedText = readField(value, 'reviewedText')
  if (typeof reviewedText !== 'string' || !reviewedText.length || reviewedText.length > 12000 || reviewedText.includes('\u0000')) throw new NormalizationIssue('EMPTY_REQUIRED_FIELD')
  const chunkHash = normalizeSha256(readField(value, 'chunkHash'), 'EVIDENCE_CHUNK_HASH_MISMATCH')
  if (chunkHash !== sha256Utf8(reviewedText)) throw new NormalizationIssue('EVIDENCE_CHUNK_HASH_MISMATCH')
  const chunkSnapshot = normalizeSha256(readField(value, 'evidenceSnapshotHash'))
  if (chunkSnapshot !== normalizedSnapshot) throw new NormalizationIssue('EVIDENCE_SNAPSHOT_MISMATCH')
  const sourceType = readField(value, 'sourceType')
  if (!['first_party', 'authority', 'research', 'documentation', 'regulatory', 'other'].includes(sourceType as string)) throw new NormalizationIssue('INVALID_INPUT')
  const approvedPurposes = normalizePurposes(readField(value, 'approvedPurposes'))
  return { sourceId: normalizeId(readField(value, 'sourceId')), artifactId: normalizeId(readField(value, 'artifactId')), chunkId: normalizeId(readField(value, 'chunkId')), sourceType: sourceType as ApprovedEvidenceChunk['sourceType'], title: normalizeWhitespaceText(readField(value, 'title'), 10000), locator: normalizeLocator(readField(value, 'locator')), artifactHash: normalizeSha256(readField(value, 'artifactHash')), chunkHash, corpusSnapshotHash: normalizeSha256(readField(value, 'corpusSnapshotHash')), evidenceSnapshotHash: chunkSnapshot, reviewedText, approvedPurposes, capturedAt: normalizeTimestamp(readField(value, 'capturedAt')), reviewStatus: 'approved' }
}

function normalizeAuthoritySource(value: unknown): AuthoritySource {
  const expected = ['sourceId', 'artifactId', 'title', 'locator', 'sourceHash', 'capturedAt', 'reviewStatus'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  if (readField(value, 'reviewStatus') !== 'approved') throw new NormalizationIssue('EVIDENCE_NOT_APPROVED')
  return { sourceId: normalizeId(readField(value, 'sourceId')), artifactId: normalizeId(readField(value, 'artifactId')), title: normalizeWhitespaceText(readField(value, 'title'), 10000), locator: normalizeLocator(readField(value, 'locator')), sourceHash: normalizeSha256(readField(value, 'sourceHash')), capturedAt: normalizeTimestamp(readField(value, 'capturedAt')), reviewStatus: 'approved' }
}

export function normalizeRetrievalPlan(value: unknown): RetrievalPlan {
  const expected = ['retrievalVersion', 'queryFingerprint', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'topK', 'allowedSourceIds', 'allowedArtifactIds', 'requiredPurposes'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  const topK = readField(value, 'topK')
  if (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 20) throw new NormalizationIssue('LIMIT_EXCEEDED')
  if (readField(value, 'retrievalVersion') !== 'geo-content-quality-retrieval-v1') throw new NormalizationIssue('INVALID_INPUT')
  return { retrievalVersion: 'geo-content-quality-retrieval-v1', queryFingerprint: normalizeSha256(readField(value, 'queryFingerprint')), corpusSnapshotHash: normalizeSha256(readField(value, 'corpusSnapshotHash')), evidenceSnapshotHash: normalizeSha256(readField(value, 'evidenceSnapshotHash')), topK, allowedSourceIds: normalizeIdList(readField(value, 'allowedSourceIds'), 100), allowedArtifactIds: normalizeIdList(readField(value, 'allowedArtifactIds'), 100), requiredPurposes: normalizePurposes(readField(value, 'requiredPurposes')) }
}

function normalizeProvenance(value: unknown): ProviderProvenance {
  const expected = ['provider', 'model', 'requestId', 'providerVersion', 'generationMode', 'requestedAt', 'generatedAt'] as const
  if (!hasExactKeys(value, expected)) throw new NormalizationIssue('UNKNOWN_FIELD')
  return { provider: normalizeId(readField(value, 'provider')), model: normalizeId(readField(value, 'model')), requestId: normalizeId(readField(value, 'requestId')), providerVersion: normalizeId(readField(value, 'providerVersion')), generationMode: normalizeId(readField(value, 'generationMode')), requestedAt: normalizeTimestamp(readField(value, 'requestedAt')), generatedAt: normalizeTimestamp(readField(value, 'generatedAt')) }
}

export function canonicalQueryPayload(input: Pick<ContentQualityInput, 'topic' | 'workingTitle' | 'primaryQuestion' | 'audience' | 'goals' | 'language'>): string {
  return JSON.stringify({ topic: input.topic, workingTitle: input.workingTitle, primaryQuestion: input.primaryQuestion, audience: input.audience, goals: input.goals, language: input.language })
}

export function queryFingerprintForFields(input: Pick<ContentQualityInput, 'topic' | 'workingTitle' | 'primaryQuestion' | 'audience' | 'goals' | 'language'>): string { return sha256Utf8(canonicalQueryPayload(input)) }

function mapSchemaIssue(error: unknown): ReasonCode {
  if (!isRecord(error) || !Array.isArray(error.issues)) return 'INVALID_INPUT'
  const issues = error.issues as Array<Record<string, unknown>>
  if (issues.some(issue => issue.code === 'unrecognized_keys')) return 'UNKNOWN_FIELD'
  if (issues.some(issue => issue.code === 'too_big')) return 'LIMIT_EXCEEDED'
  const paths = issues.map(issue => Array.isArray(issue.path) ? issue.path.map(String) : [])
  if (paths.some(path => path.some(segment => ['requestedAt', 'capturedAt', 'generatedAt'].includes(segment)))) return 'INVALID_TIMESTAMP'
  if (paths.some(path => path.some(segment => ['artifactHash', 'chunkHash', 'evidenceSnapshotHash', 'sourceHash'].includes(segment)))) return 'INVALID_HASH'
  if (paths.some(path => path.some(segment => ['topic', 'workingTitle', 'primaryQuestion'].includes(segment)))) return 'EMPTY_REQUIRED_FIELD'
  return 'INVALID_INPUT'
}

export function normalizeContentQualityInput(value: unknown): NormalizationResult {
  try {
    if (!isRecord(value)) return { status: 'invalid', input: null, reasonCodes: ['INVALID_INPUT'] }
    const rawChunks = readField(value, 'approvedEvidenceChunks')
    if (Array.isArray(rawChunks)) {
      for (const rawChunk of rawChunks) {
        if (!isRecord(rawChunk)) continue
        const rawStatus = readField(rawChunk, 'reviewStatus')
        if (rawStatus === 'stale' || rawStatus === 'revoked' || rawStatus === 'removed') return { status: 'invalid', input: null, reasonCodes: ['STALE_EVIDENCE'] }
        if (rawStatus !== 'approved') return { status: 'invalid', input: null, reasonCodes: ['EVIDENCE_NOT_APPROVED'] }
        const rawPurposes = readField(rawChunk, 'approvedPurposes')
        if (Array.isArray(rawPurposes) && !rawPurposes.includes('content_draft')) return { status: 'invalid', input: null, reasonCodes: ['EVIDENCE_PURPOSE_NOT_ALLOWED'] }
      }
    }
    const rawRetrieval = readField(value, 'retrievalPlan')
    if (isRecord(rawRetrieval)) {
      const rawTopK = readField(rawRetrieval, 'topK')
      if (typeof rawTopK === 'number' && (!Number.isInteger(rawTopK) || rawTopK < 1 || rawTopK > 20)) return { status: 'invalid', input: null, reasonCodes: ['LIMIT_EXCEEDED'] }
    }
    const parsed = contentQualityInputSchema.safeParse(value)
    if (!parsed.success) return { status: 'invalid', input: null, reasonCodes: [mapSchemaIssue(parsed.error)] }
    const expected = ['contractVersion', 'ownerUserId', 'clientId', 'briefId', 'jobId', 'topic', 'workingTitle', 'primaryQuestion', 'contentType', 'language', 'industryRisk', 'audience', 'brandVoice', 'goals', 'constraints', 'selectedRuleIds', 'evidenceSnapshotHash', 'approvedEvidenceChunks', 'authoritySources', 'retrievalPlan', 'providerProvenance', 'requestedAt'] as const
    if (!hasExactKeys(value, expected)) return { status: 'invalid', input: null, reasonCodes: ['UNKNOWN_FIELD'] }
    const requestedAt = normalizeTimestamp(readField(value, 'requestedAt'))
    const evidenceSnapshotHash = normalizeSha256(readField(value, 'evidenceSnapshotHash'))
    const chunksRaw = readField(value, 'approvedEvidenceChunks')
    if (!Array.isArray(chunksRaw)) throw new NormalizationIssue('INVALID_INPUT')
    const chunks = chunksRaw.map(chunk => normalizeApprovedEvidenceChunk(chunk, evidenceSnapshotHash))
    if (chunks.reduce((total, chunk) => total + chunk.reviewedText.length, 0) > 50000) throw new NormalizationIssue('LIMIT_EXCEEDED')
    for (const chunk of chunks) if (Date.parse(chunk.capturedAt) > Date.parse(requestedAt)) throw new NormalizationIssue('FUTURE_EVIDENCE')
    const identities = chunks.map(chunk => `${chunk.sourceId}|${chunk.artifactId}|${chunk.chunkId}`)
    if (new Set(identities).size !== identities.length) throw new NormalizationIssue('DUPLICATE_EVIDENCE')
    const authorityRaw = readField(value, 'authoritySources')
    if (!Array.isArray(authorityRaw)) throw new NormalizationIssue('INVALID_INPUT')
    const authoritySources = authorityRaw.map(normalizeAuthoritySource)
    for (const source of authoritySources) if (Date.parse(source.capturedAt) > Date.parse(requestedAt)) throw new NormalizationIssue('FUTURE_EVIDENCE')
    const authorityIdentities = authoritySources.map(source => `${source.sourceId}|${source.artifactId}`)
    if (new Set(authorityIdentities).size !== authorityIdentities.length) throw new NormalizationIssue('DUPLICATE_EVIDENCE')
    const topic = normalizeWhitespaceText(readField(value, 'topic'), 500)
    const workingTitle = normalizeWhitespaceText(readField(value, 'workingTitle'), 300)
    const primaryQuestion = normalizeWhitespaceText(readField(value, 'primaryQuestion'), 500)
    const audience = normalizeWhitespaceText(readField(value, 'audience'), 10000)
    const brandVoice = normalizeWhitespaceText(readField(value, 'brandVoice'), 10000)
    const goalsRaw = readField(value, 'goals')
    const constraintsRaw = readField(value, 'constraints')
    if (!Array.isArray(goalsRaw) || !Array.isArray(constraintsRaw)) throw new NormalizationIssue('INVALID_INPUT')
    const goals = goalsRaw.map(goal => normalizeWhitespaceText(goal, 10000))
    const constraints = constraintsRaw.map(constraint => normalizeWhitespaceText(constraint, 10000))
    const selectedRuleIdsRaw = readField(value, 'selectedRuleIds')
    const selectedRuleIds = normalizeOrderedIdList(selectedRuleIdsRaw, 40, 'RULE_CHECK_FAILED')
    try {
      const canonicalRules = resolveCanonicalGeoRules(selectedRuleIds)
      if (canonicalRules.length !== selectedRuleIds.length || canonicalRules.some((rule, index) => rule.id !== selectedRuleIds[index])) throw new Error('RULE_CHECK_FAILED')
    } catch {
      throw new NormalizationIssue('RULE_CHECK_FAILED')
    }
    const retrievalPlan = normalizeRetrievalPlan(readField(value, 'retrievalPlan'))
    const language = readField(value, 'language') as ContentQualityInput['language']
    const computedQueryFingerprint = queryFingerprintForFields({ topic, workingTitle, primaryQuestion, audience, goals, language })
    if (retrievalPlan.queryFingerprint !== computedQueryFingerprint) throw new NormalizationIssue('QUERY_FINGERPRINT_MISMATCH')
    if (retrievalPlan.evidenceSnapshotHash !== evidenceSnapshotHash) throw new NormalizationIssue('EVIDENCE_SNAPSHOT_MISMATCH')
    const providerProvenance = normalizeProvenance(readField(value, 'providerProvenance'))
    if (providerProvenance.requestedAt !== requestedAt) throw new NormalizationIssue('PROVIDER_PROVENANCE_INVALID')
    if (Date.parse(providerProvenance.generatedAt) < Date.parse(requestedAt)) throw new NormalizationIssue('INVALID_TIMESTAMP')
    const input: ContentQualityInput = { contractVersion: CONTENT_QUALITY_CONTRACT_VERSION, ownerUserId: normalizeId(readField(value, 'ownerUserId')), clientId: normalizeId(readField(value, 'clientId')), briefId: normalizeId(readField(value, 'briefId')), jobId: normalizeId(readField(value, 'jobId')), topic, workingTitle, primaryQuestion, contentType: readField(value, 'contentType') as ContentQualityInput['contentType'], language, industryRisk: readField(value, 'industryRisk') as ContentQualityInput['industryRisk'], audience, brandVoice, goals, constraints, selectedRuleIds, evidenceSnapshotHash, approvedEvidenceChunks: chunks.sort((left, right) => codeUnitCompare(`${left.sourceId}|${left.artifactId}|${left.chunkId}`, `${right.sourceId}|${right.artifactId}|${right.chunkId}`)), authoritySources: authoritySources.sort((left, right) => codeUnitCompare(`${left.sourceId}|${left.artifactId}`, `${right.sourceId}|${right.artifactId}`)), retrievalPlan: { ...retrievalPlan, queryFingerprint: computedQueryFingerprint }, providerProvenance, requestedAt }
    return { status: 'valid', input, reasonCodes: [] }
  } catch (error: unknown) {
    return { status: 'invalid', input: null, reasonCodes: [error instanceof NormalizationIssue ? error.reasonCode : 'INVALID_INPUT'] }
  }
}
