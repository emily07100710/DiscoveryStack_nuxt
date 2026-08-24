import { createHash } from 'node:crypto'
import {
  canonicalJson,
  isOpaqueReference,
  isValidContentRoot,
  isValidSha256,
  isValidSlug,
  readValue,
  strictTimestamp,
  utf8ByteLength,
} from '../first-party-publishing/normalization'
import type {
  FirstPartyContentBlockedResult,
  FirstPartyContentDocument,
  FirstPartyContentLanguage,
  FirstPartyContentParseResult,
  FirstPartyContentType,
  FirstPartyParseInput,
} from './types'

const FRONTMATTER_KEYS = [
  'title',
  'slug',
  'language',
  'contentType',
  'publicationId',
  'scheduleEntryId',
  'productionPlanId',
  'draftId',
  'reviewId',
  'evidenceSnapshotHash',
  'contentHash',
  'publishedAt',
  'authoritySourceIds',
  'appliedRuleIds',
] as const

const FRONTMATTER_KEY_SET = new Set<string>(FRONTMATTER_KEYS)
const SENSITIVE_KEYS = new Set(['secret', 'token', 'authorization', 'credential', 'rawProviderResponse'])
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

type ParsedFrontmatter = Record<string, unknown>

function blocked(code: FirstPartyContentBlockedResult['code'], ...reasons: string[]): FirstPartyContentBlockedResult {
  return { status: 'blocked', code, reasons }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOwn(record: Record<string, unknown>, key: string): unknown {
  try {
    return readValue(record, key)
  } catch {
    return undefined
  }
}

function parseJsonScalar(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function parseFrontmatter(markdown: string): { ok: true; values: ParsedFrontmatter; body: string } | { ok: false; code: FirstPartyContentBlockedResult['code']; reason: string } {
  if (!markdown.startsWith('---\n')) return { ok: false, code: 'FRONTMATTER_MISSING', reason: 'document must start with one leading frontmatter block' }
  const closing = markdown.indexOf('\n---\n', 4)
  if (closing < 0) return { ok: false, code: 'FRONTMATTER_MISSING', reason: 'leading frontmatter block is not closed' }
  const block = markdown.slice(4, closing)
  const body = markdown.slice(closing + 5)
  if (body.startsWith('---\n') || /(?:^|\n)---\n/.test(body)) return { ok: false, code: 'FRONTMATTER_DUPLICATE', reason: 'body contains a second frontmatter delimiter' }
  const lines = block.split('\n')
  const seenKeys = new Set<string>()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator <= 0) return { ok: false, code: 'FRONTMATTER_FIELD_INVALID', reason: 'frontmatter line is not a key/value pair' }
    const key = line.slice(0, separator)
    if (!FRONTMATTER_KEY_SET.has(key) || SENSITIVE_KEYS.has(key)) return { ok: false, code: 'FRONTMATTER_UNKNOWN_KEY', reason: `frontmatter key ${key} is not permitted` }
    if (seenKeys.has(key)) return { ok: false, code: 'FRONTMATTER_DUPLICATE', reason: `frontmatter key ${key} is duplicated` }
    seenKeys.add(key)
  }
  if (lines.length !== FRONTMATTER_KEYS.length) return { ok: false, code: 'FRONTMATTER_FIELD_INVALID', reason: 'frontmatter must contain the exact fixed field set' }
  const values: ParsedFrontmatter = {}
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf(':')
    const key = line.slice(0, separator)
    const raw = line.slice(separator + 1).trimStart()
    const expectedKey = FRONTMATTER_KEYS[index]
    if (key !== expectedKey) return { ok: false, code: 'FRONTMATTER_FIELD_INVALID', reason: 'frontmatter field order or name is not canonical' }
    const parsed = parseJsonScalar(raw)
    if (parsed === undefined) return { ok: false, code: 'FRONTMATTER_FIELD_INVALID', reason: `frontmatter value for ${key} is not valid JSON scalar syntax` }
    values[key] = parsed
  }
  return { ok: true, values, body }
}

function stringField(values: ParsedFrontmatter, key: string): string | undefined {
  const value = readOwn(values, key)
  return typeof value === 'string' ? value : undefined
}

function sortedOpaqueList(values: ParsedFrontmatter, key: string): string[] | undefined {
  const value = readOwn(values, key)
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return undefined
  const result: string[] = []
  for (const item of value) {
    if (!isOpaqueReference(item) || result.includes(item)) return undefined
    result.push(item)
  }
  return result.sort((left, right) => left.localeCompare(right))
}

function validSourcePath(contentRoot: string, sourcePath: unknown, slug: string): sourcePath is string {
  if (typeof sourcePath !== 'string' || sourcePath.length <= contentRoot.length || sourcePath.length > 512) return false
  if (CONTROL.test(sourcePath) || sourcePath.startsWith('/') || sourcePath.includes('\\') || sourcePath.includes('%') || sourcePath.includes('?') || sourcePath.includes('#') || sourcePath.includes('//')) return false
  if (!sourcePath.startsWith(`${contentRoot}/`)) return false
  const segments = sourcePath.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return false
  return sourcePath.endsWith(`/${slug}.md`)
}

function publicationIdentity(values: ParsedFrontmatter): FirstPartyContentDocument['publicationIdentity'] | undefined {
  const publicationId = stringField(values, 'publicationId')
  const scheduleEntryId = stringField(values, 'scheduleEntryId')
  const productionPlanId = stringField(values, 'productionPlanId')
  const draftId = stringField(values, 'draftId')
  const reviewId = stringField(values, 'reviewId')
  if (!isOpaqueReference(publicationId) || !isOpaqueReference(scheduleEntryId) || !isOpaqueReference(productionPlanId) || !isOpaqueReference(draftId) || !isOpaqueReference(reviewId)) return undefined
  return { publicationId, scheduleEntryId, productionPlanId, draftId, reviewId }
}

export function parseFirstPartyContentDocument(input: unknown): FirstPartyContentParseResult {
  try {
    if (!isPlainRecord(input)) return blocked('INVALID_INPUT', 'parse input must be a plain object')
    const keys = Object.keys(input)
    if (keys.some(key => !['contentRoot', 'sourcePath', 'markdown', 'content'].includes(key))) return blocked('INVALID_INPUT', 'parse input contains an unknown key')
    const contentRoot = readOwn(input, 'contentRoot')
    const sourcePath = readOwn(input, 'sourcePath')
    const markdown = readOwn(input, 'markdown')
    const contentAlias = readOwn(input, 'content')
    if (!isValidContentRoot(contentRoot)) return blocked('PATH_INVALID', 'contentRoot is not a safe relative path')
    if (markdown !== undefined && contentAlias !== undefined) return blocked('INVALID_INPUT', 'provide only one markdown content field')
    const rawMarkdown = markdown ?? contentAlias
    if (typeof rawMarkdown !== 'string' || rawMarkdown.length < 1 || rawMarkdown.length > 10_000_000) return blocked('DOCUMENT_INVALID', 'markdown content is missing or exceeds the bounded input size')
    const parsed = parseFrontmatter(rawMarkdown)
    if (!parsed.ok) return blocked(parsed.code, parsed.reason)
    const values = parsed.values
    const title = stringField(values, 'title')
    const slug = stringField(values, 'slug')
    const language = stringField(values, 'language')
    const contentType = stringField(values, 'contentType')
    const evidenceSnapshotHash = stringField(values, 'evidenceSnapshotHash')
    const contentHash = stringField(values, 'contentHash')
    const publishedAt = stringField(values, 'publishedAt')
    const identity = publicationIdentity(values)
    const authoritySourceIds = sortedOpaqueList(values, 'authoritySourceIds')
    const appliedRuleIds = sortedOpaqueList(values, 'appliedRuleIds')
    if (title === undefined || title.length < 1 || title.length > 512 || CONTROL.test(title) || title.includes('\n') || title.includes('\r')) return blocked('FRONTMATTER_FIELD_INVALID', 'title must be a bounded safe string')
    if (slug === undefined || !isValidSlug(slug)) return blocked('FRONTMATTER_FIELD_INVALID', 'slug must be lowercase ASCII with no traversal')
    if (language !== 'en' && language !== 'zh-hant') return blocked('FRONTMATTER_FIELD_INVALID', 'language must be en or zh-hant')
    if (contentType !== 'article' && contentType !== 'faq' && contentType !== 'service_page') return blocked('FRONTMATTER_FIELD_INVALID', 'contentType is not supported in V1')
    if (identity === undefined) return blocked('FRONTMATTER_FIELD_INVALID', 'publication identity fields are invalid')
    if (!isValidSha256(evidenceSnapshotHash) || evidenceSnapshotHash !== evidenceSnapshotHash.toLowerCase()) return blocked('EVIDENCE_HASH_INVALID', 'evidenceSnapshotHash must be lowercase SHA-256')
    if (!isValidSha256(contentHash)) return blocked('CONTENT_HASH_INVALID', 'contentHash must be SHA-256')
    if (typeof parsed.body !== 'string' || parsed.body.length < 1 || CONTROL.test(parsed.body)) return blocked('DOCUMENT_INVALID', 'body is missing or contains forbidden control characters')
    const timestamp = strictTimestamp(publishedAt)
    if (!timestamp.ok) return blocked('FRONTMATTER_FIELD_INVALID', timestamp.reason)
    if (!validSourcePath(contentRoot, sourcePath, slug)) return blocked('PATH_INVALID', 'sourcePath must stay under contentRoot and end with the approved slug')
    if (authoritySourceIds === undefined || appliedRuleIds === undefined) return blocked('FRONTMATTER_FIELD_INVALID', 'authoritySourceIds and appliedRuleIds must be non-empty unique arrays')
    const calculatedBodyHash = createHash('sha256').update(parsed.body, 'utf8').digest('hex')
    if (calculatedBodyHash !== contentHash.toLowerCase()) return blocked('BODY_HASH_MISMATCH', 'contentHash does not equal the body UTF-8 SHA-256')
    const normalizedLanguage = language as FirstPartyContentLanguage
    const normalizedContentType = contentType as FirstPartyContentType
    const canonicalPath = normalizedLanguage === 'zh-hant'
      ? `/zh-hant/${normalizedContentType === 'article' ? 'articles' : normalizedContentType === 'faq' ? 'faq' : 'services'}/${slug}`
      : `/en/${normalizedContentType === 'article' ? 'articles' : normalizedContentType === 'faq' ? 'faq' : 'services'}/${slug}`
    const fingerprintInput = {
      publicationIdentity: identity,
      routePath: canonicalPath,
      canonicalPath,
      title,
      language: normalizedLanguage,
      contentType: normalizedContentType,
      contentHash: contentHash.toLowerCase(),
      evidenceSnapshotHash,
      authoritySourceIds,
      appliedRuleIds,
      publishedAt: timestamp.iso,
    }
    const fingerprintJson = canonicalJson(fingerprintInput)
    if (fingerprintJson === undefined) return blocked('DOCUMENT_INVALID', 'document fingerprint could not be canonicalized')
    const document: FirstPartyContentDocument = {
      status: 'verified',
      publicationIdentity: identity,
      title,
      slug,
      language: normalizedLanguage,
      contentType: normalizedContentType,
      body: parsed.body,
      bodyHash: calculatedBodyHash,
      evidenceSnapshotHash,
      authoritySourceIds,
      appliedRuleIds,
      publishedAt: timestamp.iso,
      sourcePath,
      routePath: canonicalPath,
      canonicalPath,
      documentFingerprint: createHash('sha256').update(fingerprintJson, 'utf8').digest('hex'),
    }
    if (utf8ByteLength(document.body) < 1) return blocked('DOCUMENT_INVALID', 'body byte length must be positive')
    return { status: 'verified', document }
  } catch {
    return blocked('INVALID_INPUT', 'document could not be safely parsed')
  }
}
