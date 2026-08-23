import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProductionRuntimeProviders } from '../server/seo-geo-core/productionProviders'

describe('Production runtime provider resolver', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses a configured server-side API provider without dependency injection', () => {
    vi.stubEnv('NUXT_CONTENT_DRAFT_PROVIDER', 'autogeo_api')
    vi.stubEnv('NUXT_AUTOGEO_GEMINI_API_KEY', 'test')
    const runtime = resolveProductionRuntimeProviders()
    expect(runtime.mode).toBe('autogeo_api')
    expect(runtime.configured).toBe(true)
    expect(runtime.baseDraftGenerator.id).toContain('content-provider:autogeo-api')
    expect(runtime.optimizationAdapter.id).toBe('autogeo-api')
    expect(runtime.provenance).toMatchObject({ baseDraftRole: 'content-draft-provider', optimizerRole: 'selected-rule-autogeo-optimizer' })
  })

  it('falls back to scaffold and reference rules when configured provider credentials are unavailable', () => {
    vi.stubEnv('NUXT_CONTENT_DRAFT_PROVIDER', 'autogeo_api')
    vi.stubEnv('NUXT_AUTOGEO_GEMINI_API_KEY', '')
    const runtime = resolveProductionRuntimeProviders()
    expect(runtime.mode).toBe('reference_rules')
    expect(runtime.configured).toBe(false)
    expect(runtime.fallbackReason).toBe('provider-credentials-or-endpoint-not-configured')
    expect(runtime.baseDraftGenerator.id).toBe('discoverystack-deterministic-scaffold')
    expect(runtime.optimizationAdapter.id).toBe('reference-rules-v1')
  })
})
