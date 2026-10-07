import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'

const localRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(localRequire.resolve('nuxt/package.json'))
const { parse, compileScript } = nuxtRequire('vue/compiler-sfc')
const { createSSRApp, computed, reactive, ref } = nuxtRequire('vue')
const { renderToString } = nuxtRequire('vue/server-renderer')
const componentPath = new URL('../components/owner/LivePublicationActionsPanel.vue', import.meta.url)
const source = readFileSync(componentPath, 'utf8')
const parsed = parse(source, { filename: componentPath.pathname })
if (parsed.errors.length) throw new Error('Live publication actions panel did not parse.')
const compiled = compileScript(parsed.descriptor, { id: 'live-publication-actions-panel-test', inlineTemplate: true, templateOptions: { ssr: true } })
const js = transpileModule(compiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText

async function render() {
  const fetcher = vi.fn(async () => { throw new Error('SSR must not fetch owner action data.') })
  const module = { exports: {} as { default?: unknown } }
  const onMounted = vi.fn()
  new Function('require', 'module', 'exports', 'ref', 'computed', 'reactive', 'onMounted', '$fetch', js)(nuxtRequire, module, module.exports, ref, computed, reactive, onMounted, fetcher)
  const html = await renderToString(createSSRApp(module.exports.default))
  return { html, fetcher, onMounted }
}

describe('owner live publication actions panel contract', () => {
  it('renders a safe client-only loading envelope without server fetch or fake data', async () => {
    const { html, fetcher, onMounted } = await render()
    expect(html).toContain('發布前後證據')
    expect(html).toContain('正在讀取擁有人專屬的安全摘要')
    expect(html).toContain('不代表瀏覽器可見性、搜尋索引或 AI 引用')
    expect(html).not.toContain('核准審查')
    expect(html).not.toContain('fingerprint')
    expect(fetcher).not.toHaveBeenCalled()
    expect(onMounted).toHaveBeenCalledTimes(1)
  })

  it('uses only read and review endpoints with exact acknowledgements, bound current evidence and read-only refresh', () => {
    expect(source).toContain("const endpoint = '/api/interventions/closed-loop/live-actions'")
    expect(source).toContain("readApi<Workspace>(endpoint, { method: 'GET' })")
    expect(source).toContain("mutateApi(`${endpoint}/review`")
    expect(source).toContain('actionId: item.id')
    expect(source).toContain('evidenceFingerprint: review.evidenceFingerprint')
    expect(source).toContain('decision: review.decision')
    expect(source).toContain('piiReviewConfirmed: true')
    expect(source).toContain('rightsConfirmed: true')
    expect(source).toContain('observationalOnlyAcknowledged: true')
    expect(source).toContain('reviewReason: review.reviewReason.trim()')
    expect(source).toContain('function resetReview()')
    expect(source).toContain('resetReview()\n  safeError.value =')
    expect(source).not.toMatch(/reconcile|captureNow|runTraining|publishNow/iu)
    expect(source).not.toContain('{{ item.evidenceFingerprint }}')
    expect(source).not.toMatch(/type="checkbox"[^>]*checked/u)
  })

  it('requires current unexpired observed evidence, three acknowledgements and a bounded reason', () => {
    expect(source).toContain("item.status === 'observed' && item.reviewStatus === 'pending'")
    expect(source).toContain('item.currentEvidenceValid && item.evidenceFingerprint === review.evidenceFingerprint && !isExpired(item)')
    expect(source).toContain('review.piiReviewConfirmed && review.rightsConfirmed && review.observationalOnlyAcknowledged')
    expect(source).toContain('reviewReasonLength.value >= 10 && reviewReasonLength.value <= 500')
    expect(source).toContain('minlength="10" maxlength="500"')
    expect(source.match(/type="checkbox"/gu)).toHaveLength(3)
    expect(source).toContain('重新讀取會清除選取與所有確認')
  })
})
