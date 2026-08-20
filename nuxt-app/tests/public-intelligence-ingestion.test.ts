import { describe, expect, it } from 'vitest'
import { cleanAndExtractPublicDocument, ingestionRequestFingerprint, MAX_PUBLIC_DOCUMENT_BYTES, readBoundedPublicHtml } from '../server/public-intelligence/ingestion'
import { artifactFingerprint, canonicalHumanAnnotationSourceUrl, humanAnnotationSourceIdentity } from '../server/public-intelligence/repository'

describe('policy-approved public ingestion contracts', () => {
  it('extracts bounded structural features and only returns hashes for a public document', () => {
    const output = cleanAndExtractPublicDocument(`<!doctype html><html><head><title>SEO service</title><link rel="canonical" href="https://example.com/services"><script type="application/ld+json">{"@type":"ProfessionalService"}</script></head><body><h1>SEO services</h1><nav><a href="/services">Services</a></nav><a href="/contact">Contact our expert</a><section>Frequently asked questions</section></body></html>`)
    expect(output.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(output.cleanedTextHash).toMatch(/^[a-f0-9]{64}$/)
    expect(output).not.toHaveProperty('html')
    expect(output).not.toHaveProperty('cleanedText')
    expect(output.features.documentTitlePresent).toBe(true)
    expect(output.features.hasH1).toBe(true)
    expect(output.features.canonicalPresent).toBe(true)
    expect(output.features.schemaTypes).toContain('ProfessionalService')
    expect(output.features.signals.primaryCta).toBe(true)
    expect(output.features.signals.expertContact).toBe(true)
    expect(output.features.signals.faqOrGuidedTopics).toBe(true)
  })

  it('records PII detection as redaction-ready metadata without retaining the detected values', () => {
    const output = cleanAndExtractPublicDocument('<html><body><h1>Contact</h1>Email hello@example.com or call +886 2 1234 5678.</body></html>')
    expect(output.piiOutcome).toBe('redacted')
    expect(output.piiFindingCounts.emails).toBe(1)
    expect(output.piiFindingCounts.phones).toBe(1)
    expect(JSON.stringify(output)).not.toContain('hello@example.com')
    expect(JSON.stringify(output)).not.toContain('+886 2 1234 5678')
  })

  it('does not classify the known public pod.link footer identifier as a phone number, while retaining fail-closed detection for an actual phone', () => {
    const identifierOnly = cleanAndExtractPublicDocument('<html><body><a href="https://pod.link/1512522198">Podcast</a></body></html>')
    const mixed = cleanAndExtractPublicDocument('<html><body><a href="https://pod.link/1512522198">Podcast</a> Call +886 2 1234 5678.</body></html>')

    expect(identifierOnly.piiOutcome).toBe('not_detected')
    expect(identifierOnly.piiFindingCounts.phones).toBe(0)
    expect(mixed.piiOutcome).toBe('redacted')
    expect(mixed.piiFindingCounts.phones).toBe(1)
  })

  it('does not classify ISO publication dates or timezone-qualified timestamps as phone numbers', () => {
    const output = cleanAndExtractPublicDocument('<html><body>Last updated 2025-12-10. Starts 2025-07-21T19:00-05:00 and ends 2025-07-21T23:00:00Z.</body></html>')
    expect(output.piiOutcome).toBe('not_detected')
    expect(output.piiFindingCounts.phones).toBe(0)
  })

  it('keeps actual phone, email and national-ID-like strings fail-closed beside ISO timestamps', () => {
    const output = cleanAndExtractPublicDocument('<html><body>Published 2025-07-21T19:00-05:00. Call +886 2 1234 5678, email hello@example.com, ID A123456789.</body></html>')
    expect(output.piiOutcome).toBe('redacted')
    expect(output.piiFindingCounts.emails).toBe(1)
    expect(output.piiFindingCounts.nationalIds).toBe(1)
    expect(output.piiFindingCounts.phones).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(output)).not.toContain('+886 2 1234 5678')
    expect(JSON.stringify(output)).not.toContain('hello@example.com')
    expect(JSON.stringify(output)).not.toContain('A123456789')
  })

  it('rejects an oversized response before it can enter cleaning or persistence', async () => {
    const response = new Response('small', { headers: { 'content-length': String(MAX_PUBLIC_DOCUMENT_BYTES + 1) } })
    await expect(readBoundedPublicHtml(response)).rejects.toThrow('response_too_large')
  })

  it('uses source ID, normalised URL and extractor version for dedupe—not raw page content', () => {
    const first = ingestionRequestFingerprint({ sourceId: 7, normalizedUrl: 'https://approved.example/service' })
    const second = ingestionRequestFingerprint({ sourceId: 7, normalizedUrl: 'https://approved.example/service' })
    const differentUrl = ingestionRequestFingerprint({ sourceId: 7, normalizedUrl: 'https://approved.example/other' })
    expect(first).toBe(second)
    expect(first).not.toBe(differentUrl)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
  })

  it('distinguishes separate source documents with coincident structural features while retaining exact-document deduplication', () => {
    const shared = {
      sourceId: 1,
      artifactType: 'structural_features',
      sourceLocator: 'document:derived-structural-features',
      artifactText: null,
      fieldData: { signals: { primaryCta: false }, primaryJourneyStage: 'progression', navigationDepth: 0, serviceRoutes: 0 },
    }
    const first = artifactFingerprint({ ...shared, sourceUrl: 'https://developers.google.com/search/docs/one?hl=en', sourceSpanHash: 'a'.repeat(64) })
    const sameDocument = artifactFingerprint({ ...shared, sourceUrl: 'https://developers.google.com/search/docs/one?hl=en', sourceSpanHash: 'a'.repeat(64) })
    const differentDocument = artifactFingerprint({ ...shared, sourceUrl: 'https://developers.google.com/search/docs/two?hl=en', sourceSpanHash: 'b'.repeat(64) })

    expect(first).toBe(sameDocument)
    expect(first).not.toBe(differentDocument)
  })

  it('identifies a human annotation by its canonical source document rather than a recrawl-specific source span or Google documentation language', () => {
    const initialCapture = humanAnnotationSourceIdentity({ sourceId: 1, sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link?hl=en' })
    const laterCapture = humanAnnotationSourceIdentity({ sourceId: 1, sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link?hl=ja#testing' })
    const otherDocument = humanAnnotationSourceIdentity({ sourceId: 1, sourceUrl: 'https://developers.google.com/search/docs/appearance/snippet?hl=en' })
    const nonGoogleQuery = canonicalHumanAnnotationSourceUrl('https://example.com/reference?hl=ja')

    expect(initialCapture).toBe(laterCapture)
    expect(initialCapture).not.toBe(otherDocument)
    expect(initialCapture).toMatch(/^[a-f0-9]{64}$/)
    expect(canonicalHumanAnnotationSourceUrl('https://developers.google.com/search/docs/appearance/title-link?hl=pt-br')).toBe('https://developers.google.com/search/docs/appearance/title-link')
    expect(nonGoogleQuery).toBe('https://example.com/reference?hl=ja')
  })
})
