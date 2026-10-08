import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterAll, describe, expect, it, vi } from 'vitest'

const appRoot = new URL('../', import.meta.url).pathname
const nodeRequire = createRequire(import.meta.url)
const vueRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = vueRequire('vue') as typeof import('vue')
const { createRenderer, createVNode, h, nextTick, ref, Suspense } = vue
const compilerPackage = readdirSync(join(appRoot, 'node_modules/.pnpm')).find(name => name.startsWith('@vue+compiler-sfc@'))
if (!compilerPackage) throw new Error('Installed @vue/compiler-sfc package is required for this local UI runtime contract.')
const { compileScript, parse } = nodeRequire(join(appRoot, 'node_modules/.pnpm', compilerPackage, 'node_modules/@vue/compiler-sfc'))
vi.stubGlobal('Document', class Document {})
vi.stubGlobal('ShadowRoot', class ShadowRoot {})
vi.stubGlobal('document', { activeElement: null })
afterAll(() => vi.unstubAllGlobals())

type HostNode = {
  type: string
  props: Record<string, unknown>
  children: HostNode[]
  text: string
  parent: HostNode | null
  value: string
  checked: boolean
  selected: boolean
  listeners: Record<string, (event: { target: HostNode }) => void>
  options: HostNode[]
  addEventListener: (name: string, handler: (event: { target: HostNode }) => void) => void
  removeEventListener: (name: string, handler: (event: { target: HostNode }) => void) => void
}
type Dataset = Record<string, unknown> & { manifestId: string, status: string, manifestFingerprint: string, knowledgeAuthority?: Record<string, unknown> }
type View = { value: { status: string, workspace: Record<string, unknown> } }

function hostNode(type: string): HostNode {
  return { type, props: {}, children: [], text: '', parent: null, value: '', checked: false, selected: false, listeners: {}, options: [], addEventListener(name, handler) { this.listeners[name] = handler }, removeEventListener(name) { delete this.listeners[name] } }
}
function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }
function callHandler(node: HostNode, name: string) {
  const handler = node.props[name]
  if (Array.isArray(handler)) {
    for (const action of handler) if (typeof action === 'function') (action as (event: { target: HostNode }) => void)({ target: node })
  } else if (typeof handler === 'function') (handler as (event: { target: HostNode }) => void)({ target: node })
}
function fireModel(node: HostNode, value: string | boolean) {
  const update = node.props['onUpdate:modelValue']
  if (typeof update === 'function') (update as (value: string | boolean) => void)(value)
  callHandler(node, 'onChange')
}
function mount(component: unknown) {
  const renderer = createRenderer<HostNode, HostNode>({
    createElement: tag => hostNode(tag), createText: text => Object.assign(hostNode('#text'), { text }),
    createComment: text => Object.assign(hostNode('#comment'), { text }), setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === 'value') node.value = String(value ?? ''); if (key === 'checked') node.checked = Boolean(value) },
    insert: (child, parent, anchor) => { child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(child) : parent.children.splice(index, 0, child) },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    parentNode: node => node.parent, nextSibling: node => { if (!node.parent) return null; const siblings = node.parent.children; return siblings[siblings.indexOf(node) + 1] || null },
    insertStaticContent: (content: string, parent: HostNode, anchor: HostNode | null) => { const node = Object.assign(hostNode('#static'), { text: content, parent }); const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(node) : parent.children.splice(index, 0, node); return [node, node] },
  })
  const root = hostNode('root')
  const wrapper = { setup: () => () => createVNode(Suspense, null, { default: () => createVNode(component as never), fallback: () => h('div') }) }
  const app = renderer.createApp(wrapper)
  app.component('NuxtLink', { props: ['to'], render: () => h('a') })
  app.component('GeoObservationAdmission', { render: () => h('div') })
  app.mount(root)
  return { app, root }
}
async function settle() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function findButton(root: HostNode, label: string): HostNode {
  const found = all(root, node => node.type === 'button' && textContent(node).includes(label))[0]
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function click(root: HostNode, label: string) { callHandler(findButton(root, label), 'onClick'); await settle() }
function selector(root: HostNode): HostNode { const found = all(root, node => node.type === 'select' && String(node.props.id || '').startsWith('knowledge-mode-'))[0]; if (!found) throw new Error('Missing Knowledge mode selector'); return found }
function acknowledgement(root: HostNode): HostNode { const found = all(root, node => node.type === 'input' && node.props.type === 'checkbox' && node.parent?.type === 'label')[0]; if (!found) throw new Error('Missing declaration acknowledgment'); return found }

const authorityHash = 'a'.repeat(64)
function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    manifestId: 'manifest-1', status: 'ready_for_review', taskType: 'citation_selection', positiveCount: 1, hardNegativeCount: 1,
    websiteCount: 2, queryGroupCount: 2, trainRowCount: 1, validationRowCount: 1, testRowCount: 1, temporalHoldoutRowCount: 0,
    manifestFingerprint: 'b'.repeat(64), limitations: [], knowledgeAuthority: { status: 'not_declared', mode: null, authorityFingerprint: null, activePinCount: 0, reasonCodes: ['explicit_dependency_approval_required'] },
    ...overrides,
  }
}
function workspace(ownerUserId = 7, item = dataset()) {
  return { status: 'success', workspace: { ownerUserId, policy: null, cycles: [], events: [], shadowEvaluations: [], rollbackDecisions: [], advisoryAssignments: [], outcome: {
    readiness: { development: { ready: false, status: 'insufficient_data', missing: [] }, shadow: { ready: false, status: 'insufficient_data', missing: [] } },
    datasets: [item], trainingRuns: [], models: [], datasetDecisions: [], modelDecisions: [],
  } } }
}
function mainWorkspace() {
  return { status: 'success', workspace: { ownerUserId: 7, inventory: {
    structuralAuxiliaryCount: 0, outcomeObservationsCount: 0, verifiedPrimaryCount: 0, providerSecondaryCount: 0, positiveCount: 0,
    hardNegativeCount: 0, websiteCount: 0, queryCount: 0, engineCount: 0, observationSpanDays: null, externalDatasetStatus: 'unverified_external_dataset',
  }, readiness: { development: { ready: false, status: 'insufficient_data', missing: [] }, shadow: { ready: false, status: 'insufficient_data', missing: [] } },
  datasets: [], trainingRuns: [], models: [], decisions: [], } }
}
function receipt(item: Dataset, ownerUserId: number, mode: string, decision: 'approve' | 'revoke' = 'approve') {
  const status = decision === 'approve' ? 'approved' : 'revoked'
  return { status: 'success', automaticallyApproved: false, receiptIsCurrentAuthority: false,
    manifest: { manifestId: item.manifestId, manifestFingerprint: item.manifestFingerprint, status },
    datasetDecision: { decisionId: `geo-dataset-decision-${'c'.repeat(20)}`, manifestId: item.manifestId, manifestFingerprint: item.manifestFingerprint, newStatus: status, reviewerUserId: ownerUserId,
      ...(decision === 'approve' ? { knowledgeAuthority: { mode, authorityFingerprint: authorityHash } } : {}),
    },
  }
}

function compilePage(fetcher: (...args: unknown[]) => Promise<unknown>, views: { main: View, modelOps: View }, refreshes: { main: () => Promise<void>, modelOps: () => Promise<void> }) {
  const url = new URL('../pages/audit-lab/geo-outcome-model.vue', import.meta.url)
  const parsed = parse(readFileSync(url, 'utf8'), { filename: url.pathname })
  if (!parsed.descriptor.scriptSetup) throw new Error('GEO page setup missing.')
  const compiled = compileScript(parsed.descriptor, { id: 'geo-knowledge-authority-ui-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = {
    module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nodeRequire(id),
    definePageMeta() {}, useHead() {}, ref: vue.ref, reactive: vue.reactive, computed: vue.computed, watch: vue.watch, onScopeDispose: vue.onScopeDispose,
    useFetch: (path: string) => Promise.resolve(path === '/api/geo-outcome-model/workspace'
      ? { data: vue.ref(views.main.value), error: vue.ref(undefined), pending: vue.ref(false), refresh: refreshes.main }
      : { data: vue.ref(views.modelOps.value), error: vue.ref(undefined), pending: vue.ref(false), refresh: refreshes.modelOps }),
    $fetch: fetcher, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
  }
  sandbox.globalThis = sandbox
  runInNewContext(javascript, sandbox)
  return module.exports.default
}

function setup(fetcher: (...args: unknown[]) => Promise<unknown>) {
  const main = ref(mainWorkspace()) as unknown as View
  const modelOps = ref(workspace()) as unknown as View
  const mainRefresh = vi.fn(async () => {})
  const modelOpsRefresh = vi.fn(async () => {})
  const component = compilePage(fetcher, { main, modelOps }, { main: mainRefresh, modelOps: modelOpsRefresh })
  return { ...mount(component), main, modelOps, mainRefresh, modelOpsRefresh }
}

describe('GEO Knowledge authority dataset review mounted UI behavior', () => {
  it('starts with no declaration, requires acknowledgment, and clears acknowledgment when mode changes', async () => {
    const fetcher = vi.fn(async () => receipt(dataset(), 7, 'declared_none_v1'))
    const { app, root } = setup(fetcher)
    await settle()
    expect(selector(root).value).toBe('')
    expect(findButton(root, 'Approve').props.disabled).toBe(true)
    selector(root).value = 'pinned_v1'; fireModel(selector(root), 'pinned_v1'); await settle()
    acknowledgement(root).checked = true; fireModel(acknowledgement(root), true); await settle()
    expect(findButton(root, 'Approve').props.disabled).toBe(false)
    selector(root).value = 'declared_none_v1'; fireModel(selector(root), 'declared_none_v1'); await settle()
    expect(acknowledgement(root).checked).toBe(false)
    expect(findButton(root, 'Approve').props.disabled).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    app.unmount()
  })

  it('retries the identical command after uncertainty even when a refreshed authority summary changes, while blocking revoke replacement', async () => {
    const item = dataset()
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('network unavailable'), { statusCode: 503 }))
      .mockResolvedValueOnce(receipt(item, 7, 'pinned_v1'))
    const { app, root, modelOps } = setup(fetcher)
    await settle()
    selector(root).value = 'pinned_v1'; fireModel(selector(root), 'pinned_v1'); await settle()
    acknowledgement(root).checked = true; fireModel(acknowledgement(root), true); await settle()
    await click(root, 'Approve')
    const first = fetcher.mock.calls[0]?.[1] as { body: Record<string, unknown> }
    expect(first.body.knowledgeMode).toBe('pinned_v1')
    const changedDataset = (modelOps.value.workspace as { outcome: { datasets: Dataset[] } }).outcome.datasets[0]!
    changedDataset.status = 'approved'
    changedDataset.knowledgeAuthority = { status: 'current', mode: 'pinned_v1', authorityFingerprint: 'c'.repeat(64), activePinCount: 2, reasonCodes: [] }
    await settle()
    expect(textContent(root)).toContain('Knowledge authority · current')
    expect(all(root, node => node.type === 'button' && textContent(node).trim() === 'Revoke').length).toBe(0)
    await click(root, 'Retry same approval')
    const second = fetcher.mock.calls[1]?.[1] as { body: Record<string, unknown> }
    expect(second.body).toEqual(first.body)
    expect(fetcher.mock.calls[1]?.[0]).toBe(fetcher.mock.calls[0]?.[0])
    app.unmount()
  })

  it('treats malformed success as uncertain and retains the command until a valid server receipt arrives', async () => {
    const item = dataset()
    const fetcher = vi.fn().mockResolvedValueOnce({ status: 'success', manifest: { manifestId: item.manifestId } }).mockResolvedValueOnce(receipt(item, 7, 'declared_none_v1'))
    const { app, root } = setup(fetcher)
    await settle()
    selector(root).value = 'declared_none_v1'; fireModel(selector(root), 'declared_none_v1'); await settle()
    acknowledgement(root).checked = true; fireModel(acknowledgement(root), true); await settle()
    await click(root, 'Approve')
    expect(textContent(root)).toContain('保留原請求識別')
    await click(root, 'Retry same approval')
    expect((fetcher.mock.calls[1]?.[1] as { body: Record<string, unknown> }).body).toEqual((fetcher.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body)
    expect(textContent(root)).toContain('Dataset approve review receipt validated')
    app.unmount()
  })

  it.each([401, 403])('clears pending review after %s and disables actions until reload succeeds', async statusCode => {
    const fetcher = vi.fn().mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { statusCode }))
    const { app, root, modelOpsRefresh } = setup(fetcher)
    await settle()
    selector(root).value = 'declared_none_v1'; fireModel(selector(root), 'declared_none_v1'); await settle()
    acknowledgement(root).checked = true; fireModel(acknowledgement(root), true); await settle()
    await click(root, 'Approve')
    expect(textContent(root)).toContain('Owner authorization changed')
    expect(findButton(root, 'Approve').props.disabled).toBe(true)
    expect(all(root, node => node.type === 'button' && textContent(node).includes('Retry same approval'))).toHaveLength(0)
    await click(root, 'Reload workspace')
    expect(modelOpsRefresh).toHaveBeenCalledOnce()
    expect(findButton(root, 'Approve').props.disabled).toBe(true)
    app.unmount()
  })

  it('ignores a late receipt after the owner scope changes', async () => {
    const item = dataset()
    let resolveRequest: ((value: unknown) => void) | undefined
    const fetcher = vi.fn(() => new Promise(resolve => { resolveRequest = resolve }))
    const { app, root, modelOps } = setup(fetcher)
    await settle()
    selector(root).value = 'declared_none_v1'; fireModel(selector(root), 'declared_none_v1'); await settle()
    acknowledgement(root).checked = true; fireModel(acknowledgement(root), true); await settle()
    callHandler(findButton(root, 'Approve'), 'onClick')
    await settle()
    modelOps.value.workspace.ownerUserId = 8
    await settle()
    resolveRequest?.(receipt(item, 7, 'declared_none_v1'))
    await settle()
    expect(textContent(root)).toContain('Owner authorization changed')
    expect(textContent(root)).not.toContain('Dataset approve review receipt validated')
    app.unmount()
  })

  it('does not refresh or update the page after unmount while a review receipt is pending', async () => {
    const item = dataset()
    let resolveRequest: ((value: unknown) => void) | undefined
    const fetcher = vi.fn(() => new Promise(resolve => { resolveRequest = resolve }))
    const { app, root, mainRefresh, modelOpsRefresh } = setup(fetcher)
    await settle()
    selector(root).value = 'declared_none_v1'; fireModel(selector(root), 'declared_none_v1'); await settle()
    acknowledgement(root).checked = true; fireModel(acknowledgement(root), true); await settle()
    callHandler(findButton(root, 'Approve'), 'onClick')
    await settle()
    app.unmount()
    resolveRequest?.(receipt(item, 7, 'declared_none_v1'))
    await settle()
    expect(mainRefresh).not.toHaveBeenCalled()
    expect(modelOpsRefresh).not.toHaveBeenCalled()
  })
})
