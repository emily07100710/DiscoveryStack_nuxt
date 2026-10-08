import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const appRoot = new URL('../', import.meta.url).pathname
const nodeRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = nuxtRequire('vue') as typeof import('vue')
const { createRenderer, defineComponent, h, nextTick } = vue
const { compileScript, parse } = nuxtRequire('vue/compiler-sfc')
const guidePath = new URL('../components/OwnerWorkGuide.vue', import.meta.url)

type HostNode = { type: string, props: Record<string, unknown>, children: HostNode[], text: string, parent: HostNode | null }
function hostNode(type: string, text = ''): HostNode { return { type, props: {}, children: [], text, parent: null } }
function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }

function mountGuide() {
  const source = readFileSync(guidePath, 'utf8')
  const parsed = parse(source, { filename: guidePath.pathname })
  if (parsed.errors.length) throw new Error('Owner work guide did not parse.')
  const compiled = compileScript(parsed.descriptor, { id: 'owner-work-guide-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const fetcher = vi.fn(() => { throw new Error('Guide rendering must not make requests.') })
  const sandbox: Record<string, unknown> = {
    module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nuxtRequire(id),
    $fetch: fetcher, useFetch: fetcher,
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
  const app = renderer.createApp(module.exports.default as never)
  app.component('NuxtLink', defineComponent({
    props: { to: { type: String, required: true } },
    setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  }))
  app.mount(root)
  return { app, root, fetcher }
}

describe('owner daily work guide mounted behavior', () => {
  it('renders actionable daily links at their existing workbench destinations', async () => {
    const { app, root, fetcher } = mountGuide()
    await nextTick()
    const links = all(root, node => node.type === 'a').map(node => ({ href: node.props.href, label: textContent(node).trim() }))
    expect(links.slice(0, 4)).toEqual([
      { href: '/leads', label: '開啟客戶名單 →' },
      { href: '/audit-lab/content-operations', label: '開啟內容工作台 →' },
      { href: '/audit-lab/weekly-content', label: '開啟文章送審與 LINE →' },
      { href: '/audit-lab/measurement-operations', label: '開啟成效觀察 →' },
    ])
    expect(fetcher).not.toHaveBeenCalled()
    app.unmount()
  })

  it('presents four ordered service steps, clearly gates the Do Alignment pilot, and keeps help disclosed on demand', async () => {
    const { app, root, fetcher } = mountGuide()
    await nextTick()
    const orderedList = all(root, node => node.type === 'ol')[0]!
    const steps = orderedList.children.filter(node => node.type === 'li')
    expect(steps).toHaveLength(4)
    const stepText = steps.map(step => textContent(step).replace(/\s+/g, ' ').trim())
    expect(stepText[0]).toContain('整理客戶與可用資料')
    expect(stepText[1]).toContain('安排文章並請客戶確認')
    expect(stepText[2]).toContain('確認發布紀錄與成效')
    expect(stepText[3]).toContain('另外審核學習資料')
    expect(steps.map(step => textContent(step).match(/[1-4]/)?.[0])).toEqual(['1', '2', '3', '4'])
    const pilot = all(root, node => node.type === 'section' && node.props['aria-labelledby'] === 'alignment-pilot-title')[0]!
    expect(textContent(pilot)).toContain('正式串接仍待核對')
    expect(textContent(pilot)).toContain('不會建立客戶、綁定 LINE 或發布文章')
    expect(textContent(pilot)).toContain('明確操作與授權')
    const staticMarkup = all(root, node => node.type === '#static').map(node => node.text).join('')
    expect(staticMarkup).toMatch(/<details class="work-guide__help"(?:\s|>)/)
    expect(staticMarkup.match(/<details class="work-guide__help"[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|>)/)
    expect(staticMarkup).toContain('>不知道功能放在哪裡？</summary>')
    expect(staticMarkup).toContain('目前仍沿用擁有人登入，尚未新增員工帳號或放寬資料存取權限。')
    expect(fetcher).not.toHaveBeenCalled()
    app.unmount()
  })
})
