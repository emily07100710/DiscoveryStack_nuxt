import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { createGeoFlowQwenGenerationRuntime } from '../../geoflow-runtime/qwen'
import { GEOFLOW_PROTOCOL_VERSION } from '../../geoflow-integration'
import { computeManagedSiteProviderManifestHash } from './generation-artifact'
import type { ManagedSiteArtifactVault } from './generation-service'
import type {
  ManagedSiteGeneratedFile,
  ManagedSiteGenerationAdapter,
  ManagedSiteGenerationProviderOutput,
  ManagedSiteGenerationRequest,
  ManagedSitePaymentWebhookAdapter,
  ManagedSiteVerifiedPaymentWebhook,
} from './types'

function sha256(value: string): string { return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex') }
function escapeHtml(value: string): string { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;') }
function opaquePart(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 120) }

function requestSiteSpec(request: ManagedSiteGenerationRequest) {
  return request.siteSpec as {
    businessIdentity: { brandName: string; audience: string; brief: string }
    designTokens: { colorPrimary: string; colorAccent: string; colorSurface: string; colorText: string }
    seoGeoStructuralRequirements: Record<string, boolean>
  }
}

function markdownToStaticAstro(title: string, markdown: string): string {
  const blocks = markdown.split(/\n{2,}/u).map(block => block.trim()).filter(Boolean).slice(0, 80)
  const body = blocks.map(block => {
    const heading = block.match(/^#{1,3}\s+(.+)$/su)
    if (heading) return `<h2>${escapeHtml(heading[1]!.trim())}</h2>`
    return `<p>${escapeHtml(block.replace(/^[-*]\s+/gmu, '').replace(/\n/gu, ' '))}</p>`
  }).join('\n      ')
  return `---\n// Generated candidate contains no executable provider code.\n---\n<html lang="zh-Hant">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width" />\n    <meta name="robots" content="index,follow" />\n    <title>${escapeHtml(title)}</title>\n    <style is:global>@import '../styles/site.css';</style>\n  </head>\n  <body>\n    <main>\n      <h1>${escapeHtml(title)}</h1>\n      ${body}\n    </main>\n  </body>\n</html>\n`
}

function generatedFiles(request: ManagedSiteGenerationRequest, markdown: string): ManagedSiteGeneratedFile[] {
  const spec = requestSiteSpec(request)
  const page = markdownToStaticAstro(spec.businessIdentity.brandName, markdown)
  const css = `:root { --primary: ${spec.designTokens.colorPrimary}; --accent: ${spec.designTokens.colorAccent}; --surface: ${spec.designTokens.colorSurface}; --text: ${spec.designTokens.colorText}; }\n* { box-sizing: border-box; }\nbody { margin: 0; background: var(--surface); color: var(--text); font-family: system-ui, sans-serif; line-height: 1.65; }\nmain { width: min(72rem, calc(100% - 2rem)); margin: 0 auto; padding: 4rem 0; }\nh1, h2 { color: var(--primary); line-height: 1.15; }\na { color: var(--accent); }\n`
  const robots = 'User-agent: *\nAllow: /\n'
  const files: ManagedSiteGeneratedFile[] = [
    { path: 'src/pages/index.astro', mediaType: 'text/astro', content: page, sha256: sha256(page) },
    { path: 'src/styles/site.css', mediaType: 'text/css', content: css, sha256: sha256(css) },
    { path: 'public/robots.txt', mediaType: 'text/markdown', content: robots, sha256: sha256(robots) },
  ]
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/** Reuses the canonical Bailian/Qwen content runtime, then projects admitted text into a fixed no-script Astro template. */
export function createBailianQwenManagedSiteGenerationAdapter(options: { endpoint: string; model?: string; providerKey?: string; fetchImpl?: typeof fetch; now?: () => string }): ManagedSiteGenerationAdapter {
  const providerKey = options.providerKey || 'bailian-qwen'
  return {
    async generate(request, context) {
      if (!context.credentialReference) throw Object.assign(new Error('credential reference missing'), { code: 'CREDENTIAL_MISSING', retryable: false })
      const spec = requestSiteSpec(request)
      const evidenceText = [spec.businessIdentity.brandName, spec.businessIdentity.audience, spec.businessIdentity.brief].join('\n')
      const evidenceChunkHash = sha256(evidenceText.normalize('NFKC').trim().replace(/\s+/gu, ' '))
      const runtime = createGeoFlowQwenGenerationRuntime({
        endpoint: options.endpoint,
        model: options.model,
        credentialRef: context.credentialReference,
        resolveCredential: async reference => {
          const resolved = await context.resolveCredential(reference)
          return resolved.ok ? resolved.value : undefined
        },
        fetchImpl: options.fetchImpl as any,
        timeoutMs: context.timeoutMs,
        now: options.now,
        attempt: context.attemptNumber,
      })
      const createdAt = options.now ? options.now() : new Date().toISOString()
      const result = await runtime.generate({
        protocolVersion: GEOFLOW_PROTOCOL_VERSION,
        requestId: `managed-site-${request.projectId}-${request.sourceVersionId}`,
        idempotencyKey: request.idempotencyKey,
        ownerUserId: request.ownerUserId,
        clientId: request.projectId,
        calendarEntryId: request.sourceVersionId,
        productionPlanId: request.projectId,
        deliverableId: request.sourceVersionId,
        briefId: request.sourceVersionId,
        jobId: request.sourceVersionId,
        evidenceSnapshotHash: request.evidenceConstraints.evidenceSnapshotHash,
        brief: { title: spec.businessIdentity.brandName, audience: spec.businessIdentity.audience, goals: ['Generate an evidence-safe managed website candidate.'], constraints: [...request.evidenceConstraints.limitations, 'Return bounded approved-source copy only.'] },
        contentType: 'landing_page',
        language: request.locale,
        generationMode: 'draft',
        revisionContext: null,
        requestedCapabilities: ['qwen_generation', 'knowledge_rag', 'human_review'],
        selectedRuleIds: [],
        authoritySourceIds: request.evidenceConstraints.authoritySourceIds.length ? request.evidenceConstraints.authoritySourceIds : ['validated-customer-brief'],
        evidenceChunks: [{ sourceId: 'managed-site-spec', artifactId: `version-${request.sourceVersionId}`, chunkId: 'business-identity', chunkHash: evidenceChunkHash, reviewedText: evidenceText, locator: `https://evidence.routing.discoverystack.dev/managed-sites/${request.projectId}/versions/${request.sourceVersionId}` }],
        createdAt,
      })
      if (!result.ok) throw Object.assign(new Error('Qwen request schema rejected'), { code: 'PROVIDER_REQUEST_REJECTED', retryable: false })
      if (result.value.status !== 'draft_ready' && result.value.status !== 'review_required') {
        const blocked = result.value as typeof result.value & { failure?: { code?: string; retryable?: boolean } }
        throw Object.assign(new Error('Qwen did not produce an admissible draft'), { code: blocked.failure?.code || 'PROVIDER_OUTPUT_BLOCKED', retryable: blocked.status === 'failed' && blocked.failure?.retryable === true })
      }
      const files = generatedFiles(request, result.value.contentArtifact.bodyMarkdown)
      return { schemaVersion: 'managed-site-generation-provider-response-v1', providerKey, providerModel: result.value.providerProvenance.model, providerRequestId: opaquePart(result.value.externalArticleKey), requestFingerprint: request.requestFingerprint, files, manifestHash: computeManagedSiteProviderManifestHash(files) }
    },
  }
}

export function createMockManagedSiteGenerationAdapter(options: { providerKey?: string; model?: string; mutate?: (output: ManagedSiteGenerationProviderOutput) => ManagedSiteGenerationProviderOutput } = {}): ManagedSiteGenerationAdapter {
  return {
    async generate(request, context) {
      if (context.executionMode !== 'mocked') throw Object.assign(new Error('mock adapter mode mismatch'), { code: 'MODE_MISMATCH', retryable: false })
      const spec = requestSiteSpec(request)
      const files = generatedFiles(request, `# ${spec.businessIdentity.brandName}\n\n${spec.businessIdentity.brief}\n\n${spec.businessIdentity.audience}`)
      const output: ManagedSiteGenerationProviderOutput = { schemaVersion: 'managed-site-generation-provider-response-v1', providerKey: options.providerKey || 'mock-generator', providerModel: options.model || 'mock-site-model-v1', providerRequestId: `mock-generation-${request.projectId}-${request.sourceVersionId}`, requestFingerprint: request.requestFingerprint, files, manifestHash: computeManagedSiteProviderManifestHash(files) }
      return options.mutate ? options.mutate(structuredClone(output)) : output
    },
  }
}

export function createMemoryManagedSiteArtifactVault(): ManagedSiteArtifactVault & { records: Map<string, { manifest: unknown; files: readonly ManagedSiteGeneratedFile[] }> } {
  const records = new Map<string, { manifest: unknown; files: readonly ManagedSiteGeneratedFile[] }>()
  return {
    records,
    async storeImmutableCandidate(input) {
      const key = `vault:managed-site:${input.ownerUserId}:${input.projectId}:${input.requestFingerprint}`
      const existing = records.get(key)
      if (existing && stableFingerprint(existing.manifest) !== stableFingerprint(input.manifest)) throw Object.assign(new Error('vault identity collision'), { code: 'VAULT_COLLISION', retryable: false })
      records.set(key, { manifest: structuredClone(input.manifest), files: structuredClone(input.files) })
      return { vaultReference: key, contentHash: input.manifest.contentHash, exactResponseIdentity: `vault-receipt:${input.manifest.manifestHash}` }
    },
  }
}

function paymentPayload(value: unknown): ManagedSiteVerifiedPaymentWebhook | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const keys = ['providerKey', 'providerEventId', 'providerReference', 'eventType', 'draftOrderId', 'amountMinor', 'currency', 'occurredAt', 'exactResponseIdentity']
  if (Object.keys(candidate).length !== keys.length || keys.some(key => !Object.hasOwn(candidate, key))) return null
  if (typeof candidate.providerKey !== 'string' || typeof candidate.providerEventId !== 'string' || typeof candidate.providerReference !== 'string' || typeof candidate.exactResponseIdentity !== 'string') return null
  if (!['checkout_succeeded', 'checkout_failed', 'checkout_cancelled', 'payment_refunded'].includes(String(candidate.eventType))) return null
  if (!Number.isSafeInteger(candidate.draftOrderId) || Number(candidate.draftOrderId) < 1 || !Number.isSafeInteger(candidate.amountMinor) || Number(candidate.amountMinor) < 0) return null
  if (typeof candidate.currency !== 'string' || !/^[A-Z]{3}$/u.test(candidate.currency) || typeof candidate.occurredAt !== 'string' || !Number.isFinite(Date.parse(candidate.occurredAt))) return null
  return { ...(candidate as Omit<ManagedSiteVerifiedPaymentWebhook, 'canonicalPayloadHash'>), canonicalPayloadHash: '' } as ManagedSiteVerifiedPaymentWebhook
}

/** Test-only raw-body HMAC adapter. Production providers implement the same signature-first boundary. */
export function createHmacRawBodyPaymentWebhookAdapter(providerKey: string): ManagedSitePaymentWebhookAdapter {
  return {
    async verifyRawWebhook(input) {
      const resolution = await input.resolveCredential(input.credentialReference)
      if (!resolution.ok || !/^[a-f0-9]{64}$/u.test(input.signatureHeader)) return null
      const expected = createHmac('sha256', resolution.value).update(input.rawBody).digest()
      const supplied = Buffer.from(input.signatureHeader, 'hex')
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.from(input.rawBody).toString('utf8')) } catch { return null }
      const event = paymentPayload(parsed)
      if (!event || event.providerKey !== providerKey) return null
      return { ...event, canonicalPayloadHash: createHash('sha256').update(input.rawBody).digest('hex') }
    },
  }
}

export function createMockRawBodyPaymentWebhookAdapter(providerKey = 'mock-payment'): ManagedSitePaymentWebhookAdapter {
  return createHmacRawBodyPaymentWebhookAdapter(providerKey)
}
