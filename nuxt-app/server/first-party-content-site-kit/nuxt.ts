import { buildFirstPartySeoProjection } from './seo'
import type {
  FirstPartyContentBlockedResult,
  FirstPartyContentDocument,
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

export function buildNuxtContentProjection(input: unknown): FirstPartyNuxtProjectionResult {
  try {
    if (!isRecord(input)) return blocked('Nuxt projection input must be a plain object')
    const document = read(input, 'document')
    if (!isDocument(document)) return blocked('Nuxt projection requires a verified document')
    const seo = buildFirstPartySeoProjection(input as unknown as FirstPartyProjectionInput)
    if (seo.status === 'blocked') return seo
    const projection: FirstPartyNuxtProjectionResult = {
      status: 'verified',
      framework: 'nuxt',
      routeParams: { lang: document.language, slug: document.slug },
      pageData: { document, seo },
      useHead: seo.meta,
      jsonLd: seo.jsonLd,
      sitemap: seo.sitemap,
    }
    const serialized = JSON.stringify(projection)
    if (serialized === undefined || serialized.includes('undefined') || serialized.includes('NaN') || serialized.includes('Infinity')) return blocked('Nuxt projection is not JSON-safe')
    return projection
  } catch {
    return blocked('Nuxt projection input could not be safely read')
  }
}
