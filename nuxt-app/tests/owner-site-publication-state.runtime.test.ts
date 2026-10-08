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
const componentPath = new URL('../components/OwnerSitePublicationState.vue', import.meta.url)

type HostNode = { type: string, props: Record<string, unknown>, children: HostNode[], text: string, parent: HostNode | null }
function hostNode(type: string, text = ''): HostNode { return { type, props: {}, children: [], text, parent: null } }
function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }

const published = {
  state: 'published', contentMatch: 'matched', observedAt: '2026-10-08T06:00:00.000Z', publishedAt: '2026-10-08T05:00:00.000Z',
  postVersion: 2, publishedVersion: 2, hasUnpublishedChanges: false, receiptIsCurrentState: false,
}

function mountState(value: unknown, preserveValue = false) {
  const source = readFileSync(componentPath, 'utf8')
  const parsed = parse(source, { filename: componentPath.pathname })
  if (parsed.errors.length) throw new Error('Owner site publication state component did not parse.')
  const compiled = compileScript(parsed.descriptor, { id: 'owner-site-publication-state-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = { module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nuxtRequire(id) }
  sandbox.globalThis = sandbox
  runInNewContext(javascript, sandbox)
  sandbox.serializedValue = JSON.stringify(value)
  const propValue = value === undefined ? undefined : preserveValue ? value : runInNewContext('JSON.parse(serializedValue)', sandbox)

  const renderer = createRenderer<HostNode, HostNode>({
    createElement: type => hostNode(type), createText: text => hostNode('#text', text), createComment: text => hostNode('#comment', text),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, next) => { node.props[key] = next },
    insert: (child, parent, anchor) => { child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(child) : parent.children.splice(index, 0, child) },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    parentNode: node => node.parent, nextSibling: node => { if (!node.parent) return null; const siblings = node.parent.children; return siblings[siblings.indexOf(node) + 1] || null },
    insertStaticContent: (content, parent, anchor) => { const node = hostNode('#static', content); node.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(node) : parent.children.splice(index, 0, node); return [node, node] },
  })
  const root = hostNode('root')
  const State = module.exports.default
  const app = renderer.createApp(defineComponent({ setup: () => () => h(State as never, { value: propValue }) }))
  app.mount(root)
  return { app, root }
}

describe('OwnerSitePublicationState mounted display', () => {
  it('shows an exact-match publication as a timestamped historical verification', async () => {
    const { app, root } = mountState(published)
    await nextTick()
    const rendered = textContent(root)
    expect(all(root, node => node.props['aria-label'] === '網站發布核驗紀錄')).toHaveLength(1)
    expect(rendered).toContain('網站確認已發布，公開版本與送入內容一致')
    expect(rendered).toContain('核驗當時，之後狀態可能改變')
    expect(rendered).toContain('不會授予發布權限、替代客戶同意或觸發成效學習')
    expect(rendered).not.toContain('publicationId')
    expect(rendered).not.toContain('postId')
    expect(rendered).not.toContain('已核准發布')
    app.unmount()
  })

  it.each([
    [{ ...published, contentMatch: 'changed' }, '網站已發布，但公開內容與送入版本不同，需重新核對。'],
    [{ ...published, contentMatch: 'unverifiable' }, '網站已發布，但舊收件紀錄缺少內容指紋，無法確認版本一致。'],
  ])('distinguishes a changed or unverifiable published snapshot', async (value, message) => {
    const { app, root } = mountState(value)
    await nextTick()
    expect(textContent(root)).toContain(message)
    expect(textContent(root)).not.toContain('公開版本與送入內容一致')
    app.unmount()
  })

  it('keeps a matching published snapshot distinct from a later private draft edit', async () => {
    const { app, root } = mountState({ ...published, postVersion: 3, publishedVersion: 2, hasUnpublishedChanges: true })
    await nextTick()
    expect(textContent(root)).toContain('網站確認已發布，公開版本與送入內容一致')
    expect(textContent(root)).toContain('另有尚未發布的編輯；公開版本仍與送入內容一致。')
    app.unmount()
  })

  it('accepts protocol snapshots without a publication timestamp when the version identity is sufficient', async () => {
    const { app, root } = mountState({ ...published, publishedAt: null })
    await nextTick()
    expect(textContent(root)).toContain('網站確認已發布，公開版本與送入內容一致')
    app.unmount()
  })

  it.each([
    ['wrapped state', { ...published, state: new String('published') }],
    ['wrapped content match', { ...published, contentMatch: new String('matched') }],
  ])('rejects %s rather than coercing its enum field', async (_label, value) => {
    const { app, root } = mountState(value, true)
    await nextTick()
    expect(textContent(root)).toContain('網站發布狀態尚未核驗，或回傳資料不完整。')
    app.unmount()
  })

  it.each([
    [{ ...published, state: 'private', contentMatch: 'not_published', publishedAt: null, publishedVersion: null, hasUnpublishedChanges: false }, '核驗當時，文章未公開。'],
    [{ ...published, state: 'archived', contentMatch: 'not_published', publishedAt: null, publishedVersion: null, hasUnpublishedChanges: false }, '核驗當時，文章已封存且未公開。'],
  ])('shows private or archived as not published at check time', async (value, message) => {
    const { app, root } = mountState(value)
    await nextTick()
    expect(textContent(root)).toContain(message)
    expect(textContent(root)).not.toContain('網站確認已發布')
    app.unmount()
  })

  it.each([
    ['null', null],
    ['extra field', { ...published, postId: 'synthetic-post-must-not-render' }],
    ['wrong current-state marker', { ...published, receiptIsCurrentState: true }],
    ['published without its snapshot version', { ...published, publishedVersion: null }],
    ['private with a published content claim', { ...published, state: 'private' }],
    ['private with a publication timestamp', { ...published, state: 'private', contentMatch: 'not_published', publishedVersion: null, hasUnpublishedChanges: false }],
    ['private with a published version', { ...published, state: 'private', contentMatch: 'not_published', publishedAt: null, hasUnpublishedChanges: false }],
    ['archived with published fields', { ...published, state: 'archived', contentMatch: 'not_published', hasUnpublishedChanges: false }],
    ['future published version', { ...published, publishedVersion: 4 }],
    ['published with a future publication timestamp', { ...published, publishedAt: '2026-10-08T07:00:00.000Z' }],
    ['published version below protocol version floor', { ...published, postVersion: 2, publishedVersion: 1 }],
    ['inconsistent unpublished-change marker', { ...published, hasUnpublishedChanges: true }],
    ['invalid check timestamp', { ...published, observedAt: 'not-a-time' }],
  ])('fails closed to neutral wording for %s', async (_label, value) => {
    const { app, root } = mountState(value)
    await nextTick()
    const rendered = textContent(root)
    expect(rendered).toContain('網站發布狀態尚未核驗，或回傳資料不完整。')
    expect(rendered).toContain('不會依此資料推定已發布、已刪除或已核准')
    expect(rendered).not.toContain('網站確認已發布')
    expect(rendered).not.toContain('synthetic-post-must-not-render')
    expect(all(root, node => node.type === 'button')).toHaveLength(0)
    app.unmount()
  })
})
