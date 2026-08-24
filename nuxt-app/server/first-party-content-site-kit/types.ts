import type { FirstPartyPublicationIdentity } from '../first-party-publishing/types'

export const FIRST_PARTY_CONTENT_SITE_KIT_VERSION = 'first-party-content-site-kit-v1' as const

export type FirstPartyContentLanguage = 'en' | 'zh-hant'
export type FirstPartyContentType = 'article' | 'faq' | 'service_page'

export type ContentSiteKitDecisionCode =
  | 'INVALID_INPUT'
  | 'DOCUMENT_INVALID'
  | 'FRONTMATTER_MISSING'
  | 'FRONTMATTER_DUPLICATE'
  | 'FRONTMATTER_UNKNOWN_KEY'
  | 'FRONTMATTER_FIELD_INVALID'
  | 'BODY_HASH_MISMATCH'
  | 'EVIDENCE_HASH_INVALID'
  | 'CONTENT_HASH_INVALID'
  | 'PATH_INVALID'
  | 'ROUTE_INVALID'
  | 'MANIFEST_TOO_LARGE'
  | 'MANIFEST_COLLISION'
  | 'ORIGIN_INVALID'
  | 'SEO_INPUT_INVALID'
  | 'FAQ_PAIRS_INVALID'
  | 'PROJECTION_INVALID'

export type FirstPartyContentPublicationIdentity = Pick<FirstPartyPublicationIdentity, 'publicationId' | 'scheduleEntryId' | 'productionPlanId' | 'draftId' | 'reviewId'>

export interface FirstPartyContentDocument {
  readonly status: 'verified'
  readonly publicationIdentity: FirstPartyContentPublicationIdentity
  readonly title: string
  readonly slug: string
  readonly language: FirstPartyContentLanguage
  readonly contentType: FirstPartyContentType
  readonly body: string
  readonly bodyHash: string
  readonly evidenceSnapshotHash: string
  readonly authoritySourceIds: readonly string[]
  readonly appliedRuleIds: readonly string[]
  readonly publishedAt: string
  readonly sourcePath: string
  readonly routePath: string
  readonly canonicalPath: string
  readonly documentFingerprint: string
}

export interface FirstPartyContentBlockedResult {
  readonly status: 'blocked'
  readonly code: ContentSiteKitDecisionCode
  readonly reasons: readonly string[]
}

export type FirstPartyContentParseResult = { readonly status: 'verified'; readonly document: FirstPartyContentDocument } | FirstPartyContentBlockedResult

export interface FirstPartyContentManifest {
  readonly status: 'verified'
  readonly version: typeof FIRST_PARTY_CONTENT_SITE_KIT_VERSION
  readonly documents: readonly FirstPartyContentDocument[]
  readonly manifestFingerprint: string
}

export type FirstPartyContentManifestResult = { readonly status: 'verified'; readonly manifest: FirstPartyContentManifest } | FirstPartyContentBlockedResult

export interface FirstPartyFaqPair {
  readonly question: string
  readonly answer: string
}

export interface FirstPartyFaqEvidenceEnvelope {
  readonly status: 'bound_faq_v1'
  readonly documentFingerprint: string
  readonly evidenceSnapshotHash: string
  readonly pairs: readonly FirstPartyFaqPair[]
  readonly pairsFingerprint: string
}

export interface FirstPartyHreflangAlternate {
  readonly language: FirstPartyContentLanguage
  readonly href: string
}

export interface FirstPartyBreadcrumbItem {
  readonly name: string
  readonly item: string
}

export interface FirstPartySitemapEntry {
  readonly loc: string
  readonly lastmod: string
  readonly alternates: readonly FirstPartyHreflangAlternate[]
}

export interface FirstPartySeoMeta {
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string
  readonly robots: 'index, follow'
  readonly openGraph: {
    readonly type: 'article' | 'website'
    readonly title: string
    readonly description: string
    readonly url: string
    readonly locale: FirstPartyContentLanguage
    readonly publishedTime: string
  }
  readonly hreflang: readonly FirstPartyHreflangAlternate[]
  readonly xDefault?: string
  readonly breadcrumb: readonly FirstPartyBreadcrumbItem[]
}

export interface FirstPartySeoProjection {
  readonly status: 'verified'
  readonly documentFingerprint: string
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string
  readonly meta: FirstPartySeoMeta
  readonly jsonLd: readonly Record<string, unknown>[]
  readonly sitemap: FirstPartySitemapEntry
}

export type FirstPartySeoResult = FirstPartySeoProjection | FirstPartyContentBlockedResult

export interface FirstPartyAstroContentProjection {
  readonly status: 'verified'
  readonly framework: 'astro'
  readonly routeParams: Readonly<Record<'lang' | 'slug', string>>
  readonly collection: {
    readonly id: string
    readonly data: FirstPartyContentDocument
    readonly body: string
  }
  readonly pageProps: {
    readonly document: FirstPartyContentDocument
    readonly seo: FirstPartySeoProjection
  }
  readonly head: FirstPartySeoMeta
  readonly jsonLd: readonly Record<string, unknown>[]
  readonly sitemap: FirstPartySitemapEntry
}

export type FirstPartyAstroProjectionResult = FirstPartyAstroContentProjection | FirstPartyContentBlockedResult

export interface FirstPartyNuxtMetaName {
  readonly name: string
  readonly content: string
}

export interface FirstPartyNuxtMetaProperty {
  readonly property: string
  readonly content: string
}

export type FirstPartyNuxtMeta = FirstPartyNuxtMetaName | FirstPartyNuxtMetaProperty

export interface FirstPartyNuxtHead {
  readonly title: string
  readonly htmlAttrs: {
    readonly lang: FirstPartyContentLanguage
  }
  readonly meta: Array<FirstPartyNuxtMeta>
  readonly link: Array<{
    readonly rel: string
    readonly href: string
    readonly hreflang?: string
  }>
  readonly script: Array<{
    readonly type: 'application/ld+json'
    readonly textContent: string
  }>
}

export interface FirstPartyNuxtContentProjection {
  readonly status: 'verified'
  readonly framework: 'nuxt'
  readonly routeParams: Readonly<Record<'lang' | 'slug', string>>
  readonly pageData: {
    readonly document: FirstPartyContentDocument
    readonly seo: FirstPartySeoProjection
  }
  readonly useHead: FirstPartyNuxtHead
  readonly jsonLd: readonly Record<string, unknown>[]
  readonly sitemap: FirstPartySitemapEntry
}

export type FirstPartyNuxtProjectionResult = FirstPartyNuxtContentProjection | FirstPartyContentBlockedResult

export interface FirstPartySeoInput {
  readonly document: unknown
  readonly siteOrigin: unknown
  readonly siteName: unknown
  readonly organizationLogoUrl?: unknown
  readonly alternateDocuments?: unknown
  readonly fallbackDocument?: unknown
  readonly xDefaultDocument?: unknown
  readonly faqPairs?: unknown
}

export interface FirstPartyProjectionInput extends FirstPartySeoInput {}

export type FirstPartyParseInput =
  | {
      readonly contentRoot: unknown
      readonly sourcePath: unknown
      readonly markdown: unknown
    }
  | {
      readonly contentRoot: unknown
      readonly sourcePath: unknown
      readonly content: unknown
    }
