import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { createInMemoryInterventionLoopRepository, getIntervention, registerIntervention } from '../server/intervention-loop'

// Use Nuxt's already-installed Vue/compiler/renderer, not a second Vue version or a new dependency.
const localRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(localRequire.resolve('nuxt/package.json'))
const { parse, compileScript } = nuxtRequire('vue/compiler-sfc')
const { createSSRApp, defineComponent, h } = nuxtRequire('vue')
const { renderToString } = nuxtRequire('vue/server-renderer')
const path = new URL('../components/InterventionEnvelopePanel.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(path, 'utf8'), { filename: path.pathname })
if (errors.length) throw new Error('Evidence panel did not parse.')
const compiled = compileScript(descriptor, { id: 'envelope-render-test', inlineTemplate: true, templateOptions: { ssr: true } })
const js = transpileModule(compiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
const compiledModule = { exports: {} as { default?: unknown } }
new Function('require', 'module', 'exports', js)(nuxtRequire, compiledModule, compiledModule.exports)

async function unknownEnvelope() {
  const dependencies = { repository: createInMemoryInterventionLoopRepository(), baselineProvider: { readInventoryHash: async () => null }, clock: { now: () => new Date('2026-09-21T00:00:00.000Z') } }
  const row = (await registerIntervention(7, { targetUrl: 'https://example.com/empty', changeSummary: '目前尚無量測證據', interventionType: 'content_update', idempotencyKey: 'render-test' }, dependencies)).intervention
  return (await getIntervention(7, row.id, dependencies)).envelope
}

async function render(envelope: Awaited<ReturnType<typeof unknownEnvelope>>) {
  const app = createSSRApp(compiledModule.exports.default, { envelope })
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props: { to: string }, { slots }: { slots: { default?: () => unknown } }) => () => h('a', { href: props.to }, slots.default?.()) }))
  return renderToString(app)
}

describe('actual compiled evidence panel rendering', () => {
  it('renders all four evidence cards, unknown data, and a closed training gate', async () => {
    const html = await render(await unknownEnvelope())
    for (const label of ['改之前', '做了什麼', '改之後', '可信程度', '尚無量測資料', '目前不能', '尚未綁定有效的學習同意', '不產生推測的置信百分比']) expect(html).toContain(label)
    expect(html).toContain('未知／未知')
    expect(html).not.toMatch(/0%|100%|保證|production_active/)
    expect(html).toContain('href="/audit-lab/geo-outcome-model"')
  })
  it('keeps a genuine zero sample distinct from missing evidence and preserves the causal limitation', async () => {
    const envelope = await unknownEnvelope()
    envelope.confidence.sampleSize.before = 0
    const html = await render(envelope)
    expect(html).toContain('0／未知')
    expect(html).toContain('只能視為相關，不能視為因果')
    expect(html).toContain('aria-label="機器學習資料守門"')
    expect(html).toContain('aria-label="改動前後與學習資料檢查"')
  })
})
