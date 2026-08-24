import { normalizedPromptHash } from '../../../server/llm-visibility/guards'
import type {
  AdapterResult,
  AdapterSuccess,
  IdempotencyRecord,
  ProbePlanInput,
  ProbeProvider,
  ProjectIdentity,
  ProviderTarget,
  QuerySnapshot,
  VisibilityProbeAdapter,
  VisibilityProbeIdempotencyRegistry,
} from '../../../server/llm-visibility-probes'

export const SYNTHETIC_SHA = 'a'.repeat(64)
export const SYNTHETIC_SHA_B = 'b'.repeat(64)
export const SYNTHETIC_SHA_C = 'c'.repeat(64)

export const syntheticProject = (): ProjectIdentity => ({
  projectId: 'project-synthetic-001',
  canonicalWebsiteDomain: 'example.com',
  brandName: 'Acme',
  brandAliases: ['Acme Inc'],
  competitorBrands: ['RivalCo', 'OtherBrand'],
  locale: 'en',
})

export function syntheticQuery(overrides: Partial<QuerySnapshot> = {}): QuerySnapshot {
  const promptText = overrides.promptText ?? 'Which product fits this need?'
  const normalizedPrompt = promptText.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  return {
    queryId: overrides.queryId ?? 'query-synthetic-001',
    projectId: overrides.projectId ?? 'project-synthetic-001',
    promptText,
    promptHash: overrides.promptHash ?? normalizedPromptHash(normalizedPrompt),
    intent: overrides.intent ?? 'product_discovery',
    locale: overrides.locale ?? 'en',
    active: overrides.active ?? true,
  }
}

export function syntheticTarget(overrides: Partial<ProviderTarget> = {}): ProviderTarget {
  return {
    provider: overrides.provider ?? 'chatgpt',
    modelLabel: overrides.modelLabel ?? 'synthetic-model-1',
    adapterKey: overrides.adapterKey ?? 'synthetic-adapter-1',
    status: overrides.status ?? 'active',
    allowedLocales: overrides.allowedLocales ?? ['en'],
    maximumResponseBytes: overrides.maximumResponseBytes ?? 120_000,
    timeoutMs: overrides.timeoutMs ?? 10_000,
  }
}

export function syntheticPlanInput(overrides: Partial<ProbePlanInput> = {}): ProbePlanInput {
  return {
    ownerScopeKey: overrides.ownerScopeKey ?? 'owner-synthetic-scope',
    project: overrides.project ?? syntheticProject(),
    activeQuerySnapshots: overrides.activeQuerySnapshots ?? [syntheticQuery()],
    providerTargets: overrides.providerTargets ?? [syntheticTarget()],
    observationWindowKey: overrides.observationWindowKey ?? 'window-2026-08',
    maximumProbes: overrides.maximumProbes ?? 10,
    engineVersion: overrides.engineVersion ?? 'llm_visibility_probe_engine_v1',
  }
}

export function syntheticSuccess(overrides: Partial<AdapterSuccess> = {}): AdapterSuccess {
  return {
    ok: true,
    provider: overrides.provider ?? 'chatgpt',
    modelLabel: overrides.modelLabel ?? 'synthetic-model-1',
    responseText: overrides.responseText ?? 'Acme is one option. RivalCo is another option.',
    citationUrls: overrides.citationUrls ?? ['https://example.com/guide', 'https://docs.example.net/source'],
    observedAt: overrides.observedAt ?? '2026-08-24T00:00:00.000Z',
    providerRequestId: overrides.providerRequestId ?? 'request-synthetic-001',
    responseMetadata: overrides.responseMetadata ?? { finishReason: 'stop', inputTokens: 12, outputTokens: 18, totalTokens: 30 },
  }
}

export class SyntheticRegistry implements VisibilityProbeIdempotencyRegistry {
  readonly records = new Map<string, IdempotencyRecord>()
  async get(requestFingerprint: string): Promise<IdempotencyRecord | null> { return this.records.get(requestFingerprint) ?? null }
  async record(record: IdempotencyRecord): Promise<void> { this.records.set(record.requestFingerprint, record) }
}

export function syntheticAdapter(overrides: { adapterKey?: string, provider?: ProbeProvider, modelLabel?: string, result?: AdapterResult, onCall?: (input: unknown) => void } = {}): VisibilityProbeAdapter {
  return {
    adapterKey: overrides.adapterKey ?? 'synthetic-adapter-1',
    provider: overrides.provider ?? 'chatgpt',
    modelLabel: overrides.modelLabel ?? 'synthetic-model-1',
    async execute(input) {
      overrides.onCall?.(input)
      return overrides.result ?? syntheticSuccess()
    },
  }
}
