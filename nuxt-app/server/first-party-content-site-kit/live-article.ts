import { buildFirstPartyContentManifest, isNormalizedFirstPartyContentDocument } from './manifest'
import { buildFirstPartySeoProjection } from './seo'
import type { FirstPartyContentBlockedResult, FirstPartyContentDocument } from './types'
import { livePageMatchesExpected, projectExpectedLiveDocument, projectLivePage, renderLiveContentArticle, type LiveDocumentInput, type LivePageProjection } from '../learning-loop/live-page-projection'

export type FirstPartyLiveArticleProjection = {
  readonly status: 'verified'
  readonly canonicalUrl: string
  readonly documentFingerprint: string
  readonly controlledArticleHtml: string
  readonly expectedProjection: LivePageProjection
} | FirstPartyContentBlockedResult

function blocked(...reasons: string[]): FirstPartyContentBlockedResult {
  return { status: 'blocked', code: 'PROJECTION_INVALID', reasons }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) return null
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

/**
 * Build only a controlled article fragment from a revalidated Site Kit document.
 * This deliberately does not return a document shell, styling, or a deployment claim.
 */
export function buildFirstPartyLiveArticleProjection(input: unknown): FirstPartyLiveArticleProjection {
  try {
    const request = exactRecord(input, ['document', 'siteOrigin', 'siteName'])
    if (!request) return blocked('live article input must contain only document, siteOrigin, and siteName as plain data fields')

    // Rebuild the verified wrapper from the document body; never trust a caller's status flag.
    if (!isNormalizedFirstPartyContentDocument(request.document)) return blocked('document must be a normalized document, not a verified wrapper')
    const manifestResult = buildFirstPartyContentManifest([request.document])
    if (manifestResult.status !== 'verified' || manifestResult.manifest.documents.length !== 1) return blocked('document failed the canonical manifest identity, hash, route, or privacy validation')
    const document: FirstPartyContentDocument = manifestResult.manifest.documents[0]!
    const seo = buildFirstPartySeoProjection({ document, siteOrigin: request.siteOrigin, siteName: request.siteName })
    if (seo.status !== 'verified') return blocked('SEO projection rejected the public origin or verified document')

    const liveDocument: LiveDocumentInput = {
      publicationId: document.publicationIdentity.publicationId,
      draftId: document.publicationIdentity.draftId,
      reviewId: document.publicationIdentity.reviewId,
      contentHash: document.bodyHash,
      evidenceSnapshotHash: document.evidenceSnapshotHash,
      title: document.title,
      body: document.body,
    }
    const article = renderLiveContentArticle(liveDocument)
    const expectedProjection = projectExpectedLiveDocument(liveDocument, seo.canonicalUrl)
    if (!article || !expectedProjection) return blocked('document Markdown, PII, identity, or expected live projection is not supported')

    // Exercise the exact article inside a representative SSR shell before exposing it.
    const renderedPage = `<html lang="${document.language}"><head><meta charset="utf-8"><title>Site page</title><link rel="canonical" href="${seo.canonicalUrl}"></head><body><header><nav aria-label="Primary">Site navigation</nav></header><main>${article}</main><footer>Site footer</footer></body></html>`
    const actualProjection = projectLivePage({ html: renderedPage, status: 200, url: seo.canonicalUrl })
    if (!actualProjection || !livePageMatchesExpected(actualProjection, expectedProjection)) return blocked('controlled article did not match the actual-page semantic projection')

    return {
      status: 'verified',
      canonicalUrl: seo.canonicalUrl,
      documentFingerprint: document.documentFingerprint,
      controlledArticleHtml: article,
      expectedProjection,
    }
  } catch {
    return blocked('live article projection input could not be safely verified')
  }
}
