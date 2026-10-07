import { outcomeSha256, isOutcomeSha256 } from '../outcome-learning/normalization'
import type { OutcomeLearningCandidate } from '../outcome-learning/types'
import type { EffectPublicationMetadataSidecar } from './effect-trainer'

export type EffectLiveActionFeatures = {
  newPage: number
  titleChanged: number
  paragraphsAdded: number
  paragraphsRemoved: number
  paragraphsReplaced: number
  paragraphsUnmodified: number
  beforeTextLength: number
  plannedTextLength: number
  beforeParagraphCount: number
  plannedParagraphCount: number
}

export type EffectLiveActionMetadata = {
  candidateFingerprint: string
  actionEvidenceFingerprint: string
  actionReviewFingerprint: string
  actionReleaseFingerprint: string
  plannedActionFingerprint: string
  receiptFingerprint: string
  authorizationFingerprint: string
  sourceFingerprint: string
  beforeCapturedAt: string
  dispatchStartedAt: string
  publishedAt: string
  verifiedAt: string
  expiresAt: string
  features: EffectLiveActionFeatures
}

export type EffectLiveActionMetadataSidecar = {
  schema: 'content-effect-live-action-metadata.v1'
  entries: EffectLiveActionMetadata[]
  sidecarFingerprint: string
}

const SCHEMA = 'content-effect-live-action-metadata.v1' as const
const HASHES = ['candidateFingerprint', 'actionEvidenceFingerprint', 'actionReviewFingerprint', 'actionReleaseFingerprint', 'plannedActionFingerprint', 'receiptFingerprint', 'authorizationFingerprint', 'sourceFingerprint'] as const
const TIME_KEYS = ['beforeCapturedAt', 'dispatchStartedAt', 'publishedAt', 'verifiedAt', 'expiresAt'] as const
const FEATURE_KEYS = ['newPage', 'titleChanged', 'paragraphsAdded', 'paragraphsRemoved', 'paragraphsReplaced', 'paragraphsUnmodified', 'beforeTextLength', 'plannedTextLength', 'beforeParagraphCount', 'plannedParagraphCount'] as const
const ENTRY_KEYS = [...HASHES, ...TIME_KEYS, 'features']
const PUB_ENTRY_KEYS = ['candidateFingerprint', 'publicationGroupFingerprint', 'baselineMetadataFingerprint', 'latestBaselineCapturedAt', 'publishedAt', 'gscFollowUpWindowStart', 'gscFollowUpWindowEnd', 'capturedAt']
const PUB_SIDECAR_KEYS = ['schema', 'trainingAsOf', 'entries', 'sidecarFingerprint']
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getOwnPropertySymbols(value).length) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Object.keys(descriptors).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null
    const output: Record<string, unknown> = Object.create(null)
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[key] = descriptor.value
    }
    return output
  } catch { return null }
}

function dataArray(value: unknown, maximumLength: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || value.length > maximumLength) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const expected = ['length', ...Array.from({ length: value.length }, (_, index) => String(index))].sort()
    const actual = Object.keys(descriptors).sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null
    const output: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output.push(descriptor.value)
    }
    return output
  } catch { return null }
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_MILLIS.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function validFeatures(value: unknown): EffectLiveActionFeatures | null {
  const raw = ownRecord(value, FEATURE_KEYS)
  if (!raw) return null
  for (const key of FEATURE_KEYS) {
    const number = raw[key]
    const maximum = key === 'beforeTextLength' || key === 'plannedTextLength' ? 256 * 1024 : 512
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > maximum) return null
  }
  if (![0, 1].includes(raw.newPage as number) || ![0, 1].includes(raw.titleChanged as number)) return null
  if ((raw.beforeParagraphCount as number) !== (raw.paragraphsRemoved as number) + (raw.paragraphsReplaced as number) + (raw.paragraphsUnmodified as number)
    || (raw.plannedParagraphCount as number) !== (raw.paragraphsAdded as number) + (raw.paragraphsReplaced as number) + (raw.paragraphsUnmodified as number)
    || (raw.beforeParagraphCount as number) + (raw.plannedParagraphCount as number) > 512
    || (raw.beforeTextLength as number) > 256 * 1024 || (raw.plannedTextLength as number) > 256 * 1024) return null
  if (raw.newPage === 1 && (raw.beforeTextLength !== 0 || raw.beforeParagraphCount !== 0 || raw.paragraphsRemoved !== 0 || raw.paragraphsReplaced !== 0 || raw.paragraphsUnmodified !== 0 || raw.titleChanged !== 1)) return null
  return Object.fromEntries(FEATURE_KEYS.map(key => [key, raw[key]])) as EffectLiveActionFeatures
}

function normalizeEntry(value: unknown, publishedAt: string, followUpWindowEnd: string, capturedAt: string, asOf: number): EffectLiveActionMetadata | null {
  const raw = ownRecord(value, ENTRY_KEYS)
  if (!raw || HASHES.some(key => !isOutcomeSha256(raw[key])) || TIME_KEYS.some(key => !canonicalDate(raw[key]))) return null
  const features = validFeatures(raw.features)
  if (!features || raw.publishedAt !== publishedAt) return null
  const before = Date.parse(raw.beforeCapturedAt as string)
  const dispatch = Date.parse(raw.dispatchStartedAt as string)
  const publication = Date.parse(raw.publishedAt as string)
  const verified = Date.parse(raw.verifiedAt as string)
  const expires = Date.parse(raw.expiresAt as string)
  if (before > dispatch || dispatch > publication || publication > verified || verified > publication + 24 * 60 * 60 * 1000
    || dispatch - before > 30_000 || expires <= verified || verified >= Date.parse(followUpWindowEnd) || verified >= Date.parse(capturedAt) || verified > asOf) return null
  const normalized = Object.create(null) as Record<string, unknown>
  for (const key of HASHES) normalized[key] = raw[key]
  for (const key of TIME_KEYS) normalized[key] = raw[key]
  normalized.features = features
  return normalized as EffectLiveActionMetadata
}

function sorted<T extends { candidateFingerprint: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.candidateFingerprint < b.candidateFingerprint ? -1 : a.candidateFingerprint > b.candidateFingerprint ? 1 : 0)
}

function validPublicationMetadata(value: unknown, candidates: readonly OutcomeLearningCandidate[]): Map<string, { publishedAt: string; gscFollowUpWindowEnd: string; capturedAt: string }> | null {
  const raw = ownRecord(value, PUB_SIDECAR_KEYS)
  const candidateRows = dataArray(candidates, 500)
  const entriesInput = raw && dataArray(raw.entries, 500)
  if (!raw || raw.schema !== 'content-effect-publication-metadata.v1' || !canonicalDate(raw.trainingAsOf) || !isOutcomeSha256(raw.sidecarFingerprint) || !entriesInput || entriesInput.length !== candidates.length || !candidateRows?.length || candidateRows.length > 500) return null
  const candidateSet = new Set(candidateRows.map(item => (item as OutcomeLearningCandidate).candidateFingerprint))
  if (candidateSet.size !== candidates.length || [...candidateSet].some(item => !isOutcomeSha256(item))) return null
  const entries: Array<Record<string, unknown>> = []
  const result = new Map<string, { publishedAt: string; gscFollowUpWindowEnd: string; capturedAt: string }>()
  for (const valueEntry of entriesInput) {
    const entry = ownRecord(valueEntry, PUB_ENTRY_KEYS)
    if (!entry || PUB_ENTRY_KEYS.filter(key => key.endsWith('Fingerprint')).some(key => !isOutcomeSha256(entry[key]))
      || !canonicalDate(entry.latestBaselineCapturedAt) || !canonicalDate(entry.publishedAt) || !canonicalDate(entry.gscFollowUpWindowStart)
      || !canonicalDate(entry.gscFollowUpWindowEnd) || !canonicalDate(entry.capturedAt) || !candidateSet.has(entry.candidateFingerprint as string)
      || result.has(entry.candidateFingerprint as string) || (entry.latestBaselineCapturedAt as string) > (entry.publishedAt as string)
      || (entry.gscFollowUpWindowStart as string) < (entry.publishedAt as string) || (entry.gscFollowUpWindowStart as string) >= (entry.gscFollowUpWindowEnd as string)
      || (entry.capturedAt as string) < (entry.gscFollowUpWindowEnd as string)) return null
    entries.push(entry)
    result.set(entry.candidateFingerprint as string, { publishedAt: entry.publishedAt as string, gscFollowUpWindowEnd: entry.gscFollowUpWindowEnd as string, capturedAt: entry.capturedAt as string })
  }
  if (result.size !== candidates.length) return null
  sorted(entries as Array<Record<string, unknown> & { candidateFingerprint: string }>)
  const maxCaptured = [...result.values()].map(row => row.capturedAt).sort().at(-1)
  const body = { schema: raw.schema, trainingAsOf: raw.trainingAsOf, entries }
  if (raw.trainingAsOf !== maxCaptured || outcomeSha256(body) !== raw.sidecarFingerprint) return null
  return result
}

export function buildEffectLiveActionMetadata(entries: EffectLiveActionMetadata[]): EffectLiveActionMetadataSidecar | null {
  try {
    const inputEntries = dataArray(entries, 500)
    if (!inputEntries || inputEntries.length < 1) return null
    const candidates = inputEntries.map(entry => {
      const raw = ownRecord(entry, ENTRY_KEYS)
      if (!raw || !isOutcomeSha256(raw.candidateFingerprint)) return null
      return raw.candidateFingerprint as string
    })
    if (candidates.some(item => item === null) || new Set(candidates).size !== entries.length) return null
    const normalized = inputEntries.map(entry => {
      const raw = ownRecord(entry, ENTRY_KEYS)
      if (!raw || HASHES.some(key => !isOutcomeSha256(raw[key])) || TIME_KEYS.some(key => !canonicalDate(raw[key]))) return null
      const features = validFeatures(raw.features)
      if (!features) return null
      const before = Date.parse(raw.beforeCapturedAt as string), dispatch = Date.parse(raw.dispatchStartedAt as string), published = Date.parse(raw.publishedAt as string), verified = Date.parse(raw.verifiedAt as string), expires = Date.parse(raw.expiresAt as string)
      if (before > dispatch || dispatch > published || published > verified || verified > published + 24 * 60 * 60 * 1000 || dispatch - before > 30_000 || expires <= verified) return null
      return { ...Object.fromEntries(HASHES.map(key => [key, raw[key]])), ...Object.fromEntries(TIME_KEYS.map(key => [key, raw[key]])), features } as EffectLiveActionMetadata
    })
    if (normalized.some(item => item === null)) return null
    const canonicalEntries = sorted(normalized as EffectLiveActionMetadata[])
    const body = { schema: SCHEMA, entries: canonicalEntries }
    return { ...body, sidecarFingerprint: outcomeSha256(body) }
  } catch { return null }
}

export function validateEffectLiveActionMetadata(value: unknown, candidates: readonly OutcomeLearningCandidate[], publicationMetadata: EffectPublicationMetadataSidecar): EffectLiveActionMetadataSidecar | null {
  try {
    const candidateRows = dataArray(candidates, 500)
    if (!candidateRows?.length) return null
    const publicationEntries = validPublicationMetadata(publicationMetadata, candidateRows as OutcomeLearningCandidate[])
    if (!publicationEntries) return null
    const raw = ownRecord(value, ['schema', 'entries', 'sidecarFingerprint'])
    const inputEntries = raw && dataArray(raw.entries, 500)
    if (!raw || raw.schema !== SCHEMA || !isOutcomeSha256(raw.sidecarFingerprint) || !inputEntries || inputEntries.length !== candidateRows.length) return null
    const normalized: EffectLiveActionMetadata[] = []
    const seen = new Set<string>()
    const asOf = Date.parse((publicationMetadata as EffectPublicationMetadataSidecar).trainingAsOf)
    for (const valueEntry of inputEntries) {
      const stub = ownRecord(valueEntry, ENTRY_KEYS)
      const publication = stub && publicationEntries.get(stub.candidateFingerprint as string)
      if (!stub || !publication || seen.has(stub.candidateFingerprint as string)) return null
      const entry = normalizeEntry(valueEntry, publication.publishedAt, publication.gscFollowUpWindowEnd, publication.capturedAt, asOf)
      if (!entry) return null
      seen.add(entry.candidateFingerprint)
      normalized.push(entry)
    }
    if (seen.size !== candidateRows.length) return null
    const canonicalEntries = sorted(normalized)
    const body = { schema: SCHEMA, entries: canonicalEntries }
    const fingerprint = outcomeSha256(body)
    if (fingerprint !== raw.sidecarFingerprint) return null
    return { ...body, sidecarFingerprint: fingerprint }
  } catch { return null }
}
