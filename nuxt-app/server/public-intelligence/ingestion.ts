import { createHash } from 'node:crypto'

export const PUBLIC_INGESTION_EXTRACTOR_VERSION = 'public-ingestion-v2'
export const MAX_PUBLIC_DOCUMENT_BYTES = 1_000_000
export const MAX_PUBLIC_TEXT_CHARACTERS = 120_000

export type PiiFindingCounts = { emails: number, phones: number, nationalIds: number }
export type PublicDocumentFeatures = {
  documentTitlePresent: boolean
  hasH1: boolean
  canonicalPresent: boolean
  indexability: 'indexable' | 'noindex' | 'unknown'
  schemaTypes: string[]
  internalLinkCount: number
  signals: {
    primaryCta: boolean
    serviceRouting: boolean
    expertContact: boolean
    insights: boolean
    trustSignals: boolean
    priceOrEstimator: boolean
    faqOrGuidedTopics: boolean
  }
}

export type CleanedPublicDocument = {
  contentHash: string
  cleanedTextHash: string
  cleanedCharacterCount: number
  piiFindingCounts: PiiFindingCounts
  piiOutcome: 'not_detected' | 'redacted'
  features: PublicDocumentFeatures
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(?:x[\da-f]+|\d+);/gi, ' ')
}

function stripMarkup(value: string) {
  return decodeHtml(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
}

function countMatches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length
}

/**
 * Google Developers documentation includes a public pod.link numeric URL identifier in its footer.
 * It is not a telephone number; normalise only this exact URL form before PII scanning so it cannot
 * suppress valid public documentation while every other phone-like token remains fail-closed.
 */
function removeKnownNonPersonalUrlIdentifiers(value: string) {
  return value.replace(/\bhttps?:\/\/(?:www\.)?pod\.link\/\d{8,}\b/gi, '[public-url-identifier]')
}

function extractSchemaTypes(value: string) {
  const types = new Set<string>()
  for (const match of value.matchAll(/"@type"\s*:\s*"([A-Za-z][A-Za-z0-9._-]{1,80})"/g)) types.add(match[1]!)
  return [...types].sort().slice(0, 30)
}

function extractDocumentFeatures(html: string, cleanedText: string): PublicDocumentFeatures {
  const lower = html.toLowerCase()
  const text = cleanedText.toLowerCase()
  const contactPattern = /\b(contact|book|consult|enquir|talk to|聯絡|預約|諮詢|洽詢)\b/i
  const pricingPattern = /\b(price|pricing|quote|estimate|cost|費用|報價|價格|估算)\b/i
  const faqPattern = /\b(faq|frequently asked|question|常見問題|問答)\b/i
  return {
    documentTitlePresent: /<title\b[^>]*>\s*[^<]/i.test(html),
    hasH1: /<h1\b[^>]*>\s*[^<]/i.test(html),
    canonicalPresent: /<link\b[^>]*rel=["']canonical["']/i.test(html),
    indexability: /<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html) ? 'noindex' : /<meta\b[^>]*name=["']robots["']/i.test(html) ? 'indexable' : 'unknown',
    schemaTypes: extractSchemaTypes(html),
    internalLinkCount: countMatches(html, /<a\b[^>]+href=["']\/(?!\/)/gi),
    signals: {
      primaryCta: contactPattern.test(cleanedText),
      serviceRouting: /<a\b[^>]+href=["'][^"']+["']/i.test(html) && /\b(service|solution|capabilit|服務|方案)\b/i.test(cleanedText),
      expertContact: contactPattern.test(cleanedText) && /\b(team|expert|specialist|advisor|顧問|專家|團隊)\b/i.test(cleanedText),
      insights: /\b(blog|insight|article|publication|journal|文章|洞察|觀點)\b/i.test(text),
      trustSignals: /\b(case stud|client|award|certif|testimonial|案例|客戶|獎項|認證)\b/i.test(text),
      priceOrEstimator: pricingPattern.test(cleanedText),
      faqOrGuidedTopics: faqPattern.test(cleanedText),
    },
  }
}

/**
 * Converts one bounded public document into hashes and non-identifying structural facts.
 * The cleaned/redacted text remains in memory only; callers must persist hashes and typed features, not page copy.
 */
export function cleanAndExtractPublicDocument(rawHtml: string): CleanedPublicDocument {
  const boundedHtml = rawHtml.slice(0, MAX_PUBLIC_DOCUMENT_BYTES)
  const cleanedText = stripMarkup(boundedHtml).slice(0, MAX_PUBLIC_TEXT_CHARACTERS)
  const piiScanText = removeKnownNonPersonalUrlIdentifiers(cleanedText)
  const piiFindingCounts: PiiFindingCounts = {
    emails: countMatches(piiScanText, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi),
    phones: countMatches(piiScanText, /(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g),
    nationalIds: countMatches(piiScanText, /\b[A-Z][12]\d{8}\b/g),
  }
  const piiDetected = Object.values(piiFindingCounts).some(count => count > 0)
  const redacted = piiScanText
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g, '[redacted-phone]')
    .replace(/\b[A-Z][12]\d{8}\b/g, '[redacted-id]')
  return {
    contentHash: sha256(boundedHtml),
    cleanedTextHash: sha256(redacted),
    cleanedCharacterCount: cleanedText.length,
    piiFindingCounts,
    piiOutcome: piiDetected ? 'redacted' : 'not_detected',
    features: extractDocumentFeatures(boundedHtml, cleanedText),
  }
}

/** Reads at most the configured public-document size. Oversized responses are rejected before any persistence. */
export async function readBoundedPublicHtml(response: Response) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > MAX_PUBLIC_DOCUMENT_BYTES) throw new Error('response_too_large')
  if (!response.body) throw new Error('empty_response_body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_PUBLIC_DOCUMENT_BYTES) throw new Error('response_too_large')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return { html: new TextDecoder().decode(joined), byteLength: size }
}

export function ingestionRequestFingerprint(input: { sourceId: number, normalizedUrl: string, extractorVersion?: string }) {
  return sha256(JSON.stringify({ sourceId: input.sourceId, normalizedUrl: input.normalizedUrl, extractorVersion: input.extractorVersion || PUBLIC_INGESTION_EXTRACTOR_VERSION }))
}
