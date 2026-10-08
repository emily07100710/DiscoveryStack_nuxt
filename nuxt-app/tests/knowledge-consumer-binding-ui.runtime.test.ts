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
const compilerPackage = readdirSync(join(appRoot, 'node_modules/.pnpm')).find(name => name.startsWith('@vue+compiler-sfc@'))
if (!compilerPackage) throw new Error('Installed @vue/compiler-sfc package is required for this local runtime contract.')
const { compileScript, parse } = nodeRequire(join(appRoot, 'node_modules/.pnpm', compilerPackage, 'node_modules/@vue/compiler-sfc'))

type Node = { type: string, props: Record<string, unknown>, children: Node[], text: string, parent: Node | null, value: string, checked: boolean, listeners: Record<string, (event: { target: Node }) => void>, addEventListener: (name: string, handler: (event: { target: Node }) => void) => void, removeEventListener: (name: string, handler: (event: { target: Node }) => void) => void, readonly options: Node[] }
function hostNode(type: string): Node {
  return {
    type, props: {}, children: [], text: '', parent: null, value: '', checked: false, listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler },
    removeEventListener(name, handler) { if (this.listeners[name] === handler) delete this.listeners[name] },
    get options() { return this.children.flatMap(child => child.type === 'option' ? [child] : child.options) },
  }
}
function all(root: Node, predicate: (node: Node) => boolean): Node[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(node: Node): string { return node.text + node.children.map(textContent).join('') }
function compileComponent(fetcher: (...args: unknown[]) => Promise<unknown>) {
  const url = new URL('../components/KnowledgeConsumerBindings.vue', import.meta.url)
  const parsed = parse(readFileSync(url, 'utf8'), { filename: url.pathname })
  if (!parsed.descriptor.scriptSetup) throw new Error('Knowledge consumer binding script setup missing')
  // Keep the full production template while avoiding staticVNode host-insert calls
  // unsupported by this intentionally small deterministic custom renderer.
  const compiled = compileScript(parsed.descriptor, { id: 'knowledge-consumer-binding-runtime', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  runInNewContext(javascript, { module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nodeRequire(id), $fetch: fetcher, crypto: { randomUUID: vi.fn(() => 'ui-command-key-0001') } })
  return module.exports.default
}
function mount(component: unknown) {
  const renderer = createRenderer<Node, Node>({
    createElement: tag => hostNode(tag), createText: text => Object.assign(hostNode('#text'), { text }), createComment: text => Object.assign(hostNode('#comment'), { text }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === 'value') node.value = String(value ?? '') },
    insert: (child, parent, anchor) => { child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; at < 0 ? parent.children.push(child) : parent.children.splice(at, 0, child) },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    parentNode: node => node.parent, nextSibling: node => { if (!node.parent) return null; const siblings = node.parent.children; return siblings[siblings.indexOf(node) + 1] || null },
  })
  const root = hostNode('root')
  const app = renderer.createApp(component as never, { entities: [{ id: 1, canonicalName: 'Entity One', entityType: 'Organization' }], claims: [{ id: 3, statement: 'Claim Three', claimType: 'research' }], sources: [{ id: 9, title: 'Source Nine', canonicalUrl: 'https://example.test/source' }] })
  app.mount(root)
  return { app, root }
}
async function settle() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function fire(node: Node, event: string) {
  const payload = { target: node }
  node.listeners[event]?.(payload)
  const handler = node.props[`on${event[0]!.toUpperCase()}${event.slice(1)}`]
  if (typeof handler === 'function') (handler as (event: { target: Node }) => void)(payload)
  const update = node.props['onUpdate:modelValue']
  if (typeof update === 'function' && (event === 'change' || event === 'input')) (update as (value: boolean | string) => void)(node.props.type === 'checkbox' ? node.checked : node.value)
}
async function choose(root: Node, label: string, value: string) {
  const control = all(root, node => node.type === 'select' && node.props['aria-label'] === label)[0]
  if (!control) throw new Error(`Missing select ${label}`)
  control.value = value
  for (const option of control.options) option.props.selected = option.value === value
  fire(control, 'change')
  await nextTick()
}
function button(root: Node, text: string) {
  const target = all(root, node => node.type === 'button' && textContent(node).includes(text))[0]
  if (!target || typeof target.props.onClick !== 'function') throw new Error(`Missing button ${text}`)
  return target
}
async function click(root: Node, text: string) { (button(root, text).props.onClick as () => void)(); await settle() }
async function acknowledge(root: Node) {
  const checkbox = all(root, node => node.type === 'input' && node.props.type === 'checkbox')[0]
  if (!checkbox) throw new Error('Missing dependency-only acknowledgment')
  checkbox.checked = true
  fire(checkbox, 'change')
  await nextTick()
}

const H = 'a'.repeat(64)
const fp = (n: number) => String(n).padStart(64, '0')
const anchor = { consumerKind: 'geo_dataset', consumerId: 77, consumerVersion: H, consumerContentHash: H }
function history(id: number, revisionNumber: number) {
  return { status: 'success', history: { subject: { kind: 'entity', id }, items: [{ revisionId: revisionNumber, revisionNumber, revisionKind: 'mutation', contentHash: H, previousRevisionFingerprint: null, revisionFingerprint: fp(revisionNumber), eventFingerprint: H, operations: ['updateEntity'], occurredAt: '2026-10-08T00:00:00.000Z' }], nextCursor: null, historyScope: 'recorded_mutations_only', rawSnapshotIncluded: false, automaticPublication: false, productionActivation: false, automaticTrainingAdmission: false } }
}
function binding(overrides: Record<string, unknown> = {}) {
  return { id: 4, consumerKind: 'geo_dataset', consumerId: 77, consumerVersion: H, consumerContentHash: H, subjectKind: 'entity', subjectId: 1, revisionId: 1, revisionNumber: 1, revisionContentHash: H, revisionFingerprint: fp(1), operation: 'bind', sequenceNumber: 1, bindingFingerprint: fp(80), previousBindingFingerprint: null, nativeAvailability: 'present', ...overrides }
}
function bindingsReply(rows: unknown[] = []) {
  const count = (kind: string) => new Set(rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && (row as Record<string, unknown>).operation === 'bind' && (row as Record<string, unknown>).consumerKind === kind).map(row => row.consumerId)).size
  const coverage = ['content', 'schema', 'dataset', 'public_api', 'benchmark_prompt', 'reviewer'].map(category => ({ category, state: ['dataset', 'benchmark_prompt'].includes(category) ? 'complete' : 'unconfigured', scope: 'explicit only', limitationCodes: [], registeredConsumerCount: category === 'dataset' ? count('geo_dataset') : category === 'benchmark_prompt' ? count('benchmark_prompt') : 0 }))
  return { status: 'ok', coverage, bindings: rows, exhaustive: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false }
}
function catalogReply(items: unknown[] = [anchor]) { return { status: 'ok', catalog: { consumerKind: 'geo_dataset', items, nextAfterId: null, scope: 'owner_native_immutable_consumers_v1', rawTextIncluded: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false } } }
function receipt(row: ReturnType<typeof binding>) { const { nativeAvailability: _omit, ...safe } = row; return { status: 'ok', value: { binding: safe, replayed: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false } } }
function defaultFetch(rows: unknown[] = [], mutate: (...args: unknown[]) => Promise<unknown> = async () => receipt(binding())) {
  return vi.fn(async (path: unknown, options?: unknown) => {
    if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) return bindingsReply(rows)
    if (path === '/api/knowledge/consumer-catalog') return catalogReply()
    if (path === '/api/knowledge/revision-history') return history(1, 1)
    if ((options as { method?: string } | undefined)?.method === 'POST') return mutate(path, options)
    throw new Error(`unexpected request ${String(path)}`)
  })
}
async function readyToBind(root: Node) {
  await click(root, '載入連結與選項')
  await choose(root, '選擇知識紀錄', '1')
  await choose(root, '選擇 native consumer', '77')
  await click(root, '核對目前修訂')
  await acknowledge(root)
}

describe('Knowledge consumer bindings mounted runtime', () => {
  it('binds the selected native ID to the exact current revision with server-derived authority and explicit acknowledgment', async () => {
    const mutate = vi.fn(async () => receipt(binding({ revisionFingerprint: fp(1) })))
    const fetcher = defaultFetch([], mutate)
    const { app, root } = mount(compileComponent(fetcher))
    await readyToBind(root)
    await click(root, '建立依賴')
    const post = fetcher.mock.calls.find(([path, options]) => path === '/api/knowledge/consumer-bindings' && (options as { method?: string } | undefined)?.method === 'POST')
    expect(post?.[1]).toEqual({ method: 'POST', body: { consumerKind: 'geo_dataset', consumerId: 77, subjectKind: 'entity', subjectId: 1, operation: 'bind', expectedRevisionFingerprint: fp(1), expectedBindingFingerprint: null, idempotencyKey: 'ui-command-key-0001' } })
    expect(textContent(root)).toContain('已記錄精確知識修訂依賴')
    expect(textContent(root)).toContain('不會自動發布內容')
    app.unmount()
  })

  it('repins stale history and then revokes without discarding the append-only latest state', async () => {
    let rev = 2
    const mutate = vi.fn(async (_path: unknown, options: unknown) => {
      const body = (options as { body: Record<string, unknown> }).body
      return receipt(binding({ id: body.operation === 'bind' ? 5 : 6, revisionId: body.operation === 'bind' ? 2 : 2, revisionNumber: 2, revisionFingerprint: fp(2), sequenceNumber: body.operation === 'bind' ? 2 : 3, previousBindingFingerprint: body.operation === 'bind' ? fp(80) : fp(81), bindingFingerprint: body.operation === 'bind' ? fp(81) : fp(82), operation: body.operation }))
    })
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) return bindingsReply([binding()])
      if (path === '/api/knowledge/consumer-catalog') return catalogReply()
      if (path === '/api/knowledge/revision-history') return history(1, rev)
      if ((options as { method?: string } | undefined)?.method === 'POST') return mutate(path, options)
      throw new Error('unexpected request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await click(root, '載入連結與選項'); await choose(root, '選擇知識紀錄', '1'); await choose(root, '選擇 native consumer', '77')
    await click(root, '核對目前修訂')
    expect(textContent(root)).toContain('需要重新綁定')
    await acknowledge(root); await click(root, '重新綁定目前修訂')
    expect((mutate.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body.expectedRevisionFingerprint).toBe(fp(2))
    expect(textContent(root)).toContain('已記錄精確知識修訂依賴')
    rev = 2
    await acknowledge(root); await click(root, '撤銷依賴')
    expect(mutate).toHaveBeenCalledTimes(2)
    expect((mutate.mock.calls[1]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ operation: 'revoke', expectedRevisionFingerprint: null, expectedBindingFingerprint: fp(81) })
    expect(textContent(root)).toContain('已記錄撤銷')
    app.unmount()
  })

  it('retains a removed native binding for revoke but does not offer a fresh bind', async () => {
    const mutate = vi.fn(async (_path: unknown, _options: unknown) => receipt(binding({ operation: 'revoke', sequenceNumber: 2, previousBindingFingerprint: fp(80), bindingFingerprint: fp(81), nativeAvailability: 'missing' })))
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) return bindingsReply([binding({ nativeAvailability: 'missing' })])
      if (path === '/api/knowledge/consumer-catalog') return catalogReply([])
      if ((options as { method?: string } | undefined)?.method === 'POST') return mutate(path, options)
      throw new Error(`unexpected request ${String(path)}`)
    })
    const { app, root } = mount(compileComponent(fetcher))
    await click(root, '載入連結與選項')
    await choose(root, '選擇知識紀錄', '1')
    await choose(root, '選擇 native consumer', '77')
    expect(textContent(root)).toContain('已不存在')
    expect(all(root, node => node.type === 'button' && textContent(node).includes('建立依賴'))).toHaveLength(0)
    await acknowledge(root)
    expect(button(root, '撤銷依賴').props.disabled).toBe(false)
    await click(root, '撤銷依賴')
    expect(mutate).toHaveBeenCalledTimes(1)
    expect((mutate.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ operation: 'revoke', expectedRevisionFingerprint: null, expectedBindingFingerprint: fp(80) })
    expect(textContent(root)).toContain('已記錄撤銷')
    app.unmount()
  })

  it('pages the owner catalog with a forward cursor and retains the selected anchor', async () => {
    const firstItems = Array.from({ length: 25 }, (_, index) => ({ ...anchor, consumerId: index + 1 }))
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings') return bindingsReply()
      if (path === '/api/knowledge/consumer-catalog') {
        const query = (options as { query: { afterId?: number } }).query
        const items = query.afterId === undefined ? firstItems : [{ ...anchor, consumerId: 26 }]
        return { status: 'ok', catalog: { consumerKind: 'geo_dataset', items, nextAfterId: query.afterId === undefined ? 25 : null, scope: 'owner_native_immutable_consumers_v1', rawTextIncluded: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false } }
      }
      throw new Error('unexpected request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await click(root, '載入連結與選項')
    await choose(root, '選擇 native consumer', '7')
    await click(root, '載入下一頁')
    const calls = fetcher.mock.calls.filter(([path]) => path === '/api/knowledge/consumer-catalog')
    expect(calls.map(([, options]) => options)).toEqual([{ query: { kind: 'geo_dataset' } }, { query: { kind: 'geo_dataset', afterId: 25 } }])
    const select = all(root, node => node.type === 'select' && node.props['aria-label'] === '選擇 native consumer')[0]
    expect(select?.value).toBe('7')
    expect(select?.options.some(option => option.value === '26')).toBe(true)
    app.unmount()
  })

  it('accepts a terminal catalog page containing exactly 25 items', async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({ ...anchor, consumerId: index + 1 }))
    const fetcher = vi.fn(async (path: unknown) => path === '/api/knowledge/consumer-bindings'
      ? bindingsReply()
      : { status: 'ok', catalog: { consumerKind: 'geo_dataset', items, nextAfterId: null, scope: 'owner_native_immutable_consumers_v1', rawTextIncluded: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false } })
    const { app, root } = mount(compileComponent(fetcher))
    await click(root, '載入連結與選項')
    expect(textContent(root)).toContain('25 個明確 native IDs')
    expect(all(root, node => node.type === 'button' && textContent(node).includes('載入下一頁'))).toHaveLength(0)
    app.unmount()
  })

  it('rejects a nonterminal cursor that does not equal the last item and oversized numeric prompt versions', async () => {
    const cases: Array<{ name: string, fetcher: (...args: unknown[]) => Promise<unknown>, choosePrompt?: boolean }> = [
      {
        name: 'cursor mismatch', fetcher: async (path, options) => {
          if (path === '/api/knowledge/consumer-bindings') return bindingsReply()
          if (path === '/api/knowledge/consumer-catalog') return { ...catalogReply(Array.from({ length: 25 }, (_, index) => ({ ...anchor, consumerId: index + 1 }))), catalog: { ...catalogReply().catalog, items: Array.from({ length: 25 }, (_, index) => ({ ...anchor, consumerId: index + 1 })), nextAfterId: 26 } }
          throw new Error(String(options))
        },
      },
      {
        name: 'oversized prompt version', choosePrompt: true, fetcher: async (path, options) => {
          if (path === '/api/knowledge/consumer-bindings') return bindingsReply()
          if (path === '/api/knowledge/consumer-catalog') return { status: 'ok', catalog: { ...catalogReply().catalog, consumerKind: 'benchmark_prompt', items: [{ consumerKind: 'benchmark_prompt', consumerId: 8, consumerVersion: '2147483648', consumerContentHash: H }] } }
          throw new Error(String(options))
        },
      },
      {
        name: 'private internal coverage expansion', fetcher: async (path, options) => {
          if (path === '/api/knowledge/consumer-bindings') return { ...bindingsReply(), coverage: bindingsReply().coverage.map((bucket, index) => index === 2 ? { ...bucket, consumers: [{ ownerUserId: 7, consumerId: 'geo_dataset:77', dependencies: [{ kind: 'entity', id: 1 }] }] } : bucket) }
          if (path === '/api/knowledge/consumer-catalog') return catalogReply()
          throw new Error(String(options))
        },
      },
    ]
    for (const fixture of cases) {
      const { app, root } = mount(compileComponent(fixture.fetcher))
      if (fixture.choosePrompt) await choose(root, 'Native consumer 類型', 'benchmark_prompt')
      await click(root, '載入連結與選項')
      expect(textContent(root), fixture.name).toContain('回應無法安全核對')
      app.unmount()
    }
  })

  it.each([500, 503])('preserves the exact body and idempotency key after uncertain HTTP %i, and retries only that command', async (status) => {
    let calls = 0
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) return bindingsReply()
      if (path === '/api/knowledge/consumer-catalog') return catalogReply()
      if (path === '/api/knowledge/revision-history') return history(1, 1)
      if ((options as { method?: string } | undefined)?.method === 'POST') { calls++; if (calls === 1) throw Object.assign(new Error('private backend detail'), { statusCode: status }); return receipt(binding()) }
      throw new Error('unexpected request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await readyToBind(root); await click(root, '建立依賴')
    const first = fetcher.mock.calls.find(([path, options]) => path === '/api/knowledge/consumer-bindings' && (options as { method?: string } | undefined)?.method === 'POST')?.[1]
    expect(textContent(root)).toContain('結果不確定')
    expect(textContent(root)).not.toContain('private backend detail')
    expect(button(root, '載入連結與選項').props.disabled).toBe(true)
    expect(all(root, node => node.type === 'select').every(node => node.props.disabled === true)).toBe(true)
    const callsBeforeLockedRefresh = fetcher.mock.calls.length
    ;(button(root, '載入連結與選項').props.onClick as () => void)()
    await choose(root, 'Native consumer 類型', 'benchmark_prompt')
    await settle()
    expect(fetcher.mock.calls).toHaveLength(callsBeforeLockedRefresh)
    expect(textContent(root)).toContain('只能重試同一命令與 key')
    await click(root, '重試同一命令')
    const posts = fetcher.mock.calls.filter(([path, options]) => path === '/api/knowledge/consumer-bindings' && (options as { method?: string } | undefined)?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.[1]).toEqual(first)
    expect(posts[1]?.[1]).toEqual(first)
    app.unmount()
  })

  it('requires a fresh revision after 409 reload before a successful rebind, and maps GET 403/409 to fixed copy', async () => {
    let mutateCalls = 0
    let bindingReads = 0
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) {
        bindingReads++
        return bindingsReply(bindingReads > 1 ? [binding({ revisionFingerprint: fp(0) })] : [])
      }
      if (path === '/api/knowledge/consumer-catalog') return catalogReply()
      if (path === '/api/knowledge/revision-history') return history(1, 1)
      if ((options as { method?: string } | undefined)?.method === 'POST') {
        mutateCalls++
        if (mutateCalls === 1) throw Object.assign(new Error('SECRET STORAGE DETAIL'), { statusCode: 409 })
        return receipt(binding({ revisionFingerprint: fp(1), sequenceNumber: 2, previousBindingFingerprint: fp(80), bindingFingerprint: fp(81) }))
      }
      throw Object.assign(new Error('SECRET STORAGE DETAIL'), { statusCode: 409 })
    })
    const { app, root } = mount(compileComponent(fetcher))
    await readyToBind(root); await click(root, '建立依賴')
    expect(textContent(root)).toContain('請重新載入連結與修訂')
    expect(textContent(root)).not.toContain('SECRET STORAGE DETAIL')
    expect(button(root, '載入連結與選項').props.disabled).toBe(false)
    await click(root, '載入連結與選項')
    expect(textContent(root)).not.toContain('目前修訂：')
    expect(all(root, node => node.type === 'button' && textContent(node).includes('建立依賴'))).toHaveLength(0)
    expect(all(root, node => node.type === 'button' && textContent(node).includes('重新綁定目前修訂'))).toHaveLength(0)
    await choose(root, '選擇知識紀錄', '1')
    await choose(root, '選擇 native consumer', '77')
    await click(root, '核對目前修訂')
    expect(textContent(root)).toContain('需要重新綁定')
    await acknowledge(root)
    await click(root, '重新綁定目前修訂')
    expect(mutateCalls).toBe(2)
    expect(textContent(root)).toContain('已記錄精確知識修訂依賴')
    app.unmount()

    for (const status of [403, 409]) {
      const failing = vi.fn(async () => { throw Object.assign(new Error('SECRET STORAGE DETAIL'), { statusCode: status }) })
      const mounted = mount(compileComponent(failing))
      await click(mounted.root, '載入連結與選項')
      expect(textContent(mounted.root)).toContain(status === 403 ? '需要有效的 owner session' : '連結狀態無法完整核對')
      expect(textContent(mounted.root)).not.toContain('SECRET STORAGE DETAIL')
      mounted.app.unmount()
    }
  })

  it.each([401, 403])('invalidates revision and workspace after mutation %i until an explicit owner reload', async (status) => {
    let postCalls = 0
    let authorize = false
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) return bindingsReply()
      if (path === '/api/knowledge/consumer-catalog') return catalogReply()
      if (path === '/api/knowledge/revision-history') return history(1, 1)
      if ((options as { method?: string } | undefined)?.method === 'POST') {
        postCalls++
        if (!authorize) throw Object.assign(new Error('SESSION DETAIL SECRET'), { statusCode: status })
        return receipt(binding())
      }
      throw new Error('unexpected request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await readyToBind(root); await click(root, '建立依賴')
    expect(textContent(root)).toContain('需要有效的 owner session')
    expect(textContent(root)).not.toContain('目前修訂：')
    expect(textContent(root)).not.toContain('SESSION DETAIL SECRET')
    expect(all(root, node => node.type === 'select').every(node => node.props.disabled === true)).toBe(true)
    await click(root, '載入連結與選項')
    expect(postCalls).toBe(1)
    expect(textContent(root)).not.toContain('目前修訂：')
    authorize = true
    await choose(root, '選擇知識紀錄', '1')
    await choose(root, '選擇 native consumer', '77')
    await click(root, '核對目前修訂')
    await acknowledge(root)
    await click(root, '建立依賴')
    expect(postCalls).toBe(2)
    app.unmount()
  })

  it('does not auto-read on native-kind change and ignores an obsolete in-flight read', async () => {
    let release: ((value: unknown) => void) | undefined
    let first = true
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) {
        if (first) { first = false; return await new Promise(resolve => { release = resolve }) }
        return bindingsReply()
      }
      if (path === '/api/knowledge/consumer-catalog') return catalogReply()
      if (path === '/api/knowledge/revision-history') return history(1, 1)
      if ((options as { method?: string } | undefined)?.method === 'POST') throw Object.assign(new Error('SECRET DB DETAIL'), { statusCode: 409 })
      throw Object.assign(new Error('SECRET DB DETAIL'), { statusCode: 403 })
    })
    const { app, root } = mount(compileComponent(fetcher))
    ;(button(root, '載入連結與選項').props.onClick as () => void)(); await nextTick()
    await choose(root, 'Native consumer 類型', 'benchmark_prompt')
    release?.(bindingsReply([binding({ id: 99, consumerId: 99 })]))
    await settle()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(textContent(root)).not.toContain('#99')
    app.unmount()

    const errorFetch = vi.fn(async () => { throw Object.assign(new Error('SECRET DB DETAIL'), { statusCode: 403 }) })
    const second = mount(compileComponent(errorFetch))
    await click(second.root, '載入連結與選項')
    expect(textContent(second.root)).toContain('需要有效的 owner session')
    expect(textContent(second.root)).not.toContain('SECRET DB DETAIL')
    second.app.unmount()
  })

  it('lets an unrelated binding/catalog load finish when the Knowledge subject kind changes', async () => {
    let release: ((value: unknown) => void) | undefined
    const fetcher = vi.fn(async (path: unknown) => {
      if (path === '/api/knowledge/consumer-bindings') return await new Promise(resolve => { release = resolve })
      if (path === '/api/knowledge/consumer-catalog') return catalogReply()
      throw new Error('unexpected request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    ;(button(root, '載入連結與選項').props.onClick as () => void)(); await nextTick()
    await choose(root, '知識紀錄類型', 'claim')
    release?.(bindingsReply())
    await settle()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(all(root, node => node.type === 'select' && node.props['aria-label'] === '選擇 native consumer')).toHaveLength(1)
    expect(textContent(root)).toContain('資料集與 Prompt 知識依賴')
    app.unmount()
  })

  it('ignores a late successful POST receipt after component unmount', async () => {
    let resolveMutation: ((value: unknown) => void) | undefined
    const fetcher = vi.fn(async (path: unknown, options?: unknown) => {
      if (path === '/api/knowledge/consumer-bindings' && !(options as { method?: string } | undefined)?.method) return bindingsReply()
      if (path === '/api/knowledge/consumer-catalog') return catalogReply()
      if (path === '/api/knowledge/revision-history') return history(1, 1)
      if ((options as { method?: string } | undefined)?.method === 'POST') return await new Promise(resolve => { resolveMutation = resolve })
      throw new Error('unexpected request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await readyToBind(root)
    ;(button(root, '建立依賴').props.onClick as () => void)(); await nextTick()
    app.unmount()
    resolveMutation?.(receipt(binding()))
    await settle()
    expect(fetcher.mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === 'POST')).toHaveLength(1)
  })
})
