import { createHash } from 'node:crypto'
import { canonicalJson, isOpaqueReference, isValidSha256, isValidSlug, strictTimestamp, utf8ByteLength } from '../first-party-publishing/normalization'
import type {
  FirstPartyContentBlockedResult,
  FirstPartyContentDocument,
  FirstPartyContentLanguage,
  FirstPartyContentManifest,
  FirstPartyContentManifestResult,
  FirstPartyContentType,
} from './types'

const DOCUMENT_KEYS = new Set([
  'status',
  'publicationIdentity',
  'title',
  'slug',
  'language',
  'contentType',
  'body',
  'bodyHash',
  'evidenceSnapshotHash',
  'authoritySourceIds',
  'appliedRuleIds',
  'publishedAt',
  'sourcePath',
  'routePath',
  'canonicalPath',
  'documentFingerprint',
])

function blocked(code: FirstPartyContentBlockedResult['code'], ...reasons: string[]): FirstPartyContentManifestResult {
  return { status: 'blocked', code, reasons }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function isSortedUnique(values: unknown): values is readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) return false
  if (!values.every(value => isOpaqueReference(value))) return false
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined || previous >= current) return false
  }
  return true
}

function isPublicationIdentity(value: unknown): value is FirstPartyContentDocument['publicationIdentity'] {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 5 || keys.some(key => !['publicationId', 'scheduleEntryId', 'productionPlanId', 'draftId', 'reviewId'].includes(key))) return false
  return ['publicationId', 'scheduleEntryId', 'productionPlanId', 'draftId', 'reviewId'].every(key => isOpaqueReference(read(value, key)))
}

function isSafeRelativeSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.startsWith('/') || value.includes('\\') || value.includes('%') || value.includes('?') || value.includes('#') || value.includes('//')) return false
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function isNormalizedFirstPartyContentDocument(value: unknown): value is FirstPartyContentDocument {
  if (!isRecord(value) || Object.keys(value).some(key => !DOCUMENT_KEYS.has(key))) return false
  const status = read(value, 'status')
  const title = read(value, 'title')
  const slug = read(value, 'slug')
  const language = read(value, 'language')
  const contentType = read(value, 'contentType')
  const body = read(value, 'body')
  const bodyHash = read(value, 'bodyHash')
  const evidenceHash = read(value, 'evidenceSnapshotHash')
  const publishedAt = read(value, 'publishedAt')
  const sourcePath = read(value, 'sourcePath')
  const routePath = read(value, 'routePath')
  const canonicalPath = read(value, 'canonicalPath')
  const fingerprint = read(value, 'documentFingerprint')
  const timestamp = strictTimestamp(publishedAt)
  const identity = read(value, 'publicationIdentity')
  const authorities = read(value, 'authoritySourceIds')
  const rules = read(value, 'appliedRuleIds')
  const expectedRoute = (language === 'en' || language === 'zh-hant') && (contentType === 'article' || contentType === 'faq' || contentType === 'service_page') && typeof slug === 'string'
    ? `/${language}/${contentType === 'article' ? 'articles' : contentType === 'faq' ? 'faq' : 'services'}/${slug}`
    : undefined
  const fingerprintInput = {
    publicationIdentity: identity,
    routePath: expectedRoute,
    canonicalPath: expectedRoute,
    title,
    language,
    contentType,
    contentHash: typeof bodyHash === 'string' ? bodyHash.toLowerCase() : bodyHash,
    evidenceSnapshotHash: evidenceHash,
    authoritySourceIds: authorities,
    appliedRuleIds: rules,
    publishedAt,
  }
  let fingerprintMatches = false
  try {
    fingerprintMatches = typeof fingerprint === 'string' && isValidSha256(fingerprint) && createHash('sha256').update(JSON.stringify(fingerprintInput), 'utf8').digest('hex') === fingerprint
  } catch {
    fingerprintMatches = false
  }
  return status === 'verified'
    && isPublicationIdentity(identity)
    && typeof title === 'string' && title.length >= 1 && title.length <= 512
    && typeof slug === 'string' && isValidSlug(slug)
    && (language === 'en' || language === 'zh-hant')
    && (contentType === 'article' || contentType === 'faq' || contentType === 'service_page')
    && typeof body === 'string' && body.length >= 1 && utf8ByteLength(body) >= 1
    && isValidSha256(bodyHash) && createHash('sha256').update(body, 'utf8').digest('hex') === bodyHash.toLowerCase()
    && isValidSha256(evidenceHash) && evidenceHash === evidenceHash.toLowerCase()
    && timestamp.ok && publishedAt === timestamp.iso
    && isSortedUnique(authorities)
    && isSortedUnique(rules)
    && isSafeRelativeSourcePath(sourcePath)
    && expectedRoute !== undefined && routePath === expectedRoute
    && canonicalPath === routePath
    && fingerprintMatches
}

function compareDocuments(left: FirstPartyContentDocument, right: FirstPartyContentDocument): number {
  const leftValues = [left.language, left.contentType, left.slug, left.publicationIdentity.publicationId]
  const rightValues = [right.language, right.contentType, right.slug, right.publicationIdentity.publicationId]
  for (let index = 0; index < leftValues.length; index += 1) {
    const leftValue = leftValues[index] ?? ''
    const rightValue = rightValues[index] ?? ''
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }
  return 0
}

export function buildFirstPartyContentManifest(input: unknown): FirstPartyContentManifestResult {
  try {
    const documentsInput = Array.isArray(input)
      ? input
      : isRecord(input) && Object.keys(input).length === 1 && Object.prototype.hasOwnProperty.call(input, 'documents')
        ? read(input, 'documents')
        : undefined
    if (!Array.isArray(documentsInput)) return blocked('INVALID_INPUT', 'manifest input must be an array or { documents }')
    if (documentsInput.length > 500) return blocked('MANIFEST_TOO_LARGE', 'manifest cannot contain more than 500 documents')
    const documents: FirstPartyContentDocument[] = []
    for (const candidate of documentsInput) {
      const unwrapped = isRecord(candidate) && Object.keys(candidate).length === 2 && read(candidate, 'status') === 'verified' && Object.prototype.hasOwnProperty.call(candidate, 'document') ? read(candidate, 'document') : candidate
      if (!isNormalizedFirstPartyContentDocument(unwrapped)) return blocked('DOCUMENT_INVALID', 'manifest accepts only verified normalized documents')
      documents.push(unwrapped)
    }
    const sorted = [...documents].sort(compareDocuments)
    const publicationIds = new Set<string>()
    const routes = new Set<string>()
    const slugs = new Set<string>()
    for (const document of sorted) {
      const publicationId = document.publicationIdentity.publicationId
      const routeKey = `${document.language}:${document.contentType}:${document.slug}`
      if (publicationIds.has(publicationId)) return blocked('MANIFEST_COLLISION', `duplicate publicationId: ${publicationId}`)
      if (routes.has(document.routePath)) return blocked('MANIFEST_COLLISION', `duplicate routePath: ${document.routePath}`)
      if (slugs.has(routeKey)) return blocked('MANIFEST_COLLISION', `duplicate language/contentType/slug: ${routeKey}`)
      publicationIds.add(publicationId)
      routes.add(document.routePath)
      slugs.add(routeKey)
    }
    const fingerprintInput = {
      version: 'first-party-content-site-kit-v1',
      documents: sorted.map(document => ({
        publicationIdentity: document.publicationIdentity,
        title: document.title,
        slug: document.slug,
        language: document.language,
        contentType: document.contentType,
        bodyHash: document.bodyHash,
        evidenceSnapshotHash: document.evidenceSnapshotHash,
        authoritySourceIds: document.authoritySourceIds,
        appliedRuleIds: document.appliedRuleIds,
        publishedAt: document.publishedAt,
        sourcePath: document.sourcePath,
        routePath: document.routePath,
        canonicalPath: document.canonicalPath,
        documentFingerprint: document.documentFingerprint,
      })),
    }
    const fingerprintJson = canonicalJson(fingerprintInput)
    if (fingerprintJson === undefined) return blocked('DOCUMENT_INVALID', 'manifest fingerprint could not be canonicalized')
    const manifestFingerprint = createHash('sha256').update(fingerprintJson, 'utf8').digest('hex')
    const manifest: FirstPartyContentManifest = {
      status: 'verified',
      version: 'first-party-content-site-kit-v1',
      documents: sorted,
      manifestFingerprint,
    }
    return { status: 'verified', manifest }
  } catch {
    return blocked('INVALID_INPUT', 'manifest could not be safely built')
  }
}

export type { FirstPartyContentLanguage, FirstPartyContentType }
