import { describe, expect, it } from 'vitest'
import type { ManagedSiteFunnelSession } from '../server/database/schema'
import { generateFunnelPreviewDraft } from '../server/managed-sites/funnel/preview-draft-service'
import { createDeterministicManagedSiteBlueprint } from '../server/managed-sites/live-connectors/adapters'
import { managedSiteStableFingerprint } from '../server/managed-sites/live-connectors/canonical'
import type { ManagedSiteGenerationAdapter } from '../server/managed-sites/live-connectors/types'
import type { CustomerSitePreset } from '../server/managed-sites/site-spec'
import type { FunnelAnswers } from '../server/managed-sites/funnel/session-service'

const now = new Date('2026-10-06T04:00:00.000Z')
const configuredProvider = { configured: true as const, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'test-model', apiKey: 'test-key', providerLabel: 'openai' as const, source: 'llm' as const }

function generatedBlueprintAdapter(mutate?: (blueprint: ReturnType<typeof createDeterministicManagedSiteBlueprint>) => void): ManagedSiteGenerationAdapter {
  return {
    async generate(request) {
      const blueprint = createDeterministicManagedSiteBlueprint(request)
      mutate?.(blueprint)
      return { schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey: 'preset-test-provider', providerModel: 'test-model', providerRequestId: 'preset-test-request', requestFingerprint: request.requestFingerprint, blueprint, blueprintHash: managedSiteStableFingerprint(blueprint) }
    },
  }
}

function previewSession(customerSitePreset: CustomerSitePreset): ManagedSiteFunnelSession {
  const answers: FunnelAnswers = {
    existingSite: { hasSite: false },
    company: { brandName: '版型測試品牌', whatWeDo: '提供品牌策略服務。', feelings: ['清楚', '可信任'], mainOffer: '品牌顧問', conversionGoals: ['increase_inquiries'] },
    contact: { email: 'preview@example.test', contactName: '預覽聯絡人' },
    style: { referenceUrls: [], stylePreset: 'premium', customerSitePreset, designTier: 'template' },
    siteType: 'brand_blog',
    modules: ['managed_content_admin'],
  }
  return {
    id: 73,
    sessionTokenHash: 'a'.repeat(64),
    status: 'active',
    currentStep: 5,
    answers,
    consentSnapshot: null,
    previewId: null,
    previewAccessTokenHash: null,
    quoteId: null,
    leadIntentId: null,
    draftOrderId: null,
    projectId: null,
    releaseId: null,
    builtPreviewUrl: null,
    checkoutUrl: null,
    expiresAt: new Date('2026-10-20T04:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
  }
}

describe('managed-site funnel preview preset binding', () => {
  it.each(['atelier', 'bloom', 'alignment'] as const)('renders the selected %s preset in the deterministic preview', async (preset) => {
    const draft = await generateFunnelPreviewDraft(previewSession(preset), {
      providerConfiguration: { configured: false, reason: 'endpoint-missing' },
      clock: () => now,
    })

    expect(draft.source).toBe('template')
    expect(draft.html).toContain(`class="site-preset--${preset}"`)
    expect(draft.html).toContain(`data-site-preset="${preset}"`)
    expect(draft.html).not.toMatch(/<script\b/iu)
  })

  it('keeps the selected preset when rendering an approved provider blueprint', async () => {
    const draft = await generateFunnelPreviewDraft(previewSession('bloom'), {
      providerConfiguration: configuredProvider,
      generationAdapter: generatedBlueprintAdapter(blueprint => { blueprint.pages[0]!.title = 'Provider preview' }),
      clock: () => now,
    })

    expect(draft.source).toBe('llm')
    expect(draft.headline).toBe('Provider preview')
    expect(draft.html).toContain('data-site-preset="bloom"')
  })

  it('keeps the selected preset on the safe template rendered after an oversized provider preview', async () => {
    const draft = await generateFunnelPreviewDraft(previewSession('alignment'), {
      providerConfiguration: configuredProvider,
      generationAdapter: generatedBlueprintAdapter(blueprint => {
        const home = blueprint.pages[0]!
        while (home.sections.length < 30) {
          const index = home.sections.length
          home.sections.push({ sectionId: `provider-section-${index}`, kind: 'summary', heading: `Provider section ${index}`, body: '&'.repeat(2_000), ctaLabel: null, ctaHref: null, moduleKey: null, formEndpoint: null })
        }
      }),
      clock: () => now,
    })

    expect(draft.source).toBe('template')
    expect(draft.sourceReason).toContain('安全檢查')
    expect(draft.html).toContain('data-site-preset="alignment"')
    expect(Buffer.byteLength(draft.html, 'utf8')).toBeLessThan(256_000)
  })
})
