import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GEOFLOW_PROTOCOL_VERSION } from '../server/geoflow-integration'
import { createGeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'
import { createOpenAiCompatibleChatClient, resolveOpenAiCompatibleProviderConfiguration } from '../server/llm-provider/openai-compatible'
import { createMemoryAiBudgetPort, proposeAiWebsiteEdit } from '../server/managed-sites/page-editor/ai'
import { createOpenAiCompatibleAiPlannerAdapter } from '../server/managed-sites/page-editor/ai-planner-openai-compatible'
import { createInitialPage } from '../server/managed-sites/page-editor/canonical'
import type { PageActor } from '../server/managed-sites/page-editor/types'

const realEnabled = process.env.DS_RUN_REAL_LLM_TESTS === '1'

function configuredProvider() {
  const configuration = resolveOpenAiCompatibleProviderConfiguration({ env: process.env })
  if (!configuration.configured) throw new Error(`Real LLM configuration is unavailable: ${configuration.reason}. Set NUXT_LLM_* before running this opt-in suite.`)
  return configuration
}

if (!realEnabled) {
  describe('real OpenAI-compatible provider tests', () => {
    it.skip('NOT RUN: real LLM tests need DS_RUN_REAL_LLM_TESTS=1 and NUXT_LLM_* env')
  })
}

if (realEnabled) describe.runIf(process.env.DS_RUN_REAL_LLM_TESTS === '1')('real OpenAI-compatible provider tests', () => {
  it('returns a minimal non-empty completion', async () => {
    const configuration = configuredProvider()
    const client = createOpenAiCompatibleChatClient({ ...configuration, fetchImpl: globalThis.fetch })
    const result = await client.complete({ messages: [{ role: 'user', content: 'Reply with one short Traditional Chinese greeting.' }], timeoutMs: 30_000 })
    expect(result.content.trim().length).toBeGreaterThan(0)
  }, 60_000)

  it('plans a real managed-site edit without applying or publishing it', async () => {
    const configuration = configuredProvider()
    const planner = createOpenAiCompatibleAiPlannerAdapter({ client: createOpenAiCompatibleChatClient({ ...configuration, fetchImpl: globalThis.fetch }) })
    const actor: PageActor = { ownerUserId: 1, projectId: 1, actorUserId: null, authority: 'system_test', role: 'customer_admin', canPublish: true }
    const page = createInitialPage(actor, { pageId: 'page_real_llm', locale: 'zh-hant', route: '/', contentType: 'home', designThemeId: 'default', designTokenVersion: 'tokens-v1', designTokens: { palette: 'indigo_sand', typeScale: 'balanced', spacing: 'balanced', radius: 'soft', maxWidth: 'standard', contrast: 'aa' }, sections: [{ blockId: 'block_real_hero', type: 'hero', visible: true, layoutVariant: 'split', data: { title: '原始標題', description: '核准內容', alignment: 'center' }, mediaBindingIds: [], schedule: null }], seo: { title: '原始標題', description: '核准內容說明。', canonicalPath: '/', noindex: true, ogBindingId: null }, mediaBindings: [] })
    const proposal = await proposeAiWebsiteEdit({ actor, page, request: '把首頁主標題改成「春季優惠開跑」', approvedMedia: [], resolveMedia: async () => null, budget: createMemoryAiBudgetPort(), planner, idempotencyKey: 'real-llm-editor-plan' })
    expect(['proposed', 'clarification_required']).toContain(proposal.status)
    console.log(`REAL LLM EDITOR RESULT: summary=${proposal.summary}; operations=${proposal.operations.length}`)
  }, 60_000)

  it('runs a real GEO base draft and reports only typed outcome metadata', async () => {
    const configuration = configuredProvider()
    const reviewedText = '核准事實：本測試只驗證一段簡短草稿。'
    const createdAt = new Date()
    const runtime = createGeoFlowQwenGenerationRuntime({ endpoint: configuration.endpoint, model: configuration.model, credentialRef: 'real-llm-env', resolveCredential: reference => reference === 'real-llm-env' ? configuration.apiKey : undefined, fetchImpl: globalThis.fetch, now: () => new Date(createdAt.getTime() + 1_000).toISOString() })
    const result = await runtime.generate({ protocolVersion: GEOFLOW_PROTOCOL_VERSION, requestId: 'real-llm-geo-request', idempotencyKey: 'real-llm-geo-idempotency', ownerUserId: 1, clientId: 1, calendarEntryId: 1, productionPlanId: 1, deliverableId: 1, briefId: 1, jobId: 1, evidenceSnapshotHash: 'a'.repeat(64), brief: { title: '簡短草稿', audience: '內容 owner', goals: ['整理核准事實'], constraints: ['不得新增未核准主張'] }, contentType: 'article', language: 'zh-hant', generationMode: 'draft', revisionContext: null, requestedCapabilities: ['qwen_generation', 'knowledge_rag', 'human_review'], selectedRuleIds: [], authoritySourceIds: ['source-real'], evidenceChunks: [{ sourceId: 'source-real', artifactId: 'artifact-real', chunkId: 'chunk-real', chunkHash: createHash('sha256').update(Buffer.from(reviewedText.normalize('NFKC').trim().replace(/\s+/gu, ' '), 'utf8')).digest('hex'), reviewedText, locator: 'https://evidence.routing.discoverystack.dev/real-llm' }], createdAt: createdAt.toISOString() })
    expect(typeof result.ok).toBe('boolean')
    if (!result.ok) console.log(`REAL LLM GEO RESULT: validation_failure=${result.reason}`)
    else if (result.value.status === 'draft_ready' || result.value.status === 'review_required') { expect(['bailian', 'openai']).toContain(result.value.providerProvenance.provider); console.log(`REAL LLM GEO RESULT: status=${result.value.status}; provider=${result.value.providerProvenance.provider}`) }
    else console.log(`REAL LLM GEO RESULT: status=${result.value.status}; reason=${'failure' in result.value ? result.value.failure.code : 'none'}`)
  }, 60_000)
})
