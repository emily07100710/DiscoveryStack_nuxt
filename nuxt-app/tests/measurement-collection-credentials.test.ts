import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGoogleServiceAccountCredentialResolver, isGoogleServiceAccountConfigured, parseGoogleServiceAccountForTests } from '../server/measurement-collection/credentials'
import { GOOGLE_ANALYTICS_READONLY_SCOPE, GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE } from '../server/measurement-collection/normalization'

type RuntimeConfigGlobal = { useRuntimeConfig?: () => Record<string, unknown> }

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const FIXED_NOW = new Date('2030-01-01T00:00:00.000Z')

async function serviceAccountJson(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const json = JSON.stringify({
    type: 'service_account',
    client_email: 'measurement-reader@example.test',
    private_key: await exportPKCS8(privateKey),
    private_key_id: 'testkey123',
    token_uri: TOKEN_ENDPOINT,
    ...overrides,
  })
  return { json, publicKey, clientEmail: 'measurement-reader@example.test' }
}

function tokenResponse(scope: string, overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 1200, scope, ...overrides }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('Google service-account measurement credentials', () => {
  beforeEach(() => {
    delete process.env.NUXT_GOOGLE_SERVICE_ACCOUNT_JSON
    delete (globalThis as RuntimeConfigGlobal).useRuntimeConfig
  })

  it('returns null and reports unavailable when the ambient source is unset', async () => {
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    const resolver = createGoogleServiceAccountCredentialResolver({ fetcher })
    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.toBeNull()
    expect(isGoogleServiceAccountConfigured()).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON without calling the injected fetcher', async () => {
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: '{not json', fetcher })
    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a non-service-account type and a non-Google token endpoint', async () => {
    const invalidType = await serviceAccountJson({ type: 'authorized_user' })
    const invalidEndpoint = await serviceAccountJson({ token_uri: 'https://attacker.example.test/token' })
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    await expect(createGoogleServiceAccountCredentialResolver({ serviceAccountJson: invalidType.json, fetcher })(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.toBeNull()
    await expect(createGoogleServiceAccountCredentialResolver({ serviceAccountJson: invalidEndpoint.json, fetcher })(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('signs and exchanges a Google JWT assertion with the requested readonly scope', async () => {
    const account = await serviceAccountJson()
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(TOKEN_ENDPOINT)
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded' })
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
      const assertion = body.get('assertion')
      expect(assertion).toBeTruthy()
      const verified = await jwtVerify(assertion!, account.publicKey, { currentDate: FIXED_NOW })
      expect(verified.payload.iss).toBe(account.clientEmail)
      expect(verified.payload.aud).toBe(TOKEN_ENDPOINT)
      expect(verified.payload.scope).toBe(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE)
      return tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE)
    })
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) })
    const credential = await resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])
    expect(credential?.accessToken).toBeTruthy()
    expect(Date.parse(credential?.expiresAt || '')).toBeGreaterThan(FIXED_NOW.getTime())
    expect(credential?.grantedScopes).toContain(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE)
  })

  it('keeps the abort deadline armed until the response body finishes reading', async () => {
    const account = await serviceAccountJson()
    let markFetchStarted: () => void = () => {}
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve })
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
      const signal = init?.signal
      markFetchStarted()
      return {
        ok: true,
        arrayBuffer: () => new Promise<ArrayBuffer>((_resolve, reject) => {
          const rejectOnAbort = () => reject(new DOMException('aborted', 'AbortError'))
          if (signal?.aborted) rejectOnAbort()
          else signal?.addEventListener('abort', rejectOnAbort, { once: true })
        }),
      } as Response
    })
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) })

    vi.useFakeTimers()
    try {
      const pending = resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])
      await fetchStarted
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects zero, negative, and non-number token lifetimes', async () => {
    const account = await serviceAccountJson()
    for (const expiresIn of [0, -1, '1200']) {
      const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, { expires_in: expiresIn }))
      const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) })
      await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('measures token expiry from the clock read after the response is parsed', async () => {
    const account = await serviceAccountJson()
    const completedAt = new Date(FIXED_NOW.getTime() + 5 * 60_000)
    const now = vi.fn()
      .mockReturnValueOnce(new Date(FIXED_NOW))
      .mockReturnValueOnce(new Date(completedAt))
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now })

    const credential = await resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])

    expect(credential?.expiresAt).toBe(new Date(completedAt.getTime() + 1200 * 1000).toISOString())
    expect(now).toHaveBeenCalledTimes(2)
  })

  it('returns a short-lived token without caching it', async () => {
    const account = await serviceAccountJson()
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, { expires_in: 30 }))
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) })

    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.not.toBeNull()
    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.not.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects a token response missing one of the requested scopes', async () => {
    const account = await serviceAccountJson()
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) })

    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, GOOGLE_ANALYTICS_READONLY_SCOPE])).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('caches a token per normalized scope set', async () => {
    const account = await serviceAccountJson()
    const fetcher = vi.fn(async () => tokenResponse(`${GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE} ${GOOGLE_ANALYTICS_READONLY_SCOPE}`))
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) })
    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.not.toBeNull()
    await expect(resolver(1, 'connection:2', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.not.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(resolver(1, 'connection:1', [GOOGLE_ANALYTICS_READONLY_SCOPE])).resolves.not.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('binds a warm cache entry to the actual private key', async () => {
    const account = await serviceAccountJson()
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    const options = { serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) }
    const resolver = createGoogleServiceAccountCredentialResolver(options)

    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.not.toBeNull()
    options.serviceAccountJson = JSON.stringify({
      ...JSON.parse(account.json),
      private_key: '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----',
    })

    await expect(resolver(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent token exchanges and returns defensive scope copies', async () => {
    const account = await serviceAccountJson()
    const responseScopes = `${GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE} ${GOOGLE_ANALYTICS_READONLY_SCOPE}`
    const fetcher = vi.fn(async () => tokenResponse(responseScopes))
    const resolver = createGoogleServiceAccountCredentialResolver({ serviceAccountJson: account.json, fetcher, now: () => new Date(FIXED_NOW) })

    const credentials = await Promise.all(Array.from({ length: 8 }, (_, index) => resolver(1, `connection:${index}`, index % 2 === 0
      ? [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, GOOGLE_ANALYTICS_READONLY_SCOPE]
      : [GOOGLE_ANALYTICS_READONLY_SCOPE, GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])))

    expect(fetcher).toHaveBeenCalledTimes(1)
    for (const credential of credentials) {
      expect(credential).toEqual(credentials[0])
    }
    expect(new Set(credentials.map(credential => credential?.grantedScopes)).size).toBe(credentials.length)
  })

  it('accepts a service account that Nitro runtime config already parsed into an object', async () => {
    // Nitro's applyEnv runs destr() over NUXT_-prefixed overrides, so the declared
    // string key arrives as a parsed object. Stringifying it naively yields
    // "[object Object]" and silently disables every Google measurement run.
    const account = await serviceAccountJson()
    ;(globalThis as RuntimeConfigGlobal).useRuntimeConfig = () => ({ googleServiceAccountJson: JSON.parse(account.json) })
    expect(isGoogleServiceAccountConfigured()).toBe(true)
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    const credential = await createGoogleServiceAccountCredentialResolver({ fetcher, now: () => FIXED_NOW })(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])
    expect(credential?.grantedScopes).toContain(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable for a runtime config value that is neither a string nor a service-account object', async () => {
    const fetcher = vi.fn(async () => tokenResponse(GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE))
    for (const value of [['not', 'an', 'object'], 42, null]) {
      ;(globalThis as RuntimeConfigGlobal).useRuntimeConfig = () => ({ googleServiceAccountJson: value })
      expect(isGoogleServiceAccountConfigured()).toBe(false)
      await expect(createGoogleServiceAccountCredentialResolver({ fetcher })(1, 'connection:1', [GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE])).resolves.toBeNull()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('exposes only safe parsed service-account metadata for tests', async () => {
    const account = await serviceAccountJson()
    const parsed = parseGoogleServiceAccountForTests(account.json)
    expect(parsed).toMatchObject({ ok: true, clientEmail: account.clientEmail })
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE KEY')
  })
})
