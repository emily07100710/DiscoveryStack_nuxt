import { createHash } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import { managedSiteStableFingerprint } from '../server/managed-sites/live-connectors/canonical'
import { createDeterministicManagedSiteBlueprint } from '../server/managed-sites/live-connectors/adapters'
import type { ManagedSiteGenerationAdapter, ManagedSiteGenerationRequest } from '../server/managed-sites/live-connectors/types'
import { generateFunnelPreviewDraft } from '../server/managed-sites/funnel/preview-draft-service'
import { createFunnelSession, loadFunnelSession, recordFunnelSiteAnalysis, saveFunnelStep, type FunnelAnswers } from '../server/managed-sites/funnel/session-service'
import { setManagedSiteFunnelRepositoryForTests } from '../server/managed-sites/funnel/session-repository'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

const now = new Date('2026-09-03T03:00:00.000Z')
const llmEnvironment = ['NUXT_LLM_ENDPOINT', 'NUXT_LLM_API_KEY', 'NUXT_LLM_MODEL'] as const
const savedEnvironment = Object.fromEntries(llmEnvironment.map(key => [key, process.env[key]])) as Record<typeof llmEnvironment[number], string | undefined>

beforeAll(() => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
  ;(globalThis as any).useRuntimeConfig = () => ({})
})

afterEach(() => {
  setManagedSiteFunnelRepositoryForTests(null)
  for (const key of llmEnvironment) {
    if (savedEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnvironment[key]
  }
  delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
})

function answers(brandName = '預覽品牌', existingSite: FunnelAnswers['existingSite'] = { hasSite: false }): FunnelAnswers {
  return {
    existingSite,
    company: { brandName, whatWeDo: '提供品牌策略與網站內容服務。', feelings: ['專業', '清楚'], mainOffer: '品牌策略顧問', conversionGoals: ['increase_inquiries'] },
    contact: { email: 'preview@example.test', contactName: '預覽聯絡人' },
    style: { referenceUrls: [], stylePreset: 'business', designTier: 'template' },
    siteType: 'brand_blog',
    modules: ['managed_content_admin'],
  }
}

async function sessionWithAnswers(input = answers()) {
  const memory = createFunnelSessionMemoryRepository()
  const created = await createFunnelSession(memory.repository, () => now)
  await saveFunnelStep(created.sessionId, created.sessionToken, { step: 5, answers: input }, memory.repository, () => now)
  return { memory, created, session: await loadFunnelSession(created.sessionId, created.sessionToken, memory.repository, () => now) }
}

function configuredAdapter(mutate?: (blueprint: ReturnType<typeof createDeterministicManagedSiteBlueprint>) => void): ManagedSiteGenerationAdapter {
  return {
    async generate(request) {
      const blueprint = createDeterministicManagedSiteBlueprint(request)
      mutate?.(blueprint)
      return { schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey: 'preview-test-llm', providerModel: 'test-model', providerRequestId: 'preview-test-request', requestFingerprint: request.requestFingerprint, blueprint, blueprintHash: managedSiteStableFingerprint(blueprint) }
    },
  }
}

const configuredProvider = { configured: true as const, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'test-model', apiKey: 'test-key', providerLabel: 'openai' as const, source: 'llm' as const }
const unconfiguredProvider = { configured: false as const, reason: 'endpoint-missing' as const }

function previewCopy(skeleton: ReturnType<typeof createDeterministicManagedSiteBlueprint>): { schemaVersion: string; navigation: unknown[]; pages: unknown[]; sections: unknown[]; faq: unknown[]; summaryAnswer: string } {
  return {
    schemaVersion: 'managed-site-preview-copy-v1',
    navigation: [],
    pages: [],
    sections: [],
    faq: [],
    summaryAnswer: skeleton.seoGeo.summaryAnswer,
  }
}

function copyFetch(content: string) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { status: 200 }))
}

async function requestForPreview(session: Awaited<ReturnType<typeof sessionWithAnswers>>['session']): Promise<ManagedSiteGenerationRequest> {
  let captured: ManagedSiteGenerationRequest | undefined
  await generateFunnelPreviewDraft(session, {
    providerConfiguration: configuredProvider,
    generationAdapter: {
      async generate(request) {
        captured = request
        const blueprint = createDeterministicManagedSiteBlueprint(request)
        return { schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey: 'preview-test-request-capture', providerModel: 'test-model', providerRequestId: 'preview-test-request', requestFingerprint: request.requestFingerprint, blueprint, blueprintHash: managedSiteStableFingerprint(blueprint) }
      },
    },
    clock: () => now,
  })
  if (!captured) throw new Error('Preview request was not captured.')
  return captured
}

async function routeRequest(repository: ReturnType<typeof createFunnelSessionMemoryRepository>['repository'], path: string, token: string) {
  setManagedSiteFunnelRepositoryForTests(repository)
  process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://funnel.test'
  const handler = (await import('../server/api/managed-sites/funnel/[...path]')).default
  const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, (error as any).statusCode || 500, (error as any).statusMessage); await send(event, JSON.stringify({ statusCode: (error as any).statusCode || 500 }), 'application/json') } })
  const router = createRouter(); router.use('/api/managed-sites/funnel/**', handler); app.use(router)
  return toWebHandler(app)(new Request(`https://funnel.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://funnel.test', 'x-managed-site-funnel-token': token }, body: '{}' }))
}

describe('managed-site funnel preview drafts', () => {
  it('uses a deterministic template when the LLM provider is not configured', async () => {
    const line = await sessionWithAnswers()
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: unconfiguredProvider, clock: () => now })
    expect(draft.source).toBe('template')
    expect(draft.sourceReason).toBe('AI 產生器尚未設定，改用樣板草稿。')
    expect(draft.html).toContain('<!doctype html>')
  })

  it('uses a configured LLM adapter and renders its approved blueprint', async () => {
    const line = await sessionWithAnswers()
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: configuredProvider, generationAdapter: configuredAdapter(blueprint => { blueprint.pages[0]!.title = 'LLM 專屬首頁' }), clock: () => now })
    expect(draft.source).toBe('llm')
    expect(draft.html).toContain('LLM 專屬首頁')
  })

  it('uses copy-only LLM output while retaining the deterministic first-party blueprint contract', async () => {
    const line = await sessionWithAnswers()
    const request = await requestForPreview(line.session)
    const skeleton = createDeterministicManagedSiteBlueprint(request)
    const hero = skeleton.pages[0]!.sections.find(section => section.kind !== 'module_slot' && section.kind !== 'contact_form')!
    const copy = previewCopy(skeleton)
    copy.navigation = [{ route: '/', label: '首頁導覽' }]
    copy.pages = [{ pageKey: 'home', title: '模型首頁', description: '由模型撰寫的首頁描述。' }]
    copy.sections = [{ sectionId: hero.sectionId, heading: '模型主標題', body: '由模型撰寫、供訪客理解品牌價值的繁體中文內容。' }]
    copy.faq = [{ question: '如何開始合作？', answer: '請透過聯絡頁留下需求，我們會安排下一步。' }]
    copy.summaryAnswer = '模型撰寫的精簡品牌摘要。'
    const content = JSON.stringify(copy)
    const fetchImpl = copyFetch(content)

    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: configuredProvider, fetchImpl, clock: () => now })
    const expected = structuredClone(skeleton)
    expected.navigation[0]!.label = '首頁導覽'
    expected.pages[0]!.title = '模型首頁'
    expected.pages[0]!.description = '由模型撰寫的首頁描述。'
    expected.pages[0]!.sections.find(section => section.sectionId === hero.sectionId)!.heading = '模型主標題'
    expected.pages[0]!.sections.find(section => section.sectionId === hero.sectionId)!.body = '由模型撰寫、供訪客理解品牌價值的繁體中文內容。'
    expected.faq = [{ question: '如何開始合作？', answer: '請透過聯絡頁留下需求，我們會安排下一步。' }]
    expected.seoGeo.summaryAnswer = '模型撰寫的精簡品牌摘要。'
    expected.provenance.providerContentHash = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')

    expect(draft.source).toBe('llm')
    expect(draft.headline).toBe('模型首頁')
    expect(draft.sections).toContainEqual({ heading: '模型主標題', body: '由模型撰寫、供訪客理解品牌價值的繁體中文內容。' })
    expect(draft.blueprintHash).toBe(managedSiteStableFingerprint(expected))
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body.enable_thinking).toBe(false)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(Object.keys(JSON.parse(body.messages[1].content)).sort()).toEqual(['audience', 'brandName', 'brief', 'businessGoals', 'copySlots', 'hasFaqPage', 'locale', 'siteType'])
  })

  it('ignores model copy for module slots and contact forms', async () => {
    const line = await sessionWithAnswers({ ...answers(), modules: ['managed_content_admin', 'contact_lead_capture'] })
    const request = await requestForPreview(line.session)
    const skeleton = createDeterministicManagedSiteBlueprint(request)
    const protectedSections = skeleton.pages.flatMap(page => page.sections).filter(section => section.kind === 'module_slot' || section.kind === 'contact_form')
    expect(protectedSections.map(section => section.kind).sort()).toEqual(['contact_form', 'module_slot'])
    const copy = previewCopy(skeleton)
    copy.sections = protectedSections.map(section => ({ sectionId: section.sectionId, heading: '模型不應覆寫', body: '模型不應覆寫的受保護區塊。' }))
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: configuredProvider, fetchImpl: copyFetch(JSON.stringify(copy)), clock: () => now })

    expect(draft.source).toBe('llm')
    expect(draft.sections).not.toContainEqual({ heading: '模型不應覆寫', body: '模型不應覆寫的受保護區塊。' })
  })

  it('ignores unknown, wrong-typed, and oversized copy fields without losing the LLM preview', async () => {
    const line = await sessionWithAnswers()
    const request = await requestForPreview(line.session)
    const skeleton = createDeterministicManagedSiteBlueprint(request)
    const hero = skeleton.pages[0]!.sections[0]!
    const copy = previewCopy(skeleton)
    copy.navigation = [{ route: '/unknown', label: '未知路由' }, { route: '/', label: 42 }]
    copy.pages = [{ pageKey: 'unknown', title: '未知頁面', description: '忽略' }, { pageKey: 'home', title: 42, description: 'x'.repeat(501) }]
    copy.sections = [{ sectionId: 'unknown-section', heading: '未知區塊', body: '忽略' }, { sectionId: hero.sectionId, heading: 42, body: 'x'.repeat(8_001) }]
    copy.faq = [{ question: 42, answer: '錯誤型別' }]
    copy.summaryAnswer = '保留這個有效摘要。'
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: configuredProvider, fetchImpl: copyFetch(JSON.stringify(copy)), clock: () => now })

    expect(draft.source).toBe('llm')
    expect(draft.headline).toBe(skeleton.pages[0]!.title)
    expect(draft.sections).toContainEqual({ heading: hero.heading, body: hero.body })
    expect(draft.html).not.toContain('未知區塊')
  })

  it('falls back with the safety reason when model copy contains active content', async () => {
    const line = await sessionWithAnswers()
    const request = await requestForPreview(line.session)
    const skeleton = createDeterministicManagedSiteBlueprint(request)
    const copy = previewCopy(skeleton)
    copy.sections = [{ sectionId: skeleton.pages[0]!.sections[0]!.sectionId, heading: '<script>alert(1)</script>', body: '正常內容' }]
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: configuredProvider, fetchImpl: copyFetch(JSON.stringify(copy)), clock: () => now })

    expect(draft.source).toBe('template')
    expect(draft.sourceReason).toBe('AI 產生器輸出未通過安全檢查，先顯示樣板草稿。')
    expect(draft.html.toLowerCase()).not.toContain('<script')
  })

  it('falls back cleanly when the provider returns malformed copy JSON', async () => {
    const line = await sessionWithAnswers()
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: configuredProvider, fetchImpl: copyFetch('{not json'), clock: () => now })

    expect(draft.source).toBe('template')
    expect(draft.sourceReason).toBe('AI 產生器回傳的草稿格式無法使用，先顯示樣板草稿。')
  })

  it.each([
    ['provider throw', async () => { throw new Error('offline') }],
    ['timeout', async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }) }],
    ['malformed output', async (request: any) => ({ schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey: 'preview-test-llm', providerModel: 'test-model', providerRequestId: 'preview-test-request', requestFingerprint: request.requestFingerprint, blueprint: {}, blueprintHash: 'not-a-hash' })],
  ])('falls back without rejecting when the LLM has %s', async (_label, generate) => {
    const line = await sessionWithAnswers()
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: configuredProvider, generationAdapter: { generate } as unknown as ManagedSiteGenerationAdapter, clock: () => now })
    expect(draft.source).toBe('template')
    expect(draft.sourceReason).toContain('樣板草稿')
    expect(draft.html).toContain('<!doctype html>')
  })

  it('turns a throwing deterministic template builder into a controlled 503', async () => {
    const line = await sessionWithAnswers()
    await expect(generateFunnelPreviewDraft(line.session, {
      providerConfiguration: unconfiguredProvider,
      templateBuilder: () => { throw new Error('template exploded') },
      clock: () => now,
    })).rejects.toMatchObject({ statusCode: 503, statusMessage: '預覽暫時無法產生，請稍後再試。' })
  })

  it('escapes customer text and never returns an active script', async () => {
    const line = await sessionWithAnswers(answers('</h1><script>alert(1)</script>'))
    const draft = await generateFunnelPreviewDraft(line.session, { providerConfiguration: unconfiguredProvider, clock: () => now })
    expect(draft.html.toLowerCase()).not.toContain('<script')
    expect(draft.html).toContain('&lt;/h1&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('shows a comparison only for a stored existing-site snapshot', async () => {
    const withoutBefore = await sessionWithAnswers()
    await expect(generateFunnelPreviewDraft(withoutBefore.session, { providerConfiguration: unconfiguredProvider, clock: () => now })).resolves.toMatchObject({ comparison: null })
    const snapshot = { analysedAt: '2026-09-02T00:00:00.000Z', analysisVersion: 'public-site-analysis-v1', snapshotFingerprint: 'a'.repeat(64), scores: { overall: 10, seo: 20, geo: 30, brandContent: 40, ux: 50 } }
    const withBefore = await sessionWithAnswers(answers('有比較的品牌', { hasSite: true, url: 'https://before.example.test/' }))
    await recordFunnelSiteAnalysis(withBefore.created.sessionId, withBefore.created.sessionToken, { url: 'https://before.example.test/', snapshot }, withBefore.memory.repository, () => now)
    const analysed = await loadFunnelSession(withBefore.created.sessionId, withBefore.created.sessionToken, withBefore.memory.repository, () => now)
    const draft = await generateFunnelPreviewDraft(analysed, { providerConfiguration: unconfiguredProvider, clock: () => now })
    expect(draft.comparison?.deltas).toEqual({ overall: draft.scores.overall - 10, seo: draft.scores.seo - 20, geo: draft.scores.geo - 30, brandContent: draft.scores.brandContent - 40, ux: draft.scores.ux - 50 })
  })

  it('does not create a project, version, release, deployment, or vault record', async () => {
    const line = await sessionWithAnswers()
    const managed = createManagedSiteMemoryRepository()
    const live = createLiveConnectorMemoryRepository()
    await generateFunnelPreviewDraft(line.session, { providerConfiguration: unconfiguredProvider, clock: () => now })
    expect(managed.state.projects).toHaveLength(0)
    expect(live.state.releases).toHaveLength(0)
    expect(live.state.candidates).toHaveLength(0)
  })

  it('replays the fifth draft on the sixth request and persists only its summary', async () => {
    for (const key of llmEnvironment) delete process.env[key]
    const line = await sessionWithAnswers()
    const path = `/api/managed-sites/funnel/sessions/${line.created.sessionId}/preview-draft`
    let fifth: any
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await routeRequest(line.memory.repository, path, line.created.sessionToken)
      expect(response.status).toBe(200)
      fifth = await response.json()
    }
    const sixth = await routeRequest(line.memory.repository, path, line.created.sessionToken)
    expect(sixth.status).toBe(200)
    expect(await sixth.json()).toEqual(fifth)
    const restored = await loadFunnelSession(line.created.sessionId, line.created.sessionToken, line.memory.repository, () => now)
    expect((restored.answers as FunnelAnswers).previewDraft).toEqual({ generatedAt: fifth.generatedAt, source: fifth.source, headline: fifth.headline, sections: fifth.sections })
    expect(JSON.stringify(restored.answers)).not.toContain(fifth.html)
  })
})
