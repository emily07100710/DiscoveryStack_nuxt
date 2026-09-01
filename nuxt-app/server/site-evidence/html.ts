import { isSameSite, normalizeUrl } from './normalization'
import type { FindingStatus, HtmlSignals } from './types'

const HTML_BOUND = 1024 * 1024

function decode(value: string) {
  return value.replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'")
}

function cleanText(value: string) {
  return decode(value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim())
}

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu'))
  return match ? decode(match[1] ?? match[2] ?? match[3] ?? '') : null
}

function firstTagText(html: string, tag: string) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'iu'))
  return match ? cleanText(match[1]!) || null : null
}

function resolveHttpUrl(value: string | null, baseUrl: string) {
  if (!value || /^(?:mailto|tel|javascript|data):/iu.test(value.trim())) return null
  try {
    const url = new URL(value.trim(), baseUrl)
    url.hash = ''
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch { return null }
}

export function extractHtmlSignals(inputHtml: string, baseUrl: string): HtmlSignals {
  const html = inputHtml.slice(0, HTML_BOUND)
  const links: string[] = []
  for (const match of html.matchAll(/<a\b[^>]*>/giu)) {
    const resolved = resolveHttpUrl(attribute(match[0], 'href'), baseUrl)
    if (resolved) links.push(resolved)
  }
  const internalLinks = [...new Set(links.filter(url => isSameSite(url, baseUrl)).map(normalizeUrl))]
  const externalLinks = [...new Set(links.filter(url => !isSameSite(url, baseUrl)).map(normalizeUrl))]
  let canonicalUrl: string | null = null
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = attribute(match[0], 'rel')?.toLowerCase().split(/\s+/u) || []
    if (rel.includes('canonical')) { canonicalUrl = resolveHttpUrl(attribute(match[0], 'href'), baseUrl); break }
  }
  let metaRobots: string | null = null
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    if (attribute(match[0], 'name')?.toLowerCase() === 'robots') { metaRobots = attribute(match[0], 'content'); break }
  }
  const title = firstTagText(html, 'title')
  const h1 = firstTagText(html, 'h1')
  const visible = cleanText(html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, ' ').replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/giu, ' '))
  const phrase = `${title || ''} ${visible}`.toLowerCase()
  const notFoundSignal = visible.length < 2_000 && /(?:\b404\b|page not found|not found|找不到)/iu.test(phrase)
  return { title, canonicalUrl, metaRobots, textLength: visible.length, anchorCount: links.length, internalAnchorCount: links.filter(url => isSameSite(url, baseUrl)).length, internalLinks, externalLinks, h1, notFoundSignal }
}

export type RawRenderedCheck = { status: FindingStatus | 'not_detected', evidence: Record<string, unknown> }
export type RawRenderedComparison = { raw_missing_main_content: RawRenderedCheck, js_only_links: RawRenderedCheck, raw_rendered_mismatch: RawRenderedCheck }

export function compareRawRendered(raw: HtmlSignals, rendered: HtmlSignals | null | undefined): RawRenderedComparison {
  if (!rendered) {
    const unknown = (): RawRenderedCheck => ({ status: 'unknown', evidence: { reason: 'rendered_unavailable' } })
    return { raw_missing_main_content: unknown(), js_only_links: unknown(), raw_rendered_mismatch: unknown() }
  }
  const missing = rendered.textLength > 500 && raw.textLength < rendered.textLength * 0.3
  const rawLinks = new Set(raw.internalLinks.map(normalizeUrl))
  const examples = rendered.internalLinks.map(normalizeUrl).filter(url => !rawLinks.has(url))
  const mismatchFields = (['title', 'canonicalUrl', 'metaRobots'] as const).filter(key => (raw[key] || null) !== (rendered[key] || null))
  return {
    raw_missing_main_content: { status: missing ? 'detected' : 'not_detected', evidence: { rawTextLength: raw.textLength, renderedTextLength: rendered.textLength } },
    js_only_links: { status: examples.length ? 'detected' : 'not_detected', evidence: { count: examples.length, examples: examples.slice(0, 20) } },
    raw_rendered_mismatch: { status: mismatchFields.length ? 'detected' : 'not_detected', evidence: { fields: mismatchFields } },
  }
}
