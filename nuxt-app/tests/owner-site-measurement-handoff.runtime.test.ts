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
const componentPath = new URL('../components/OwnerSiteMeasurementHandoff.vue', import.meta.url)

type HostNode = { type: string; props: Record<string, unknown>; children: HostNode[]; text: string; parent: HostNode | null }
function hostNode(type: string, text = ''): HostNode { return { type, props: {}, children: [], text, parent: null } }
function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }

const fingerprint = 'b'.repeat(64)
const available = { state: 'available', publicationFingerprint: fingerprint, confirmedAt: null, reason: 'available' }
const confirmed = { state: 'confirmed', publicationFingerprint: fingerprint, confirmedAt: '2026-10-08T06:00:00.000Z', reason: 'confirmed' }

function mountHandoff(value: unknown, busy = false, error = '') {
  const source = readFileSync(componentPath, 'utf8')
  const parsed = parse(source, { filename: componentPath.pathname })
  if (parsed.errors.length) throw new Error('Owner site measurement handoff component did not parse.')
  const compiled = compileScript(parsed.descriptor, { id: 'owner-site-measurement-handoff-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = { module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nuxtRequire(id) }
  sandbox.globalThis = sandbox
  sandbox.serializedValue = JSON.stringify(value)
  const propValue = value === undefined ? undefined : runInNewContext('JSON.parse(serializedValue)', sandbox)
  runInNewContext(javascript, sandbox)

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
  const Component = module.exports.default
  const confirmedEvents: number[] = []
  const app = renderer.createApp(defineComponent({ setup: () => () => h(Component as never, { value: propValue, busy, error, onConfirm: () => confirmedEvents.push(1) }) }))
  app.mount(root)
  return { app, root, confirmedEvents }
}

function click(node: HostNode) { const handler = node.props.onClick; if (typeof handler === 'function') (handler as () => void)() }

describe('OwnerSiteMeasurementHandoff mounted behavior', () => {
  it('requires an explicit second confirmation action and emits no event on mount', async () => {
    const { app, root, confirmedEvents } = mountHandoff(available)
    await nextTick()
    expect(textContent(root)).toContain('可確認接入成效觀察')
    expect(textContent(root)).toContain('不會發布文章或啟動訓練')
    expect(textContent(root)).toContain('尚未收集資料')
    expect(confirmedEvents).toHaveLength(0)
    const begin = all(root, node => node.type === 'button' && textContent(node).includes('確認接入成效觀察'))[0]!
    click(begin)
    await nextTick()
    expect(textContent(root)).toContain('我確認接入成效觀察')
    expect(textContent(root)).toContain('下一個已授權工作或明確排程才會收數')
    expect(textContent(root)).toContain('代替客戶同意')
    expect(confirmedEvents).toHaveLength(0)
    const confirm = all(root, node => node.type === 'button' && textContent(node).includes('我確認接入成效觀察'))[0]!
    click(confirm)
    await nextTick()
    expect(confirmedEvents).toEqual([1])
    app.unmount()
  })

  it('renders a prior confirmed handoff as historical without claiming collection or training', async () => {
    const { app, root } = mountHandoff(confirmed)
    await nextTick()
    const rendered = textContent(root)
    expect(rendered).toContain('已確認接入成效觀察（歷史確認）')
    expect(rendered).toContain('不代表目前授權或已完成收數')
    expect(rendered).toContain('不會因這次確認發布文章或啟動訓練')
    expect(all(root, node => node.type === 'button')).toHaveLength(0)
    expect(rendered).not.toContain('已收集成效資料')
    app.unmount()
  })

  it.each([
    ['not_verified', '尚無可用的網站發布核驗紀錄'],
    ['not_published', '核驗時網站內容未公開或已封存'],
    ['content_changed', '網站公開內容與送入版本不符'],
    ['observation_expired', '網站核驗紀錄已過期'],
    ['authority_invalid', '包含已撤銷的同意'],
  ])('explains blocked state %s without offering confirmation', async (reason, expected) => {
    const { app, root } = mountHandoff({ state: 'blocked', publicationFingerprint: null, confirmedAt: null, reason })
    await nextTick()
    expect(textContent(root)).toContain('目前無法接入成效觀察')
    expect(textContent(root)).toContain(expected)
    expect(all(root, node => node.type === 'button')).toHaveLength(0)
    app.unmount()
  })

  it('keeps prior confirmation time distinct when a later gate blocks reuse', async () => {
    const { app, root } = mountHandoff({ state: 'blocked', publicationFingerprint: fingerprint, confirmedAt: confirmed.confirmedAt, reason: 'observation_expired' })
    await nextTick()
    expect(textContent(root)).toContain('先前接入確認時間：')
    expect(textContent(root)).toContain('目前條件已遭阻擋，尚未代表已收數。')
    expect(all(root, node => node.type === 'button')).toHaveLength(0)
    app.unmount()
  })

  it.each([
    ['missing version fingerprint', { ...available, publicationFingerprint: null }],
    ['wrong reason for available state', { ...available, reason: 'confirmed' }],
    ['confirmed without its timestamp', { ...confirmed, confirmedAt: null }],
    ['blocked using an available reason', { state: 'blocked', publicationFingerprint: null, confirmedAt: null, reason: 'available' }],
    ['unknown field', { ...available, remoteUrl: 'https://synthetic.invalid' }],
    ['malformed timestamp', { ...confirmed, confirmedAt: 'not-a-time' }],
    ['unsupported state', { ...available, state: 'delivered' }],
  ])('fails closed for %s', async (_label, value) => {
    const { app, root, confirmedEvents } = mountHandoff(value)
    await nextTick()
    expect(textContent(root)).toContain('成效觀察接入狀態尚未確認')
    expect(all(root, node => node.type === 'button')).toHaveLength(0)
    expect(confirmedEvents).toHaveLength(0)
    app.unmount()
  })

  it('disables confirmation while the parent is resolving an uncertain request and renders only sanitized feedback', async () => {
    const { app, root, confirmedEvents } = mountHandoff(available, true, '接入確認尚未核實；目前不會宣告已收數。重新嘗試會沿用同一識別碼。')
    await nextTick()
    const firstButton = all(root, node => node.type === 'button' && textContent(node).includes('確認接入成效觀察'))[0]!
    expect(firstButton.props.disabled).toBe(true)
    expect(textContent(root)).toContain('接入確認尚未核實')
    expect(textContent(root)).not.toContain('publicationFingerprint')
    expect(confirmedEvents).toHaveLength(0)
    app.unmount()
  })
})
