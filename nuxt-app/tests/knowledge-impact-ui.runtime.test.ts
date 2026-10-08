import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const nodeRequire = createRequire(import.meta.url)
const vueRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = vueRequire('vue') as typeof import('vue')
const { createRenderer, nextTick } = vue
const compilerSfcPackage = readdirSync(join(root, 'node_modules/.pnpm')).find(name => name.startsWith('@vue+compiler-sfc@'))
if (!compilerSfcPackage) throw new Error('Installed @vue/compiler-sfc package is required for this local runtime contract.')
const { compileScript, parse } = nodeRequire(join(root, 'node_modules/.pnpm', compilerSfcPackage, 'node_modules/@vue/compiler-sfc'))

type HostNode = {
  type: string
  props: Record<string, unknown>
  children: HostNode[]
  text: string
  parent: HostNode | null
  value: string
  selected: boolean
  listeners: Record<string, (event: { target: HostNode }) => void>
  addEventListener: (name: string, handler: (event: { target: HostNode }) => void) => void
  removeEventListener: (name: string, handler: (event: { target: HostNode }) => void) => void
  readonly options: HostNode[]
}

function hostNode(type: string): HostNode {
  const node = {
    type,
    props: {} as Record<string, unknown>,
    children: [] as HostNode[],
    text: '',
    parent: null as HostNode | null,
    value: '',
    selected: false,
    listeners: {} as Record<string, (event: { target: HostNode }) => void>,
    addEventListener(name: string, handler: (event: { target: HostNode }) => void) { this.listeners[name] = handler },
    removeEventListener(name: string, handler: (event: { target: HostNode }) => void) { if (this.listeners[name] === handler) delete this.listeners[name] },
    get options(): HostNode[] { return this.children.flatMap(child => child.type === 'option' ? [child] : child.options) },
  }
  return node
}

function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))]
}

function textContent(node: HostNode): string {
  return node.text + node.children.map(textContent).join('')
}

function compileComponent(fetcher: (...args: unknown[]) => unknown) {
  const url = new URL('../components/KnowledgeImpactPreview.vue', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const parsed = parse(source, { filename: url.pathname })
  if (!parsed.descriptor.scriptSetup) throw new Error('Impact preview script setup missing')
  const compiled = compileScript(parsed.descriptor, { id: 'knowledge-impact-runtime-test', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} as Record<string, unknown> }
  runInNewContext(javascript, { module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nodeRequire(id), $fetch: fetcher })
  return module.exports.default
}

function mount(component: unknown, props: Record<string, unknown>) {
  const renderer = createRenderer<HostNode, HostNode>({
    createElement: tag => hostNode(tag),
    createText: text => Object.assign(hostNode('#text'), { text }),
    createComment: text => Object.assign(hostNode('#comment'), { text }),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === 'value') node.value = String(value ?? '') },
    insert: (child, parent, anchor) => {
      child.parent = parent
      const at = anchor ? parent.children.indexOf(anchor) : -1
      if (at < 0) parent.children.push(child)
      else parent.children.splice(at, 0, child)
    },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    parentNode: node => node.parent,
    nextSibling: node => { if (!node.parent) return null; const siblings = node.parent.children; return siblings[siblings.indexOf(node) + 1] || null },
  })
  const root = hostNode('root')
  const app = renderer.createApp(component as never, props)
  app.mount(root)
  return { app, root }
}

async function choose(root: HostNode, ariaLabel: string, value: string) {
  const select = all(root, node => node.type === 'select' && node.props['aria-label'] === ariaLabel)[0]
  if (!select) throw new Error(`Missing select ${ariaLabel}`)
  select.value = value
  for (const option of select.options) option.selected = option.value === value
  select.listeners.change?.({ target: select })
  await nextTick()
}

function clickPreview(root: HostNode) {
  const button = all(root, node => node.type === 'button' && textContent(node).includes('唯讀預覽'))[0]
  if (!button || typeof button.props.onClick !== 'function') throw new Error('Missing preview button')
  ;(button.props.onClick as () => void)()
}

const buckets = [
  { category: 'content', state: 'complete', scope: 'explicit', limitationCodes: [], items: [] },
  { category: 'schema', state: 'complete', scope: 'projection inputs', limitationCodes: [], items: [{
    kind: 'schema', id: 'schema:12', version: 'v2', contentHash: null, dependencyFingerprint: 'c'.repeat(64),
    reasonCode: 'projection_inputs_only', lineage: [{ kind: 'entity', id: 1, relation: 'primary_entity', version: null, contentHash: null }],
  }] },
  { category: 'dataset', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_unconfigured'], items: [] },
  { category: 'public_api', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_unconfigured'], items: [] },
  { category: 'benchmark_prompt', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_unconfigured'], items: [] },
  { category: 'reviewer', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_unconfigured'], items: [] },
] as const

function report(kind: 'entity' | 'claim' | 'source' = 'entity', id = 1, overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: 7,
    subject: { kind, id },
    coverageScope: 'known_explicit_dependencies_only',
    exhaustive: false,
    graphFingerprint: 'a'.repeat(64),
    outputFingerprint: 'd'.repeat(64),
    affectedKnowledge: [],
    buckets,
    automaticPublication: false,
    productionActivation: false,
    automaticTrainingAdmission: false,
    ...overrides,
  }
}

const subjects = {
  entities: [{ id: 1, canonicalName: 'Entity One', entityType: 'Organization' }],
  claims: [{ id: 3, statement: 'Claim Three', claimType: 'research findings' }],
  sources: [{ id: 9, title: 'Source Nine', canonicalUrl: 'https://example.test/source' }],
}

describe('knowledge impact preview mounted runtime', () => {
  it('selects listed subjects, performs GET-only preview, and renders six buckets plus source-to-claim lineage', async () => {
    const sourceLineage = [
      { kind: 'source', id: 9, relation: 'evidenced_by', version: null, contentHash: null },
      { kind: 'source_version', id: 90, relation: 'evidence_source_version', version: 1, contentHash: 'e'.repeat(64) },
      { kind: 'claim', id: 30, relation: 'evidence_claim', version: null, contentHash: null },
    ]
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (..._args: unknown[]) => ({ status: 'ok', value: report('source', 9, { affectedKnowledge: sourceLineage }) }))
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '預覽項目類型', 'source')
    await choose(root, '選擇已登錄項目', '9')
    clickPreview(root)
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/knowledge/impact-preview')
    expect(fetcher.mock.calls[0]?.[1]).toEqual({ query: { kind: 'source', id: 9 } })
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('method')
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body')
    const rendered = textContent(root)
    for (const label of ['受影響內容', '受影響結構化資料', '受影響資料集', '受影響公開 API 輸出', '受影響 Benchmark Prompts', '所需審查者']) expect(rendered).toContain(label)
    expect(rendered.match(/尚未接上，無法判定/gu)).toHaveLength(4)
    expect(rendered).toContain('Dependency fingerprint')
    expect(rendered).toContain('primary_entity')
    expect(rendered).toContain('直接關聯的知識紀錄')
    expect(rendered).toContain('來源版本 · #90')
    expect(rendered).toContain('evidence_claim')
    expect(rendered).toContain('不發布、不變更業務狀態')
    app.unmount()
  })

  it.each([
    [401, '需要有效的 owner session'],
    [422, '選取項目無效'],
    [404, '找不到此 owner 項目'],
    [409, '資料或關聯無法完整核對，未截斷結果'],
    [503, '影響快照目前無法安全顯示'],
  ])('maps HTTP %i to static copy without reflecting provider/private error text', async (status, expected) => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (..._args: unknown[]) => { throw Object.assign(new Error('SECRET-ERROR'), { statusCode: status, data: { message: 'PRIVATE BODY' } }) })
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '選擇已登錄項目', '1')
    clickPreview(root)
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(textContent(root)).toContain(expected)
    expect(textContent(root)).not.toContain('SECRET-ERROR')
    expect(textContent(root)).not.toContain('PRIVATE BODY')
    expect(fetcher).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('drops stale responses when kind or ID changes during a pending request', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    const fetcher = vi.fn(() => new Promise<unknown>(resolve => { resolveRequest = resolve }))
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '選擇已登錄項目', '1')
    clickPreview(root)
    await nextTick()
    expect(textContent(root)).toContain('正在讀取影響快照')

    await choose(root, '預覽項目類型', 'source')
    await choose(root, '選擇已登錄項目', '9')
    resolveRequest?.({ status: 'ok', value: report('entity', 1) })
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(textContent(root)).not.toContain('Graph snapshot SHA-256')
    expect(textContent(root)).not.toContain('Dependency fingerprint')
    expect(textContent(root)).not.toContain('SECRET')
    app.unmount()
  })

  it.each([
    ['productionActivation', true],
    ['automaticPublication', true],
    ['automaticTrainingAdmission', true],
  ])('rejects reports that claim %s=%s', async (flag, value) => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (..._args: unknown[]) => ({ status: 'ok', value: report('entity', 1, { [flag]: value }) }))
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '選擇已登錄項目', '1')
    clickPreview(root)
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(textContent(root)).toContain('影響快照目前無法安全顯示')
    expect(textContent(root)).not.toContain('Graph snapshot SHA-256')
    app.unmount()
  })

  it('rejects inconsistent unconfigured buckets and invalid dependency fingerprints', async () => {
    const invalidReports = [
      report('entity', 1, { ownerUserId: 0 }),
      report('entity', 1, { affectedKnowledge: [{ kind: 'source', id: 9, relation: 'evidence_claim', version: null, contentHash: 'not-a-hash' }] }),
      report('entity', 1, { affectedKnowledge: [{ kind: 'unknown', id: 9, relation: 'evidence_claim', version: null, contentHash: null }] }),
      report('entity', 1, { affectedKnowledge: [{ kind: 'claim', id: 0, relation: 'subject', version: null, contentHash: null }] }),
      report('entity', 1, { affectedKnowledge: [{ kind: 'claim', id: 9, relation: 'x'.repeat(81), version: null, contentHash: null }] }),
      report('entity', 1, { affectedKnowledge: Array.from({ length: 10_001 }, (_, index) => ({ kind: 'claim', id: index + 1, relation: 'subject', version: null, contentHash: null })) }),
      report('entity', 1, { buckets: buckets.map((bucket, index) => index === 2 ? { ...bucket, items: [{ kind: 'consumer', id: 'x', version: 'v1', contentHash: null, dependencyFingerprint: 'e'.repeat(64), reasonCode: 'exact_registered_dependency', lineage: [] }] } : bucket) }),
      report('entity', 1, { buckets: buckets.map((bucket, index) => index === 1 ? { ...bucket, items: [{ kind: 'unknown', id: 'x', version: 'v1', contentHash: null, dependencyFingerprint: 'e'.repeat(64), reasonCode: 'exact_registered_dependency', lineage: [] }] } : bucket) }),
      report('entity', 1, { buckets: buckets.map((bucket, index) => index === 1 ? { ...bucket, items: [{ kind: 'schema', id: 'x', version: 'v1', contentHash: null, dependencyFingerprint: 'bad-hash', reasonCode: 'exact_registered_dependency', lineage: [] }] } : bucket) }),
      report('entity', 1, { buckets: buckets.map((bucket, index) => index === 1 ? { ...bucket, items: [{ kind: 'schema', id: 'schema:12', version: 'v2', contentHash: 'b'.repeat(64), dependencyFingerprint: 'e'.repeat(64), reasonCode: 'projection_inputs_only', lineage: [] }] } : bucket) }),
      report('entity', 1, { buckets: buckets.map((bucket, index) => index === 1 ? { ...bucket, items: Array.from({ length: 1_001 }, () => ({ kind: 'schema', id: 'x', version: 'v1', contentHash: null, dependencyFingerprint: 'e'.repeat(64), reasonCode: 'exact_registered_dependency', lineage: [] })) } : bucket) }),
    ]
    for (const invalidReport of invalidReports) {
      const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (..._args: unknown[]) => ({ status: 'ok', value: invalidReport }))
      const { app, root } = mount(compileComponent(fetcher), subjects)
      await choose(root, '選擇已登錄項目', '1')
      clickPreview(root)
      await new Promise(resolve => setTimeout(resolve, 0))
      await nextTick()
      expect(textContent(root)).toContain('影響快照目前無法安全顯示')
      expect(textContent(root)).not.toContain('Dependency fingerprint')
      app.unmount()
    }
  })

  it('invalidates selection and result when owner subject props refresh', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (..._args: unknown[]) => ({ status: 'ok', value: report('entity', 1) }))
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '選擇已登錄項目', '1')
    clickPreview(root)
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    const instance = (app as unknown as { _instance: { props: Record<string, unknown> } })._instance
    instance.props.entities = []
    await nextTick()
    expect(textContent(root)).not.toContain('Graph snapshot SHA-256')
    expect(textContent(root)).toContain('目前沒有可選的已登錄實體')
    app.unmount()
  })
})
