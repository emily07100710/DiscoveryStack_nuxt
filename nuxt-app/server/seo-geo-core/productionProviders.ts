import { createHash } from 'node:crypto'
import { createAutoGeoApiAdapter } from '../geo/autogeo-api'
import { createAutoGeoOpenAiCompatibleAdapter } from '../geo/autogeo-openai-compatible'
import type { GeoRewriteAdapter } from '../geo/contracts'
import { referenceRulesAdapter } from '../geo/optimise'
import { createDeterministicScaffoldGenerator, type ContentDraftGenerator, type ContentDraftGenerationContext } from './contentGenerator'
import type { ContentDraftGenerationInput, ContentDraftGenerationResult } from './contracts'
import { createGeoFlowQwenGenerationRuntime, type GeoFlowQwenGenerationRuntime } from '../geoflow-runtime/qwen'
import { GEOFLOW_PROTOCOL_VERSION } from '../geoflow-integration'
import { createOpenAiCompatibleChatClient, resolveOpenAiCompatibleProviderConfiguration, type OpenAiCompatibleProviderLabel } from '../llm-provider/openai-compatible'

export type ProductionProviderMode = 'reference_rules' | 'openai_compatible' | 'autogeo_bailian_qwen' | 'autogeo_api'

export type ProductionRuntimeProviders = {
  mode: ProductionProviderMode
  configured: boolean
  fallbackReason?: string
  baseDraftGenerator: ContentDraftGenerator
  optimizationAdapter: GeoRewriteAdapter
  provenance: Record<string, unknown>
}

type RuntimeOverrides = { qwenRuntime?: GeoFlowQwenGenerationRuntime; optimizationAdapter?: GeoRewriteAdapter; fetchImpl?: typeof fetch }

function configuredValue(name: string, runtimeValue?: unknown): string {
  const environmentValue = String(process.env[name] || '').trim()
  if (environmentValue) return environmentValue
  return String(runtimeValue || '').trim()
}

function runtimeConfig(): Record<string, unknown> {
  try { return useRuntimeConfig() as Record<string, unknown> } catch { return {} }
}

function requestedMode(): string {
  const config = runtimeConfig()
  return configuredValue('NUXT_CONTENT_DRAFT_PROVIDER', config.contentDraftProvider)
}

function createCanonicalQwenGenerator(runtime: GeoFlowQwenGenerationRuntime): ContentDraftGenerator {
  return {
    id: 'geoflow-qwen-base-draft',
    version: 'geoflow-qwen-base-draft-v1',
    async generate(input: ContentDraftGenerationInput, context?: ContentDraftGenerationContext): Promise<ContentDraftGenerationResult> {
      if (!context?.calendarEntryId) throw new Error('Canonical GEOFlow/Qwen generation requires a calendar entry identity.')
      const evidenceChunks = input.evidenceMaterials.map((material, index) => {
        const reviewedText = material.reviewedText.normalize('NFKC').trim().replace(/\s+/gu, ' ')
        if (!reviewedText || !material.locator) throw new Error('Canonical GEOFlow/Qwen generation requires reviewed evidence text and a public locator.')
        return { sourceId: `source-${material.sourceId}`, artifactId: `artifact-${material.artifactId}`, chunkId: `chunk-${material.artifactId}-${index + 1}`, chunkHash: createHash('sha256').update(Buffer.from(reviewedText, 'utf8')).digest('hex'), reviewedText, locator: material.locator }
      })
      const request = {
        protocolVersion: GEOFLOW_PROTOCOL_VERSION,
        requestId: `ref-geoflow-qwen-${context.jobId}-${context.calendarEntryId}`,
        idempotencyKey: `ref-geoflow-qwen-job-${context.jobId}-evidence-${context.evidenceSnapshotHash.slice(0, 24)}`,
        ownerUserId: context.ownerUserId,
        clientId: context.clientId,
        calendarEntryId: context.calendarEntryId,
        productionPlanId: context.productionPlanId,
        deliverableId: context.deliverableId,
        briefId: context.briefId,
        jobId: context.jobId,
        evidenceSnapshotHash: context.evidenceSnapshotHash,
        brief: { title: input.title, audience: input.audience, goals: input.goals, constraints: input.constraints },
        contentType: input.contentType,
        language: input.language,
        generationMode: 'draft',
        revisionContext: null,
        requestedCapabilities: ['knowledge_rag', 'qwen_generation', 'human_review'],
        selectedRuleIds: input.strategyRules.map(rule => rule.id),
        authoritySourceIds: evidenceChunks.map(chunk => chunk.sourceId),
        evidenceChunks,
        createdAt: (context.now || new Date()).toISOString(),
      }
      const result = await runtime.generate(request)
      if (!result.ok || (result.value.status !== 'draft_ready' && result.value.status !== 'review_required') || !result.value.contentArtifact) throw new Error('Canonical GEOFlow/Qwen base draft generation was blocked or malformed.')
      const provider = result.value.providerProvenance.provider
      const model = result.value.providerProvenance.model
      return { title: result.value.contentArtifact.title || input.title, body: result.value.contentArtifact.bodyMarkdown, mode: 'provider_draft', provider, providerVersion: model, provenance: { stage: 'base_draft', generator: 'geoflow-qwen-base-draft', providerExecution: result.value.providerProvenance.mode === 'provider', providerModel: `${provider}:${model}`, providerProvenance: result.value.providerProvenance, providerRequestId: result.value.requestId, requestFingerprint: result.value.requestFingerprint, briefFingerprint: result.value.draftIdentity.briefFingerprint, evidenceSnapshotHash: result.value.evidenceSnapshotHash, baseDraftHash: result.value.contentArtifact.bodyHash }, limitations: result.value.limitations }
    },
  }
}

function configuredProvider(mode: Exclude<ProductionProviderMode, 'reference_rules'>, overrides: RuntimeOverrides): { adapter: GeoRewriteAdapter; qwenRuntime: GeoFlowQwenGenerationRuntime; providerLabel?: OpenAiCompatibleProviderLabel } | undefined {
  const config = runtimeConfig()
  const provider = resolveOpenAiCompatibleProviderConfiguration({ runtimeConfig: config })
  const credentialRef = configuredValue('NUXT_GEOFLOW_QWEN_CREDENTIAL_REFERENCE', config.geoflowQwenCredentialReference) || 'ref-env-geoflow-qwen'
  const qwenRuntime = overrides.qwenRuntime || (provider.configured ? createGeoFlowQwenGenerationRuntime({ endpoint: provider.endpoint, model: provider.model, credentialRef, resolveCredential: reference => reference === credentialRef ? provider.apiKey : undefined, fetchImpl: overrides.fetchImpl }) : undefined)
  if (!qwenRuntime) return undefined
  if (overrides.optimizationAdapter) return { adapter: overrides.optimizationAdapter, qwenRuntime, ...(provider.configured ? { providerLabel: provider.providerLabel } : {}) }
  if (mode === 'autogeo_api') {
    const apiKey = configuredValue('NUXT_AUTOGEO_GEMINI_API_KEY', config.autoGeoGeminiApiKey)
    if (!apiKey) return undefined
    return { adapter: createAutoGeoApiAdapter({ apiKey }), qwenRuntime, ...(provider.configured ? { providerLabel: provider.providerLabel } : {}) }
  }
  if (!provider.configured) return undefined
  const client = createOpenAiCompatibleChatClient({ endpoint: provider.endpoint, apiKey: provider.apiKey, model: provider.model, fetchImpl: overrides.fetchImpl })
  return { adapter: createAutoGeoOpenAiCompatibleAdapter({ client }), qwenRuntime, providerLabel: provider.providerLabel }
}

function fallback(fallbackReason: string, requested?: string): ProductionRuntimeProviders {
  return { mode: 'reference_rules', configured: false, fallbackReason, baseDraftGenerator: createDeterministicScaffoldGenerator(), optimizationAdapter: referenceRulesAdapter, provenance: { mode: 'reference_rules', configured: false, fallbackReason, requestedMode: requested || null, baseDraftRole: 'deterministic-scaffold', optimizerRole: 'reference-rules', providerExecution: false, ruleSource: 'discoverystack-autogeo-compatible' } }
}

export function resolveProductionRuntimeProviders(requested = requestedMode(), overrides: RuntimeOverrides = {}): ProductionRuntimeProviders {
  const normalized = requested.trim().toLowerCase()
  if (normalized === 'reference_rules' || !normalized) return fallback(normalized ? 'provider-not-configured' : 'content-provider-not-configured', normalized)
  if (normalized !== 'autogeo_api' && normalized !== 'autogeo_bailian_qwen' && normalized !== 'openai_compatible') return fallback('unknown-content-provider-mode', normalized)
  const mode = normalized as Exclude<ProductionProviderMode, 'reference_rules'>
  const configured = configuredProvider(mode, overrides)
  if (!configured) return fallback('provider-credentials-endpoint-or-optimizer-not-configured', mode)
  return { mode, configured: true, baseDraftGenerator: createCanonicalQwenGenerator(configured.qwenRuntime), optimizationAdapter: configured.adapter, provenance: { mode, configured: true, providerExecution: true, baseDraftRole: 'geoflow-qwen', optimizerRole: configured.adapter.id === 'reference-rules-v1' ? 'reference-rules' : 'isolated-autogeo-optimizer', provider: configured.adapter.id, ...(configured.providerLabel ? { providerLabel: configured.providerLabel } : {}), canonicalBaseRuntime: 'geoflow-qwen-runtime-v1' } }
}

export function createProviderRuntimeForTests(input: { qwenRuntime: GeoFlowQwenGenerationRuntime; optimizationAdapter: GeoRewriteAdapter }): ProductionRuntimeProviders {
  return resolveProductionRuntimeProviders('autogeo_bailian_qwen', { qwenRuntime: input.qwenRuntime, optimizationAdapter: input.optimizationAdapter })
}
