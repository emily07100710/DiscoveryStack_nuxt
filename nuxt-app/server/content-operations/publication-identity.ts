import { createHash } from 'node:crypto'
import { buildFirstPartyMarkdownArtifact } from '../first-party-publishing/artifact'
import { isOpaqueReference, isValidSlug } from '../first-party-publishing/normalization'
type ContentType = 'article' | 'faq' | 'service_page'
type Language = 'en' | 'zh-hant'

export type PublicationIdentity = {
  publicationId: string
  slug: string
  path: string
  identityFingerprint: string
}

export type PublicationIdentityInput = {
  clientId: number
  entryId: number
  targetId: string
  targetOrigin: string
  contentRoot: string
  contentType: ContentType
  language: Language
  title: string
  ownerScopeKey: string
  existingIdentity?: PublicationIdentity | null
}

const IDENTITY_BODY = 'identity-path-probe'
const IDENTITY_BODY_HASH = createHash('sha256').update(IDENTITY_BODY, 'utf8').digest('hex')
const IDENTITY_TIMESTAMP = '2000-01-01T00:00:00.000Z'

function codeUnitCompare(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(codeUnitCompare).map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function safeRead(record: Record<string, unknown>, key: string): unknown {
  try { return record[key] } catch { return undefined }
}

function validIdentity(value: unknown): value is PublicationIdentity {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return typeof safeRead(record, 'publicationId') === 'string' && isOpaqueReference(safeRead(record, 'publicationId'))
      && typeof safeRead(record, 'slug') === 'string' && isValidSlug(safeRead(record, 'slug'))
      && typeof safeRead(record, 'path') === 'string' && (safeRead(record, 'path') as string).length > 0
      && typeof safeRead(record, 'identityFingerprint') === 'string' && /^[a-f0-9]{64}$/.test(safeRead(record, 'identityFingerprint') as string)
  } catch { return false }
}

function fallbackBase(contentType: ContentType): string {
  return contentType === 'service_page' ? 'service' : contentType
}

function slugBase(title: string, contentType: ContentType): string {
  const normalized = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const ascii = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-').slice(0, 80).replace(/-+$/g, '')
  return ascii.length >= 3 ? ascii : fallbackBase(contentType)
}

function buildPath(contentRoot: string, input: PublicationIdentityInput, slug: string): string | null {
  const publication = {
    ownerScopeKey: input.ownerScopeKey,
    scheduleEntryId: `entry-${input.entryId}`,
    productionPlanId: `plan-${input.entryId}`,
    productionDeliverableId: `deliverable-${input.entryId}`,
    jobId: `job-${input.entryId}`,
    draftId: `draft-${input.entryId}`,
    draftVersion: 1,
    draftStage: 'optimized' as const,
    reviewId: `review-${input.entryId}`,
    reviewDecision: 'approved_for_delivery' as const,
    riskGateStatus: 'passed' as const,
    evidenceSnapshotHash: IDENTITY_BODY_HASH,
    contentHash: IDENTITY_BODY_HASH,
    title: input.title,
    body: IDENTITY_BODY,
    slug,
    contentType: input.contentType,
    language: input.language,
    scheduledAt: IDENTITY_TIMESTAMP,
    scheduleKey: `schedule-${input.entryId}`,
    authoritySourceIds: ['source-identity'],
    ruleIds: ['rule-identity'],
  }
  const artifact = buildFirstPartyMarkdownArtifact(contentRoot, publication)
  return artifact.status === 'ok' ? artifact.artifact.path : null
}

export function buildPublicationIdentity(input: PublicationIdentityInput): { ok: true; identity: PublicationIdentity } | { ok: false; reason: string } {
  try {
    if (!Number.isSafeInteger(input.clientId) || input.clientId < 1 || !Number.isSafeInteger(input.entryId) || input.entryId < 1) return { ok: false, reason: 'clientId and entryId must be positive safe integers' }
    if (!isOpaqueReference(input.targetId) || !isOpaqueReference(input.ownerScopeKey)) return { ok: false, reason: 'target and owner scope identities must be opaque' }
    if (!['article', 'faq', 'service_page'].includes(input.contentType) || !['en', 'zh-hant'].includes(input.language)) return { ok: false, reason: 'content type or language is unsupported' }
    if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 500) return { ok: false, reason: 'title is malformed' }
    if (input.existingIdentity !== undefined && input.existingIdentity !== null) return validIdentity(input.existingIdentity) ? { ok: true, identity: input.existingIdentity } : { ok: false, reason: 'persisted publication identity is malformed' }
    const base = slugBase(input.title, input.contentType)
    const suffixSeed = stableStringify({ clientId: input.clientId, entryId: input.entryId, targetId: input.targetId, language: input.language, contentType: input.contentType, title: input.title })
    const shortHash = createHash('sha256').update(suffixSeed, 'utf8').digest('hex').slice(0, 10)
    const slug = `${base}-${input.entryId}-${shortHash}`.slice(0, 160).replace(/-+$/g, '')
    if (!isValidSlug(slug)) return { ok: false, reason: 'generated publication slug is invalid' }
    const path = buildPath(input.contentRoot, input, slug)
    if (!path) return { ok: false, reason: 'formal publisher path could not be generated' }
    const fingerprint = createHash('sha256').update(stableStringify({ clientId: input.clientId, entryId: input.entryId, language: input.language, contentType: input.contentType, targetId: input.targetId, targetOrigin: input.targetOrigin, slug, path }), 'utf8').digest('hex')
    return { ok: true, identity: { publicationId: `publication-${input.entryId}`, slug, path, identityFingerprint: fingerprint } }
  } catch { return { ok: false, reason: 'publication identity input could not be safely read' } }
}

export function publicationPathFor(contentRoot: string, input: PublicationIdentityInput, slug: string): string | null {
  try { return buildPath(contentRoot, input, slug) } catch { return null }
}
