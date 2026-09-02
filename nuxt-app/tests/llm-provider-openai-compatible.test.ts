import { describe, expect, it, vi } from 'vitest'
import { createOpenAiCompatibleChatClient, isAllowedOpenAiCompatibleEndpoint, normalizeOpenAiCompatibleEndpoint, OpenAiCompatibleProviderError, resolveOpenAiCompatibleProviderConfiguration } from '../server/llm-provider/openai-compatible'

const bailianFull = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'
const workspaceFull = 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions'
const openaiFull = 'https://api.openai.com/v1/chat/completions'

describe('OpenAI-compatible provider boundary', () => {
  it.each([
    [bailianFull, bailianFull],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
    [workspaceFull, workspaceFull],
    ['https://api.openai.com/v1/', openaiFull],
    ['https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/', workspaceFull],
  ])('normalizes allowed endpoint %s', (input, expected) => {
    expect(normalizeOpenAiCompatibleEndpoint(input)).toBe(expected)
    expect(isAllowedOpenAiCompatibleEndpoint(input)).toBe(true)
  })

  it.each([
    'http://api.openai.com/v1/chat/completions',
    'https://api.openai.com/compatible-mode/v1/chat/completions',
    'https://dashscope.aliyuncs.com/v1/chat/completions',
    'https://api.openai.com/v1/models',
    'https://api.openai.com/v1?key=value',
    'https://api.openai.com/v1#fragment',
    'https://user:pass@api.openai.com/v1',
    'https://api.openai.com:443/v1',
    'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    'https://api.openai.com.evil.test/v1',
    'https://evil-dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'https://xdashscope.aliyuncs.com/compatible-mode/v1',
    'https://workspace.us-west-1.maas.aliyuncs.com/compatible-mode/v1',
  ])('rejects disallowed endpoint %s', input => expect(normalizeOpenAiCompatibleEndpoint(input)).toBeNull())

  it('resolves field precedence, runtime values, and both legacy sources without leaking OpenAI model defaults', () => {
    expect(resolveOpenAiCompatibleProviderConfiguration({ env: { NUXT_LLM_ENDPOINT: 'https://api.openai.com/v1', NUXT_LLM_API_KEY: 'primary-key', NUXT_LLM_MODEL: 'gpt-test', NUXT_GEOFLOW_QWEN_ENDPOINT: 'https://dashscope.aliyuncs.com/compatible-mode/v1', NUXT_GEOFLOW_QWEN_API_KEY: 'legacy-key' }, runtimeConfig: {} })).toEqual({ configured: true, endpoint: openaiFull, apiKey: 'primary-key', model: 'gpt-test', providerLabel: 'openai', source: 'llm' })
    expect(resolveOpenAiCompatibleProviderConfiguration({ env: {}, runtimeConfig: { llmEndpoint: 'https://api.openai.com/v1', llmApiKey: 'runtime-key', llmModel: 'gpt-runtime' } })).toMatchObject({ configured: true, source: 'llm', model: 'gpt-runtime' })
    expect(resolveOpenAiCompatibleProviderConfiguration({ env: { NUXT_GEOFLOW_QWEN_ENDPOINT: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', NUXT_GEOFLOW_QWEN_API_KEY: 'legacy-key', NUXT_GEOFLOW_QWEN_MODEL: 'qwen-max' }, runtimeConfig: {} })).toMatchObject({ configured: true, source: 'legacy-geoflow-qwen', model: 'qwen-max' })
    expect(resolveOpenAiCompatibleProviderConfiguration({ env: { NUXT_AUTOGEO_BAILIAN_ENDPOINT: 'https://dashscope.aliyuncs.com/compatible-mode/v1', NUXT_AUTOGEO_BAILIAN_API_KEY: 'old-key' }, runtimeConfig: {} })).toMatchObject({ configured: true, source: 'legacy-autogeo-bailian', model: 'qwen-plus' })
    expect(resolveOpenAiCompatibleProviderConfiguration({ env: { NUXT_LLM_ENDPOINT: 'https://api.openai.com/v1', NUXT_LLM_API_KEY: 'key' }, runtimeConfig: { autoGeoBailianModel: 'qwen-plus' } })).toEqual({ configured: false, reason: 'model-missing' })
    expect(resolveOpenAiCompatibleProviderConfiguration({ env: { NUXT_LLM_ENDPOINT: 'https://api.openai.com/v1', NUXT_LLM_API_KEY: 'key', NUXT_LLM_MODEL: 'bad model' }, runtimeConfig: {} })).toEqual({ configured: false, reason: 'model-invalid' })
    expect(resolveOpenAiCompatibleProviderConfiguration({ env: { NUXT_LLM_ENDPOINT: 'https://api.openai.com/v1', NUXT_LLM_API_KEY: 'key', NUXT_LLM_MODEL: 'gpt-base' }, runtimeConfig: {}, modelOverride: 'gpt-editor' })).toMatchObject({ configured: true, model: 'gpt-editor' })
  })

  it('sends the neutral request shape and only adds response_format for JSON mode', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ model: 'gpt-test', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200 }))
    const client = createOpenAiCompatibleChatClient({ endpoint: 'https://api.openai.com/v1', apiKey: 'placeholder-secret', model: 'gpt-test', fetchImpl })
    const messages = [{ role: 'user' as const, content: 'Return JSON' }]
    const result = await client.complete({ messages, responseFormat: 'json_object', requestId: 'request-123' })
    expect(result).toMatchObject({ model: 'gpt-test', providerLabel: 'openai', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, finishReason: 'stop' })
    expect(fetchImpl).toHaveBeenCalledWith(openaiFull, expect.objectContaining({ method: 'POST', redirect: 'error', headers: expect.objectContaining({ 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer placeholder-secret', 'x-discoverystack-request-id': 'request-123' }) }))
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ model: 'gpt-test', stream: false, messages, response_format: { type: 'json_object' } })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('temperature')

    await client.complete({ messages, responseFormat: 'text' })
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ model: 'gpt-test', stream: false, messages })
  })

  it.each([
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
    [429, 'rate_limited', true],
    [500, 'upstream', true],
    [400, 'upstream', false],
  ])('maps HTTP %i to %s', async (status, code, retryable) => {
    const client = createOpenAiCompatibleChatClient({ endpoint: bailianFull, apiKey: 'placeholder-secret', model: 'qwen-plus', fetchImpl: vi.fn().mockResolvedValue(new Response('sensitive response body', { status })) })
    const error = await client.complete({ messages: [{ role: 'user', content: 'test' }] }).catch(value => value)
    expect(error).toMatchObject({ code, retryable, httpStatus: status })
    expect(error.message).not.toContain('sensitive response body')
    expect(error.message).not.toContain('placeholder-secret')
  })

  it('maps aborts, invalid JSON, and oversized bodies without secret-bearing messages', async () => {
    const abortingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const timeoutClient = createOpenAiCompatibleChatClient({ endpoint: bailianFull, apiKey: 'placeholder-secret', model: 'qwen-plus', fetchImpl: abortingFetch as typeof fetch })
    await expect(timeoutClient.complete({ messages: [{ role: 'user', content: 'test' }], timeoutMs: 1 })).rejects.toMatchObject({ code: 'timeout', retryable: true })
    const malformedClient = createOpenAiCompatibleChatClient({ endpoint: bailianFull, apiKey: 'placeholder-secret', model: 'qwen-plus', fetchImpl: vi.fn().mockResolvedValue(new Response('not json', { status: 200 })) })
    const malformed = await malformedClient.complete({ messages: [{ role: 'user', content: 'test' }] }).catch(value => value) as OpenAiCompatibleProviderError
    expect(malformed.code).toBe('malformed_response')
    expect(malformed.message).not.toContain('placeholder-secret')
    const oversizedClient = createOpenAiCompatibleChatClient({ endpoint: bailianFull, apiKey: 'placeholder-secret', model: 'qwen-plus', fetchImpl: vi.fn().mockResolvedValue(new Response('x'.repeat(201), { status: 200 })), maxResponseBytes: 200 })
    await expect(oversizedClient.complete({ messages: [{ role: 'user', content: 'test' }] })).rejects.toMatchObject({ code: 'malformed_response' })
  })
})
