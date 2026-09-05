import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { managedSiteStableFingerprint } from './canonical'
import { isAllowedBailianEndpoint } from '../../geo/autogeo-bailian-qwen'
import { SITE_MODULE_LABELS_ZH, type SiteSpec } from '../site-spec'
import type { ManagedSiteArtifactVault, ManagedSiteArtifactVaultBundle } from './generation-service'
import type {
  ManagedSiteBlueprintProviderOutput,
  ManagedSiteBlueprintV1,
  ManagedSiteGeneratedFile,
  ManagedSiteGenerationAdapter,
  ManagedSiteGenerationRequest,
  ManagedSitePaymentWebhookAdapter,
  ManagedSiteVerifiedPaymentWebhook,
} from './types'
import { readBoundedManagedSiteResponse } from './hmac-broker-transport'
import { ManagedSiteCopyRejectedError, managedSiteCopyPrompt, mergeManagedSiteCopy, parseManagedSiteCopyDocument } from './blueprint-copy'

function sha256(value: string): string { return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex') }
function opaquePart(value: string): string { return value.replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 120) }

function requestSiteSpec(request: ManagedSiteGenerationRequest): SiteSpec { return request.siteSpec as SiteSpec }

function modulePage(moduleKey: string): ManagedSiteBlueprintV1['pages'][number]['pageKey'] {
  if (moduleKey === 'shopify_commerce') return 'shop'
  if (moduleKey === 'google_booking_assisted_integration' || moduleKey === 'contact_lead_capture') return 'contact'
  return 'home'
}

function modulePageForSite(moduleKey: string, pageKeys: ManagedSiteBlueprintV1['pages'][number]['pageKey'][]): ManagedSiteBlueprintV1['pages'][number]['pageKey'] {
  const preferredPage = modulePage(moduleKey)
  return pageKeys.includes(preferredPage) ? preferredPage : 'home'
}

export function applyManagedSiteFirstPartySectionContracts(blueprint: ManagedSiteBlueprintV1, request: ManagedSiteGenerationRequest): ManagedSiteBlueprintV1 {
  const spec = requestSiteSpec(request)
  const hasContactForm = spec.selectedModules.includes('contact_lead_capture')
  const targetPageKey = spec.siteType === 'one_page' ? 'home' : 'contact'
  const contactSectionId = 'module-contact-lead-capture'
  return {
    ...blueprint,
    pages: blueprint.pages.map(page => {
      const normalized: ManagedSiteBlueprintV1['pages'][number]['sections'] = page.sections
        .filter(section => !hasContactForm || section.moduleKey !== 'contact_lead_capture')
        .map(section => ({ ...section, formEndpoint: null }))
      if (hasContactForm && page.pageKey === targetPageKey) normalized.push({
        sectionId: contactSectionId,
        kind: 'contact_form',
        heading: spec.locale === 'zh-hant' ? '聯絡我們' : 'Contact us',
        body: spec.locale === 'zh-hant' ? '填寫表單後，我們會保存你的訊息；完成收信信箱綁定時也會寄送通知。' : 'Your submission is stored, and a bound inbox also receives an email notification.',
        ctaLabel: null,
        ctaHref: null,
        moduleKey: 'contact_lead_capture',
        formEndpoint: request.formEndpoint,
      })
      return { ...page, sections: normalized }
    }),
    selectedModulePlacements: blueprint.selectedModulePlacements.map(placement => placement.moduleKey === 'contact_lead_capture'
      ? { ...placement, pageKey: targetPageKey, sectionId: contactSectionId, mode: 'first_party' }
      : placement),
  }
}

const PAGE_LABELS_ZH: Record<ManagedSiteBlueprintV1['pages'][number]['pageKey'], string> = { home: '首頁', about: '關於我們', services: '服務項目', faq: '常見問題', contact: '聯絡我們', blog: '部落格', shop: '商品' }

function blueprintPages(spec: SiteSpec): ManagedSiteBlueprintV1['pages'] {
  const pageKeys: ManagedSiteBlueprintV1['pages'][number]['pageKey'][] = spec.siteType === 'one_page' ? ['home'] : spec.siteType === 'brand_blog' ? ['home', 'about', 'services', 'faq', 'contact', 'blog'] : ['home', 'services', 'faq', 'contact', 'shop']
  const pageLabel = (pageKey: ManagedSiteBlueprintV1['pages'][number]['pageKey']) => spec.locale === 'zh-hant' ? PAGE_LABELS_ZH[pageKey] : pageKey
  return pageKeys.map(pageKey => {
    const label = pageLabel(pageKey)
    const sections: ManagedSiteBlueprintV1['pages'][number]['sections'] = [{ sectionId: `${pageKey}-summary`, kind: pageKey === 'home' ? 'hero' : pageKey === 'faq' ? 'faq' : pageKey === 'blog' ? 'blog_index' : pageKey === 'shop' ? 'shop_index' : pageKey === 'services' ? 'services' : pageKey === 'about' ? 'about' : 'contact', heading: pageKey === 'home' ? spec.businessIdentity.brandName : label, body: pageKey === 'home' ? spec.businessIdentity.brief : spec.locale === 'zh-hant' ? `這裡會放上${label}的內容，對象是${spec.businessIdentity.audience}，實際文字會依你提供的資料調整。` : `Evidence-bounded ${pageKey} information for ${spec.businessIdentity.audience}.`, ctaLabel: pageKey === 'home' ? (spec.locale === 'zh-hant' ? '聯絡我們' : 'Contact') : null, ctaHref: pageKey === 'home' ? (spec.siteType === 'one_page' ? '#contact' : '/contact') : null, moduleKey: null, formEndpoint: null }]
    for (const moduleKey of [...spec.selectedModules].sort().filter(key => modulePageForSite(key, pageKeys) === pageKey)) sections.push({ sectionId: `module-${moduleKey.replace(/_/gu, '-')}`, kind: 'module_slot', heading: spec.locale === 'zh-hant' ? SITE_MODULE_LABELS_ZH[moduleKey] : moduleKey.replace(/_/gu, ' '), body: spec.locale === 'zh-hant' ? '這個功能會在網站上線、並完成設定與確認後才啟用，目前只是示意位置。' : 'This module is an inert preview slot until configured and verified by the owner.', ctaLabel: null, ctaHref: null, moduleKey, formEndpoint: null })
    return { pageKey, route: pageKey === 'home' ? '/' : `/${pageKey}`, title: pageKey === 'home' ? spec.businessIdentity.brandName : `${spec.businessIdentity.brandName}${spec.locale === 'zh-hant' ? '・' : ' · '}${label}`, description: `${spec.businessIdentity.brief.slice(0, 240)}${spec.locale === 'zh-hant' ? '・' : ' · '}${label}`, sections }
  })
}

export function createDeterministicManagedSiteBlueprint(request: ManagedSiteGenerationRequest): ManagedSiteBlueprintV1 {
  const spec = requestSiteSpec(request)
  const pages = blueprintPages(spec)
  return applyManagedSiteFirstPartySectionContracts({
    schemaVersion: 'managed-site-blueprint-v1', brandName: spec.businessIdentity.brandName, locale: spec.locale, siteType: spec.siteType,
    navigation: pages.map(page => ({ label: page.pageKey === 'home' ? spec.businessIdentity.brandName : spec.locale === 'zh-hant' ? PAGE_LABELS_ZH[page.pageKey] : page.pageKey, route: page.route })), pages,
    faq: pages.some(page => page.pageKey === 'faq') ? [{ question: spec.locale === 'zh-hant' ? `${spec.businessIdentity.brandName} 提供什麼服務？` : `What does ${spec.businessIdentity.brandName} provide?`, answer: spec.businessIdentity.brief }] : [],
    selectedModulePlacements: [...spec.selectedModules].sort().map(moduleKey => {
      const page = pages.find(candidate => candidate.sections.some(section => section.moduleKey === moduleKey))
      if (!page) throw createError({ statusCode: 422, statusMessage: `所選模組 ${moduleKey} 無法放入此網站類型，請調整網站類型或模組後再試。` })
      return { moduleKey, pageKey: page.pageKey, sectionId: `module-${moduleKey.replace(/_/gu, '-')}`, mode: ['managed_content_admin', 'contact_lead_capture', 'geo_content_subscription', 'geo_measurement_dashboard'].includes(moduleKey) ? 'first_party' : 'safe_placeholder' } as const
    }),
    seoGeo: { summaryAnswer: spec.businessIdentity.brief, canonicalPlaceholder: '{{CANONICAL_ORIGIN}}', organizationName: spec.businessIdentity.brandName, evidenceLimitations: [...spec.limitations], structuredDataKinds: ['Organization', ...(pages.some(page => page.pageKey === 'services') ? ['Service' as const] : []), ...(spec.siteType === 'simple_commerce' ? ['Product' as const] : []), ...(pages.some(page => page.pageKey === 'faq') ? ['FAQPage' as const] : [])] },
    provenance: { evidenceSnapshotHash: request.evidenceConstraints.evidenceSnapshotHash, authoritySourceIds: [...request.evidenceConstraints.authoritySourceIds].sort(), providerContentHash: sha256(stableFingerprint({ brand: spec.businessIdentity, pages: pages.map(page => page.pageKey) })) },
  }, request)
}

/** Qwen returns copy for a deterministic first-party blueprint. Executable source is produced later by the first-party compiler. */
export function createBailianQwenManagedSiteGenerationAdapter(options: { endpoint: string; model?: string; providerKey?: string; fetchImpl?: typeof fetch; now?: () => string }): ManagedSiteGenerationAdapter {
  const providerKey = options.providerKey || 'bailian-qwen'
  return {
    async generate(request, context) {
      if (!context.credentialReference) throw Object.assign(new Error('credential reference missing'), { code: 'CREDENTIAL_MISSING', retryable: false })
      if (!isAllowedBailianEndpoint(options.endpoint)) throw Object.assign(new Error('Bailian endpoint is not on the canonical official allowlist'), { code: 'ENDPOINT_NOT_ALLOWED', retryable: false })
      const credential = await context.resolveCredential(context.credentialReference)
      if (!credential.ok) throw Object.assign(new Error('credential reference unresolved'), { code: 'CREDENTIAL_MISSING', retryable: false })
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), context.timeoutMs)
      let response: Response
      const providerRequestIdentity = `managed-site-${request.requestFingerprint.slice(0, 48)}`
      const configuredModel = options.model || 'qwen-plus'
      const skeleton = createDeterministicManagedSiteBlueprint(request)
      const prompt = managedSiteCopyPrompt(request, skeleton)
      try {
        response = await (options.fetchImpl || fetch)(options.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.value}`, 'x-discoverystack-request-id': providerRequestIdentity }, body: JSON.stringify({ model: configuredModel, stream: false, enable_thinking: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] }) })
      } catch { throw Object.assign(new Error('Qwen blueprint transport failed'), { code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_FAILURE', retryable: true }) } finally { clearTimeout(timer) }
      if (!response.ok) throw Object.assign(new Error('Qwen blueprint provider rejected request'), { code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_FAILURE', retryable: response.status === 429 || response.status >= 500 })
      const raw = await readBoundedManagedSiteResponse(response, 320_000)
      let envelope: any
      try { envelope = JSON.parse(raw) } catch { throw Object.assign(new Error('Qwen blueprint response is malformed'), { code: 'PROVIDER_OUTPUT_BLOCKED', retryable: false }) }
      // OpenAI-compatible vendors legitimately append additive metadata (`object`, `created`, `logprobs`,
      // `reasoning_content`, token detail objects) and prefix the body id over the transport request id, so every
      // field this adapter actually trusts is pinned exactly while unrecognised extras are only bounded, never enumerated.
      const requiredEnvelopeKeys = ['id', 'model', 'choices', 'usage']
      const envelopeIdentifier = envelope && typeof envelope === 'object' && typeof envelope.id === 'string' ? envelope.id : ''
      const transportRequestId = response.headers.get('x-request-id') || ''
      const vendorIdPrefix = envelopeIdentifier.length > transportRequestId.length ? envelopeIdentifier.slice(0, envelopeIdentifier.length - transportRequestId.length) : ''
      const envelopeBoundToTransport = transportRequestId.length >= 3 && (envelopeIdentifier === transportRequestId || (envelopeIdentifier.endsWith(transportRequestId) && /^[A-Za-z0-9._:-]{1,32}-$/u.test(vendorIdPrefix)))
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length < requiredEnvelopeKeys.length || Object.keys(envelope).length > 12 || !requiredEnvelopeKeys.every(key => Object.hasOwn(envelope, key)) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u.test(envelopeIdentifier) || !envelopeBoundToTransport || envelope.model !== configuredModel || !Array.isArray(envelope.choices) || envelope.choices.length !== 1) throw Object.assign(new Error('Qwen blueprint response envelope identity is invalid'), { code: 'PROVIDER_OUTPUT_BLOCKED', retryable: false })
      const choice = envelope.choices[0]
      // `finish_reason` stays pinned to `stop` here: a truncated blueprint is unusable, unlike a capability probe.
      if (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.keys(choice).length > 8 || !['index', 'message', 'finish_reason'].every(key => Object.hasOwn(choice, key)) || choice.index !== 0 || choice.finish_reason !== 'stop') throw Object.assign(new Error('Qwen blueprint response did not complete normally'), { code: 'PROVIDER_OUTPUT_BLOCKED', retryable: false })
      const message = choice.message
      if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length > 6 || !['role', 'content'].every(key => Object.hasOwn(message, key)) || message.role !== 'assistant' || typeof message.content !== 'string') throw Object.assign(new Error('Qwen blueprint response message is invalid'), { code: 'PROVIDER_OUTPUT_BLOCKED', retryable: false })
      const usage = envelope.usage
      if (!usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).length > 8 || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => Object.hasOwn(usage, key) && Number.isSafeInteger(usage[key]) && usage[key] >= 0) || usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) throw Object.assign(new Error('Qwen blueprint response usage is malformed'), { code: 'PROVIDER_OUTPUT_BLOCKED', retryable: false })
      const content = message.content
      if (typeof content !== 'string' || content.includes('```')) throw Object.assign(new Error('Qwen did not return strict JSON'), { code: 'PROVIDER_OUTPUT_BLOCKED', retryable: false })
      let blueprint: ManagedSiteBlueprintV1
      try { blueprint = mergeManagedSiteCopy(skeleton, parseManagedSiteCopyDocument(content), content) } catch (error) {
        if (error instanceof ManagedSiteCopyRejectedError) throw Object.assign(new Error('Qwen blueprint copy is unusable'), { code: 'PROVIDER_OUTPUT_BLOCKED', retryable: true })
        throw error
      }
      return { schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey, providerModel: configuredModel, providerRequestId: opaquePart(envelope.id), requestFingerprint: request.requestFingerprint, blueprint, blueprintHash: managedSiteStableFingerprint(blueprint) }
    },
  }
}

export function createMockManagedSiteGenerationAdapter(options: { providerKey?: string; model?: string; mutate?: (output: ManagedSiteBlueprintProviderOutput) => ManagedSiteBlueprintProviderOutput } = {}): ManagedSiteGenerationAdapter {
  return {
    async generate(request, context) {
      if (context.executionMode !== 'mocked') throw Object.assign(new Error('mock adapter mode mismatch'), { code: 'MODE_MISMATCH', retryable: false })
      const blueprint = createDeterministicManagedSiteBlueprint(request)
      const output: ManagedSiteBlueprintProviderOutput = { schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey: options.providerKey || 'mock-generator', providerModel: options.model || 'mock-site-model-v1', providerRequestId: `mock-generation-${request.projectId}-${request.sourceVersionId}`, requestFingerprint: request.requestFingerprint, blueprint, blueprintHash: managedSiteStableFingerprint(blueprint) }
      return options.mutate ? options.mutate(structuredClone(output)) : output
    },
  }
}

export function createMemoryManagedSiteArtifactVault(): ManagedSiteArtifactVault & { records: Map<string, ManagedSiteArtifactVaultBundle> } {
  const records = new Map<string, ManagedSiteArtifactVaultBundle>()
  return {
    records,
    async lookupImmutableCandidate(input) {
      const key = `vault:managed-site:${input.ownerUserId}:${input.projectId}:${input.requestFingerprint}`
      const bundle = records.get(key)
      return bundle ? { bundle: structuredClone(bundle), vaultReference: key, exactResponseIdentity: `vault-receipt:${bundle.manifest.manifestHash}` } : null
    },
    async storeImmutableCandidate(input) {
      const key = `vault:managed-site:${input.ownerUserId}:${input.projectId}:${input.requestFingerprint}`
      const existing = records.get(key)
      if (existing && stableFingerprint(existing) !== stableFingerprint(input)) throw Object.assign(new Error('vault identity collision'), { code: 'VAULT_COLLISION', retryable: false, statusCode: 409 })
      records.set(key, structuredClone(input))
      return { vaultReference: key, contentHash: input.manifest.contentHash, exactResponseIdentity: `vault-receipt:${input.manifest.manifestHash}` }
    },
  }
}

function paymentPayload(value: unknown): ManagedSiteVerifiedPaymentWebhook | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const keys = ['providerKey', 'providerEventId', 'providerReference', 'eventType', 'draftOrderId', 'amountMinor', 'currency', 'occurredAt', 'exactResponseIdentity', 'configurationFingerprint', 'verificationReceiptFingerprint', 'checkoutReceiptFingerprint']
  if (Object.keys(candidate).length !== keys.length || keys.some(key => !Object.hasOwn(candidate, key))) return null
  if (typeof candidate.providerKey !== 'string' || typeof candidate.providerEventId !== 'string' || typeof candidate.providerReference !== 'string' || typeof candidate.exactResponseIdentity !== 'string' || typeof candidate.configurationFingerprint !== 'string' || typeof candidate.verificationReceiptFingerprint !== 'string' || typeof candidate.checkoutReceiptFingerprint !== 'string' || ![candidate.configurationFingerprint, candidate.verificationReceiptFingerprint, candidate.checkoutReceiptFingerprint].every(value => /^[a-f0-9]{64}$/u.test(String(value)))) return null
  if (!['checkout_succeeded', 'checkout_failed', 'checkout_cancelled', 'payment_refunded', 'payment_disputed'].includes(String(candidate.eventType))) return null
  if (!Number.isSafeInteger(candidate.draftOrderId) || Number(candidate.draftOrderId) < 1 || !Number.isSafeInteger(candidate.amountMinor) || Number(candidate.amountMinor) < 0) return null
  if (typeof candidate.currency !== 'string' || !/^[A-Z]{3}$/u.test(candidate.currency) || typeof candidate.occurredAt !== 'string' || !Number.isFinite(Date.parse(candidate.occurredAt))) return null
  return { ...(candidate as Omit<ManagedSiteVerifiedPaymentWebhook, 'canonicalPayloadHash'>), canonicalPayloadHash: '' } as ManagedSiteVerifiedPaymentWebhook
}

function hmacPaymentWebhookAdapter(providerKey: string): ManagedSitePaymentWebhookAdapter {
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

/** Exact internal_hmac_v1 raw-body adapter. It is not a Stripe or generic vendor adapter. */
export function createInternalHmacV1PaymentWebhookAdapter(providerKey: 'internal_hmac_v1'): ManagedSitePaymentWebhookAdapter { return hmacPaymentWebhookAdapter(providerKey) }

export function createMockRawBodyPaymentWebhookAdapter(providerKey = 'mock-payment'): ManagedSitePaymentWebhookAdapter {
  return hmacPaymentWebhookAdapter(providerKey)
}
