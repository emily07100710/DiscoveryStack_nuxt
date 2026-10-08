import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const appRoot = new URL('../', import.meta.url).pathname
const nodeRequire = createRequire(import.meta.url)
const vueRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = vueRequire('vue') as typeof import('vue')
const { createRenderer, nextTick } = vue
const compilerSfcPackage = readdirSync(join(appRoot, 'node_modules/.pnpm')).find(name => name.startsWith('@vue+compiler-sfc@'))
if (!compilerSfcPackage) throw new Error('Installed @vue/compiler-sfc package is required for this local runtime contract.')
const { compileScript, parse } = nodeRequire(join(appRoot, 'node_modules/.pnpm', compilerSfcPackage, 'node_modules/@vue/compiler-sfc'))

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

type HistoryQuery = { kind: 'entity' | 'claim' | 'source', id: number, cursor?: string }
type FetchOptions = { query: HistoryQuery }

function hostNode(type: string): HostNode {
  return {
    type, props: {}, children: [], text: '', parent: null, value: '', selected: false, listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler },
    removeEventListener(name, handler) { if (this.listeners[name] === handler) delete this.listeners[name] },
    get options() { return this.children.flatMap(child => child.type === 'option' ? [child] : child.options) },
  }
}

function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))]
}

function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }

function compileComponent(fetcher: (...args: unknown[]) => Promise<unknown>) {
  const url = new URL('../components/KnowledgeRevisionHistory.vue', import.meta.url)
  const parsed = parse(readFileSync(url, 'utf8'), { filename: url.pathname })
  if (!parsed.descriptor.scriptSetup) throw new Error('Knowledge revision history script setup missing')
  const compiled = compileScript(parsed.descriptor, { id: 'knowledge-revision-history-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} as Record<string, unknown> }
  runInNewContext(javascript, { module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nodeRequire(id), $fetch: fetcher })
  return module.exports.default
}

function mount(component: unknown, props: Record<string, unknown>) {
  const renderer = createRenderer<HostNode, HostNode>({
    createElement: tag => hostNode(tag), createText: text => Object.assign(hostNode('#text'), { text }),
    createComment: text => Object.assign(hostNode('#comment'), { text }), setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === 'value') node.value = String(value ?? '') },
    insert: (child, parent, anchor) => { child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; at < 0 ? parent.children.push(child) : parent.children.splice(at, 0, child) },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    parentNode: node => node.parent, nextSibling: node => { if (!node.parent) return null; const siblings = node.parent.children; return siblings[siblings.indexOf(node) + 1] || null },
  })
  const root = hostNode('root')
  const app = renderer.createApp(component as never, props)
  app.mount(root)
  return { app, root }
}

async function choose(root: HostNode, label: string, value: string) {
  const control = all(root, node => node.type === 'select' && node.props['aria-label'] === label)[0]
  if (!control) throw new Error(`Missing select ${label}`)
  control.value = value
  for (const option of control.options) option.selected = option.value === value
  control.listeners.change?.({ target: control })
  const onChange = control.props.onChange
  if (typeof onChange === 'function') (onChange as (event: { target: HostNode }) => void)({ target: control })
  await nextTick()
}

function button(root: HostNode, label: string) {
  const found = all(root, node => node.type === 'button' && textContent(node).includes(label))[0]
  if (!found || typeof found.props.onClick !== 'function') throw new Error(`Missing button ${label}`)
  return found
}

async function settle() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }

function revision(revisionId: number, revisionNumber = revisionId, revisionKind: 'mutation' | 'legacy_baseline' = 'mutation') {
  const fingerprint = (revisionNumber: number) => revisionNumber.toString(16).padStart(64, '0')
  return {
    revisionId, revisionNumber, revisionKind, contentHash: 'a'.repeat(64),
    previousRevisionFingerprint: revisionNumber === 1 ? null : fingerprint(revisionNumber - 1),
    revisionFingerprint: fingerprint(revisionNumber), eventFingerprint: 'd'.repeat(64),
    operations: revisionKind === 'legacy_baseline' ? ['legacy_baseline'] : ['updateEntity'],
    occurredAt: `2026-10-08T02:${String(revisionId % 60).padStart(2, '0')}:00.000Z`,
  }
}

function history(kind: HistoryQuery['kind'], id: number, items: unknown[], nextCursor: string | null = null, overrides: Record<string, unknown> = {}) {
  return {
    subject: { kind, id }, items, nextCursor, historyScope: 'recorded_mutations_only', rawSnapshotIncluded: false,
    automaticPublication: false, productionActivation: false, automaticTrainingAdmission: false, ...overrides,
  }
}

const subjects = {
  entities: [{ id: 1, canonicalName: 'Entity One', entityType: 'Organization' }],
  claims: [{ id: 3, statement: 'Claim Three', claimType: 'research findings' }],
  sources: [{ id: 9, title: 'Source Nine', canonicalUrl: 'https://example.test/source' }],
}

describe('knowledge revision history mounted runtime', () => {
  it('selects only listed entity, claim, or source and uses a GET request with the selected subject', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const options = args[1] as FetchOptions
      return { status: 'success', history: history(options.query.kind, options.query.id, [revision(1)]) }
    })
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '歷史紀錄類型', 'claim')
    expect(textContent(root)).toContain('Claim Three')
    await choose(root, '選擇歷史 subject', '3')
    ;(button(root, '讀取歷史').props.onClick as () => void)()
    await settle()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/knowledge/revision-history')
    expect(fetcher.mock.calls[0]?.[1]).toEqual({ query: { kind: 'claim', id: 3 } })
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('method')
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body')
    expect(textContent(root)).toContain('Revision #1')
    expect(textContent(root)).toContain('Mutation event fingerprint')
    expect(textContent(root)).toContain('不會審批、發布或訓練')
    app.unmount()
  })

  it('paginates in bounded pages, appends using only the opaque server cursor, and renders legacy baseline distinctly', async () => {
    const firstPage = Array.from({ length: 25 }, (_, index) => revision(27 - index))
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const query = (args[1] as FetchOptions).query
      return query.cursor
        ? { status: 'success', history: history(query.kind, query.id, [revision(2), revision(1, 1, 'legacy_baseline')]) }
        : { status: 'success', history: history(query.kind, query.id, firstPage, 'opaque-next-page') }
    })
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '選擇歷史 subject', '1')
    ;(button(root, '讀取歷史').props.onClick as () => void)(); await settle()
    expect(all(root, node => node.type === 'li' && textContent(node).includes('Revision #'))).toHaveLength(25)
    ;(button(root, '載入更早的 25 筆').props.onClick as () => void)(); await settle()
    const calls = fetcher.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1]?.[1]).toEqual({ query: { kind: 'entity', id: 1, cursor: 'opaque-next-page' } })
    expect(all(root, node => node.type === 'li' && textContent(node).includes('Revision #'))).toHaveLength(27)
    expect(textContent(root)).toContain('Legacy baseline · 不是原始舊歷史事件')
    expect(textContent(root)).toContain('舊資料基線')
    app.unmount()
  })

  it('rejects DTOs containing raw snapshot fields or inconsistent safety flags without rendering history', async () => {
    const invalid = [
      history('entity', 1, [revision(1)], null, { canonicalSnapshot: '{"private":"secret"}' }),
      history('entity', 1, [revision(1)], null, { rawSnapshotIncluded: true }),
      history('entity', 1, [{ ...revision(1), rawSnapshot: 'PRIVATE SNAPSHOT' }]),
      history('entity', 1, [revision(1)], null, { automaticTrainingAdmission: true }),
      history('entity', 1, Array.from({ length: 26 }, (_, index) => revision(index + 1))),
      history('entity', 1, [], 'cursor-without-items'),
      history('entity', 1, [revision(3), revision(1)]),
      history('entity', 1, [revision(1), revision(2)]),
      history('entity', 1, Array.from({ length: 25 }, (_, index) => revision(27 - index)), 'c'.repeat(1025)),
      history('entity', 1, [revision(99)]),
    ]
    for (const [invalidIndex, value] of invalid.entries()) {
      const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: 'success', history: value }))
      const { app, root } = mount(compileComponent(fetcher), subjects)
      await choose(root, '選擇歷史 subject', '1')
      ;(button(root, '讀取歷史').props.onClick as () => void)(); await settle()
      expect(textContent(root), `invalid DTO fixture ${invalidIndex}`).toContain('知識歷史目前無法安全載入')
      expect(textContent(root)).not.toContain('PRIVATE SNAPSHOT')
      expect(textContent(root)).not.toContain('Revision #1')
      app.unmount()
    }
  })

  it.each([
    [401, '需要有效的 owner session'], [403, '需要有效的 owner session'], [404, '找不到此 owner 項目'],
    [409, '歷史游標或資料狀態無法完整核對'], [422, '查詢無效'], [503, '知識歷史目前無法安全載入'],
  ])('maps HTTP %i to static non-reflective copy', async (status, expected) => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => { throw Object.assign(new Error('DATABASE SECRET'), { statusCode: status, data: { message: 'PRIVATE SNAPSHOT CONTENT' } }) })
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '歷史紀錄類型', 'source')
    await choose(root, '選擇歷史 subject', '9')
    ;(button(root, '讀取歷史').props.onClick as () => void)(); await settle()
    expect(textContent(root)).toContain(expected)
    expect(textContent(root)).not.toContain('DATABASE SECRET')
    expect(textContent(root)).not.toContain('PRIVATE SNAPSHOT CONTENT')
    app.unmount()
  })

  it('ignores an old history page after the selection changes from A to B and back to A', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    let aCalls = 0
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const query = (args[1] as FetchOptions).query
      if (query.id === 1) {
        aCalls++
        if (aCalls === 1) return await new Promise(resolve => { resolveFirst = resolve })
      }
      return { status: 'success', history: history(query.kind, query.id, [revision(query.id)]) }
    })
    const { app, root } = mount(compileComponent(fetcher), { ...subjects, entities: [...subjects.entities, { id: 2, canonicalName: 'Entity Two', entityType: 'Organization' }] })
    await choose(root, '選擇歷史 subject', '1')
    ;(button(root, '讀取歷史').props.onClick as () => void)(); await nextTick()
    await choose(root, '選擇歷史 subject', '2')
    ;(button(root, '讀取歷史').props.onClick as () => void)(); await settle()
    await choose(root, '選擇歷史 subject', '1')
    expect(textContent(root)).not.toContain('Revision #2')
    resolveFirst?.({ status: 'success', history: history('entity', 1, [revision(99)]) })
    await settle()
    expect(textContent(root)).not.toContain('Revision #99')
    expect(textContent(root)).not.toContain('Revision #2')
    expect(textContent(root)).not.toContain('Revision #')
    app.unmount()
  })

  it('fails closed when a later page repeats a prior revision identity', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const query = (args[1] as FetchOptions).query
      return query.cursor
        ? { status: 'success', history: history(query.kind, query.id, [revision(1)]) }
        : { status: 'success', history: history(query.kind, query.id, Array.from({ length: 25 }, (_, index) => revision(25 - index)), 'opaque-cursor') }
    })
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '選擇歷史 subject', '1')
    ;(button(root, '讀取歷史').props.onClick as () => void)(); await settle()
    ;(button(root, '載入更早的 25 筆').props.onClick as () => void)(); await settle()
    expect(textContent(root)).toContain('歷史游標或資料狀態無法完整核對')
    expect(textContent(root)).not.toContain('Revision #1')
    app.unmount()
  })

  it('fails closed when a later page skips a revision number', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const query = (args[1] as FetchOptions).query
      return query.cursor
        ? { status: 'success', history: history(query.kind, query.id, [revision(1)]) }
        : { status: 'success', history: history(query.kind, query.id, Array.from({ length: 25 }, (_, index) => revision(27 - index)), 'opaque-cursor') }
    })
    const { app, root } = mount(compileComponent(fetcher), subjects)
    await choose(root, '選擇歷史 subject', '1')
    ;(button(root, '讀取歷史').props.onClick as () => void)(); await settle()
    ;(button(root, '載入更早的 25 筆').props.onClick as () => void)(); await settle()
    expect(textContent(root)).toContain('歷史游標或資料狀態無法完整核對')
    expect(textContent(root)).not.toContain('Revision #5')
    app.unmount()
  })
})
