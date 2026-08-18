import { describe, expect, it } from 'vitest'
import { MAX_APPROVED_PUBLIC_REDIRECTS, resolveApprovedPublicRedirect } from '../server/public-intelligence/redirect-policy'

describe('policy-approved public redirect contracts', () => {
  const source = { sourceUrl: 'https://developers.google.com/search/docs', domain: 'developers.google.com' }

  it('permits a relative HTTPS redirect that remains within the approved source host', () => {
    expect(resolveApprovedPublicRedirect({
      source,
      currentUrl: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro',
      location: '/search/docs/crawling-indexing/robots/intro?hl=en',
    })).toBe('https://developers.google.com/search/docs/crawling-indexing/robots/intro?hl=en')
  })

  it('rejects redirects to an external host, downgrade, private host, or absent Location', () => {
    expect(() => resolveApprovedPublicRedirect({ source, currentUrl: source.sourceUrl, location: 'https://example.com/' })).toThrow('unexpected_redirect')
    expect(() => resolveApprovedPublicRedirect({ source, currentUrl: source.sourceUrl, location: 'http://developers.google.com/search/docs' })).toThrow('unexpected_redirect')
    expect(() => resolveApprovedPublicRedirect({ source, currentUrl: source.sourceUrl, location: 'https://127.0.0.1/' })).toThrow('unexpected_redirect')
    expect(() => resolveApprovedPublicRedirect({ source, currentUrl: source.sourceUrl, location: null })).toThrow('unexpected_redirect')
  })

  it('caps redirect processing to a small fixed number of hops', () => {
    expect(MAX_APPROVED_PUBLIC_REDIRECTS).toBe(3)
  })
})
