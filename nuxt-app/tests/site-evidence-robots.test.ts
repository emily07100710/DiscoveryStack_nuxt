import { describe, expect, it } from 'vitest'
import { evaluateRobots, extractSitemapUrls, parseRobots } from '../server/site-evidence/robots'

const robots = `
User-agent: *
Disallow: /private/*
Allow: /private/public$
Disallow: /tie
Allow: /tie
Sitemap: https://example.com/sitemap.xml

User-agent: DiscoveryStack-SiteEvidence
Disallow: /specific
Allow: /specific/open
`

describe('site evidence robots parser', () => {
  it('uses the most-specific applicable agent group and longest wildcard match', () => {
    expect(evaluateRobots(robots, '/specific/no', 'DiscoveryStack-SiteEvidence/1.0')).toMatchObject({ verdict: 'disallowed', matchedRule: 'Disallow: /specific' })
    expect(evaluateRobots(robots, '/specific/open/page', 'DiscoveryStack-SiteEvidence/1.0').verdict).toBe('allowed')
    expect(evaluateRobots(robots, '/private/no', 'OtherBot').verdict).toBe('disallowed')
    expect(evaluateRobots(robots, '/private/public', 'OtherBot').verdict).toBe('allowed')
    expect(evaluateRobots(robots, '/private/public/more', 'OtherBot').verdict).toBe('disallowed')
  })

  it('lets Allow win equal-length ties and extracts absolute sitemap directives', () => {
    expect(evaluateRobots(robots, '/tie', 'OtherBot').verdict).toBe('allowed')
    expect(extractSitemapUrls(`${robots}\nSitemap: /relative.xml\nSitemap: ftp://example.com/no.xml`)).toEqual(['https://example.com/sitemap.xml'])
  })

  it('tolerates malformed lines while marking the parse honestly', () => {
    const parsed = parseRobots('bad line\nDisallow: /orphan\nUser-agent:\nUser-agent: *\nDisallow:')
    expect(parsed.malformed).toBe(true)
    expect(evaluateRobots('bad line', '/', 'Bot').verdict).toBe('allowed')
  })
})
