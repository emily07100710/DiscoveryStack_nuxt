import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { OWNER_NAVIGATION_GROUPS, resolveOwnerNavigation } from '../utils/owner-navigation'

const localRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(localRequire.resolve('nuxt/package.json'))
const { parse, compileScript } = nuxtRequire('vue/compiler-sfc')
const { createRenderer, defineComponent, h, nextTick, reactive, ref, computed, watch } = nuxtRequire('vue')
const sourcePath = new URL('../layouts/owner.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(sourcePath, 'utf8'), { filename: sourcePath.pathname })
if (errors.length) throw new Error('Owner layout did not parse.')
const compiled = compileScript(descriptor, { id: 'owner-layout-navigation-test', inlineTemplate: true })
const js = transpileModule(compiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText

type Node = { tag: string; props: Record<string, unknown>; children: Array<Node | string>; parent?: Node; text?: string }
function createHost() {
  const renderer = createRenderer({
    createElement: (tag: string) => ({ tag, props: {}, children: [] }),
    createText: (text: string) => ({ tag: '#text', props: {}, children: [], text }),
    createComment: (text: string) => ({ tag: '#comment', props: {}, children: [], text }),
    setText: (node: Node, text: string) => { node.text = text },
    setElementText: (node: Node, text: string) => { node.children = text ? [text] : [] },
    patchProp: (node: Node, key: string, _previous: unknown, next: unknown) => { node.props[key] = next },
    insert: (node: Node, parent: Node, anchor: Node | null) => {
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove: (node: Node) => {
      if (!node.parent) return
      const index = node.parent.children.indexOf(node)
      if (index >= 0) node.parent.children.splice(index, 1)
      node.parent = undefined
    },
    parentNode: (node: Node) => node.parent,
    nextSibling: (node: Node) => {
      const siblings = node.parent?.children || []
      return siblings[siblings.indexOf(node) + 1] as Node | undefined
    },
  })
  return { renderer, root: { tag: '#root', props: {}, children: [] } as Node }
}

function find(node: Node, predicate: (candidate: Node) => boolean): Node | undefined {
  if (predicate(node)) return node
  for (const child of node.children) if (typeof child !== 'string') {
    const match = find(child, predicate)
    if (match) return match
  }
}

async function mountLayout() {
  const route = reactive({ path: '/audit-lab/learning-loop' })
  const { renderer, root } = createHost()
  const module = { exports: {} as { default?: unknown } }
  const testRequire = (id: string) => id === '../utils/owner-navigation' ? { OWNER_NAVIGATION_GROUPS, resolveOwnerNavigation } : nuxtRequire(id)
  new Function('require', 'module', 'exports', 'useRuntimeConfig', 'useRoute', 'useHead', 'computed', 'ref', 'watch', js)(
    testRequire, module, module.exports, () => ({ public: { discoveryStackPublicSiteOrigin: 'https://public.example.test' } }), () => route, vi.fn(), computed, ref, watch,
  )
  const app = renderer.createApp(module.exports.default)
  app.component('NuxtLink', defineComponent({
    props: ['to', 'ariaCurrent', 'aria-current'],
    setup: (props: Record<string, unknown>, { slots }: { slots: { default?: () => unknown } }) => () => h('a', { href: props.to, 'aria-current': props['aria-current'] ?? props.ariaCurrent }, slots.default?.()),
  }))
  app.mount(root)
  await nextTick()
  return { app, root, route }
}

describe('owner workbench navigation behavior', () => {
  it('expands and collapses the mobile navigation from its accessible button', async () => {
    const { app, root } = await mountLayout()
    const toggle = find(root, node => node.tag === 'button' && node.props['aria-controls'] === 'owner-workbench-navigation')!
    const nav = find(root, node => node.tag === 'nav' && node.props.id === 'owner-workbench-navigation')!

    expect(toggle.props['aria-expanded']).toBe(false)
    expect(String(nav.props.class)).not.toContain('is-open')
    ;(toggle.props.onClick as () => void)()
    await nextTick()
    expect(toggle.props['aria-expanded']).toBe(true)
    expect(String(nav.props.class)).toContain('is-open')
    ;(toggle.props.onClick as () => void)()
    await nextTick()
    expect(toggle.props['aria-expanded']).toBe(false)
    expect(String(nav.props.class)).not.toContain('is-open')
    app.unmount()
  })

  it('closes the expanded navigation after a route change while preserving all workbench links', async () => {
    const { app, root, route } = await mountLayout()
    const toggle = find(root, node => node.tag === 'button' && node.props['aria-controls'] === 'owner-workbench-navigation')!
    ;(toggle.props.onClick as () => void)()
    await nextTick()
    route.path = '/audit-lab/geo'
    await nextTick()

    expect(toggle.props['aria-expanded']).toBe(false)
    const links: string[] = []
    const nav = find(root, node => node.tag === 'nav' && node.props.id === 'owner-workbench-navigation')!
    const visit = (node: Node) => {
      if (node.tag === 'a' && typeof node.props.href === 'string') links.push(node.props.href)
      for (const child of node.children) if (typeof child !== 'string') visit(child)
    }
    visit(nav)
    expect(links).toHaveLength(19)
    expect(links).toContain('/leads')
    expect(links).toContain('/audit-lab/content-operations/strategy')
    expect(links).toContain('/audit-lab/knowledge')
    expect(links).toContain('/audit-lab/learning-loop')
    expect(links).toContain('/audit-lab/email-delivery')
    expect(find(root, node => node.tag === 'a' && node.props.href === 'https://public.example.test/zh-hant')).toBeTruthy()
    expect(find(root, node => node.tag === 'a' && node.props['aria-current'] === 'page')?.props.href).toBe('/audit-lab/geo')
    app.unmount()
  })

  it('keeps exactly one active link for child routes and none for unknown routes', async () => {
    const { app, root, route } = await mountLayout()
    route.path = '/audit-lab/content-operations/strategy/draft/42'
    await nextTick()
    const activeLinks = () => {
      const found: Node[] = []
      const visit = (node: Node) => {
        if (node.tag === 'a' && node.props['aria-current'] === 'page') found.push(node)
        for (const child of node.children) if (typeof child !== 'string') visit(child)
      }
      visit(root)
      return found
    }
    expect(activeLinks()).toHaveLength(1)
    const activeLink = activeLinks()[0]
    if (!activeLink) throw new Error('Expected one active navigation link.')
    expect(activeLink.props.href).toBe('/audit-lab/content-operations/strategy')
    route.path = '/audit-lab/not-a-real-page'
    await nextTick()
    expect(activeLinks()).toHaveLength(0)
    app.unmount()
  })
})
