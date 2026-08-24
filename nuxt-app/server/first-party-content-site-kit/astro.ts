import { buildFirstPartySeoProjection } from './seo'
import type {
  FirstPartyAstroProjectionResult,
  FirstPartyContentBlockedResult,
  FirstPartyContentDocument,
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

export function buildAstroContentProjection(input: unknown): FirstPartyAstroProjectionResult {
  try {
    if (!isRecord(input)) return blocked('Astro projection input must be a plain object')
    const document = read(input, 'document')
    if (!isDocument(document)) return blocked('Astro projection requires a verified document')
    const seo = buildFirstPartySeoProjection(input as unknown as FirstPartyProjectionInput)
    if (seo.status === 'blocked') return seo
    const projection: FirstPartyAstroProjectionResult = {
      status: 'verified',
      framework: 'astro',
      routeParams: { lang: document.language, slug: document.slug },
      collection: {
        id: document.sourcePath,
        data: document,
        body: document.body,
      },
      pageProps: { document, seo },
      head: seo.meta,
      jsonLd: seo.jsonLd,
      sitemap: seo.sitemap,
    }
    const serialized = JSON.stringify(projection)
    if (serialized === undefined || serialized.includes('undefined') || serialized.includes('NaN') || serialized.includes('Infinity')) return blocked('Astro projection is not JSON-safe')
    return projection
  } catch {
    return blocked('Astro projection input could not be safely read')
  }
}
