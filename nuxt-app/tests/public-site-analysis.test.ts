import { describe, expect, it } from 'vitest'
import { analysePublicHomepageHtml, isPublicIpAddress } from '../server/utils/publicSiteAnalysis'

describe('public homepage analysis', () => {
  it('scores only bounded structural evidence from the supplied homepage', () => {
    const result = analysePublicHomepageHtml({
      requestedUrl: 'https://brand.example/',
      analysedAt: new Date('2026-08-22T00:00:00.000Z'),
      html: `<!doctype html><html><head><title>Signal Studio</title><link rel="canonical" href="https://brand.example/"><meta name="robots" content="index,follow"><script type="application/ld+json">{"@type":"ProfessionalService"}</script></head><body><h1>Growth systems</h1><a href="/services">Services</a><a href="/contact">Contact our expert</a><section>Client case studies</section><section>Frequently asked questions</section></body></html>`,
    })
    expect(result.scope).toBe('public_homepage_only')
    expect(result.scores.overall).toBeGreaterThan(70)
    expect(result.checks).toMatchObject({ titlePresent: true, h1Present: true, canonicalPresent: true, schemaPresent: true, primaryCta: true })
    expect(JSON.stringify(result)).not.toContain('Growth systems')
  })

  it('produces useful priorities rather than invented performance claims', () => {
    const result = analysePublicHomepageHtml({ requestedUrl: 'https://brand.example/', html: '<html><body><p>Hello</p></body></html>' })
    expect(result.scores.overall).toBeLessThan(30)
    expect(result.recommendationKeys).toEqual(expect.arrayContaining(['clarify_page_topic', 'add_primary_action']))
    expect(result).not.toHaveProperty('conversionRate')
    expect(result).not.toHaveProperty('traffic')
  })

  it('rejects private and non-routable addresses at the network boundary', () => {
    for (const address of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1']) {
      expect(isPublicIpAddress(address)).toBe(false)
    }
    expect(isPublicIpAddress('8.8.8.8')).toBe(true)
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true)
  })
})
