import { createHash } from 'node:crypto'
import { isPublicHttpsOrigin } from '../first-party-publishing/target-guard'
import { isOpaqueReference, isValidSha256, strictTimestamp } from '../first-party-publishing/normalization'
import { isNormalizedFirstPartyContentDocument } from './manifest'
import type {
  FirstPartyContentBlockedResult,
  FirstPartyContentDocument,
  FirstPartyContentLanguage,
  FirstPartyContentType,
  FirstPartyFaqPair,
  FirstPartyHreflangAlternate,
  FirstPartySeoInput,
  FirstPartySeoMeta,
  FirstPartySeoProjection,
  FirstPartySeoResult,
} from './types'

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const INPUT_KEYS = new Set(['document', 'siteOrigin', 'siteName', 'organizationLogoUrl', 'alternateDocuments', 'fallbackDocument', 'xDefaultDocument', 'faqPairs'])
const LANGUAGE_ORDER: readonly FirstPartyContentLanguage[] = ['en', 'zh-hant']

function blocked(code: FirstPartyContentBlockedResult['code'], ...reasons: string[]): FirstPartySeoResult {
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

function safeString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && !CONTROL.test(value)
}

function publicOrigin(value: unknown): string | undefined {
  if (!safeString(value, 512)) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (!isPublicHttpsOrigin(parsed.origin) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) return undefined
  return parsed.origin
}

function publicAbsoluteUrl(value: unknown): string | undefined {
  if (!safeString(value, 1024)) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (!isPublicHttpsOrigin(parsed.origin) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) return undefined
  return parsed.href
}

function routeSegment(contentType: FirstPartyContentType): 'articles' | 'faq' | 'services' {
  return contentType === 'article' ? 'articles' : contentType === 'faq' ? 'faq' : 'services'
}

function canonicalUrl(origin: string, document: FirstPartyContentDocument): string {
  return `${origin}${document.routePath}`
}

function plainExcerpt(document: FirstPartyContentDocument): string {
  const transformed = document.body
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[>#*_`~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const combined = `${document.title}. ${transformed}`.trim()
  return combined.slice(0, 160).trim()
}

function breadcrumb(origin: string, document: FirstPartyContentDocument): readonly FirstPartySeoMeta['breadcrumb'][number][] {
  const section = routeSegment(document.contentType)
  return [
    { name: 'Home', item: `${origin}/` },
    { name: section, item: `${origin}/${document.language}/${section}` },
    { name: document.title, item: canonicalUrl(origin, document) },
  ]
}

function normalizedAlternates(origin: string, document: FirstPartyContentDocument, raw: unknown): { ok: true; documents: FirstPartyContentDocument[] } | { ok: false; reason: string } {
  const candidates: FirstPartyContentDocument[] = [document]
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length > 2) return { ok: false, reason: 'alternateDocuments must contain at most two documents' }
    for (const item of raw) {
      if (!isNormalizedFirstPartyContentDocument(item)) return { ok: false, reason: 'alternateDocuments must contain verified documents' }
      candidates.push(item)
    }
  }
  const byLanguage = new Map<FirstPartyContentLanguage, FirstPartyContentDocument>()
  for (const candidate of candidates) {
    if (byLanguage.has(candidate.language)) return { ok: false, reason: 'alternateDocuments contains duplicate language entries' }
    if (canonicalUrl(origin, candidate).includes('?') || canonicalUrl(origin, candidate).includes('#')) return { ok: false, reason: 'alternate document route is not canonical' }
    byLanguage.set(candidate.language, candidate)
  }
  return { ok: true, documents: LANGUAGE_ORDER.filter(language => byLanguage.has(language)).map(language => byLanguage.get(language) as FirstPartyContentDocument) }
}

function verifiedFaqPairs(raw: unknown): { ok: true; pairs: FirstPartyFaqPair[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) return { ok: false, reason: 'faqPairs must contain 1-32 verified pairs' }
  const pairs: FirstPartyFaqPair[] = []
  for (const value of raw) {
    if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.keys(value).every(key => key === 'question' || key === 'answer')) return { ok: false, reason: 'faq pair contains an unknown key' }
    const question = read(value, 'question')
    const answer = read(value, 'answer')
    if (!safeString(question, 512) || !safeString(answer, 5_000) || CONTROL.test(question) || CONTROL.test(answer)) return { ok: false, reason: 'faq pair question and answer must be bounded safe strings' }
    pairs.push({ question, answer })
  }
  return { ok: true, pairs }
}

function baseJsonLd(origin: string, document: FirstPartyContentDocument, siteName: string, logoUrl: string | undefined): Record<string, unknown> {
  const url = canonicalUrl(origin, document)
  const publisher: Record<string, unknown> = { '@type': 'Organization', name: siteName }
  if (logoUrl !== undefined) publisher.logo = { '@type': 'ImageObject', url: logoUrl }
  return {
    '@context': 'https://schema.org',
    '@id': `${url}#webpage`,
    url,
    name: document.title,
    inLanguage: document.language,
    isPartOf: { '@type': 'WebSite', name: siteName, url: `${origin}/` },
    publisher,
  }
}

function jsonLdFor(origin: string, document: FirstPartyContentDocument, siteName: string, logoUrl: string | undefined, faqPairs: readonly FirstPartyFaqPair[] | undefined): readonly Record<string, unknown>[] {
  const url = canonicalUrl(origin, document)
  const base = baseJsonLd(origin, document, siteName, logoUrl)
  if (document.contentType === 'article') {
    return [{
      ...base,
      '@type': 'Article',
      '@id': `${url}#article`,
      headline: document.title,
      datePublished: document.publishedAt,
      mainEntityOfPage: { '@id': `${url}#webpage` },
    }]
  }
  if (document.contentType === 'faq' && faqPairs !== undefined) {
    return [
      { ...base, '@type': 'WebPage' },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        '@id': `${url}#faqpage`,
        url,
        inLanguage: document.language,
        mainEntity: faqPairs.map(pair => ({
          '@type': 'Question',
          name: pair.question,
          acceptedAnswer: { '@type': 'Answer', text: pair.answer },
        })),
      },
    ]
  }
  return [{ ...base, '@type': 'WebPage', '@id': `${url}#webpage` }]
}

function buildHreflang(origin: string, documents: readonly FirstPartyContentDocument[]): readonly FirstPartyHreflangAlternate[] {
  return documents.map(document => ({ language: document.language, href: canonicalUrl(origin, document) }))
}

export function buildFirstPartySeoProjection(input: unknown): FirstPartySeoResult {
  try {
    if (!isRecord(input) || Object.keys(input).some(key => !INPUT_KEYS.has(key))) return blocked('SEO_INPUT_INVALID', 'SEO input contains an unknown key')
    const documentValue = read(input, 'document')
    if (!isNormalizedFirstPartyContentDocument(documentValue)) return blocked('SEO_INPUT_INVALID', 'SEO requires a verified normalized document')
    const origin = publicOrigin(read(input, 'siteOrigin'))
    if (origin === undefined) return blocked('ORIGIN_INVALID', 'siteOrigin must be a public HTTPS origin without path, query, or fragment')
    const siteName = read(input, 'siteName')
    if (!safeString(siteName, 256)) return blocked('SEO_INPUT_INVALID', 'siteName must be a bounded safe string')
    const logoRaw = read(input, 'organizationLogoUrl')
    const logoUrl = logoRaw === undefined ? undefined : publicAbsoluteUrl(logoRaw)
    if (logoRaw !== undefined && logoUrl === undefined) return blocked('ORIGIN_INVALID', 'organizationLogoUrl must be a public HTTPS URL')
    const alternates = normalizedAlternates(origin, documentValue, read(input, 'alternateDocuments'))
    if (!alternates.ok) return blocked('SEO_INPUT_INVALID', alternates.reason)
    const fallbackRaw = read(input, 'fallbackDocument') ?? read(input, 'xDefaultDocument')
    let fallback: FirstPartyContentDocument | undefined
    if (fallbackRaw !== undefined) {
      if (!isNormalizedFirstPartyContentDocument(fallbackRaw)) return blocked('SEO_INPUT_INVALID', 'fallbackDocument must be a verified document')
      if (!alternates.documents.some(document => document.documentFingerprint === fallbackRaw.documentFingerprint)) return blocked('SEO_INPUT_INVALID', 'fallbackDocument must be one of the explicit alternate documents')
      fallback = fallbackRaw
    }
    const faqRaw = read(input, 'faqPairs')
    let faqPairs: FirstPartyFaqPair[] | undefined
    if (faqRaw !== undefined) {
      const faqResult = verifiedFaqPairs(faqRaw)
      if (!faqResult.ok) return blocked('FAQ_PAIRS_INVALID', faqResult.reason)
      if (documentValue.contentType !== 'faq') return blocked('FAQ_PAIRS_INVALID', 'faqPairs are only accepted for faq documents')
      faqPairs = faqResult.pairs
    }
    const canonical = canonicalUrl(origin, documentValue)
    const hreflang = buildHreflang(origin, alternates.documents)
    const description = plainExcerpt(documentValue)
    if (description.length < 1) return blocked('SEO_INPUT_INVALID', 'description cannot be derived from the verified document')
    const meta: FirstPartySeoMeta = {
      title: documentValue.title,
      description,
      canonicalUrl: canonical,
      robots: 'index, follow',
      openGraph: {
        type: documentValue.contentType === 'service_page' ? 'website' : 'article',
        title: documentValue.title,
        description,
        url: canonical,
        locale: documentValue.language,
        publishedTime: documentValue.publishedAt,
      },
      hreflang,
      ...(fallback === undefined ? {} : { xDefault: canonicalUrl(origin, fallback) }),
      breadcrumb: breadcrumb(origin, documentValue),
    }
    const projection: FirstPartySeoProjection = {
      status: 'verified',
      documentFingerprint: documentValue.documentFingerprint,
      title: documentValue.title,
      description,
      canonicalUrl: canonical,
      meta,
      jsonLd: jsonLdFor(origin, documentValue, siteName, logoUrl, faqPairs),
      sitemap: { loc: canonical, lastmod: documentValue.publishedAt, alternates: hreflang },
    }
    const serialized = JSON.stringify(projection)
    if (serialized === undefined || serialized.includes('undefined') || serialized.includes('NaN') || serialized.includes('Infinity')) return blocked('SEO_INPUT_INVALID', 'SEO projection is not JSON-safe')
    return projection
  } catch {
    return blocked('SEO_INPUT_INVALID', 'SEO input could not be safely read')
  }
}

export function computeSeoProjectionFingerprint(projection: FirstPartySeoProjection): string {
  return createHash('sha256').update(JSON.stringify(projection), 'utf8').digest('hex')
}

export type { FirstPartyContentLanguage, FirstPartyContentType }
