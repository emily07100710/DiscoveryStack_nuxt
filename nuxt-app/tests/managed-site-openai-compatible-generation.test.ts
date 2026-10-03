import { describe, expect, it, vi } from 'vitest'
import { createOpenAiCompatibleChatClient } from '../server/llm-provider/openai-compatible'
import { buildManagedSiteGenerationRequest } from '../server/managed-sites/live-connectors/generation-service'
import { createBailianQwenManagedSiteGenerationAdapter, createDeterministicManagedSiteBlueprint } from '../server/managed-sites/live-connectors/adapters'
import { assertCanonicalBailianManagedSiteEndpoint } from '../server/managed-sites/live-connectors/provider-verifiers'
import { buildSiteSpec } from '../server/managed-sites/site-spec'

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

function generationRequest() {
  const siteSpec = buildSiteSpec({
    draftIdentity: 'shared-provider-generation',
    locale: 'en',
    brandName: 'Shared Provider Site',
    audience: 'Evidence-reviewed buyers',
    brief: 'Evidence-bounded managed website content.',
    businessGoals: ['increase_inquiries'],
    siteType: 'brand_blog',
    selectedModules: ['managed_content_admin', 'geo_content_subscription'],
    styleReferences: [],
  }, new Date('2026-09-09T00:00:00.000Z'))
  return buildManagedSiteGenerationRequest(1, 10, 20, 'a'.repeat(64), siteSpec, 'astro', 'shared-provider-generation-request')
}

function validCopyContent(request = generationRequest()): string {
  const skeleton = createDeterministicManagedSiteBlueprint(request)
  return JSON.stringify({ schemaVersion: 'managed-site-preview-copy-v1', navigation: [], pages: [], sections: [], faq: [], summaryAnswer: skeleton.seoGeo.summaryAnswer })
}

function strictEnvelope(content: string, responseId = 'provider-request-001') {
  return {
    id: responseId,
    model: 'qwen-plus',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }
}

function generationContext(overrides: Partial<Parameters<ReturnType<typeof createBailianQwenManagedSiteGenerationAdapter>['generate']>[1]> = {}) {
  return {
    executionMode: 'live' as const,
    credentialReference: 'vault:test-managed-site-provider',
    resolveCredential: async () => ({ ok: true as const, value: 'test-only-key' }),
    timeoutMs: 1_000,
    attemptNumber: 1,
    ...overrides,
  }
}

describe('managed-site generation through the shared OpenAI-compatible provider', () => {
  it('returns the configured provider provenance from a valid strict envelope', async () => {
    const request = generationRequest()
    const providerRequestId = 'provider-request-001'
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer test-only-key')
      expect(headers.get('x-discoverystack-request-id')).toBe(`managed-site-${request.requestFingerprint.slice(0, 48)}`)
      expect(headers.get('accept')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'qwen-plus', stream: false, enable_thinking: false, response_format: { type: 'json_object' } })
      return new Response(JSON.stringify(strictEnvelope(validCopyContent(request), providerRequestId)), { status: 200, headers: { 'x-request-id': providerRequestId } })
    }) as typeof fetch
    const adapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: ENDPOINT, fetchImpl })

    await expect(adapter.generate(request, generationContext())).resolves.toMatchObject({
      providerKey: 'bailian-qwen',
      providerModel: 'qwen-plus',
      providerRequestId,
      requestFingerprint: request.requestFingerprint,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps an aborted shared-provider request to the existing retryable timeout code', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as typeof fetch
    const adapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: ENDPOINT, fetchImpl })

    await expect(adapter.generate(generationRequest(), generationContext({ timeoutMs: 1 }))).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('maps a forged strict envelope to the existing non-retryable output-blocked code', async () => {
    const envelope = strictEnvelope(validCopyContent(), 'forged-provider-id')
    envelope.usage.total_tokens = 99
    const adapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: ENDPOINT, fetchImpl: async () => new Response(JSON.stringify(envelope), { status: 200, headers: { 'x-request-id': 'different-transport-id' } }) })

    await expect(adapter.generate(generationRequest(), generationContext())).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_BLOCKED', retryable: false })
  })

  it('maps a blank provider response to a retryable failure so the build is not permanently blocked', async () => {
    const responseId = 'provider-request-blank-001'
    const adapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: ENDPOINT, fetchImpl: async () => new Response(JSON.stringify(strictEnvelope('   ', responseId)), { status: 200, headers: { 'x-request-id': responseId } }) })

    await expect(adapter.generate(generationRequest(), generationContext())).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_BLOCKED', retryable: true })
  })

  it('fails closed on missing credentials and non-allowlisted endpoints before transport', async () => {
    const request = generationRequest()
    const allowedFetch = vi.fn()
    const allowedAdapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: ENDPOINT, fetchImpl: allowedFetch as typeof fetch })
    await expect(allowedAdapter.generate(request, generationContext({ credentialReference: null }))).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING', retryable: false })
    await expect(allowedAdapter.generate(request, generationContext({ resolveCredential: async () => ({ ok: false as const, reason: 'missing_reference' as const }) }))).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING', retryable: false })

    const resolveCredential = vi.fn(async () => ({ ok: true as const, value: 'test-only-key' }))
    const disallowedAdapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: 'https://provider.example.invalid/v1/chat/completions', fetchImpl: allowedFetch as typeof fetch })
    await expect(disallowedAdapter.generate(request, generationContext({ credentialReference: null, resolveCredential }))).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING', retryable: false })
    await expect(disallowedAdapter.generate(request, generationContext({ resolveCredential }))).rejects.toMatchObject({ code: 'ENDPOINT_NOT_ALLOWED', retryable: false })
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(allowedFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['network failure', async () => { throw new TypeError('mocked network failure') }, 'NETWORK_FAILURE', true],
    ['rate limit', async () => new Response('', { status: 429 }), 'RATE_LIMITED', true],
    ['unauthorized', async () => new Response('', { status: 401 }), 'UPSTREAM_FAILURE', false],
    ['retryable upstream failure', async () => new Response('', { status: 503 }), 'UPSTREAM_FAILURE', true],
    ['non-retryable upstream failure', async () => new Response('', { status: 400 }), 'UPSTREAM_FAILURE', false],
  ] as const)('preserves the existing %s error mapping', async (_label, fetchImpl, code, retryable) => {
    const adapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: ENDPOINT, fetchImpl: fetchImpl as typeof fetch })
    await expect(adapter.generate(generationRequest(), generationContext())).rejects.toMatchObject({ code, retryable })
  })

  it('uses the shared endpoint allowlist for managed-site generation and capability verification', () => {
    expect(assertCanonicalBailianManagedSiteEndpoint('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
    expect(() => assertCanonicalBailianManagedSiteEndpoint('https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions')).toThrowError(expect.objectContaining({ statusCode: 503 }))
    expect(() => assertCanonicalBailianManagedSiteEndpoint('https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')).toThrowError(expect.objectContaining({ statusCode: 503 }))
  })

  it('keeps the shared default envelope path permissive while strict identity rejects the same forgery', async () => {
    const forgedEnvelope = {
      id: 'forged-response-id',
      model: 'echoed-provider-model',
      choices: [
        { message: { content: ' default path content ' }, finish_reason: 'length' },
        { message: { content: 'ignored second choice' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 99 },
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(forgedEnvelope), { status: 200, headers: { 'x-request-id': 'different-transport-id' } })) as typeof fetch
    const client = createOpenAiCompatibleChatClient({ endpoint: ENDPOINT, apiKey: 'test-only-key', model: 'qwen-plus', fetchImpl })
    const messages = [{ role: 'user' as const, content: 'test' }]

    await expect(client.complete({ messages })).resolves.toEqual({
      content: ' default path content ',
      model: 'echoed-provider-model',
      providerLabel: 'bailian',
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 99 },
      finishReason: 'length',
      responseId: 'forged-response-id',
      transportRequestId: 'different-transport-id',
    })
    await expect(client.complete({ messages, strictEnvelopeIdentity: true })).rejects.toMatchObject({ code: 'malformed_response', retryable: false })
  })
})
