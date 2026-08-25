import { normalizeApprovedEvidenceChunk, normalizeContentQualityInput, normalizeRetrievalPlan, normalizeSha256, codeUnitCompare, NormalizationIssue, isRecord, readField, hasExactKeys, queryFingerprintForFields } from './normalization'
import { canonicalizeQualityValue, sha256Text } from './fingerprint'
import { RETRIEVAL_VERSION, LEXICAL_RETRIEVAL_SCORE_BASIS, type ApprovedEvidenceChunk, type ContentQualityInput, type RetrievalCandidate, type RetrievalPlan, type RetrievalResult, type RetrievedEvidenceChunk } from './types'
import type { ReasonCode } from './reason-codes'

const CANDIDATE_KEYS = ['chunk', 'limitations'] as const
const MINIMAL_CANDIDATE_KEYS = ['chunk'] as const
const PLAN_KEYS = ['retrievalVersion', 'queryFingerprint', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'topK', 'allowedSourceIds', 'allowedArtifactIds', 'requiredPurposes'] as const
const RETRIEVAL_RESULT_KEYS = ['status', 'retrievalVersion', 'queryFingerprint', 'retrievalFingerprint', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'chunks', 'reasonCodes', 'limitations'] as const
const RETRIEVED_CHUNK_KEYS = ['sourceId', 'artifactId', 'chunkId', 'sourceType', 'title', 'locator', 'artifactHash', 'chunkHash', 'corpusSnapshotHash', 'evidenceSnapshotHash', 'reviewedText', 'approvedPurposes', 'capturedAt', 'reviewStatus', 'matchedTokenCount', 'queryTokenCount', 'relevanceRatio', 'scoreBasis', 'limitations'] as const

function emptyResult(status: 'blocked' | 'not_ready', reasonCode: ReasonCode, plan?: RetrievalPlan, queryFingerprint = ''): RetrievalResult {
  return { status, retrievalVersion: RETRIEVAL_VERSION, queryFingerprint, retrievalFingerprint: null, corpusSnapshotHash: plan?.corpusSnapshotHash || '', evidenceSnapshotHash: plan?.evidenceSnapshotHash || '', chunks: [], reasonCodes: [reasonCode], limitations: ['Deterministic lexical evidence retrieval V1 did not create fallback context; human review is required.'] }
}

export function tokenizeLexical(value: unknown): string[] {
  if (typeof value !== 'string') throw new NormalizationIssue('INVALID_INPUT')
  const normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  const output: string[] = []
  const chars = Array.from(normalized)
  let index = 0
  while (index < chars.length) {
    const current = chars[index]!
    if (/\p{Script=Han}/u.test(current)) {
      const run: string[] = []
      while (index < chars.length && /\p{Script=Han}/u.test(chars[index]!)) run.push(chars[index++]!)
      if (run.length === 1) output.push(run[0]!)
      else for (let cursor = 0; cursor < run.length - 1; cursor += 1) output.push(`${run[cursor]}${run[cursor + 1]}`)
      continue
    }
    if (/[\p{L}\p{N}]/u.test(current)) {
      const run: string[] = []
      while (index < chars.length && /[\p{L}\p{N}]/u.test(chars[index]!) && !/\p{Script=Han}/u.test(chars[index]!)) run.push(chars[index++]!)
      const token = run.join('')
      const isPureNumber = run.length > 0 && run.every(char => /\p{N}/u.test(char))
      if (token.length >= 2 || isPureNumber) output.push(token)
      continue
    }
    index += 1
  }
  return [...new Set(output)].sort(codeUnitCompare)
}

function identity(chunk: Pick<ApprovedEvidenceChunk, 'sourceId' | 'artifactId' | 'chunkId'>): string { return `${chunk.sourceId}|${chunk.artifactId}|${chunk.chunkId}` }

function normalizeCandidate(value: unknown, evidenceSnapshotHash: string): RetrievalCandidate {
  if (!hasExactKeys(value, CANDIDATE_KEYS) && !hasExactKeys(value, MINIMAL_CANDIDATE_KEYS)) throw new NormalizationIssue('UNKNOWN_FIELD')
  const chunk = normalizeApprovedEvidenceChunk(readField(value, 'chunk'), evidenceSnapshotHash)
  const limitations = readField(value, 'limitations')
  if (limitations !== undefined && (!Array.isArray(limitations) || limitations.length > 10 || limitations.some(item => typeof item !== 'string' || item.length > 500))) throw new NormalizationIssue('INVALID_INPUT')
  return { chunk, limitations: limitations === undefined ? [] : [...limitations] as string[] }
}

function asPlan(value: unknown): RetrievalPlan | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, PLAN_KEYS)) return null
    return normalizeRetrievalPlan(value)
  } catch { return null }
}

function retrievalFingerprint(queryFingerprint: string, chunks: readonly RetrievedEvidenceChunk[], plan: RetrievalPlan): string {
  return sha256Text(canonicalizeQualityValue({ retrievalVersion: RETRIEVAL_VERSION, queryFingerprint, corpusSnapshotHash: plan.corpusSnapshotHash, evidenceSnapshotHash: plan.evidenceSnapshotHash, chunks: chunks.map(chunk => ({ sourceId: chunk.sourceId, artifactId: chunk.artifactId, chunkId: chunk.chunkId, chunkHash: chunk.chunkHash, matchedTokenCount: chunk.matchedTokenCount, queryTokenCount: chunk.queryTokenCount, relevanceRatio: chunk.relevanceRatio, scoreBasis: chunk.scoreBasis })) }))
}

export function buildRetrievalResult(inputOrPlanValue: unknown, candidateValues: unknown, queryInputValue?: unknown): RetrievalResult {
  let plan: RetrievalPlan
  let queryFingerprint: string
  let queryFields: Pick<ContentQualityInput, 'topic' | 'workingTitle' | 'primaryQuestion' | 'audience' | 'goals' | 'language'> | null = null
  const normalizedInput = normalizeContentQualityInput(inputOrPlanValue)
  if (normalizedInput.status === 'valid') {
    plan = normalizedInput.input.retrievalPlan
    queryFields = normalizedInput.input
    queryFingerprint = queryFingerprintForFields(queryFields)
  } else {
    const planValue = asPlan(inputOrPlanValue)
    if (!planValue) return emptyResult('blocked', normalizedInput.reasonCodes[0] || 'INVALID_INPUT')
    plan = planValue
    if (queryInputValue !== undefined) {
      const queryNormalized = normalizeContentQualityInput(queryInputValue)
      if (queryNormalized.status !== 'valid') return emptyResult('blocked', queryNormalized.reasonCodes[0] || 'INVALID_INPUT', plan)
      queryFields = queryNormalized.input
      queryFingerprint = queryFingerprintForFields(queryFields)
    } else {
      queryFingerprint = plan.queryFingerprint
    }
  }
  if (queryFingerprint !== plan.queryFingerprint) return emptyResult('blocked', 'QUERY_FINGERPRINT_MISMATCH', plan, queryFingerprint)
  if (!Array.isArray(candidateValues)) return emptyResult('blocked', 'INVALID_INPUT', plan, queryFingerprint)
  try {
    const candidates = candidateValues.map(value => normalizeCandidate(value, plan.evidenceSnapshotHash))
    const allowedSourceIds = new Set(plan.allowedSourceIds)
    const allowedArtifactIds = new Set(plan.allowedArtifactIds)
    const seen = new Set<string>()
    const queryTokens = queryFields ? tokenizeLexical([queryFields.topic, queryFields.workingTitle, queryFields.primaryQuestion, queryFields.audience, ...queryFields.goals, queryFields.language].join(' ')) : []
    if (queryTokens.length === 0) return emptyResult('not_ready', 'RETRIEVAL_NOT_READY', plan, queryFingerprint)
    const scored: RetrievedEvidenceChunk[] = []
    for (const candidate of candidates) {
      const chunk = candidate.chunk
      const chunkIdentity = identity(chunk)
      if (!allowedSourceIds.has(chunk.sourceId) || !allowedArtifactIds.has(chunk.artifactId)) throw new NormalizationIssue('RETRIEVAL_OUTSIDE_ALLOWLIST')
      if (chunk.corpusSnapshotHash !== plan.corpusSnapshotHash) throw new NormalizationIssue('RETRIEVAL_CORPUS_MISMATCH')
      if (chunk.evidenceSnapshotHash !== plan.evidenceSnapshotHash) throw new NormalizationIssue('EVIDENCE_SNAPSHOT_MISMATCH')
      if (seen.has(chunkIdentity)) throw new NormalizationIssue('DUPLICATE_EVIDENCE')
      seen.add(chunkIdentity)
      if (plan.requiredPurposes.some(purpose => !chunk.approvedPurposes.includes(purpose))) throw new NormalizationIssue('EVIDENCE_PURPOSE_NOT_ALLOWED')
      const candidateTokens = new Set(tokenizeLexical(`${chunk.title} ${chunk.reviewedText}`))
      const matchedTokenCount = queryTokens.filter(token => candidateTokens.has(token)).length
      if (matchedTokenCount === 0) continue
      scored.push({ ...chunk, matchedTokenCount, queryTokenCount: queryTokens.length, relevanceRatio: matchedTokenCount / queryTokens.length, scoreBasis: LEXICAL_RETRIEVAL_SCORE_BASIS, limitations: candidate.limitations || [] })
    }
    if (scored.length === 0) return emptyResult('not_ready', 'RETRIEVAL_NOT_READY', plan, queryFingerprint)
    scored.sort((left, right) => right.relevanceRatio - left.relevanceRatio || codeUnitCompare(identity(left), identity(right)))
    const selected = scored.slice(0, plan.topK)
    return { status: 'ready', retrievalVersion: RETRIEVAL_VERSION, queryFingerprint, retrievalFingerprint: retrievalFingerprint(queryFingerprint, selected, plan), corpusSnapshotHash: plan.corpusSnapshotHash, evidenceSnapshotHash: plan.evidenceSnapshotHash, chunks: selected, reasonCodes: [], limitations: ['This is deterministic lexical evidence retrieval V1 using bounded token overlap; it is not semantic vector retrieval, truth scoring, ranking probability, citation probability, conversion scoring, or an outcome prediction.', 'Canonical retrieval limitations are server-deterministic metadata; caller-supplied limitations are not authoritative.'] }
  } catch (error: unknown) {
    if (error instanceof NormalizationIssue) return emptyResult('blocked', error.reasonCode, plan, queryFingerprint)
    return emptyResult('blocked', 'INVALID_INPUT', plan, queryFingerprint)
  }
}

export function verifyRetrievalResult(value: unknown, inputValue: unknown): RetrievalResult | null {
  const normalizedInput = normalizeContentQualityInput(inputValue)
  if (normalizedInput.status !== 'valid') return null
  const input = normalizedInput.input
  if (!isRecord(value) || !hasExactKeys(value, RETRIEVAL_RESULT_KEYS)) return null
  try {
    if (readField(value, 'status') !== 'ready' || readField(value, 'retrievalVersion') !== RETRIEVAL_VERSION) return null
    const rawChunks = readField(value, 'chunks')
    const rawReasonCodes = readField(value, 'reasonCodes')
    const rawLimitations = readField(value, 'limitations')
    if (!Array.isArray(rawChunks) || !Array.isArray(rawReasonCodes) || rawReasonCodes.length !== 0 || !Array.isArray(rawLimitations) || rawLimitations.some(item => typeof item !== 'string' || item.length > 1000)) return null
    const normalizedQueryFingerprint = normalizeSha256(readField(value, 'queryFingerprint'))
    const normalizedRetrievalFingerprint = normalizeSha256(readField(value, 'retrievalFingerprint'))
    const normalizedCorpusSnapshotHash = normalizeSha256(readField(value, 'corpusSnapshotHash'))
    const normalizedEvidenceSnapshotHash = normalizeSha256(readField(value, 'evidenceSnapshotHash'))
    const normalizedChunks: RetrievedEvidenceChunk[] = rawChunks.map(rawChunk => {
      if (!isRecord(rawChunk) || !hasExactKeys(rawChunk, RETRIEVED_CHUNK_KEYS)) throw new NormalizationIssue('UNKNOWN_FIELD')
      const baseChunk: Record<string, unknown> = {}
      for (const key of RETRIEVED_CHUNK_KEYS.slice(0, 14)) baseChunk[key] = readField(rawChunk, key)
      const candidate = normalizeCandidate({ chunk: baseChunk, limitations: readField(rawChunk, 'limitations') }, input.evidenceSnapshotHash)
      const matchedTokenCount = readField(rawChunk, 'matchedTokenCount')
      const queryTokenCount = readField(rawChunk, 'queryTokenCount')
      const relevanceRatio = readField(rawChunk, 'relevanceRatio')
      const scoreBasis = readField(rawChunk, 'scoreBasis')
      if (typeof matchedTokenCount !== 'number' || !Number.isInteger(matchedTokenCount) || matchedTokenCount < 1 || typeof queryTokenCount !== 'number' || !Number.isInteger(queryTokenCount) || queryTokenCount < 1 || typeof relevanceRatio !== 'number' || !Number.isFinite(relevanceRatio) || relevanceRatio <= 0 || relevanceRatio > 1 || scoreBasis !== LEXICAL_RETRIEVAL_SCORE_BASIS) throw new NormalizationIssue('RETRIEVAL_FINGERPRINT_MISMATCH')
      return { ...candidate.chunk, matchedTokenCount, queryTokenCount, relevanceRatio, scoreBasis: LEXICAL_RETRIEVAL_SCORE_BASIS, limitations: candidate.limitations || [] }
    })
    const presented: RetrievalResult = { status: 'ready', retrievalVersion: RETRIEVAL_VERSION, queryFingerprint: normalizedQueryFingerprint, retrievalFingerprint: normalizedRetrievalFingerprint, corpusSnapshotHash: normalizedCorpusSnapshotHash, evidenceSnapshotHash: normalizedEvidenceSnapshotHash, chunks: normalizedChunks, reasonCodes: [], limitations: [...rawLimitations] }
    const canonical = buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })))
    if (canonical.status !== 'ready') return null
    if (canonicalizeQualityValue(presented) !== canonicalizeQualityValue(canonical)) return null
    return canonical
  } catch { return null }
}

export function isRetrievalResult(value: unknown): value is RetrievalResult {
  if (!isRecord(value)) return false
  try { return ['ready', 'not_ready', 'blocked'].includes(readField(value, 'status') as string) } catch { return false }
}

export function retrievalPlanSnapshotHash(value: unknown): string | null {
  try { return normalizeSha256(readField(normalizeRetrievalPlan(value), 'evidenceSnapshotHash')) } catch { return null }
}
