import { describe, expect, it } from 'vitest'
import { assertPublicHttpsUrl, normalizePublicHttpsOrigin } from '../server/content-operations/normalization'

const rejectedOrigins = [
  'https://0.0.0.0/',
  'https://10.1.2.3/',
  'https://127.0.0.1/',
  'https://169.254.1.1/',
  'https://172.16.0.1/',
  'https://192.168.1.1/',
  'https://100.64.0.1/',
  'https://100.127.255.254/',
  'https://192.0.0.1/',
  'https://192.0.2.1/',
  'https://192.88.99.1/',
  'https://198.18.0.1/',
  'https://198.51.100.1/',
  'https://203.0.113.1/',
  'https://224.0.0.1/',
  'https://240.0.0.1/',
  'https://255.255.255.255/',
  'https://2130706433/',
  'https://0x7f000001/',
  'https://0177.0.0.1/',
  'https://[::]/',
  'https://[::1]/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[ff02::1]/',
  'https://[::ffff:192.168.1.1]/',
  'https://[::192.168.1.1]/',
  'https://[64:ff9b::192.0.2.1]/',
  'https://[2002:c0a8:0101::1]/',
  'https://[2001:db8::1]/',
  'https://[2001:0000::1]/',
  'https://localhost/',
  'https://service.local/',
  'https://service.internal/',
  'https://service.onion/',
  'https://service.test/',
  'https://service.invalid/',
  'https://example.com/',
  'https://sub.example.net/',
  'https://deep.example.org/',
  'https://user:password@public.acme.taipei/',
  'http://public.acme.taipei/',
  'https://public.acme.taipei:8443/',
  'https://*.acme.taipei/',
  'https://public.acme.taipei/?%61pi%5Fkey=secret',
  'https://public.acme.taipei/?next=bearer%20secret',
]

describe('shared public HTTPS SSRF guard', () => {
  it.each(rejectedOrigins)('rejects %s', value => {
    expect(() => assertPublicHttpsUrl(value)).toThrow()
  })

  it('accepts a public HTTPS hostname, strips only the fragment, and normalizes origin separately', () => {
    expect(assertPublicHttpsUrl('https://www.acme.taipei/path?view=public#section')).toBe('https://www.acme.taipei/path?view=public')
    expect(normalizePublicHttpsOrigin('https://www.acme.taipei')).toBe('https://www.acme.taipei')
  })

  it('does not perform DNS resolution in V1 and rejects origin paths for origin callers', () => {
    expect(() => normalizePublicHttpsOrigin('https://www.acme.taipei/path')).toThrow()
  })
})
