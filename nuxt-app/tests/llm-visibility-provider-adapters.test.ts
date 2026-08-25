import { describe, expect, it, vi } from 'vitest'
import { createConfiguredVisibilityProviderAdapters, createVisibilityProviderAdapter } from '../server/llm-visibility-probes'

const input = {
  probeIdentity: { probeId: 'probe-1', requestFingerprint: 'a'.repeat(64), ownerScopeKey: 'owner-7-visibility', projectId: '10', queryId: '20', provider: 'chatgpt' as const, modelLabel: 'gpt-test' },
  normalizedPrompt: 'Which product fits?',
  locale: 'en' as const,
  timeoutMs: 1000,
}

describe('server visibility provider adapters', () => {
  it('fails closed without a server credential and never calls fetch', async () => {
    const fetchImpl = vi.fn()
    const adapter = createVisibilityProviderAdapter({ adapterKey: 'chatgpt-test', provider: 'chatgpt', modelLabel: 'gpt-test', credentialResolver: () => null, fetchImpl })
    await expect(adapter.execute(input)).resolves.toMatchObject({ ok: false, code: 'CREDENTIAL_NOT_CONFIGURED', retryable: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('calls the fixed official endpoint with server-only authorization and returns bounded normalized text', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(_url).toBe('https://api.openai.com/v1/responses')
      expect(init?.redirect).toBe('error')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer server-secret-value')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-test', input: 'Which product fits?', stream: false })
      return new Response(JSON.stringify({ id: 'response-1', output: [{ content: [{ text: 'Acme is one option.' }] }], citations: ['https://example.com/source'] }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' } })
    })
    const adapter = createVisibilityProviderAdapter({ adapterKey: 'chatgpt-test', provider: 'chatgpt', modelLabel: 'gpt-test', credentialResolver: () => 'server-secret-value', fetchImpl })
    const result = await adapter.execute(input)
    expect(result).toMatchObject({ ok: true, provider: 'chatgpt', modelLabel: 'gpt-test', responseText: 'Acme is one option.', citationUrls: ['https://example.com/source'], providerRequestId: 'request-1' })
    expect(JSON.stringify(result)).not.toContain('server-secret-value')
  })

  it('normalizes provider failures without leaking response bodies and treats 429 as retryable', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'secret provider body' } }), { status: 429 }))
    const adapter = createVisibilityProviderAdapter({ adapterKey: 'perplexity-test', provider: 'perplexity', modelLabel: 'sonar-test', credentialResolver: () => 'server-secret-value', fetchImpl })
    const result = await adapter.execute({ ...input, probeIdentity: { ...input.probeIdentity, provider: 'perplexity', modelLabel: 'sonar-test' } })
    expect(result).toMatchObject({ ok: false, failureKind: 'http_error', retryable: true, code: 'HTTP_429', httpStatus: 429 })
    expect(JSON.stringify(result)).not.toContain('secret provider body')
  })

  it('rejects declared oversized responses and configured adapters remain blocked when env credentials are absent', async () => {
    const oversizedFetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-length': '120001' } }))
    const adapter = createVisibilityProviderAdapter({ adapterKey: 'gemini-test', provider: 'gemini', modelLabel: 'gemini-test', credentialResolver: () => 'server-secret-value', fetchImpl: oversizedFetch })
    const result = await adapter.execute({ ...input, probeIdentity: { ...input.probeIdentity, provider: 'gemini', modelLabel: 'gemini-test' } })
    expect(result).toMatchObject({ ok: false, failureKind: 'response_too_large', retryable: false, code: 'RESPONSE_TOO_LARGE' })
    const configured = createConfiguredVisibilityProviderAdapters([{ adapterKey: 'chatgpt-test', provider: 'chatgpt', modelLabel: 'gpt-test' }], {})
    await expect(configured['chatgpt-test']!.execute(input)).resolves.toMatchObject({ ok: false, code: 'CREDENTIAL_NOT_CONFIGURED' })
  })
})
