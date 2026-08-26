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
})
