import { buildFirstPartySeoProjection } from './seo'
import { safeJsonStringify } from './canonical'
import type {
  FirstPartyContentBlockedResult,
  FirstPartyContentDocument,
  FirstPartyNuxtHead,
  FirstPartyNuxtProjectionResult,
  FirstPartyProjectionInput,
} from './types'

function blocked(...reasons: string[]): FirstPartyContentBlockedResult {
  return { status: 'blocked', code: 'PROJECTION_INVALID', reasons }
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

function isDocument(value: unknown): value is FirstPartyContentDocument {
  if (!isRecord(value)) return false
  return read(value, 'status') === 'verified'
    && typeof read(value, 'title') === 'string'
    && typeof read(value, 'slug') === 'string'
    && (read(value, 'language') === 'en' || read(value, 'language') === 'zh-hant')
    && (read(value, 'contentType') === 'article' || read(value, 'contentType') === 'faq' || read(value, 'contentType') === 'service_page')
}

function serializeJsonLd(value: Record<string, unknown>): string | undefined {
  const serialized = safeJsonStringify(value)
  return serialized === undefined ? undefined : serialized.replace(/</g, '\\u003C')
}

function buildUseHead(document: FirstPartyContentDocument, seo: Extract<ReturnType<typeof buildFirstPartySeoProjection>, { status: 'verified' }>): FirstPartyNuxtHead | undefined {
  const meta: FirstPartyNuxtHead['meta'] = [
    { name: 'description', content: seo.description },
    { name: 'robots', content: seo.meta.robots },
    { property: 'og:type', content: seo.meta.openGraph.type },
    { property: 'og:title', content: seo.meta.openGraph.title },
    { property: 'og:description', content: seo.meta.openGraph.description },
    { property: 'og:url', content: seo.meta.openGraph.url },
    { property: 'og:locale', content: seo.meta.openGraph.locale },
  ]
  if (document.contentType === 'article') meta.push({ property: 'article:published_time', content: seo.meta.openGraph.publishedTime })
  const link: FirstPartyNuxtHead['link'] = [
    { rel: 'canonical', href: seo.meta.canonicalUrl },
    ...seo.meta.hreflang.map(alternate => ({ rel: 'alternate', href: alternate.href, hreflang: alternate.language })),
  ]
  if (seo.meta.xDefault !== undefined) link.push({ rel: 'alternate', href: seo.meta.xDefault, hreflang: 'x-default' })
  const script: FirstPartyNuxtHead['script'] = []
  for (const jsonLd of seo.jsonLd) {
    const textContent = serializeJsonLd(jsonLd)
    if (textContent === undefined || textContent.includes('</script>')) return undefined
    script.push({ type: 'application/ld+json', textContent })
  }
  return {
    title: seo.title,
    htmlAttrs: { lang: document.language },
    meta,
    link,
    script,
  }
}

export function buildNuxtContentProjection(input: unknown): FirstPartyNuxtProjectionResult {
  try {
    if (!isRecord(input)) return blocked('Nuxt projection input must be a plain object')
    const document = read(input, 'document')
    if (!isDocument(document)) return blocked('Nuxt projection requires a verified document')
    const seo = buildFirstPartySeoProjection(input as unknown as FirstPartyProjectionInput)
    if (seo.status === 'blocked') return seo
    const useHead = buildUseHead(document, seo)
    if (useHead === undefined) return blocked('Nuxt useHead projection could not be safely serialized')
    const projection: FirstPartyNuxtProjectionResult = {
      status: 'verified',
      framework: 'nuxt',
      routeParams: { lang: document.language, slug: document.slug },
      pageData: { document, seo },
      useHead,
      jsonLd: seo.jsonLd,
      sitemap: seo.sitemap,
    }
    if (safeJsonStringify(projection) === undefined) return blocked('Nuxt projection is not JSON-safe')
    return projection
  } catch {
    return blocked('Nuxt projection input could not be safely read')
  }
}
