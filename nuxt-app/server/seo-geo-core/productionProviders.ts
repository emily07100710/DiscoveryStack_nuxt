import { createAutoGeoApiAdapter } from '../geo/autogeo-api'
import { createAutoGeoBailianQwenAdapter, isAllowedBailianEndpoint } from '../geo/autogeo-bailian-qwen'
import type { GeoRewriteAdapter } from '../geo/contracts'
import { referenceRulesAdapter } from '../geo/optimise'
import { createDeterministicScaffoldGenerator, createGeoRewriteContentDraftProvider, createProviderContentDraftGenerator, type ContentDraftGenerator, type ContentDraftProvider } from './contentGenerator'

export type ProductionProviderMode = 'reference_rules' | 'autogeo_bailian_qwen' | 'autogeo_api'

export type ProductionRuntimeProviders = {
  mode: ProductionProviderMode
  configured: boolean
  fallbackReason?: string
  baseDraftGenerator: ContentDraftGenerator
  optimizationAdapter: GeoRewriteAdapter
  provenance: Record<string, unknown>
}

function configuredValue(name: string, runtimeValue?: unknown): string {
  const environmentValue = String(process.env[name] || '').trim()
  if (environmentValue) return environmentValue
  return String(runtimeValue || '').trim()
}

function requestedMode(): string {
  try {
    const config = useRuntimeConfig()
    return configuredValue('NUXT_CONTENT_DRAFT_PROVIDER', config.contentDraftProvider)
  } catch {
    return configuredValue('NUXT_CONTENT_DRAFT_PROVIDER')
  }
}

function configuredProvider(mode: ProductionProviderMode): { adapter: GeoRewriteAdapter, provider: ContentDraftProvider } | undefined {
  let runtimeConfig: Record<string, unknown> = {}
  try { runtimeConfig = useRuntimeConfig() as Record<string, unknown> } catch { /* local tests do not have Nuxt runtime config */ }
  if (mode === 'autogeo_api') {
    const apiKey = configuredValue('NUXT_AUTOGEO_GEMINI_API_KEY', runtimeConfig.autoGeoGeminiApiKey)
    if (!apiKey) return undefined
    const adapter = createAutoGeoApiAdapter({ apiKey })
    return { adapter, provider: createGeoRewriteContentDraftProvider(adapter) }
  }
  const apiKey = configuredValue('NUXT_AUTOGEO_BAILIAN_API_KEY', runtimeConfig.autoGeoBailianApiKey)
  const endpoint = configuredValue('NUXT_AUTOGEO_BAILIAN_ENDPOINT', runtimeConfig.autoGeoBailianEndpoint)
  const model = configuredValue('NUXT_AUTOGEO_BAILIAN_MODEL', runtimeConfig.autoGeoBailianModel) || 'qwen-plus'
  if (!apiKey || !endpoint || !isAllowedBailianEndpoint(endpoint)) return undefined
  const adapter = createAutoGeoBailianQwenAdapter({ apiKey, endpoint, model })
  return { adapter, provider: createGeoRewriteContentDraftProvider(adapter) }
}

export function resolveProductionRuntimeProviders(requested = requestedMode()): ProductionRuntimeProviders {
  const normalized = requested.trim().toLowerCase()
  if (normalized === 'reference_rules' || !normalized) {
    const fallbackReason = normalized ? 'provider-not-configured' : 'content-provider-not-configured'
    return { mode: 'reference_rules', configured: false, fallbackReason, baseDraftGenerator: createDeterministicScaffoldGenerator(), optimizationAdapter: referenceRulesAdapter, provenance: { mode: 'reference_rules', configured: false, fallbackReason, baseDraftRole: 'deterministic-scaffold', optimizerRole: 'reference-rules', ruleSource: 'discoverystack-autogeo-compatible' } }
  }
  if (normalized !== 'autogeo_api' && normalized !== 'autogeo_bailian_qwen') {
    return { mode: 'reference_rules', configured: false, fallbackReason: 'unknown-content-provider-mode', baseDraftGenerator: createDeterministicScaffoldGenerator(), optimizationAdapter: referenceRulesAdapter, provenance: { mode: 'reference_rules', configured: false, fallbackReason: 'unknown-content-provider-mode', requestedMode: normalized, baseDraftRole: 'deterministic-scaffold', optimizerRole: 'reference-rules', ruleSource: 'discoverystack-autogeo-compatible' } }
  }
  const mode = normalized as Exclude<ProductionProviderMode, 'reference_rules'>
  const configured = configuredProvider(mode)
  if (!configured) {
    return { mode: 'reference_rules', configured: false, fallbackReason: 'provider-credentials-or-endpoint-not-configured', baseDraftGenerator: createDeterministicScaffoldGenerator(), optimizationAdapter: referenceRulesAdapter, provenance: { mode: 'reference_rules', configured: false, fallbackReason: 'provider-credentials-or-endpoint-not-configured', requestedMode: mode, baseDraftRole: 'deterministic-scaffold', optimizerRole: 'reference-rules', ruleSource: 'discoverystack-autogeo-compatible' } }
  }
  return { mode, configured: true, baseDraftGenerator: createProviderContentDraftGenerator(configured.provider), optimizationAdapter: configured.adapter, provenance: { mode, configured: true, baseDraftRole: 'content-draft-provider', optimizerRole: 'selected-rule-autogeo-optimizer', provider: configured.adapter.id } }
}
