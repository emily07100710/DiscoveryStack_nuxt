import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = nuxtRequire('vue') as typeof import('vue')
const { createRenderer, defineComponent, h, nextTick, ref, Suspense } = vue
const { compileScript, parse } = nuxtRequire('vue/compiler-sfc')
const pagePath = new URL('../pages/audit-lab/weekly-content.vue', import.meta.url)

type HostNode = { type: string, props: Record<string, unknown>, children: HostNode[], text: string, parent: HostNode | null, options: HostNode[], tagName: string, multiple: boolean, selected: boolean, addEventListener: () => void, removeEventListener: () => void }
function hostNode(type: string, text = ''): HostNode { return { type, props: {}, children: [], text, parent: null, options: [], tagName: type.toUpperCase(), multiple: false, selected: false, addEventListener: () => undefined, removeEventListener: () => undefined } }
function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }

const workspace = {
  readiness: { enabled: true, lineConfigured: true, schedulerEnabled: true },
  clients: [], configs: [], policies: [], plans: [], calendars: [],
  requests: [
    { requestId: 'synthetic-site-review', clientId: 1, entryId: 11, status: 'pending', expiresAt: '2099-10-01T00:00:00.000Z', notificationStatus: 'failed', notificationError: null, publicationStatus: 'awaiting_site_review', title: 'Synthetic draft awaiting review' },
    { requestId: 'synthetic-delivered', clientId: 1, entryId: 12, status: 'approved', expiresAt: '2099-10-01T00:00:00.000Z', notificationStatus: 'sent', notificationError: null, publicationStatus: 'delivered', title: 'Synthetic delivered article' },
    { requestId: 'synthetic-customer-review', clientId: 1, entryId: 13, status: 'pending', expiresAt: '2099-10-01T00:00:00.000Z', notificationStatus: 'failed', notificationError: null, publicationStatus: null, title: 'Synthetic customer review' },
  ],
}

async function mountWeeklyPage() {
  const source = readFileSync(pagePath, 'utf8')
  const parsed = parse(source, { filename: pagePath.pathname })
  if (parsed.errors.length) throw new Error('Weekly content page did not parse.')
  const compiled = compileScript(parsed.descriptor, { id: 'weekly-content-draft-receipt-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const fetcher = vi.fn(() => { throw new Error('Synthetic weekly page render must not make network requests.') })
  const loadWorkspace = vi.fn(async () => ({ data: ref(workspace), pending: ref(false), error: ref(null), refresh: vi.fn(async () => undefined) }))
  const sandbox: Record<string, unknown> = {
    module,
    exports: module.exports,
    require: (id: string) => id === 'vue' ? vue : nuxtRequire(id),
    computed: vue.computed,
    ref: vue.ref,
    watch: vue.watch,
    $fetch: fetcher,
    definePageMeta: vi.fn(),
    useHead: vi.fn(),
    useAsyncData: loadWorkspace,
  }
  sandbox.globalThis = sandbox
  runInNewContext(javascript, sandbox)

  const renderer = createRenderer<HostNode, HostNode>({
    createElement: type => hostNode(type), createText: text => hostNode('#text', text), createComment: text => hostNode('#comment', text),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    insert: (child, parent, anchor) => { child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(child) : parent.children.splice(index, 0, child) },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    parentNode: node => node.parent, nextSibling: node => { if (!node.parent) return null; const siblings = node.parent.children; return siblings[siblings.indexOf(node) + 1] || null },
    insertStaticContent: (content, parent, anchor) => { const node = hostNode('#static', content); node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(node) : parent.children.splice(index, 0, node); return [node, node] },
  })
  const root = hostNode('root')
  const Page = module.exports.default
  const app = renderer.createApp(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Page as never), fallback: () => h('span', 'loading') }) }))
  const setupErrors: unknown[] = []
  app.config.errorHandler = error => { setupErrors.push(error) }
  app.component('NuxtLink', defineComponent({ props: { to: { type: String, required: true } }, setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }))
  app.mount(root)
  return { app, root, fetcher, loadWorkspace, setupErrors }
}

describe('weekly content draft-receipt mounted behavior', () => {
  it('distinguishes remote teacher review from publication and keeps customer reopening unchanged', async () => {
    const { app, root, fetcher, loadWorkspace, setupErrors } = await mountWeeklyPage()
    await nextTick()
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    await nextTick()

    expect(loadWorkspace).toHaveBeenCalledOnce()
    expect(setupErrors).toEqual([])
    const rendered = textContent(root)
    expect(rendered).toContain('網站已收稿；發布結果請至內容工作台核驗')
    expect(rendered).not.toContain('草稿已收到，等待網站審核')
    expect(rendered).toContain('已發佈')
    expect(rendered).toContain('等待客戶確認')
    expect(rendered).toContain('LINE 通知失敗')
    const reopenButtons = all(root, node => node.type === 'button' && textContent(node).includes('重新寄送同一篇文章'))
    expect(reopenButtons).toHaveLength(1)
    expect(textContent(reopenButtons[0]!)).toContain('重新寄送同一篇文章')
    expect(fetcher).not.toHaveBeenCalled()
    app.unmount()
  })
})
