import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProductionRuntimeProviders } from '../server/seo-geo-core/productionProviders'
import type { GeoRewriteAdapter } from '../server/geo/contracts'

describe('Production runtime provider resolver', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses canonical GEOFlow/Qwen as base and selected-rule AutoGEO as optimizer when boundary runtimes are injected', () => {
    const qwenRuntime = { generate: vi.fn() }
    const optimizationAdapter = { id: 'custom' as const, version: 'injected-v1', rewrite: vi.fn() } as unknown as GeoRewriteAdapter
    const runtime = resolveProductionRuntimeProviders('autogeo_api', { qwenRuntime, optimizationAdapter })
    expect(runtime.mode).toBe('autogeo_api')
    expect(runtime.configured).toBe(true)
    expect(runtime.baseDraftGenerator.id).toBe('geoflow-qwen-base-draft')
    expect(runtime.baseDraftGenerator.id).not.toContain('autogeo-api')
    expect(runtime.optimizationAdapter.id).toBe('custom')
    expect(runtime.provenance).toMatchObject({ baseDraftRole: 'geoflow-qwen', optimizerRole: 'isolated-autogeo-optimizer', canonicalBaseRuntime: 'geoflow-qwen-runtime-v1' })
  })

  it('falls back to deterministic scaffold and reference rules when provider boundaries are unavailable', () => {
    vi.stubEnv('NUXT_CONTENT_DRAFT_PROVIDER', 'autogeo_api')
    vi.stubEnv('NUXT_GEOFLOW_QWEN_API_KEY', '')
    vi.stubEnv('NUXT_GEOFLOW_QWEN_ENDPOINT', '')
    vi.stubEnv('NUXT_AUTOGEO_GEMINI_API_KEY', '')
    const runtime = resolveProductionRuntimeProviders()
    expect(runtime.mode).toBe('reference_rules')
    expect(runtime.configured).toBe(false)
    expect(runtime.fallbackReason).toBe('provider-credentials-endpoint-or-optimizer-not-configured')
    expect(runtime.baseDraftGenerator.id).toBe('discoverystack-deterministic-scaffold')
    expect(runtime.optimizationAdapter.id).toBe('reference-rules-v1')
  })

  it.each([
    ['https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'qwen-plus', 'bailian'],
    ['https://api.openai.com/v1', 'gpt-test', 'openai'],
  ])('configures the generic mode for %s', (endpoint, model, providerLabel) => {
    vi.stubEnv('NUXT_CONTENT_DRAFT_PROVIDER', 'openai_compatible')
    vi.stubEnv('NUXT_LLM_ENDPOINT', endpoint)
    vi.stubEnv('NUXT_LLM_API_KEY', 'placeholder-secret')
    vi.stubEnv('NUXT_LLM_MODEL', model)
    const runtime = resolveProductionRuntimeProviders()
    expect(runtime).toMatchObject({ mode: 'openai_compatible', configured: true, provenance: { providerLabel, provider: 'autogeo-openai-compatible' } })
    expect(runtime.optimizationAdapter.id).toBe('autogeo-openai-compatible')
  })

  it('keeps autogeo_bailian_qwen as an alias backed by legacy configuration', () => {
    vi.stubEnv('NUXT_CONTENT_DRAFT_PROVIDER', 'autogeo_bailian_qwen')
    vi.stubEnv('NUXT_GEOFLOW_QWEN_ENDPOINT', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
    vi.stubEnv('NUXT_GEOFLOW_QWEN_API_KEY', 'placeholder-secret')
    vi.stubEnv('NUXT_GEOFLOW_QWEN_MODEL', 'qwen-plus')
    const runtime = resolveProductionRuntimeProviders()
    expect(runtime).toMatchObject({ mode: 'autogeo_bailian_qwen', configured: true, provenance: { providerLabel: 'bailian' } })
    expect(runtime.optimizationAdapter.id).toBe('autogeo-openai-compatible')
  })

  it.each([
    ['OpenAI without an explicit model', 'https://api.openai.com/v1', ''],
    ['a disallowed endpoint', 'https://api.openai.com.evil.test/v1', 'gpt-test'],
  ])('falls back for %s', (_label, endpoint, model) => {
    vi.stubEnv('NUXT_CONTENT_DRAFT_PROVIDER', 'openai_compatible')
    vi.stubEnv('NUXT_LLM_ENDPOINT', endpoint)
    vi.stubEnv('NUXT_LLM_API_KEY', 'placeholder-secret')
    vi.stubEnv('NUXT_LLM_MODEL', model)
    const runtime = resolveProductionRuntimeProviders()
    expect(runtime).toMatchObject({ mode: 'reference_rules', configured: false, fallbackReason: 'provider-credentials-endpoint-or-optimizer-not-configured' })
  })
})
