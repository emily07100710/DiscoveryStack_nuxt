import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { referenceRulesAdapter } from '../server/geo/optimise'
import { optimiseGeoDocument } from '../server/geo/optimise'
import { resolveProductionRuntimeProviders } from '../server/seo-geo-core/productionProviders'
import { createAutoGeoOpenAiCompatibleAdapter } from '../server/geo/autogeo-openai-compatible'
import { createOpenAiCompatibleChatClient } from '../server/llm-provider/openai-compatible'
import type { GeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'

const input = { title: '網站可讀性改善', content: '這份說明介紹如何整理服務頁資訊，讓讀者理解服務內容與下一步。', language: 'zh-hant' as const }

function clearProviderEnvironment() {
  for (const name of ['NUXT_LLM_ENDPOINT', 'NUXT_LLM_API_KEY', 'NUXT_LLM_MODEL', 'NUXT_GEOFLOW_QWEN_ENDPOINT', 'NUXT_GEOFLOW_QWEN_API_KEY', 'NUXT_GEOFLOW_QWEN_MODEL', 'NUXT_AUTOGEO_BAILIAN_ENDPOINT', 'NUXT_AUTOGEO_BAILIAN_API_KEY', 'NUXT_AUTOGEO_BAILIAN_MODEL', 'NUXT_AUTOGEO_GEMINI_API_KEY']) vi.stubEnv(name, '')
}

function configureSharedProvider() {
  vi.stubEnv('NUXT_LLM_ENDPOINT', 'https://ws-fixture1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  vi.stubEnv('NUXT_LLM_API_KEY', 'test-only-key')
  vi.stubEnv('NUXT_LLM_MODEL', 'qwen-plus')
}

describe('GEO OpenAI-compatible provider chain', () => {
  beforeEach(() => clearProviderEnvironment())
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('uses the shared OpenAI-compatible client for a successful source-bound rewrite', async () => {
    configureSharedProvider()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: input.content } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await optimiseGeoDocument(input)

    expect(result.candidate.provider).toBe('autogeo-openai-compatible')
    expect(result.candidate.provenance.execution).toBe('autogeo-framework-openai-compatible')
    expect(result.candidate.provenance.providerExecution).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('falls back with the neutral provider-unavailable reason after a shared-client timeout', async () => {
    configureSharedProvider()
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, request: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = optimiseGeoDocument(input)
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await pending

    expect(result.candidate.provider).toBe('reference-rules-v1')
    expect(result.candidate.provenance.fallbackReason).toBe('autogeo-provider-unavailable')
    expect(result.candidate.provenance.providerExecution).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('falls back instead of surfacing a malformed shared-provider response', async () => {
    configureSharedProvider()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: 'envelope' }), { status: 200 })))

    const result = await optimiseGeoDocument(input)

    expect(result.candidate.provider).toBe('reference-rules-v1')
    expect(result.candidate.provenance.fallbackReason).toBe('autogeo-provider-unavailable')
    expect(result.candidate.provenance.providerExecution).toBe(false)
  })

  it('uses the not-configured fallback when no shared, legacy, or Gemini environment is set', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await optimiseGeoDocument(input)

    expect(result.candidate.provider).toBe('reference-rules-v1')
    expect(result.candidate.provenance.fallbackReason).toBe('autogeo-not-configured')
    expect(result.candidate.provenance.providerExecution).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a misconfigured endpoint as a configuration problem rather than as not configured', async () => {
    vi.stubEnv('NUXT_LLM_ENDPOINT', 'https://not-an-allowlisted-provider.example.com/v1')
    vi.stubEnv('NUXT_LLM_API_KEY', 'test-only-key')
    vi.stubEnv('NUXT_LLM_MODEL', 'qwen-plus')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await optimiseGeoDocument(input)

    expect(result.candidate.provider).toBe('reference-rules-v1')
    expect(result.candidate.provenance.fallbackReason).toBe('provider-configuration-invalid')
    expect(result.candidate.provenance.providerExecution).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps reporting a blank shared-provider reply as a malformed response to the AutoGEO adapter', async () => {
    const client = createOpenAiCompatibleChatClient({ endpoint: 'https://api.openai.com/v1', apiKey: 'test-only-key', model: 'qwen-plus', fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 })) as unknown as typeof fetch })

    await expect(createAutoGeoOpenAiCompatibleAdapter({ client }).rewrite(input, [])).rejects.toMatchObject({ issue: 'malformed-response' })
  })

  it('continues to resolve legacy stored and new OpenAI-compatible job provider modes', () => {
    configureSharedProvider()
    const overrides = { qwenRuntime: {} as GeoFlowQwenGenerationRuntime, optimizationAdapter: referenceRulesAdapter }

    expect(resolveProductionRuntimeProviders('autogeo_bailian_qwen', overrides)).toMatchObject({ mode: 'autogeo_bailian_qwen', configured: true })
    expect(resolveProductionRuntimeProviders('openai_compatible', overrides)).toMatchObject({ mode: 'openai_compatible', configured: true })
  })
})
