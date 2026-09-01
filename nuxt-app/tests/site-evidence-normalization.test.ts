import { describe, expect, it } from 'vitest'
import { apexTwinHost, classifyUrlVariant, isSameSite, normalizeUrl, urlHash } from '../server/site-evidence/normalization'

describe('site evidence URL normalization', () => {
  it('normalizes comparison keys deterministically', () => {
    expect(normalizeUrl('HTTPS://WWW.Example.COM:443//a///b/?utm_source=x&z=2&a=1&fbclid=y#part')).toBe('https://www.example.com/a/b?a=1&z=2')
    expect(normalizeUrl('http://example.com:80/path/')).toBe('http://example.com/path')
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/')
    expect(urlHash('https://example.com/?gclid=x')).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('classifies URL variants without collapsing unrelated pages', () => {
    expect(classifyUrlVariant('http://example.com/a', 'https://example.com/a')).toBe('scheme_variant')
    expect(classifyUrlVariant('https://www.example.com/a', 'https://example.com/a')).toBe('www_variant')
    expect(classifyUrlVariant('https://example.com/a/', 'https://example.com/a')).toBe('slash_variant')
    expect(classifyUrlVariant('https://example.com/a?utm_source=x', 'https://example.com/a')).toBe('param_variant')
    expect(classifyUrlVariant('https://example.com/a', 'https://example.com/a')).toBe('identical')
    expect(classifyUrlVariant('https://example.com/a', 'https://example.com/b')).toBe('unrelated')
  })

  it('limits same-site scope to exact hosts and direct www/apex twins on standard ports', () => {
    expect(apexTwinHost('www.example.com')).toBe('example.com')
    expect(apexTwinHost('example.com')).toBe('www.example.com')
    expect(isSameSite('https://example.com/a', 'http://www.example.com/b')).toBe(true)
    expect(isSameSite('https://docs.example.com', 'https://example.com')).toBe(false)
    expect(isSameSite('https://example.com:8443', 'https://example.com')).toBe(false)
  })
})
