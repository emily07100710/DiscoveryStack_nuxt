import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'

// Compile and render the actual page with Nuxt's installed Vue, not a string-only mock UI.
const localRequire = createRequire(import.meta.url), nuxtRequire = createRequire(localRequire.resolve('nuxt/package.json'))
const { parse, compileScript } = nuxtRequire('vue/compiler-sfc')
const { createSSRApp, defineComponent, h, computed, ref, reactive, watch } = nuxtRequire('vue')
const { renderToString } = nuxtRequire('vue/server-renderer')
const path = new URL('../pages/audit-lab/learning-loop.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
if (errors.length) throw new Error('Learning workspace did not parse.')
const compiled = compileScript(descriptor, { id: 'learning-loop-page-render-test', inlineTemplate: true, templateOptions: { ssr: true } })
const js = transpileModule(compiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
const panelPath = new URL('../components/owner/LivePublicationActionsPanel.vue', import.meta.url)
const panel = parse(readFileSync(panelPath, 'utf8'), { filename: panelPath.pathname })
if (panel.errors.length) throw new Error('Live publication actions panel did not parse.')
const panelCompiled = compileScript(panel.descriptor, { id: 'learning-loop-action-panel-render-test', inlineTemplate: true, templateOptions: { ssr: true } })
const panelJs = transpileModule(panelCompiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
const admissionPath = new URL('../components/OwnerSiteLearningAdmission.vue', import.meta.url)
const admission = parse(readFileSync(admissionPath, 'utf8'), { filename: admissionPath.pathname })
if (admission.errors.length) throw new Error('Owner site-learning admission component did not parse.')
const admissionCompiled = compileScript(admission.descriptor, { id: 'learning-loop-site-admission-render-test', inlineTemplate: true, templateOptions: { ssr: true } })
const admissionJs = transpileModule(admissionCompiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText

async function render(failure?: { statusCode: number; message: string }, effectFixture?: unknown, modelFixture?: unknown) {
  const workspace = { configuration: { loopEnabled: false, crawlEnabled: false, retentionEnabled: false, weeklyContentEnabled: false, schedulerEnabled: false }, clients: [], sources: [], authorizations: [], collections: [], limitations: [] }
  const siteLearningWorkspace = {
    entries: [{ entryId: 81, targetRowId: 91, clientId: 71, label: '合成網站目標 91', confirmationFingerprint: 'a'.repeat(64), grant: null,
      authorizations: [{ id: 101, fingerprint: 'b'.repeat(64), consentVersion: 'synthetic-consent-v1', expiresAt: '2027-01-01T00:00:00.000Z' }] }],
    outcomes: [],
    release: { state: 'not_generated', status: 'gate_blocked', eligibleCandidateCount: 0, blockedOutcomeCount: 0, modelTrainingAllowed: false, citationTrainingEligible: false, limitations: ['synthetic_fixture_only'] },
  }
  const models = modelFixture || { workspace: { inventory: { verifiedPrimaryCount: 0 }, readiness: { development: { ready: false, missing: ['尚缺真實核准觀測'] }, shadow: { ready: false } }, datasets: [], trainingRuns: [], models: [] } }
  const effect = effectFixture || { enabled: false, taskType: 'content_effect_direction', release: null, models: [] }
  const fetcher = vi.fn(async (url: string, options: unknown) => ({ data: ref(url.includes('/site-learning/workspace') ? siteLearningWorkspace : url.includes('geo-outcome-model') ? models : url.includes('content-operations') ? { entries: [] } : failure ? undefined : url.endsWith('/effect-models') ? effect : workspace), error: ref(url.includes('closed-loop') ? failure : undefined), pending: ref(false), refresh: vi.fn() }))
  const post = vi.fn(() => { throw new Error('Rendering must not perform mutations.') }), meta = vi.fn(), head = vi.fn()
  const panelModule = { exports: {} as { default?: unknown } }
  new Function('require', 'module', 'exports', 'ref', 'computed', 'reactive', 'onMounted', '$fetch', panelJs)(nuxtRequire, panelModule, panelModule.exports, ref, computed, reactive, vi.fn(), post)
  const admissionModule = { exports: {} as { default?: unknown } }
  new Function('require', 'module', 'exports', admissionJs)(nuxtRequire, admissionModule, admissionModule.exports)
  const requirePage = (id: string) => id === '~/components/owner/LivePublicationActionsPanel.vue' ? panelModule.exports : id === '~/components/OwnerSiteLearningAdmission.vue' ? admissionModule.exports : nuxtRequire(id)
  const module = { exports: {} as { default?: unknown } }
  new Function('require', 'module', 'exports', 'definePageMeta', 'useHead', 'useFetch', '$fetch', 'computed', 'ref', 'reactive', 'watch', js)(requirePage, module, module.exports, meta, head, fetcher, post, computed, ref, reactive, watch)
  const app = createSSRApp(module.exports.default)
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props: { to: string }, { slots }: { slots: { default?: () => unknown } }) => () => h('a', { href: props.to }, slots.default?.()) }))
  return { html: await renderToString(app), fetcher, post, meta, head }
}

describe('compiled owner learning workspace', () => {
  it('renders the real stages, honest empty gates, and unchecked learning consent', async () => {
    const { html, fetcher, post, meta, head } = await render()
    for (const text of ['資料授權', '蒐集與檢視', '訓練與驗證', 'LINE 確認', '成效回收', '目前草稿的模型建議', '尚未蒐集資料', '尚缺真實核准觀測', '這不是市場排名', '兩件事', '尚未開通', '真正進入下一輪訓練', '不會被當成負例', '沒有完整 live 改動前後']) expect(html).toContain(text)
    expect(html).toContain('href="/audit-lab/weekly-content"')
    expect(html).toContain('href="/api/interventions/closed-loop/outcome-release"')
    expect(html).not.toMatch(/type="checkbox"[^>]*checked|>保證排名<|已訓練成功/)
    expect(html).toContain('不保證排名或收入')
    expect(html).toContain('發布前後證據')
    expect(html).toContain('另納入已獨立審查的實際改動（新版模型）')
    expect(html).toContain('網站成效資料准入')
    expect(html).toContain('擁有人申明已有客戶模型用途同意證明，不是代客戶同意')
    expect(html).toContain('確認此網站版本接入成效資料')
    expect(meta).toHaveBeenCalledWith({ layout: 'owner' })
    expect(head.mock.calls[0]?.[0].meta).toContainEqual({ name: 'robots', content: 'noindex,nofollow,noarchive' })
    expect(fetcher).toHaveBeenCalledTimes(5); expect(post).not.toHaveBeenCalled()
  })
  it.each([401, 503])('does not show usable fake operations when workspace returns %s', async statusCode => {
    const { html, post } = await render({ statusCode, message: 'Synthetic unavailable fixture.' })
    expect(html).toContain(statusCode === 401 ? '請先登入管理者帳號' : '工作台尚未就緒')
    expect(html).toContain('不會載入假的客戶、同意或模型')
    expect(html).not.toContain('記錄這份授權')
    expect(html).not.toContain('產出目前草稿的模型建議')
    expect(post).not.toHaveBeenCalled()
  })
  it('renders real review gates and safe completed-model summaries without granting approval or exposing weights', async () => {
    const effect = { enabled: true, release: { candidateCount: 180, status: 'ready_for_dataset_review', datasetDigest: 'a'.repeat(64), lineageFingerprint: 'b'.repeat(64) }, models: [{ id: 17, status: 'completed', candidateCount: 180, currentLineageValid: true, artifact: { status: 'verified', temporalHoldout: { status: 'AVAILABLE', trainingAsOf: '2026-10-06T00:00:00.000Z' }, productionActivation: false, metrics: { test: { brierScore: 0.2 } } } }] }
    const { html, post } = await render(undefined, effect)
    expect(html).toContain('核對並排入下一輪訓練'); expect(html).toContain('成效模型 #17 · 已完成')
    expect(html).toContain('AVAILABLE'); expect(html).toContain('brierScore')
    expect(html).not.toMatch(/type="checkbox"[^>]*checked|coefficients|intercept|normalization/)
    expect(post).not.toHaveBeenCalled()
  })
  it('separates fallback review from candidate advice and leaves independent review unchecked', async () => {
    const fixture = { workspace: { inventory: { verifiedPrimaryCount: 1000 }, readiness: { development: { ready: true, missing: [] }, shadow: { ready: true } }, datasets: [], trainingRuns: [], models: [
      { artifactId: 'geo-model-fallback', status: 'approved_for_shadow', fallbackOnly: true, modelFamily: 'regularized_logistic_baseline_v1', trainingRowCount: 200, metrics: {} },
      { artifactId: 'geo-model-review', status: 'ready_for_owner_review', fallbackOnly: true, modelFamily: 'regularized_logistic_baseline_v1', trainingRowCount: 200, metrics: {} },
      { artifactId: 'geo-model-candidate', status: 'approved_for_shadow', fallbackOnly: false, modelFamily: 'regularized_logistic_baseline_v1', trainingRowCount: 200, metrics: {} },
    ] } }
    const { html, post } = await render(undefined, undefined, fixture)
    expect(html).toContain('第一個模型，也要有安全的回退基準')
    expect(html).toContain('獨立核准這份回退基準')
    expect(html).toContain('value="geo-model-candidate"')
    expect(html).not.toContain('value="geo-model-fallback"')
    expect(html).not.toContain('value="geo-model-review"')
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/)
    expect(post).not.toHaveBeenCalled()
  })
})
