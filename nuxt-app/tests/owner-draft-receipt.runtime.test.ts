import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = nuxtRequire('vue') as typeof import('vue')
const { createRenderer, defineComponent, h, nextTick } = vue
const { compileScript, parse } = nuxtRequire('vue/compiler-sfc')
const componentPath = new URL('../components/OwnerDraftReceipt.vue', import.meta.url)

type HostNode = { type: string, props: Record<string, unknown>, children: HostNode[], text: string, parent: HostNode | null }
function hostNode(type: string, text = ''): HostNode { return { type, props: {}, children: [], text, parent: null } }
function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }

const validReceipt = {
  status: 'draft_received', published: false, receiptScope: 'draft_ingest_outcome', receiptIsCurrentState: false,
  publicationId: 'synthetic-publication-1', contentHash: 'a'.repeat(64), postId: 'synthetic-post-1', postVersion: 1, replayed: false,
}

function mountReceipt(receipt: unknown) {
  const source = readFileSync(componentPath, 'utf8')
  const parsed = parse(source, { filename: componentPath.pathname })
  if (parsed.errors.length) throw new Error('Owner draft receipt did not parse.')
  const compiled = compileScript(parsed.descriptor, { id: 'owner-draft-receipt-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = { module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nuxtRequire(id) }
  sandbox.globalThis = sandbox
  runInNewContext(javascript, sandbox)
  sandbox.serializedReceipt = JSON.stringify(receipt)
  const propReceipt = receipt === undefined ? undefined : runInNewContext('JSON.parse(serializedReceipt)', sandbox)

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
  const Receipt = module.exports.default
  const app = renderer.createApp(defineComponent({ setup: () => () => h(Receipt as never, { receipt: propReceipt }) }))
  app.mount(root)
  return { app, root }
}

describe('OwnerDraftReceipt mounted presentation', () => {
  it('shows a validated draft-only receipt as a historical fact, not current publication state', async () => {
    const { app, root } = mountReceipt(validReceipt)
    await nextTick()
    const rendered = textContent(root)
    expect(rendered).toContain('網站已收到草稿（歷史回執）')
    expect(rendered).toContain('目前發布狀態須另外核驗')
    expect(rendered).toContain('不代表文章目前狀態或已發布')
    expect(rendered).not.toContain('status--positive')
    expect(rendered).not.toContain('synthetic-publication-1')
    expect(rendered).not.toContain('synthetic-post-1')
    expect(rendered).not.toContain('a'.repeat(64))
    app.unmount()
  })

  it.each([
    ['published', { ...validReceipt, published: true }],
    ['current-state marker', { ...validReceipt, receiptIsCurrentState: true }],
    ['extra revision field', { ...validReceipt, remoteRevision: 'synthetic-revision' }],
    ['extra URL field', { ...validReceipt, publicationUrl: 'https://synthetic.invalid/post' }],
    ['missing version', Object.fromEntries(Object.entries(validReceipt).filter(([key]) => key !== 'postVersion'))],
  ])('renders nothing for an invalid %s receipt', async (_label, receipt) => {
    const { app, root } = mountReceipt(receipt)
    await nextTick()
    expect(textContent(root)).not.toContain('網站已收到草稿（歷史回執）')
    app.unmount()
  })

  it('labels an idempotent replay without exposing receipt identifiers or article content', async () => {
    const { app, root } = mountReceipt({ ...validReceipt, replayed: true })
    await nextTick()
    const rendered = textContent(root)
    expect(rendered).toContain('此次為重複送達，沿用原接收結果。')
    expect(rendered).not.toContain('synthetic-publication-1')
    expect(rendered).not.toContain('synthetic-post-1')
    app.unmount()
  })
})
