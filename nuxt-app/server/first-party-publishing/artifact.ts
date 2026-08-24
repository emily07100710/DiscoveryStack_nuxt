import { createHash } from 'node:crypto'
import { isValidContentRoot, isValidSha256, isValidSlug, normalizeApprovedPublication, utf8ByteLength } from './normalization'
import type { ApprovedFirstPartyPublication, FirstPartyArtifact, FirstPartyArtifactResult, FirstPartyDecisionCode, FirstPartyPublicationIdentity } from './types'

function blocked(code: FirstPartyDecisionCode, ...reasons: string[]): FirstPartyArtifactResult {
  return { status: 'blocked', code, reasons }
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function quotedList(values: readonly string[]): string {
  return JSON.stringify(values)
}

function publicationIdentity(publication: ApprovedFirstPartyPublication): FirstPartyPublicationIdentity {
  return {
    publicationId: publication.productionDeliverableId,
    ownerScopeKey: publication.ownerScopeKey,
    scheduleEntryId: publication.scheduleEntryId,
    productionPlanId: publication.productionPlanId,
    productionDeliverableId: publication.productionDeliverableId,
    jobId: publication.jobId,
    draftId: publication.draftId,
    draftVersion: publication.draftVersion,
    reviewId: publication.reviewId,
    scheduleKey: publication.scheduleKey,
  }
}

function safeFinalPath(contentRoot: string, language: string, slug: string): string | undefined {
  const languagePart = language === 'zh-hant' ? 'zh-hant' : language
  const path = `${contentRoot}/${languagePart}/articles/${slug}.md`
  const segments = path.split('/')
  if (!isValidContentRoot(contentRoot) || !isValidSlug(slug) || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('%'))) return undefined
  if (!path.startsWith(`${contentRoot}/`) || path.includes('//') || path.includes('..')) return undefined
  return path
}

function buildFrontmatter(publication: ApprovedFirstPartyPublication): string {
  const authoritySourceIds = quotedList(publication.authoritySourceIds)
  const appliedRuleIds = quotedList(publication.ruleIds)
  return [
    '---',
    `title: ${quoted(publication.title)}`,
    `slug: ${quoted(publication.slug)}`,
    `language: ${quoted(publication.language)}`,
    `contentType: ${quoted(publication.contentType)}`,
    `publicationId: ${quoted(publication.productionDeliverableId)}`,
    `scheduleEntryId: ${quoted(publication.scheduleEntryId)}`,
    `productionPlanId: ${quoted(publication.productionPlanId)}`,
    `draftId: ${quoted(publication.draftId)}`,
    `reviewId: ${quoted(publication.reviewId)}`,
    `evidenceSnapshotHash: ${quoted(publication.evidenceSnapshotHash)}`,
    `contentHash: ${quoted(publication.contentHash)}`,
    `publishedAt: ${quoted(publication.scheduledAt)}`,
    `authoritySourceIds: ${authoritySourceIds}`,
    `appliedRuleIds: ${appliedRuleIds}`,
    '---',
  ].join('\n')
}

export function buildFirstPartyMarkdownArtifact(contentRoot: unknown, input: unknown): FirstPartyArtifactResult {
  try {
    if (!isValidContentRoot(contentRoot)) return blocked('INVALID_CONTENT_ROOT', 'contentRoot is not safe')
    const normalized = normalizeApprovedPublication(input)
    if (!normalized.ok) {
      if (normalized.reason.includes('hash')) return blocked('INVALID_SHA256', normalized.reason)
      if (normalized.reason.includes('timestamp')) return blocked('INVALID_TIMESTAMP', normalized.reason)
      return blocked('INVALID_INPUT', normalized.reason)
    }
    const publication = normalized.publication
    if (!isValidSha256(publication.evidenceSnapshotHash) || !isValidSha256(publication.contentHash)) return blocked('INVALID_SHA256', 'publication hash is invalid')
    const path = safeFinalPath(contentRoot, publication.language, publication.slug)
    if (!path) return blocked('ARTIFACT_PATH_INVALID', 'artifact path is outside the content root or contains traversal')
    const frontmatter = buildFrontmatter(publication)
    const bodyBytes = utf8ByteLength(publication.body)
    const calculatedContentHash = createHash('sha256').update(publication.body, 'utf8').digest('hex')
    if (calculatedContentHash !== publication.contentHash) return blocked('CONTENT_HASH_MISMATCH', 'body UTF-8 hash does not match publication contentHash')
    const identity = publicationIdentity(publication)
    const fingerprintInput = {
      path,
      frontmatter,
      body: publication.body,
      bodyBytes,
      publicationIdentity: identity,
      contentHash: publication.contentHash,
      evidenceSnapshotHash: publication.evidenceSnapshotHash,
    }
    const artifactFingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput), 'utf8').digest('hex')
    const artifact: FirstPartyArtifact = {
      path,
      frontmatter,
      body: publication.body,
      bytes: utf8ByteLength(`${frontmatter}\n${publication.body}`),
      contentHash: calculatedContentHash,
      artifactFingerprint,
      publicationIdentity: identity,
    }
    return { status: 'ok', artifact }
  } catch {
    return blocked('INVALID_INPUT', 'artifact input could not be safely read')
  }
}
