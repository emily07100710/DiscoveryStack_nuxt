import { describe, expect, it } from 'vitest'
import { decidePublicCors, normalizePublicSiteOrigin } from '../server/utils/publicCors'

describe('public API CORS policy', () => {
  it('requires a valid HTTPS site origin in production', () => {
    expect(normalizePublicSiteOrigin('https://public.example.com/', 'production')).toBe('https://public.example.com')
    expect(normalizePublicSiteOrigin('', 'production')).toBe('')
    expect(normalizePublicSiteOrigin('http://localhost:4321', 'production')).toBe('')
    expect(normalizePublicSiteOrigin('http://localhost:4321', 'development')).toBe('http://localhost:4321')
    expect(normalizePublicSiteOrigin('https://public.example.com/path', 'production')).toBe('')
  })

  it('allows only the configured public origin to receive POST CORS headers', () => {
    const decision = decidePublicCors({ path: '/api/site-analysis', method: 'POST', origin: 'https://public.example.com', configuredOrigin: 'https://public.example.com', nodeEnv: 'production' })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('allowed')
    expect(decision.headers['access-control-allow-origin']).toBe('https://public.example.com')
    expect(decision.headers['access-control-allow-methods']).toBe('POST, OPTIONS')

    const mismatch = decidePublicCors({ path: '/api/site-analysis', method: 'POST', origin: 'https://attacker.example.com', configuredOrigin: 'https://public.example.com', nodeEnv: 'production' })
    expect(mismatch.allowed).toBe(false)
    expect(mismatch.reason).toBe('origin-mismatch')
    expect(mismatch.headers).toEqual({})
  })

  it('handles preflight and preserves same-origin private GET semantics', () => {
    const preflight = decidePublicCors({ path: '/api/leads', method: 'OPTIONS', origin: 'https://public.example.com', configuredOrigin: 'https://public.example.com', nodeEnv: 'production' })
    expect(preflight.allowed).toBe(true)
    expect(preflight.isPreflight).toBe(true)
    expect(preflight.headers['access-control-allow-origin']).toBe('https://public.example.com')

    const wrongMethod = decidePublicCors({ path: '/api/leads', method: 'OPTIONS', origin: 'https://public.example.com', accessRequestMethod: 'GET', configuredOrigin: 'https://public.example.com', nodeEnv: 'production' })
    expect(wrongMethod.allowed).toBe(false)
    expect(wrongMethod.reason).toBe('method-not-allowed')

    const sameOrigin = decidePublicCors({ path: '/api/leads', method: 'POST', configuredOrigin: 'https://public.example.com', nodeEnv: 'production' })
    expect(sameOrigin.allowed).toBe(true)
    expect(sameOrigin.headers).toEqual({})

    const ownerGet = decidePublicCors({ path: '/api/leads', method: 'GET', origin: 'https://attacker.example.com', configuredOrigin: 'https://public.example.com', nodeEnv: 'production' })
    expect(ownerGet.allowed).toBe(true)
    expect(ownerGet.reason).toBe('non-public-method')
    expect(ownerGet.headers).toEqual({})
  })

  it('does not apply public CORS to private or unrelated paths', () => {
    const privateApi = decidePublicCors({ path: '/api/seo-geo/jobs', method: 'POST', origin: 'https://attacker.example.com', configuredOrigin: 'https://public.example.com', nodeEnv: 'production' })
    expect(privateApi).toEqual({ allowed: true, isPreflight: false, headers: {}, reason: 'not-target' })
  })
})
