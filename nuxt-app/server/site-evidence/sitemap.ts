export type SitemapEntry = { url: string, lastmod: string | null }
export type ParsedSitemap = { kind: 'urlset' | 'sitemapindex' | 'unknown', entries: SitemapEntry[], truncated: boolean, errorCode: string | null }

function decodeXml(value: string) {
  const cdata = value.trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/u)
  return (cdata ? cdata[1]! : value).trim()
    .replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
}

function tag(block: string, name: string) {
  const match = block.match(new RegExp(`<(?:(?:[\\w.-]+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${name}\\s*>`, 'iu'))
  return match ? decodeXml(match[1]!) : null
}

function validHttpUrl(value: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch { return null }
}

export function parseSitemap(content: string, contentType = 'application/xml', maxEntries = 5_000): ParsedSitemap {
  const capped = Math.max(1, maxEntries)
  if (contentType.toLowerCase().includes('text/plain') && !/<(?:[\w.-]+:)?(?:urlset|sitemapindex)\b/iu.test(content)) {
    const urls = content.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(validHttpUrl).filter((url): url is string => Boolean(url))
    return { kind: urls.length ? 'urlset' : 'unknown', entries: [...new Set(urls)].slice(0, capped).map(url => ({ url, lastmod: null })), truncated: urls.length > capped, errorCode: urls.length ? null : 'sitemap_parse_failed' }
  }
  const index = /<(?:[\w.-]+:)?sitemapindex\b/iu.test(content)
  const urlset = /<(?:[\w.-]+:)?urlset\b/iu.test(content)
  const kind = index ? 'sitemapindex' : urlset ? 'urlset' : 'unknown'
  if (kind === 'unknown') return { kind, entries: [], truncated: false, errorCode: 'sitemap_parse_failed' }
  const element = kind === 'sitemapindex' ? 'sitemap' : 'url'
  const blocks = [...content.matchAll(new RegExp(`<(?:(?:[\\w.-]+):)?${element}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${element}\\s*>`, 'giu'))]
  const entries = blocks.map(match => ({ url: validHttpUrl(tag(match[1]!, 'loc')), lastmod: tag(match[1]!, 'lastmod') })).filter((entry): entry is SitemapEntry => Boolean(entry.url))
  const unique = [...new Map(entries.map(entry => [entry.url, entry])).values()]
  return { kind, entries: unique.slice(0, capped), truncated: unique.length > capped, errorCode: unique.length || !blocks.length ? null : 'sitemap_parse_failed' }
}
