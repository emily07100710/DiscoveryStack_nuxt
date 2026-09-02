import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfiguredAiPlanner } from '../server/managed-sites/page-editor/ai-planner-openai-compatible'
import { createInitialPage } from '../server/managed-sites/page-editor/canonical'
import type { PageActor } from '../server/managed-sites/page-editor/types'
import { resolveProductionRuntimeProviders } from '../server/seo-geo-core/productionProviders'

const actor: PageActor = { ownerUserId: 1, projectId: 2, actorUserId: 3, authority: 'system_test', role: 'customer_admin', canPublish: true }
const page = createInitialPage(actor, { pageId: 'page_swap_01', locale: 'zh-hant', route: '/', contentType: 'home', designThemeId: 'default', designTokenVersion: 'tokens-v1', designTokens: { palette: 'indigo_sand', typeScale: 'balanced', spacing: 'balanced', radius: 'soft', maxWidth: 'standard', contrast: 'aa' }, sections: [{ blockId: 'block_swap_hero', type: 'hero', visible: true, layoutVariant: 'split', data: { title: '核准標題', description: '核准內容', alignment: 'center' }, mediaBindingIds: [], schedule: null }], seo: { title: '核准標題', description: '核准內容說明。', canonicalPath: '/', noindex: false, ogBindingId: null }, mediaBindings: [] }, new Date('2026-09-01T00:00:00Z'))

const generationInput = {
  contentType: 'article' as const,
  title: '春季活動',
  audience: '內容 owner',
  language: 'zh-hant' as const,
  goals: ['整理核准事實'],
  constraints: ['不得新增主張'],
  diagnosisFindings: [],
  strategyRules: [],
  evidenceMaterials: [{ sourceId: 1, artifactId: 2, sourceName: '核准來源', locator: 'https://evidence.routing.discoverystack.dev/spring', artifactType: 'html', artifactHash: 'a'.repeat(64), reviewedText: '核准事實：春季活動於四月開始。' }],
}
const generationContext = { ownerUserId: 1, clientId: 2, calendarEntryId: 3, productionPlanId: 4, deliverableId: 5, briefId: 6, jobId: 7, evidenceSnapshotHash: 'b'.repeat(64), now: new Date('2026-09-01T00:01:00Z') }

describe('env-only OpenAI-compatible endpoint swapping', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('runs identical GEO and editor code against Bailian and OpenAI by changing env only', async () => {
    const results: Array<{ generatorId: string; optimizerId: string; plannerPrefix: string; provider: unknown }> = []
    for (const configuration of [
      { base: 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', normalized: 'https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', provider: 'bailian' },
      { base: 'https://api.openai.com/v1', normalized: 'https://api.openai.com/v1/chat/completions', model: 'gpt-test', provider: 'openai' },
    ]) {
      vi.stubEnv('NUXT_LLM_ENDPOINT', configuration.base)
      vi.stubEnv('NUXT_LLM_API_KEY', 'endpoint-swap-placeholder')
      vi.stubEnv('NUXT_LLM_MODEL', configuration.model)
      vi.stubEnv('NUXT_CONTENT_DRAFT_PROVIDER', 'openai_compatible')
      vi.stubEnv('NUXT_PAGE_EDITOR_AI_PROVIDER', 'openai_compatible')
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const content = body.response_format
          ? JSON.stringify({ operations: [{ type: 'update_text', target: { blockId: 'block_swap_hero', path: 'data.title' }, payload: '春季優惠', reason: '更新標題' }], summary: '更新首頁標題。', warnings: [] })
          : '# 春季活動\n\n核准事實：春季活動於四月開始。'
        return new Response(JSON.stringify({ model: configuration.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200 })
      })
      const runtime = resolveProductionRuntimeProviders(undefined, { fetchImpl: fetchImpl as typeof fetch })
      expect(runtime.configured).toBe(true)
      const generated = await runtime.baseDraftGenerator.generate(generationInput, generationContext)
      const planner = resolveConfiguredAiPlanner({ fetchImpl: fetchImpl as typeof fetch })!
      const planned = await planner.plan({ intent: 'freeform_edit', request: '[UNTRUSTED_CUSTOMER_REQUEST]\n更新標題\n[/UNTRUSTED_CUSTOMER_REQUEST]', context: { page, approvedMedia: [], commandCatalog: ['update_text'], untrustedContentBoundary: true, maxOperations: 20 }, maxOutputTokens: 2000, timeoutMs: 30_000 })
      expect(planned).toMatchObject({ summary: '更新首頁標題。' })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      for (const call of fetchImpl.mock.calls) {
        expect(call[0]).toBe(configuration.normalized)
        expect((call[1]?.headers as Record<string, string>).authorization).toBe('Bearer endpoint-swap-placeholder')
        expect(JSON.parse(String(call[1]?.body)).model).toBe(configuration.model)
      }
      expect((generated.provenance.providerProvenance as any).provider).toBe(configuration.provider)
      expect(runtime.provenance.providerLabel).toBe(configuration.provider)
      results.push({ generatorId: runtime.baseDraftGenerator.id, optimizerId: runtime.optimizationAdapter.id, plannerPrefix: planner.providerKey.split(':')[0]!, provider: (generated.provenance.providerProvenance as any).provider })
    }
    expect(results.map(result => result.generatorId)).toEqual(['geoflow-qwen-base-draft', 'geoflow-qwen-base-draft'])
    expect(results.map(result => result.optimizerId)).toEqual(['autogeo-openai-compatible', 'autogeo-openai-compatible'])
    expect(results.map(result => result.plannerPrefix)).toEqual(['openai-compatible', 'openai-compatible'])
    expect(results.map(result => result.provider)).toEqual(['bailian', 'openai'])
  })
})
