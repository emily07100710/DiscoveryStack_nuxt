import { describe, expect, it } from 'vitest'
import { compareRawRendered, extractHtmlSignals } from '../server/site-evidence/html'

describe('site evidence HTML signals', () => {
  it('extracts resolved links and structural signals from inert bounded HTML', () => {
    const result = extractHtmlSignals(`<!doctype html><html><head><title> Example &amp; Co </title><link href="/canonical/" rel="alternate canonical"><meta content="noindex,follow" name="robots"><style>.x{}</style></head><body><h1>Hello <em>world</em></h1><a href="/one">One</a><a href="two#x">Two</a><a href="https://www.example.com/twin">Twin</a><a href="https://other.test/x">Other</a><a href="mailto:a@b.c">Mail</a><script>hidden words</script><p>Visible words.</p></body></html>`, 'https://example.com/base/')
    expect(result).toMatchObject({ title: 'Example & Co', canonicalUrl: 'https://example.com/canonical/', metaRobots: 'noindex,follow', h1: 'Hello world', anchorCount: 4, internalAnchorCount: 3, notFoundSignal: false })
    expect(result.internalLinks).toEqual(['https://example.com/one', 'https://example.com/base/two', 'https://www.example.com/twin'])
    expect(result.externalLinks).toEqual(['https://other.test/x'])
    expect(result.textLength).toBeGreaterThan(10)
  })

  it('marks only conservative short 404-like pages', () => {
    expect(extractHtmlSignals('<title>404 - Page not found</title><p>Sorry.</p>', 'https://example.com/missing').notFoundSignal).toBe(true)
    expect(extractHtmlSignals(`<title>How to fix 404 pages</title><p>${'useful '.repeat(400)}</p>`, 'https://example.com/guide').notFoundSignal).toBe(false)
  })

  it('compares raw and rendered evidence and stays unknown without rendered input', () => {
    const raw = extractHtmlSignals('<title>Raw</title><p>tiny</p><a href="/a">A</a>', 'https://example.com/')
    const rendered = extractHtmlSignals(`<title>Rendered</title><link rel="canonical" href="/canonical"><meta name="robots" content="index"><p>${'content '.repeat(100)}</p><a href="/a">A</a><a href="/js">JS</a>`, 'https://example.com/')
    const compared = compareRawRendered(raw, rendered)
    expect(compared.raw_missing_main_content.status).toBe('detected')
    expect(compared.js_only_links).toMatchObject({ status: 'detected', evidence: { count: 1 } })
    expect(compared.raw_rendered_mismatch).toMatchObject({ status: 'detected' })
    expect(Object.values(compareRawRendered(raw, null)).every(value => value.status === 'unknown')).toBe(true)
  })
})
