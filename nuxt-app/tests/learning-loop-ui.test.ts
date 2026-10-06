import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'

// Compile and render the actual page with Nuxt's installed Vue, not a string-only mock UI.
const localRequire = createRequire(import.meta.url), nuxtRequire = createRequire(localRequire.resolve('nuxt/package.json'))
const { parse, compileScript } = nuxtRequire('vue/compiler-sfc')
const { createSSRApp, defineComponent, h, computed, ref, reactive } = nuxtRequire('vue')
const { renderToString } = nuxtRequire('vue/server-renderer')
const path = new URL('../pages/audit-lab/learning-loop.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
if (errors.length) throw new Error('Learning workspace did not parse.')
const compiled = compileScript(descriptor, { id: 'learning-loop-page-render-test', inlineTemplate: true, templateOptions: { ssr: true } })
const js = transpileModule(compiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText

async function render(failure?: { statusCode: number; message: string }, effectFixture?: unknown) {
  const workspace = { configuration: { loopEnabled: false, crawlEnabled: false, retentionEnabled: false, weeklyContentEnabled: false, schedulerEnabled: false }, clients: [], sources: [], authorizations: [], collections: [], limitations: [] }
  const models = { workspace: { inventory: { verifiedPrimaryCount: 0 }, readiness: { development: { ready: false, missing: ['尚缺真實核准觀測'] }, shadow: { ready: false } }, datasets: [], trainingRuns: [], models: [] } }
  const effect = effectFixture || { enabled: false, taskType: 'content_effect_direction', release: null, models: [] }
  const fetcher = vi.fn(async (url: string, options: unknown) => ({ data: ref(url.includes('geo-outcome-model') ? models : url.includes('content-operations') ? { entries: [] } : failure ? undefined : url.endsWith('/effect-models') ? effect : workspace), error: ref(url.includes('closed-loop') ? failure : undefined), pending: ref(false), refresh: vi.fn() }))
  const post = vi.fn(() => { throw new Error('Rendering must not perform mutations.') }), meta = vi.fn(), head = vi.fn()
  const module = { exports: {} as { default?: unknown } }
  new Function('require', 'module', 'exports', 'definePageMeta', 'useHead', 'useFetch', '$fetch', 'computed', 'ref', 'reactive', js)(nuxtRequire, module, module.exports, meta, head, fetcher, post, computed, ref, reactive)
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
    expect(meta).toHaveBeenCalledWith({ layout: 'owner' })
    expect(head.mock.calls[0]?.[0].meta).toContainEqual({ name: 'robots', content: 'noindex,nofollow,noarchive' })
    expect(fetcher).toHaveBeenCalledTimes(4); expect(post).not.toHaveBeenCalled()
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
    const effect = { enabled: true, release: { candidateCount: 180, status: 'ready_for_dataset_review', datasetDigest: 'a'.repeat(64), lineageFingerprint: 'b'.repeat(64) }, models: [{ id: 17, status: 'completed', candidateCount: 180, currentLineageValid: true, artifact: { status: 'verified', temporalHoldout: 'UNAVAILABLE', productionActivation: false, metrics: { test: { brierScore: 0.2 } } } }] }
    const { html, post } = await render(undefined, effect)
    expect(html).toContain('核對並排入下一輪訓練'); expect(html).toContain('成效模型 #17 · 已完成')
    expect(html).toContain('UNAVAILABLE'); expect(html).toContain('brierScore')
    expect(html).not.toMatch(/type="checkbox"[^>]*checked|coefficients|intercept|normalization/)
    expect(post).not.toHaveBeenCalled()
  })
})
