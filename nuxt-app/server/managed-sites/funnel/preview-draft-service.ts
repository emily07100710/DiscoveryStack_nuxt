import { createError } from 'h3'
import { createOpenAiCompatibleChatClient, resolveOpenAiCompatibleProviderConfiguration, type OpenAiCompatibleProviderConfiguration } from '../../llm-provider/openai-compatible'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { managedSiteStableFingerprint } from '../live-connectors/canonical'
import { analysePublicHomepageHtml } from '../../utils/publicSiteAnalysis'
import { createDeterministicManagedSiteBlueprint } from '../live-connectors/adapters'
import { ManagedSiteCopyRejectedError, managedSiteCopyPrompt, mergeManagedSiteCopy, parseManagedSiteCopyDocument } from '../live-connectors/blueprint-copy'
import { MANAGED_SITE_BLUEPRINT_MAX_BYTES, compileManagedSiteBlueprint, validateManagedSiteBlueprintProviderOutput } from '../live-connectors/blueprint'
import { renderManagedSiteStaticAssets } from '../live-connectors/internal-broker/static-renderer'
import type { ManagedSiteBlueprintProviderOutput, ManagedSiteBlueprintV1, ManagedSiteGenerationAdapter, ManagedSiteGenerationRequest } from '../live-connectors/types'
import type { ManagedSiteFunnelSession } from '../../database/schema'
import type { FunnelAnswers } from './session-service'
import { funnelSiteSpec } from './quote-projection'

export type FunnelPreviewSource = 'llm' | 'template'
type FunnelPreviewScores = { overall: number; seo: number; geo: number; brandContent: number; ux: number }

export type FunnelPreviewDraft = {
  source: FunnelPreviewSource
  sourceReason: string
  generatedAt: string
  blueprintHash: string
  headline: string
  sections: { heading: string; body: string }[]
  html: string
  scores: FunnelPreviewScores
  comparison: null | {
    before: { url: string; analysedAt: string; scores: FunnelPreviewScores }
    after: { scores: FunnelPreviewScores }
    deltas: FunnelPreviewScores
  }
}

export type FunnelPreviewDraftDependencies = {
  generationAdapter?: ManagedSiteGenerationAdapter
  providerConfiguration?: OpenAiCompatibleProviderConfiguration
  clock?: () => Date
  analyse?: typeof analysePublicHomepageHtml
  templateBuilder?: (request: ManagedSiteGenerationRequest) => ManagedSiteBlueprintProviderOutput['blueprint']
  fetchImpl?: typeof fetch
}

class PreviewDraftUnavailableError extends Error {
  constructor(readonly code: 'not_configured' | 'provider_error' | 'timeout' | 'malformed_output' | 'unsafe_html') {
    super(`Funnel preview draft unavailable: ${code}`)
    this.name = 'PreviewDraftUnavailableError'
  }
}

function answersFor(session: ManagedSiteFunnelSession): FunnelAnswers {
  return session.answers && typeof session.answers === 'object' && !Array.isArray(session.answers) ? session.answers as FunnelAnswers : {}
}

function previewRequest(session: ManagedSiteFunnelSession): ManagedSiteGenerationRequest {
  const answers = answersFor(session)
  const siteSpec = funnelSiteSpec(answers, session.id)
  const answersFingerprint = stableFingerprint(answers)
  const idempotencyKey = stableFingerprint({ scope: 'funnel-preview-draft', sessionId: session.id, answersFingerprint })
  const evidenceSnapshotHash = stableFingerprint({ scope: 'funnel-preview-evidence', sessionId: session.id, answersFingerprint })
  return {
    schemaVersion: 'managed-site-generation-request-v1',
    // This is preview-only: it never enters the generation service, database, vault, or deployment adapter.
    // A literal request is used because the persisted-project request builder correctly requires real lineage.
    ownerUserId: 0,
    projectId: 0,
    sourceVersionId: 0,
    siteSpec,
    brandContent: { brandName: siteSpec.businessIdentity.brandName, brief: siteSpec.businessIdentity.brief },
    locale: siteSpec.locale,
    selectedModules: [...siteSpec.selectedModules],
    formEndpoint: null,
    templateIntent: 'astro',
    geoBrief: { summaryAnswer: siteSpec.businessIdentity.brief, requirements: siteSpec.seoGeoStructuralRequirements },
    evidenceConstraints: { evidenceSnapshotHash, authoritySourceIds: [], limitations: [...siteSpec.limitations], humanReviewRequired: true },
    requestFingerprint: stableFingerprint({ scope: 'funnel-preview-generation-request', sessionId: session.id, idempotencyKey, siteSpec: siteSpec.deterministicFingerprint }),
    idempotencyKey,
  }
}

// A full ManagedSiteBlueprintV1 is a multi-thousand-token structured completion; the measured Bailian round trip
// runs well past a conventional 30s API budget, so the preview waits long enough for a real draft before falling back.
const FUNNEL_PREVIEW_PROVIDER_TIMEOUT_MS = 90_000

function configuredPreviewAdapter(configuration: Extract<OpenAiCompatibleProviderConfiguration, { configured: true }>, fetchImpl?: typeof fetch): ManagedSiteGenerationAdapter {
  const client = createOpenAiCompatibleChatClient({ endpoint: configuration.endpoint, apiKey: configuration.apiKey, model: configuration.model, fetchImpl })
  return {
    async generate(request) {
      const skeleton = createDeterministicManagedSiteBlueprint(request)
      const prompt = managedSiteCopyPrompt(request, skeleton)
      const completed = await client.complete({
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        responseFormat: 'json_object',
        reasoning: 'disabled',
        timeoutMs: FUNNEL_PREVIEW_PROVIDER_TIMEOUT_MS,
        requestId: `funnel-preview-${request.requestFingerprint.slice(0, 40)}`,
        maxResponseBytes: MANAGED_SITE_BLUEPRINT_MAX_BYTES,
      })
      if (/<\s*\/?\s*(?:script|iframe|object|embed|base)|\bon[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html/iu.test(completed.content)) throw new PreviewDraftUnavailableError('unsafe_html')
      let blueprint: ManagedSiteBlueprintV1
      try {
        blueprint = mergeManagedSiteCopy(skeleton, parseManagedSiteCopyDocument(completed.content), completed.content)
      } catch (error) {
        if (error instanceof ManagedSiteCopyRejectedError) throw new PreviewDraftUnavailableError('malformed_output')
        throw error
      }
      return {
        schemaVersion: 'managed-site-blueprint-provider-response-v1',
        providerKey: `openai-compatible:${configuration.providerLabel}`,
        providerModel: configuration.model,
        providerRequestId: `funnel-preview-${request.requestFingerprint.slice(0, 40)}`,
        requestFingerprint: request.requestFingerprint,
        blueprint,
        blueprintHash: managedSiteStableFingerprint(blueprint),
      }
    },
  }
}

function assertSafePreviewHtml(html: string): void {
  if (Buffer.byteLength(html, 'utf8') > MANAGED_SITE_BLUEPRINT_MAX_BYTES) throw new PreviewDraftUnavailableError('unsafe_html')
  if (/<\s*script\b/iu.test(html) || /\son[a-z]+\s*=/iu.test(html)) throw new PreviewDraftUnavailableError('unsafe_html')
  for (const match of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
    const href = match[1]!.trim()
    if (!href.startsWith('/') && !href.startsWith('#') && !/^https:\/\//iu.test(href)) throw new PreviewDraftUnavailableError('unsafe_html')
  }
}

function renderPreview(blueprint: ManagedSiteBlueprintProviderOutput['blueprint'], blueprintHash: string): Pick<FunnelPreviewDraft, 'blueprintHash' | 'headline' | 'sections' | 'html'> {
  const files = compileManagedSiteBlueprint(blueprint)
  const asset = renderManagedSiteStaticAssets(blueprint, files).find(candidate => candidate.path === 'index.html')
  if (!asset) throw new PreviewDraftUnavailableError('malformed_output')
  assertSafePreviewHtml(asset.content)
  const home = blueprint.pages.find(page => page.pageKey === 'home')
  if (!home) throw new PreviewDraftUnavailableError('malformed_output')
  return { blueprintHash, headline: home.title, sections: home.sections.map(section => ({ heading: section.heading, body: section.body })), html: asset.content }
}

function comparisonFor(answers: FunnelAnswers, after: FunnelPreviewScores): FunnelPreviewDraft['comparison'] {
  const before = answers.existingSite?.hasSite === true ? answers.existingSite.snapshot : undefined
  if (!before || !answers.existingSite?.url) return null
  const scores = before.scores
  return {
    before: { url: answers.existingSite.url, analysedAt: before.analysedAt, scores },
    after: { scores: after },
    deltas: { overall: after.overall - scores.overall, seo: after.seo - scores.seo, geo: after.geo - scores.geo, brandContent: after.brandContent - scores.brandContent, ux: after.ux - scores.ux },
  }
}

function fallbackReason(error?: unknown): string {
  if (error instanceof PreviewDraftUnavailableError && error.code === 'unsafe_html') return 'AI 產生器輸出未通過安全檢查，先顯示樣板草稿。'
  if (error instanceof PreviewDraftUnavailableError && error.code === 'malformed_output') return 'AI 產生器回傳的草稿格式無法使用，先顯示樣板草稿。'
  if ((error as { statusCode?: unknown; statusMessage?: unknown })?.statusCode === 422 && typeof (error as { statusMessage?: unknown }).statusMessage === 'string' && (error as { statusMessage: string }).statusMessage.includes('unsafe or oversized')) return 'AI 產生器輸出未通過安全檢查，先顯示樣板草稿。'
  return 'AI 產生器暫時無法回應，先顯示樣板草稿。'
}

function previewUnavailable(): never {
  throw createError({ statusCode: 503, statusMessage: '預覽暫時無法產生，請稍後再試。' })
}

function templateBlueprint(request: ManagedSiteGenerationRequest, dependencies: FunnelPreviewDraftDependencies): { blueprint: ManagedSiteBlueprintProviderOutput['blueprint']; blueprintHash: string } {
  try {
    const blueprint = (dependencies.templateBuilder || createDeterministicManagedSiteBlueprint)(request)
    return { blueprint, blueprintHash: managedSiteStableFingerprint(blueprint) }
  } catch {
    previewUnavailable()
  }
}

function renderTemplate(blueprint: ManagedSiteBlueprintProviderOutput['blueprint'], blueprintHash: string): Pick<FunnelPreviewDraft, 'blueprintHash' | 'headline' | 'sections' | 'html'> {
  try {
    return renderPreview(blueprint, blueprintHash)
  } catch {
    previewUnavailable()
  }
}

export async function generateFunnelPreviewDraft(session: ManagedSiteFunnelSession, dependencies: FunnelPreviewDraftDependencies = {}): Promise<FunnelPreviewDraft> {
  const clock = dependencies.clock || (() => new Date())
  const generatedAt = clock()
  if (!Number.isFinite(generatedAt.getTime())) throw createError({ statusCode: 422, statusMessage: 'Preview draft clock is invalid.' })
  const request = previewRequest(session)
  const configuration = dependencies.providerConfiguration || resolveOpenAiCompatibleProviderConfiguration()
  let source: FunnelPreviewSource = 'template'
  let sourceReason = 'AI 產生器尚未設定，改用樣板草稿。'
  let blueprint: ManagedSiteBlueprintProviderOutput['blueprint']
  let blueprintHash: string

  if (configuration.configured) {
    try {
      const adapter = dependencies.generationAdapter || configuredPreviewAdapter(configuration, dependencies.fetchImpl)
      const output = await adapter.generate(request, { executionMode: 'live', credentialReference: 'funnel-preview-llm', resolveCredential: () => ({ ok: true, value: configuration.apiKey }), timeoutMs: FUNNEL_PREVIEW_PROVIDER_TIMEOUT_MS, attemptNumber: 1 })
      const validated = validateManagedSiteBlueprintProviderOutput(output, request, output.providerKey)
      blueprint = validated.blueprint
      blueprintHash = validated.blueprintHash
      source = 'llm'
      sourceReason = '由已設定的 AI 產生器建立草稿。'
    } catch (error) {
      const code = error instanceof PreviewDraftUnavailableError ? error.code : (error as { code?: unknown; statusCode?: unknown })?.code || (error as { statusCode?: unknown })?.statusCode || 'unknown'
      console.warn('[managed-site-funnel] preview provider fallback', code)
      ;({ blueprint, blueprintHash } = templateBlueprint(request, dependencies))
      source = 'template'
      sourceReason = fallbackReason(error)
    }
  } else {
    ;({ blueprint, blueprintHash } = templateBlueprint(request, dependencies))
  }

  let rendered: Pick<FunnelPreviewDraft, 'blueprintHash' | 'headline' | 'sections' | 'html'>
  try {
    rendered = renderPreview(blueprint, blueprintHash)
  } catch (error) {
    if (source !== 'llm') previewUnavailable()
    ;({ blueprint, blueprintHash } = templateBlueprint(request, dependencies))
    source = 'template'
    sourceReason = fallbackReason(error)
    rendered = renderTemplate(blueprint, blueprintHash)
  }
  const hostname = `funnel-${session.id}.preview.invalid`
  const analysis = (dependencies.analyse || analysePublicHomepageHtml)({ html: rendered.html, requestedUrl: `https://${hostname}/`, finalUrl: `https://${hostname}/`, hostname, analysedAt: generatedAt })
  const scores = analysis.scores
  return { source, sourceReason, generatedAt: generatedAt.toISOString(), ...rendered, scores, comparison: comparisonFor(answersFor(session), scores) }
}
