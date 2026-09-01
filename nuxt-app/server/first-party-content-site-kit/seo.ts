import { createHash } from 'node:crypto'
import { isPublicHttpsOrigin } from '../first-party-publishing/target-guard'
import { isOpaqueReference, isValidSha256, strictTimestamp } from '../first-party-publishing/normalization'
import { isNormalizedFirstPartyContentDocument } from './manifest'
import { compareCanonicalStrings, safeJsonStringify } from './canonical'
import type {
  FirstPartyContentBlockedResult,
  FirstPartyContentDocument,
  FirstPartyContentLanguage,
  FirstPartyContentType,
  FirstPartyFaqEvidenceEnvelope,
  FirstPartyFaqPair,
  FirstPartyHreflangAlternate,
  FirstPartySeoInput,
  FirstPartySeoMeta,
  FirstPartySeoProjection,
  FirstPartySeoResult,
  KnowledgeArticleJsonLdInput,
  KnowledgeArticleJsonLdResult,
  KnowledgeEntityRef,
} from './types'

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const INPUT_KEYS = new Set(['document', 'siteOrigin', 'siteName', 'organizationLogoUrl', 'alternateDocuments', 'fallbackDocument', 'xDefaultDocument', 'faqPairs', 'publisherEntity', 'authorEntities'])
const ENTITY_KEYS = new Set(['entityUid', 'name', 'kind', 'url', 'sameAs'])
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

function knowledgeEntityRef(value: unknown, requiredKind?: KnowledgeEntityRef['kind']): { ok: true; value: KnowledgeEntityRef } | { ok: false; reason: string } {
  if (!isRecord(value) || Object.keys(value).some(key => !ENTITY_KEYS.has(key))) return { ok: false, reason: 'Knowledge entity reference contains an unknown key or is not an object' }
  const entityUid = read(value, 'entityUid')
  const name = read(value, 'name')
  const kind = read(value, 'kind')
  if (!safeString(entityUid, 32) || entityUid.trim() !== entityUid || !safeString(name, 255) || name.trim() !== name || !name.trim()) return { ok: false, reason: 'Knowledge entity identity and name must be bounded non-empty strings' }
  if (kind !== 'organization' && kind !== 'person') return { ok: false, reason: 'Knowledge entity kind must be organization or person' }
  if (requiredKind !== undefined && kind !== requiredKind) return { ok: false, reason: `Knowledge entity kind must be ${requiredKind}` }
  const rawUrl = read(value, 'url')
  const url = rawUrl === undefined ? undefined : publicAbsoluteUrl(rawUrl)
  if (rawUrl !== undefined && url === undefined) return { ok: false, reason: 'Knowledge entity url must be a public HTTPS URL' }
  const rawSameAs = read(value, 'sameAs')
  let sameAs: string[] | undefined
  if (rawSameAs !== undefined) {
    if (!Array.isArray(rawSameAs) || rawSameAs.length < 1 || rawSameAs.length > 32) return { ok: false, reason: 'Knowledge entity sameAs must contain 1-32 public HTTPS URLs' }
    sameAs = []
    for (const item of rawSameAs) {
      const normalized = publicAbsoluteUrl(item)
      if (normalized === undefined || sameAs.includes(normalized)) return { ok: false, reason: 'Knowledge entity sameAs values must be unique public HTTPS URLs' }
      sameAs.push(normalized)
    }
  }
  return { ok: true, value: { entityUid, name, kind, ...(url === undefined ? {} : { url }), ...(sameAs === undefined ? {} : { sameAs }) } }
}

function knowledgeEntityRefs(value: unknown): { ok: true; value: KnowledgeEntityRef[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length > 32) return { ok: false, reason: 'authorEntities must be an array containing at most 32 knowledge entity references' }
  const result: KnowledgeEntityRef[] = []
  const identifiers = new Set<string>()
  for (const item of value) {
    const parsed = knowledgeEntityRef(item)
    if (!parsed.ok) return parsed
    if (identifiers.has(parsed.value.entityUid)) return { ok: false, reason: 'authorEntities must not contain duplicate entityUid values' }
    identifiers.add(parsed.value.entityUid)
    result.push(parsed.value)
  }
  return { ok: true, value: result }
}

export function knowledgeEntityJsonLdId(siteOrigin: string, entityUid: string): string {
  return `${siteOrigin}/#/knowledge/${entityUid}`
}

function knowledgeEntityNode(origin: string, entity: KnowledgeEntityRef, forcedType?: 'Organization' | 'Person'): Record<string, unknown> {
  return {
    '@type': forcedType ?? (entity.kind === 'person' ? 'Person' : 'Organization'),
    '@id': knowledgeEntityJsonLdId(origin, entity.entityUid),
    name: entity.name,
    ...(entity.url === undefined ? {} : { url: entity.url }),
    ...(entity.sameAs === undefined ? {} : { sameAs: entity.sameAs }),
  }
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
  return Array.from(combined).slice(0, 160).join('').trim()
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
  const fingerprints = new Set<string>()
  const routes = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.contentType !== document.contentType) return { ok: false, reason: 'alternateDocuments must use the same contentType' }
    if (candidate.publicationIdentity.productionPlanId !== document.publicationIdentity.productionPlanId) return { ok: false, reason: 'alternateDocuments must use the same productionPlanId' }
    if (byLanguage.has(candidate.language)) return { ok: false, reason: 'alternateDocuments contains duplicate language entries' }
    if (fingerprints.has(candidate.documentFingerprint)) return { ok: false, reason: 'alternateDocuments contains duplicate document fingerprints' }
    const route = canonicalUrl(origin, candidate)
    if (routes.has(route)) return { ok: false, reason: 'alternateDocuments contains duplicate routes' }
    if (route.includes('?') || route.includes('#')) return { ok: false, reason: 'alternate document route is not canonical' }
    byLanguage.set(candidate.language, candidate)
    fingerprints.add(candidate.documentFingerprint)
    routes.add(route)
  }
  return { ok: true, documents: LANGUAGE_ORDER.filter(language => byLanguage.has(language)).map(language => byLanguage.get(language) as FirstPartyContentDocument) }
}

function verifiedFaqPairs(raw: unknown, document: FirstPartyContentDocument): { ok: true; pairs: FirstPartyFaqPair[] } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'faqPairs must be a bound_faq_v1 envelope' }
  const keys = Object.keys(raw)
  if (keys.length !== 5 || keys.some(key => !['status', 'documentFingerprint', 'evidenceSnapshotHash', 'pairs', 'pairsFingerprint'].includes(key))) return { ok: false, reason: 'faqPairs envelope has an invalid field set' }
  if (read(raw, 'status') !== 'bound_faq_v1') return { ok: false, reason: 'faqPairs envelope status is invalid' }
  const documentFingerprint = read(raw, 'documentFingerprint')
  const evidenceSnapshotHash = read(raw, 'evidenceSnapshotHash')
  const pairsFingerprint = read(raw, 'pairsFingerprint')
  const rawPairs = read(raw, 'pairs')
  if (!isOpaqueReference(documentFingerprint) || !isValidSha256(documentFingerprint) || documentFingerprint !== document.documentFingerprint) return { ok: false, reason: 'faqPairs document fingerprint is stale or invalid' }
  if (!isValidSha256(evidenceSnapshotHash) || evidenceSnapshotHash !== evidenceSnapshotHash.toLowerCase() || evidenceSnapshotHash !== document.evidenceSnapshotHash) return { ok: false, reason: 'faqPairs evidence snapshot hash is stale or invalid' }
  if (!isValidSha256(pairsFingerprint) || pairsFingerprint !== pairsFingerprint.toLowerCase()) return { ok: false, reason: 'faqPairs pairs fingerprint is invalid' }
  if (!Array.isArray(rawPairs) || rawPairs.length < 1 || rawPairs.length > 32) return { ok: false, reason: 'faqPairs envelope must contain 1-32 pairs' }
  const pairs: FirstPartyFaqPair[] = []
  const questions = new Set<string>()
  for (const value of rawPairs) {
    if (!isRecord(value) || Object.keys(value).length !== 2 || Object.keys(value).some(key => key !== 'question' && key !== 'answer')) return { ok: false, reason: 'faq pair contains an unknown key' }
    const question = read(value, 'question')
    const answer = read(value, 'answer')
    if (!safeString(question, 512) || !safeString(answer, 5_000) || CONTROL.test(question) || CONTROL.test(answer)) return { ok: false, reason: 'faq pair question and answer must be bounded safe strings' }
    if (questions.has(question)) return { ok: false, reason: 'faq pair questions must be unique' }
    questions.add(question)
    pairs.push({ question, answer })
  }
  const payload = {
    version: 'bound_faq_v1',
    documentFingerprint,
    evidenceSnapshotHash,
    pairs,
  }
  const payloadJson = safeJsonStringify(payload)
  if (payloadJson === undefined || createHash('sha256').update(payloadJson, 'utf8').digest('hex') !== pairsFingerprint) return { ok: false, reason: 'faqPairs pairs fingerprint does not match the canonical payload' }
  return { ok: true, pairs }
}

function baseJsonLd(origin: string, document: FirstPartyContentDocument, siteName: string, logoUrl: string | undefined, publisherEntity: KnowledgeEntityRef | undefined): Record<string, unknown> {
  const url = canonicalUrl(origin, document)
  const publisher: Record<string, unknown> = publisherEntity === undefined ? { '@type': 'Organization', name: siteName } : knowledgeEntityNode(origin, publisherEntity, 'Organization')
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

function jsonLdFor(origin: string, document: FirstPartyContentDocument, siteName: string, logoUrl: string | undefined, faqPairs: readonly FirstPartyFaqPair[] | undefined, publisherEntity: KnowledgeEntityRef | undefined, authorEntities: readonly KnowledgeEntityRef[] | undefined): readonly Record<string, unknown>[] {
  const url = canonicalUrl(origin, document)
  const base = baseJsonLd(origin, document, siteName, logoUrl, publisherEntity)
  if (document.contentType === 'article') {
    return [{
      ...base,
      '@type': 'Article',
      '@id': `${url}#article`,
      headline: document.title,
      datePublished: document.publishedAt,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      ...(authorEntities === undefined || authorEntities.length === 0 ? {} : { author: authorEntities.map(entity => knowledgeEntityNode(origin, entity)) }),
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
    const fallbackProvided = Object.prototype.hasOwnProperty.call(input, 'fallbackDocument')
    const xDefaultProvided = Object.prototype.hasOwnProperty.call(input, 'xDefaultDocument')
    if (fallbackProvided && xDefaultProvided) return blocked('SEO_INPUT_INVALID', 'fallbackDocument and xDefaultDocument cannot both be provided')
    const fallbackRaw = fallbackProvided ? read(input, 'fallbackDocument') : xDefaultProvided ? read(input, 'xDefaultDocument') : undefined
    let fallback: FirstPartyContentDocument | undefined
    if (fallbackRaw !== undefined) {
      if (!isNormalizedFirstPartyContentDocument(fallbackRaw)) return blocked('SEO_INPUT_INVALID', 'fallbackDocument must be a verified document')
      if (fallbackRaw.documentFingerprint === documentValue.documentFingerprint || !alternates.documents.some(candidate => candidate.documentFingerprint === fallbackRaw.documentFingerprint && candidate.documentFingerprint !== documentValue.documentFingerprint)) return blocked('SEO_INPUT_INVALID', 'fallbackDocument must be one of the explicit alternate documents')
      fallback = fallbackRaw
    }
    const faqRaw = read(input, 'faqPairs')
    let faqPairs: FirstPartyFaqPair[] | undefined
    if (faqRaw !== undefined) {
      if (documentValue.contentType !== 'faq') return blocked('FAQ_PAIRS_INVALID', 'faqPairs are only accepted for faq documents')
      const faqResult = verifiedFaqPairs(faqRaw, documentValue)
      if (!faqResult.ok) return blocked('FAQ_PAIRS_INVALID', faqResult.reason)
      faqPairs = faqResult.pairs
    }
    const publisherRaw = read(input, 'publisherEntity')
    let publisherEntity: KnowledgeEntityRef | undefined
    if (publisherRaw !== undefined) {
      const parsed = knowledgeEntityRef(publisherRaw, 'organization')
      if (!parsed.ok) return blocked('ENTITY_INPUT_INVALID', parsed.reason)
      publisherEntity = parsed.value
    }
    const authorsRaw = read(input, 'authorEntities')
    let authorEntities: KnowledgeEntityRef[] | undefined
    if (authorsRaw !== undefined) {
      const parsed = knowledgeEntityRefs(authorsRaw)
      if (!parsed.ok) return blocked('ENTITY_INPUT_INVALID', parsed.reason)
      authorEntities = parsed.value
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
        type: documentValue.contentType === 'article' ? 'article' : 'website',
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
      jsonLd: jsonLdFor(origin, documentValue, siteName, logoUrl, faqPairs, publisherEntity, authorEntities),
      sitemap: { loc: canonical, lastmod: documentValue.publishedAt, alternates: hreflang },
    }
    if (safeJsonStringify(projection) === undefined) return blocked('SEO_INPUT_INVALID', 'SEO projection is not JSON-safe')
    return projection
  } catch {
    return blocked('SEO_INPUT_INVALID', 'SEO input could not be safely read')
  }
}

export function buildKnowledgeArticleJsonLd(input: KnowledgeArticleJsonLdInput): KnowledgeArticleJsonLdResult {
  try {
    if (!isRecord(input) || Object.keys(input).some(key => !['siteOrigin', 'siteName', 'article', 'publisherEntity', 'authorEntities'].includes(key))) return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['Knowledge Article input contains an unknown key'] }
    const origin = publicOrigin(read(input, 'siteOrigin'))
    if (origin === undefined) return { status: 'blocked', code: 'ORIGIN_INVALID', reasons: ['siteOrigin must be a public HTTPS origin without path, query, or fragment'] }
    const siteNameRaw = read(input, 'siteName')
    if (siteNameRaw !== undefined && !safeString(siteNameRaw, 256)) return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['siteName must be a bounded safe string when present'] }
    const article = read(input, 'article')
    if (!isRecord(article) || Object.keys(article).some(key => !['headline', 'articleId', 'datePublished', 'inLanguage', 'canonicalUrl'].includes(key))) return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['article contains an unknown key or is not an object'] }
    const headline = read(article, 'headline')
    const articleId = read(article, 'articleId')
    if (!safeString(headline, 500) || !safeString(articleId, 1024) || !articleId.startsWith('https://')) return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['article headline and HTTPS articleId are required'] }
    const datePublished = read(article, 'datePublished')
    if (datePublished !== undefined && !strictTimestamp(datePublished).ok) return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['datePublished must be a strict timestamp'] }
    const inLanguage = read(article, 'inLanguage')
    if (inLanguage !== undefined && !safeString(inLanguage, 16)) return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['inLanguage must be a bounded safe string'] }
    const canonicalRaw = read(article, 'canonicalUrl')
    const canonicalUrlValue = canonicalRaw === undefined ? undefined : publicAbsoluteUrl(canonicalRaw)
    if (canonicalRaw !== undefined && canonicalUrlValue === undefined) return { status: 'blocked', code: 'ORIGIN_INVALID', reasons: ['canonicalUrl must be a public HTTPS URL'] }
    const publisherRaw = read(input, 'publisherEntity')
    let publisherEntity: KnowledgeEntityRef | undefined
    if (publisherRaw !== undefined) {
      const parsed = knowledgeEntityRef(publisherRaw, 'organization')
      if (!parsed.ok) return { status: 'blocked', code: 'ENTITY_INPUT_INVALID', reasons: [parsed.reason] }
      publisherEntity = parsed.value
    }
    const authorsRaw = read(input, 'authorEntities')
    let authorEntities: KnowledgeEntityRef[] | undefined
    if (authorsRaw !== undefined) {
      const parsed = knowledgeEntityRefs(authorsRaw)
      if (!parsed.ok) return { status: 'blocked', code: 'ENTITY_INPUT_INVALID', reasons: [parsed.reason] }
      authorEntities = parsed.value
    }
    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      '@id': articleId,
      headline,
      ...(canonicalUrlValue === undefined ? {} : { url: canonicalUrlValue, mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrlValue } }),
      ...(datePublished === undefined ? {} : { datePublished }),
      ...(inLanguage === undefined ? {} : { inLanguage }),
      ...(publisherEntity !== undefined ? { publisher: knowledgeEntityNode(origin, publisherEntity, 'Organization') } : siteNameRaw === undefined ? {} : { publisher: { '@type': 'Organization', name: siteNameRaw } }),
      ...(authorEntities === undefined || authorEntities.length === 0 ? {} : { author: authorEntities.map(entity => knowledgeEntityNode(origin, entity)) }),
    }
    if (safeJsonStringify(jsonLd) === undefined) return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['Knowledge Article JSON-LD is not JSON-safe'] }
    return { status: 'verified', jsonLd }
  } catch {
    return { status: 'blocked', code: 'SEO_INPUT_INVALID', reasons: ['Knowledge Article input could not be safely read'] }
  }
}

export type { FirstPartyContentLanguage, FirstPartyContentType }
