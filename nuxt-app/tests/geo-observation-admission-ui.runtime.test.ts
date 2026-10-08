import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createHash, webcrypto } from 'node:crypto'
import ts from 'typescript'
import { afterAll, describe, expect, it, vi } from 'vitest'

const appRoot = new URL('../', import.meta.url).pathname
const nodeRequire = createRequire(import.meta.url)
const vueRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = vueRequire('vue') as typeof import('vue')
const { createRenderer, nextTick } = vue
const compilerSfcPackage = readdirSync(join(appRoot, 'node_modules/.pnpm')).find(name => name.startsWith('@vue+compiler-sfc@'))
if (!compilerSfcPackage) throw new Error('Installed @vue/compiler-sfc package is required for this local runtime contract.')
const { compileScript, parse } = nodeRequire(join(appRoot, 'node_modules/.pnpm', compilerSfcPackage, 'node_modules/@vue/compiler-sfc'))
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
  addEventListener: (name: string, handler: (event: { target: HostNode }) => void) => void
  removeEventListener: (name: string, handler: (event: { target: HostNode }) => void) => void
  getRootNode: () => HostNode
  readonly options: HostNode[]
}
type MockRequestOptions = { method?: string, query?: { cursor?: string, sourceRecordId?: number }, body?: Record<string, unknown> }

function hostNode(type: string): HostNode {
  return {
    type, props: {}, children: [], text: '', parent: null, value: '', checked: false, selected: false, listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler },
    removeEventListener(name, handler) { if (this.listeners[name] === handler) delete this.listeners[name] },
    getRootNode() { let node: HostNode = this; while (node.parent) node = node.parent; return node },
    get options() { return this.children.flatMap(child => child.type === 'option' ? [child] : child.options) },
  }
}

function all(root: HostNode, predicate: (node: HostNode) => boolean): HostNode[] {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))]
}

function textContent(node: HostNode): string { return node.text + node.children.map(textContent).join('') }

function compileComponent(fetcher: (...args: unknown[]) => Promise<unknown>, changed: () => void = () => {}, cryptoImpl: unknown = webcrypto) {
  const url = new URL('../components/GeoObservationAdmission.vue', import.meta.url)
  const parsed = parse(readFileSync(url, 'utf8'), { filename: url.pathname })
  if (!parsed.descriptor.scriptSetup) throw new Error('Admission script setup missing')
  const compiled = compileScript(parsed.descriptor, { id: 'geo-observation-admission-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = {
    module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nodeRequire(id),
    $fetch: fetcher, URL, document: { activeElement: null }, Document: class Document {}, ShadowRoot: class ShadowRoot {},
    crypto: cryptoImpl,
    TextEncoder,
  }
  sandbox.globalThis = sandbox
  runInNewContext(javascript, sandbox)
  const component = module.exports.default as Record<string, unknown>
  component.emits = ['changed']
  component.setup = wrapSetup(component.setup as (...args: unknown[]) => unknown, changed)
  return component
}

function wrapSetup(setup: (...args: unknown[]) => unknown, changed: () => void) {
  return (props: unknown, context: { emit: (event: string, ...args: unknown[]) => void }) => setup(props, { ...context, emit: (event: string, ...args: unknown[]) => { if (event === 'changed') changed(); context.emit(event, ...args) } })
}

function mount(component: unknown) {
  const renderer = createRenderer<HostNode, HostNode>({
    createElement: tag => hostNode(tag), createText: text => Object.assign(hostNode('#text'), { text }),
    createComment: text => Object.assign(hostNode('#comment'), { text }), setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === 'value') node.value = String(value ?? ''); if (key === 'checked') node.checked = Boolean(value) },
    insert: (child, parent, anchor) => { child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; at < 0 ? parent.children.push(child) : parent.children.splice(at, 0, child) },
    remove: node => { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) },
    parentNode: node => node.parent, nextSibling: node => { if (!node.parent) return null; const siblings = node.parent.children; return siblings[siblings.indexOf(node) + 1] || null },
  })
  const root = hostNode('root')
  const app = renderer.createApp(component as never)
  app.mount(root)
  return { app, root }
}

async function settle() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }

function button(root: HostNode, label: string): HostNode {
  const found = all(root, node => node.type === 'button' && textContent(node).includes(label))[0]
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}

function fire(node: HostNode, event: string) {
  const payload = { target: node }
  node.listeners[event]?.(payload)
  const name = `on${event[0]!.toUpperCase()}${event.slice(1)}`
  const handler = node.props[name]
  if (typeof handler === 'function') (handler as (event: { target: HostNode }) => void)(payload)
  const modelUpdate = node.props['onUpdate:modelValue']
  if (typeof modelUpdate === 'function' && (event === 'input' || event === 'change')) {
    (modelUpdate as (value: string | boolean) => void)(node.props.type === 'checkbox' ? node.checked : node.value)
  }
}

async function select(root: HostNode, value: string) {
  const node = all(root, item => item.type === 'select' && item.props['aria-label'] === '選擇已審查來源')[0]
  if (!node) throw new Error('Missing source selector')
  node.value = value
  for (const option of node.options) option.selected = option.value === value
  fire(node, 'change')
  await settle()
}

function labeledInput(root: HostNode, labelText: string, type: 'input' | 'textarea', value: string) {
  const label = all(root, node => node.type === 'label' && textContent(node).includes(labelText))[0]
  const control = label && all(label, node => node.type === type)[0]
  if (!control) throw new Error(`Missing ${type} for ${labelText}`)
  control.value = value
  fire(control, type === 'textarea' ? 'input' : 'input')
  fire(control, 'change')
  return control
}

function confirmLabel(root: HostNode, labelText: string) {
  const label = all(root, node => node.type === 'label' && textContent(node).includes(labelText))[0]
  const control = label && all(label, node => node.type === 'input' && node.props.type === 'checkbox')[0]
  if (!control) throw new Error(`Missing confirmation ${labelText}`)
  control.checked = true
  fire(control, 'change')
  return control
}

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = 'c'.repeat(64)
const H4 = 'f'.repeat(64)
const uncitedUrl = 'https://uncited.example/negative'
const uncitedIdentity = createHash('sha256').update(JSON.stringify({ canonicalCandidateUrl: uncitedUrl })).digest('hex')
const source = {
  sourceRecordId: 41, provider: 'consumer-snapshot', model: 'reviewed-export', locale: 'zh-TW',
  observedAt: '2026-10-08T00:00:00.000Z', responseHash: H1, citationCount: 1, eligible: true, reasonCodes: [],
}
const emptyWorkspace = { sources: [source], nextCursor: null, selectedSource: null }
const selectedWorkspace = (observation: Record<string, unknown> | null = null, sourceRecordId = 41, candidateUrl = 'https://public.example/page', intakeEnabled = false) => ({
  sources: [], nextCursor: null,
  selectedSource: {
    ...source, sourceRecordId, intakeEnabled,
    citations: [{ candidateUrl, candidatePageIdentityHash: H2, citationPosition: 1, observation }],
    candidateSets: intakeEnabled ? [{ decisionId: 'decision-1', candidateSetFingerprint: H3, decision: 'approve', memberCount: 1, createdAt: '2026-10-08T01:00:00.000Z' }] : [],
    candidateAuthorities: intakeEnabled ? [{ candidatePageIdentityHash: H2, canonicalPageHash: H1, websiteIdentityHash: H2, candidateSetFingerprint: H3, authorityBasis: 'manual_owner_attested_v1', citationStatus: 'cited', observation }] : [],
  },
})
const pendingObservation = {
  observationFingerprint: H3, candidatePageIdentityHash: H2, contentHash: H1, citationStatus: 'cited', citationPosition: 1,
  verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown', featureOrigin: 'unknown_external', missingFeatureCount: 3,
}
const candidateSetReceipt = (decision: 'approve' | 'revoke', candidateSetFingerprint: string, memberCount: number) => ({
  decisionId: `geo-candidate-review-${'d'.repeat(20)}`, decision, candidateSetFingerprint, memberCount,
  decisionFingerprint: 'e'.repeat(64), createdAt: '2026-10-08T01:00:00.000Z',
})
function governanceResponse(action: string, reason: string) {
  const verificationStatus = action === 'revoke' ? 'revoked' : 'unverified'
  const consentStatus = action === 'approve_consent' ? 'approved' : action === 'revoke' ? 'revoked' : 'unknown'
  const piiStatus = action === 'approve_pii' ? 'clean' : 'unknown'
  const factType = action === 'verify_evidence' ? 'evidence_verification' : action === 'approve_consent' ? 'consent_review' : action === 'approve_pii' ? 'pii_review' : 'revocation'
  const evidenceLocatorHash = action === 'verify_evidence' ? 'f'.repeat(64) : null
  return {
    status: 'success', observation: { observationFingerprint: H3, verificationStatus, consentStatus, piiStatus },
    verificationDecision: {
      decisionId: `geo-governance-${'a'.repeat(20)}`, ownerUserId: 7, observationFingerprint: H3, reviewerUserId: 7,
      previousVerificationStatus: 'unverified', newVerificationStatus: verificationStatus, evidenceLocatorHash,
      factType, factStatus: action === 'revoke' ? 'revoked' : 'approved', reason, decisionFingerprint: 'b'.repeat(64),
      consentStatus, piiStatus, createdAt: '2026-10-08T01:00:00.000Z',
    },
    evidenceBinding: action === 'verify_evidence' ? {
      ownerUserId: 7, observationFingerprint: H3, evidenceLocatorHash, purpose: 'geo_outcome_verification',
      sourceKind: 'llm_visibility_observation', sourceRecordId: 41, sourceProjectId: 2, sourceQueryId: 3, sourceRunId: 4,
      sourceResponseHash: H1, sourceCitationSetFingerprint: 'c'.repeat(64), candidateAuthorityId: 5,
      candidateAuthorityFingerprint: 'd'.repeat(64), candidateSetFingerprint: H3, canonicalCandidateUrlHash: 'e'.repeat(64),
      serverDerivedCitationStatus: 'cited', serverDerivedCitationPosition: 1, evidenceBindingFingerprint: '1'.repeat(64),
      sourceObservedAt: '2026-10-08T00:00:00.000Z', createdAt: '2026-10-08T01:00:00.000Z',
    } : null,
  }
}

describe('Geo observation admission mounted runtime', () => {
  it('loads only owner workspace GET on mount and leaves empty state empty', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (..._args: unknown[]) => ({ status: 'success', workspace: { sources: [], nextCursor: null, selectedSource: null } }))
    const { app, root } = mount(compileComponent(fetcher))
    await settle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/geo-outcome-model/admission/workspace')
    expect(fetcher.mock.calls[0]?.[1]).toEqual({ query: {} })
    expect(textContent(root)).toContain('尚無可選的已審查 consumer snapshot')
    expect(fetcher.mock.calls.some(call => (call[1] as { method?: string } | undefined)?.method === 'POST')).toBe(false)
    app.unmount()
  })

  it('selects a real listed source and intake posts only server-derived identity input with safe pending reply', async () => {
    let intakeMade = false
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, MockRequestOptions | undefined]
      if (path.endsWith('/workspace') && options?.method !== 'POST') return options?.query?.sourceRecordId ? { status: 'success', workspace: selectedWorkspace(intakeMade ? pendingObservation : null, 41, 'https://public.example/page', true) } : { status: 'success', workspace: emptyWorkspace }
      if (path.endsWith('/admission/intake')) { intakeMade = true; return { status: 'success', observation: { ...pendingObservation, sourceRecordId: 41, governanceIndependent: true, trainingAdmission: false, productionActivation: false, replayed: false } } }
      throw new Error('unexpected local mocked request')
    })
    const changed = vi.fn()
    const { app, root } = mount(compileComponent(fetcher, changed))
    await settle()
    await select(root, '41')
    expect(textContent(root)).toContain('https://public.example/page')
    button(root, '建立待審 observation').props.onClick && (button(root, '建立待審 observation').props.onClick as () => void)()
    await settle()
    const intake = fetcher.mock.calls.find(call => call[0] === '/api/geo-outcome-model/admission/intake')
    expect(intake?.[1]).toMatchObject({ method: 'POST', body: { sourceRecordId: 41, candidateUrl: 'https://public.example/page' } })
    expect(intake?.[1]).not.toHaveProperty('body.citationStatus')
    expect(intake?.[1]).not.toHaveProperty('body.featureOrigin')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(textContent(root)).toContain('Intake receipt 已確認；不代表 evidence、consent、PII 或訓練核准')
    expect(textContent(root)).toContain('特徵缺失／來源未知會保留為 unknown')
    expect(textContent(root)).toContain('unknown_external')
    app.unmount()
  })

  it('treats a replayed original pending receipt as historical and renders the refreshed current verified state', async () => {
    let intakeReplayed = false
    const current = { ...pendingObservation, verificationStatus: 'verified', consentStatus: 'approved', piiStatus: 'clean' }
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { method?: string, query?: { sourceRecordId?: number } } | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId
        ? { status: 'success', workspace: selectedWorkspace(intakeReplayed ? current : null, 41, 'https://public.example/page', true) }
        : { status: 'success', workspace: emptyWorkspace }
      if (path.endsWith('/admission/intake')) {
        intakeReplayed = true
        return { status: 'success', observation: { ...pendingObservation, sourceRecordId: 41, governanceIndependent: true, trainingAdmission: false, productionActivation: false, replayed: true } }
      }
      throw new Error('unexpected local mocked request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    ;(button(root, '建立待審 observation').props.onClick as () => void)(); await settle()
    const rendered = textContent(root)
    expect(rendered).toContain('已重播原始 intake receipt；它不是目前治理狀態或核准')
    expect(rendered).toContain('verified')
    expect(rendered).toContain('Consentapproved')
    expect(rendered).toContain('PII reviewclean')
    expect(rendered).not.toContain('紀錄仍待獨立審查')
    app.unmount()
  })

  it('blocks invalid candidate review until same-run proof, reason, exact hashes and confirmation exist', async () => {
    let approved = false
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, MockRequestOptions | undefined]
      if (path.endsWith('/workspace')) {
        if (!options?.query?.sourceRecordId) return { status: 'success', workspace: emptyWorkspace }
        const current = selectedWorkspace(null, 41, 'https://public.example/page', approved)
        if (approved && current.selectedSource) {
          current.selectedSource.candidateSets = [{ decisionId: 'new-decision', candidateSetFingerprint: H4, decision: 'approve', memberCount: 1, createdAt: '2026-10-08T01:00:00.000Z' }]
          current.selectedSource.candidateAuthorities = [{ candidatePageIdentityHash: H2, canonicalPageHash: H1, websiteIdentityHash: H2, candidateSetFingerprint: H4, authorityBasis: 'manual_owner_attested_v1', citationStatus: 'cited', observation: null }]
        }
        return { status: 'success', workspace: current }
      }
      approved = true
      return candidateSetReceipt('approve', H3, 1)
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    const approve = button(root, '提交人工 candidate-set review')
    expect(approve.props.disabled).toBe(true)
    labeledInput(root, '候選 URL', 'input', 'http://other.example/page')
    labeledInput(root, '實際頁面 snapshot SHA-256', 'input', H1)
    labeledInput(root, 'Owner 審查理由', 'textarea', '已逐項核對同次檢索結果')
    expect(approve.props.disabled).toBe(true)
    confirmLabel(root, '我確認這些 URL 是同一 source run')
    await nextTick()
    expect(button(root, '提交人工 candidate-set review').props.disabled).toBe(true)
    labeledInput(root, '候選 URL', 'input', 'https://other.example/page')
    await nextTick()
    expect(button(root, '提交人工 candidate-set review').props.disabled).toBe(false)
    ;(button(root, '提交人工 candidate-set review').props.onClick as () => void)()
    await settle()
    const call = fetcher.mock.calls.find(item => item[0] === '/api/geo-outcome-model/candidate-sets/review')
    expect(call?.[1]).toMatchObject({ method: 'POST', body: { sourceRecordId: 41, decision: 'approve', reason: '已逐項核對同次檢索結果', candidates: [{ candidateUrl: 'https://other.example/page', contentHash: H1 }] } })
    expect(call?.[1]).not.toHaveProperty('body.featureJson')
    expect(textContent(root)).toContain('候選集審查已記錄；不是訓練核准。')
    labeledInput(root, '候選 URL', 'input', 'https://other.example/page')
    labeledInput(root, '實際頁面 snapshot SHA-256', 'input', H1)
    labeledInput(root, 'Owner 審查理由', 'textarea', '已逐項核對同次檢索結果')
    confirmLabel(root, '我確認這些 URL 是同一 source run')
    ;(button(root, '提交人工 candidate-set review').props.onClick as () => void)(); await settle()
    const approvals = fetcher.mock.calls.filter(item => item[0] === '/api/geo-outcome-model/candidate-sets/review')
    expect((approvals[1]?.[1] as { body: { idempotencyKey: string } }).body.idempotencyKey).not.toBe((approvals[0]?.[1] as { body: { idempotencyKey: string } }).body.idempotencyKey)
    expect(textContent(root)).not.toContain('https://other.example/page')
    app.unmount()
  })

  it('retains an idempotency key across a failed exact retry and changes it when request content changes', async () => {
    let reviewCount = 0
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, MockRequestOptions | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId ? { status: 'success', workspace: selectedWorkspace() } : { status: 'success', workspace: emptyWorkspace }
      if (path.endsWith('/candidate-sets/review')) {
        reviewCount++
        if (reviewCount === 1) throw Object.assign(new Error('PRIVATE BODY'), { statusCode: 503, data: { message: 'SECRET' } })
        return candidateSetReceipt('approve', H3, 1)
      }
      throw new Error('unexpected local mocked request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    labeledInput(root, '候選 URL', 'input', 'https://other.example/page')
    labeledInput(root, '實際頁面 snapshot SHA-256', 'input', H1)
    labeledInput(root, 'Owner 審查理由', 'textarea', '人工確認 A')
    confirmLabel(root, '我確認這些 URL 是同一 source run')
    const approve = button(root, '提交人工 candidate-set review')
    ;(approve.props.onClick as () => void)(); await settle()
    expect(textContent(root)).toContain('服務暫不可用')
    expect(textContent(root)).not.toContain('SECRET')
    ;(button(root, '提交人工 candidate-set review').props.onClick as () => void)(); await settle()
    const reviews = fetcher.mock.calls.filter(call => call[0] === '/api/geo-outcome-model/candidate-sets/review')
    const first = (reviews[0]?.[1] as { body: Record<string, unknown> }).body
    const second = (reviews[1]?.[1] as { body: Record<string, unknown> }).body
    expect(first.idempotencyKey).toBe(second.idempotencyKey)
    expect(first).toEqual(second)
    app.unmount()
  })

  it('keeps each governance action independent and binds sourceRecordId only to evidence verification', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { method?: string, query?: { sourceRecordId?: number }, body?: Record<string, unknown> } | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId ? { status: 'success', workspace: selectedWorkspace(pendingObservation, 41, 'https://public.example/page', true) } : { status: 'success', workspace: emptyWorkspace }
      return governanceResponse(String(options?.body?.action), String(options?.body?.reason))
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    const actionSection = all(root, node => node.type === 'section' && node.props.class === 'governance-action' && textContent(node).includes('核對 primary evidence'))[0]
    if (!actionSection) throw new Error('Missing evidence governance section')
    const reason = all(actionSection, node => node.type === 'textarea')[0]
    if (!reason) throw new Error('Missing evidence reason input')
    reason.value = '已對照原始 consumer snapshot'; fire(reason, 'input'); fire(reason, 'change')
    const confirm = all(actionSection, node => node.type === 'input' && node.props.type === 'checkbox')[0]
    if (!confirm) throw new Error('Missing evidence confirmation')
    confirm.checked = true; fire(confirm, 'change'); await nextTick()
    const submit = all(actionSection, node => node.type === 'button')[0]
    if (!submit || typeof submit.props.onClick !== 'function') throw new Error('Missing evidence submit button')
    ;(submit.props.onClick as () => void)(); await settle()
    const call = fetcher.mock.calls.find(item => String(item[0]).endsWith(`/observations/${H3}/verify`))
    expect(call?.[1]).toMatchObject({ method: 'POST', body: { action: 'verify_evidence', reason: '已對照原始 consumer snapshot', sourceRecordId: 41 } })
    expect(textContent(root)).toContain('Unknown')
    app.unmount()
  })

  it('sends consent, PII, and revoke as independent owner decisions without source binding', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { method?: string, query?: { sourceRecordId?: number }, body?: Record<string, unknown> } | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId ? { status: 'success', workspace: selectedWorkspace(pendingObservation, 41, 'https://public.example/page', true) } : { status: 'success', workspace: emptyWorkspace }
      return governanceResponse(String(options?.body?.action), String(options?.body?.reason))
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    const targets = [
      { label: '獨立核准 consent', action: 'approve_consent' },
      { label: '獨立核准 PII 檢查', action: 'approve_pii' },
      { label: '終止撤回此 observation', action: 'revoke' },
    ]
    for (const [index, target] of targets.entries()) {
      const section = all(root, node => node.type === 'section' && node.props.class === 'governance-action' && textContent(node).includes(target.label))[0]
      if (!section) throw new Error(`Missing independent ${target.action} section`)
      const reason = all(section, node => node.type === 'textarea')[0]
      const confirm = all(section, node => node.type === 'input' && node.props.type === 'checkbox')[0]
      const submit = all(section, node => node.type === 'button')[0]
      if (!reason || !confirm || !submit || typeof submit.props.onClick !== 'function') throw new Error(`Incomplete ${target.action} controls`)
      reason.value = `獨立檢查 ${target.action}`; fire(reason, 'input'); fire(reason, 'change')
      confirm.checked = true; fire(confirm, 'change'); await nextTick()
      ;(submit.props.onClick as () => void)(); await settle()
    }
    const writes = fetcher.mock.calls.filter(call => String(call[0]).endsWith(`/observations/${H3}/verify`))
    expect(writes).toHaveLength(3)
    for (const [index, target] of targets.entries()) {
      const options = writes[index]?.[1] as { method: string, body: Record<string, unknown> }
      expect(options.method).toBe('POST')
      expect(options.body).toMatchObject({ action: target.action, reason: `獨立檢查 ${target.action}` })
      expect(options.body).not.toHaveProperty('sourceRecordId')
    }
    expect(new Set(writes.map(call => (call[1] as { body: { idempotencyKey: string } }).body.idempotencyKey)).size).toBe(3)
    app.unmount()
  })

  it('validates an in-flight governance receipt against the submitted reason, not later form edits', async () => {
    let resolveReview: (() => void) | undefined
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, MockRequestOptions | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId
        ? { status: 'success', workspace: selectedWorkspace(pendingObservation, 41, 'https://public.example/page', true) }
        : { status: 'success', workspace: emptyWorkspace }
      return await new Promise(resolve => {
        const receipt = governanceResponse(String(options?.body?.action), String(options?.body?.reason))
        resolveReview = () => resolve(receipt)
      })
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    const section = all(root, node => node.type === 'section' && node.props.class === 'governance-action' && textContent(node).includes('獨立核准 consent'))[0]
    const reason = section && all(section, node => node.type === 'textarea')[0]
    const confirm = section && all(section, node => node.type === 'input' && node.props.type === 'checkbox')[0]
    const submit = section && all(section, node => node.type === 'button')[0]
    if (!reason || !confirm || !submit || typeof submit.props.onClick !== 'function') throw new Error('Missing consent controls')
    reason.value = '這次提交的同意依據'; fire(reason, 'input'); fire(reason, 'change')
    confirm.checked = true; fire(confirm, 'change'); await nextTick()
    ;(submit.props.onClick as () => void)(); await nextTick()
    reason.value = '下一次操作的不同理由'; fire(reason, 'input'); fire(reason, 'change')
    resolveReview?.(); await settle()
    expect(textContent(root)).toContain('治理決定已記錄')
    expect(textContent(root)).not.toContain('服務暫不可用')
    const write = fetcher.mock.calls.find(call => String(call[0]).endsWith(`/observations/${H3}/verify`))
    expect(write?.[1]).toMatchObject({ body: { reason: '這次提交的同意依據' } })
    app.unmount()
  })

  it('rejects an apparent governance success whose evidence binding names another source', async () => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { query?: { sourceRecordId?: number }, body?: Record<string, unknown> } | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId
        ? { status: 'success', workspace: selectedWorkspace(pendingObservation, 41, 'https://public.example/page', true) }
        : { status: 'success', workspace: emptyWorkspace }
      const forged = governanceResponse(String(options?.body?.action), String(options?.body?.reason))
      if (forged.evidenceBinding) forged.evidenceBinding.sourceRecordId = 42
      return forged
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    const section = all(root, node => node.type === 'section' && node.props.class === 'governance-action' && textContent(node).includes('核對 primary evidence'))[0]
    if (!section) throw new Error('Missing evidence governance section')
    const reason = all(section, node => node.type === 'textarea')[0]
    const confirm = all(section, node => node.type === 'input' && node.props.type === 'checkbox')[0]
    const submit = all(section, node => node.type === 'button')[0]
    if (!reason || !confirm || !submit) throw new Error('Incomplete evidence confirmation controls')
    reason.value = '核對 source binding'; fire(reason, 'input'); fire(reason, 'change')
    confirm.checked = true; fire(confirm, 'change'); await nextTick()
    ;(submit.props.onClick as () => void)(); await settle()
    expect(textContent(root)).toContain('服務暫不可用')
    expect(textContent(root)).not.toContain('治理決定已記錄')
    expect(textContent(root)).not.toContain('sourceRecordId: 42')
    app.unmount()
  })

  it('supports explicitly confirmed candidate-set revoke with its exact fingerprint and no candidate payload', async () => {
    const approvedSet = { decisionId: 'decision-1', candidateSetFingerprint: H3, decision: 'approve', memberCount: 1, createdAt: '2026-10-08T01:00:00Z' }
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, MockRequestOptions | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId ? { status: 'success', workspace: { ...selectedWorkspace(), selectedSource: { ...selectedWorkspace().selectedSource, candidateSets: [approvedSet] } } } : { status: 'success', workspace: emptyWorkspace }
      return candidateSetReceipt('revoke', H3, 0)
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    labeledInput(root, '撤銷理由', 'textarea', '人工核對 authority 已失效')
    expect(button(root, '撤銷此 candidate set').props.disabled).toBe(true)
    confirmLabel(root, '我確認要撤銷這組精確 candidate-set authority')
    await nextTick()
    ;(button(root, '撤銷此 candidate set').props.onClick as () => void)(); await settle()
    const write = fetcher.mock.calls.find(call => call[0] === '/api/geo-outcome-model/candidate-sets/review' && (call[1] as { body?: { decision?: string } } | undefined)?.body?.decision === 'revoke')
    expect(write?.[1]).toMatchObject({ method: 'POST', body: { sourceRecordId: 41, decision: 'revoke', reason: '人工核對 authority 已失效', candidateSetFingerprint: H3 } })
    expect(write?.[1]).not.toHaveProperty('body.candidates')
    app.unmount()
  })

  it.each([[401, '需要 owner session'], [409, '資料已變更或請求識別衝突'], [503, '服務暫不可用']])('maps status %i to static non-reflective text', async (status, message) => {
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, MockRequestOptions | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId ? { status: 'success', workspace: selectedWorkspace(null, 41, 'https://public.example/page', true) } : { status: 'success', workspace: emptyWorkspace }
      throw Object.assign(new Error('SECRET ERROR'), { statusCode: status, data: { message: 'PRIVATE BODY' } })
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    ;(button(root, '建立待審 observation').props.onClick as () => void)(); await settle()
    expect(textContent(root)).toContain(message)
    expect(textContent(root)).not.toContain('SECRET ERROR')
    expect(textContent(root)).not.toContain('PRIVATE BODY')
    app.unmount()
  })

  it('drops a selected-source response arriving after the owner changes source', async () => {
    let resolveSelected: ((value: unknown) => void) | undefined
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { query?: { sourceRecordId?: number } } | undefined]
      if (!path.endsWith('/workspace')) throw new Error('unexpected path')
      if (options?.query?.sourceRecordId === 41) return await new Promise(resolve => { resolveSelected = resolve })
      return { status: 'success', workspace: { ...emptyWorkspace, sources: [{ ...source, sourceRecordId: 42 }] } }
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41'); await select(root, '42')
    resolveSelected?.({ status: 'success', workspace: selectedWorkspace() })
    await settle()
    expect(textContent(root)).not.toContain('SOURCE RECORD #41')
    expect(textContent(root)).not.toContain('https://public.example/page')
    app.unmount()
  })

  it('prevents ABA source responses from restoring stale data and clears confirmations on every source switch', async () => {
    let firstAResolve: ((value: unknown) => void) | undefined
    let sourceACalls = 0
    const source42 = { ...source, sourceRecordId: 42, model: 'other-reviewed-export' }
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { query?: { sourceRecordId?: number } } | undefined]
      if (!path.endsWith('/workspace')) throw new Error('unexpected path')
      const sourceRecordId = options?.query?.sourceRecordId
      if (!sourceRecordId) return { status: 'success', workspace: { sources: [source, source42], nextCursor: null, selectedSource: null } }
      if (sourceRecordId === 42) return { status: 'success', workspace: selectedWorkspace(null, 42, 'https://source-b.example/current') }
      sourceACalls++
      if (sourceACalls === 1) return await new Promise(resolve => { firstAResolve = resolve })
      return { status: 'success', workspace: selectedWorkspace(pendingObservation, 41, `https://source-a.example/current-${sourceACalls}`) }
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41'); await select(root, '42'); await select(root, '41')
    expect(textContent(root)).toContain('https://source-a.example/current-2')
    const evidenceSection = all(root, node => node.type === 'section' && node.props.class === 'governance-action' && textContent(node).includes('核對 primary evidence'))[0]
    if (!evidenceSection) throw new Error('Missing evidence confirmation controls')
    const reason = all(evidenceSection, node => node.type === 'textarea')[0]
    if (!reason) throw new Error('Missing evidence reason control')
    reason.value = '此 source 的審查理由'; fire(reason, 'input'); fire(reason, 'change')
    confirmLabel(root, '我已獨立核對並確認只提交此項 verify_evidence')
    await select(root, '42'); await select(root, '41')
    const clearedSection = all(root, node => node.type === 'section' && node.props.class === 'governance-action' && textContent(node).includes('核對 primary evidence'))[0]
    const clearedReason = clearedSection && all(clearedSection, node => node.type === 'textarea')[0]
    const clearedConfirm = clearedSection && all(clearedSection, node => node.type === 'input' && node.props.type === 'checkbox')[0]
    expect(clearedReason?.value).toBe('')
    expect(clearedConfirm?.checked).toBe(false)
    firstAResolve?.({ status: 'success', workspace: selectedWorkspace(pendingObservation, 41, 'https://source-a.example/stale') })
    await settle()
    expect(textContent(root)).toContain('https://source-a.example/current-3')
    expect(textContent(root)).not.toContain('https://source-a.example/stale')
    app.unmount()
  })

  it('does not render a pending mutation result into a later ABA selection', async () => {
    let resolveIntake: ((value: unknown) => void) | undefined
    const source42 = { ...source, sourceRecordId: 42, model: 'other-reviewed-export' }
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { method?: string, query?: { sourceRecordId?: number } } | undefined]
      const sourceRecordId = options?.query?.sourceRecordId
      if (path.endsWith('/workspace')) return sourceRecordId
        ? { status: 'success', workspace: selectedWorkspace(null, sourceRecordId, `https://source-${sourceRecordId}.example/current`, true) }
        : { status: 'success', workspace: { sources: [source, source42], nextCursor: null, selectedSource: null } }
      if (path.endsWith('/admission/intake')) return await new Promise(resolve => { resolveIntake = resolve })
      throw new Error('unexpected local mocked request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    ;(button(root, '建立待審 observation').props.onClick as () => void)()
    await nextTick()
    await select(root, '42'); await select(root, '41')
    resolveIntake?.({ status: 'success', observation: { ...pendingObservation, sourceRecordId: 41, governanceIndependent: true, trainingAdmission: false, productionActivation: false, replayed: false } })
    await settle()
    expect(textContent(root)).not.toContain('已建立待審 observation；證據、consent 與 PII 均未核准。')
    expect(textContent(root)).toContain('https://source-41.example/current')
    expect(button(root, '建立待審 observation').props.disabled).toBe(false)
    app.unmount()
  })

  it('fails closed when a selected-source response identifies a different source than requested', async () => {
    const source42 = { ...source, sourceRecordId: 42 }
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { query?: { sourceRecordId?: number } } | undefined]
      if (!path.endsWith('/workspace')) throw new Error('unexpected path')
      return options?.query?.sourceRecordId
        ? { status: 'success', workspace: selectedWorkspace(null, 42) }
        : { status: 'success', workspace: { sources: [source, source42], nextCursor: null, selectedSource: null } }
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    expect(textContent(root)).toContain('來源資料無法安全讀取；請重新載入')
    expect(textContent(root)).not.toContain('SOURCE RECORD #42')
    app.unmount()
  })

  it('does not offer citation intake when an active set does not authorize that exact candidate identity', async () => {
    const mismatched = selectedWorkspace(null, 41, 'https://public.example/page', true)
    if (!mismatched.selectedSource) throw new Error('Missing selected source fixture')
    mismatched.selectedSource.candidateAuthorities = [{
      candidatePageIdentityHash: H4, canonicalPageHash: H1, websiteIdentityHash: H2, candidateSetFingerprint: H3,
      authorityBasis: 'manual_owner_attested_v1', citationStatus: 'not_cited', observation: null,
    }]
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { query?: { sourceRecordId?: number } } | undefined]
      if (!path.endsWith('/workspace')) throw new Error('unexpected path')
      return options?.query?.sourceRecordId ? { status: 'success', workspace: mismatched } : { status: 'success', workspace: emptyWorkspace }
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    expect(textContent(root)).toContain('https://public.example/page')
    expect(all(root, node => node.type === 'button' && textContent(node).includes('建立待審 observation'))).toHaveLength(0)
    app.unmount()
  })

  it.each([uncitedUrl, uncitedUrl.replace('public.example', 'PUBLIC.example')])('after a fresh mount, matches canonical identity for %s and intakes the existing active authority', async enteredUrl => {
    const selected = selectedWorkspace(null, 41, 'https://public.example/page', true)
    if (!selected.selectedSource) throw new Error('Missing selected source fixture')
    selected.selectedSource.candidateSets = [{ decisionId: 'existing-approved', candidateSetFingerprint: H4, decision: 'approve', memberCount: 1, createdAt: '2026-10-08T01:00:00.000Z' }]
    selected.selectedSource.candidateAuthorities = [{ candidatePageIdentityHash: uncitedIdentity, canonicalPageHash: H1, websiteIdentityHash: H2, candidateSetFingerprint: H4, authorityBasis: 'manual_owner_attested_v1', citationStatus: 'not_cited', observation: null }]
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { method?: string, query?: { sourceRecordId?: number }, body?: Record<string, unknown> } | undefined]
      if (path.endsWith('/workspace')) return options?.query?.sourceRecordId ? { status: 'success', workspace: selected } : { status: 'success', workspace: emptyWorkspace }
      if (path.endsWith('/admission/intake')) return { status: 'success', observation: { ...pendingObservation, candidatePageIdentityHash: uncitedIdentity, citationStatus: 'not_cited', citationPosition: null, sourceRecordId: 41, governanceIndependent: true, trainingAdmission: false, productionActivation: false, replayed: false } }
      throw new Error('unexpected local mocked request')
    })
    const { app, root } = mount(compileComponent(fetcher))
    await settle(); await select(root, '41')
    expect(textContent(root)).toContain(uncitedIdentity)
    expect(textContent(root)).not.toContain(uncitedUrl)
    labeledInput(root, '已核准候選 URL', 'input', enteredUrl)
    ;(button(root, '核對目前既有 authority').props.onClick as () => void)()
    await settle()
    expect(textContent(root)).toContain('已和目前核准的未引用 authority 精確比對')
    ;(button(root, '建立待審 observation').props.onClick as () => void)()
    await settle()
    const intake = fetcher.mock.calls.find(call => call[0] === '/api/geo-outcome-model/admission/intake')
    expect(intake?.[1]).toMatchObject({ method: 'POST', body: { sourceRecordId: 41, candidateUrl: uncitedUrl } })
    expect(intake?.[1]).not.toHaveProperty('body.citationStatus')
    expect(intake?.[1]).not.toHaveProperty('body.candidatePageIdentityHash')
    app.unmount()
  })

  it.each([
    ['unknown URL', false, true, webcrypto],
    ['revoked candidate set', true, false, webcrypto],
    ['missing Web Crypto subtle', false, false, { randomUUID: webcrypto.randomUUID.bind(webcrypto) }],
  ])('fails closed for %s without writing', async (_label, revokeSet, useDifferentUrl, cryptoImpl) => {
    const selected = selectedWorkspace(null, 41, 'https://public.example/page', true)
    if (!selected.selectedSource) throw new Error('Missing selected source fixture')
    const activeUrl = useDifferentUrl ? uncitedUrl : uncitedUrl
    const activeIdentity = createHash('sha256').update(JSON.stringify({ canonicalCandidateUrl: activeUrl })).digest('hex')
    selected.selectedSource.candidateSets = [{ decisionId: 'existing-approved', candidateSetFingerprint: H4, decision: 'approve', memberCount: 1, createdAt: '2026-10-08T01:00:00.000Z' }, ...(revokeSet ? [{ decisionId: 'existing-revoked', candidateSetFingerprint: H4, decision: 'revoke' as const, memberCount: 0, createdAt: '2026-10-08T01:01:00.000Z' }] : [])]
    selected.selectedSource.candidateAuthorities = [{ candidatePageIdentityHash: activeIdentity, canonicalPageHash: H1, websiteIdentityHash: H2, candidateSetFingerprint: H4, authorityBasis: 'manual_owner_attested_v1', citationStatus: 'not_cited', observation: null }]
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { method?: string, query?: { sourceRecordId?: number } } | undefined]
      if (!path.endsWith('/workspace')) throw new Error('unexpected local mocked write')
      return options?.query?.sourceRecordId ? { status: 'success', workspace: selected } : { status: 'success', workspace: emptyWorkspace }
    })
    const { app, root } = mount(compileComponent(fetcher, () => {}, cryptoImpl))
    await settle(); await select(root, '41')
    const inputUrl = useDifferentUrl ? 'https://unknown.example/not-approved' : uncitedUrl
    labeledInput(root, '已核准候選 URL', 'input', inputUrl)
    ;(button(root, '核對目前既有 authority').props.onClick as () => void)()
    await settle()
    expect(fetcher.mock.calls.some(call => (call[1] as { method?: string } | undefined)?.method === 'POST')).toBe(false)
    expect(all(root, node => node.type === 'button' && textContent(node).includes('建立待審 observation'))).toHaveLength(0)
    if (cryptoImpl !== webcrypto) expect(textContent(root)).toContain('此瀏覽器無法安全核對既有 authority')
    else expect(textContent(root)).toContain('找不到符合此 URL 的目前有效未引用核准 authority')
    app.unmount()
  })

  it('clears a checked URL and ignores late Web Crypto results after an ABA source switch', async () => {
    let resolveDigest: ((value: ArrayBuffer) => void) | undefined
    const delayedCrypto = {
      randomUUID: webcrypto.randomUUID.bind(webcrypto),
      subtle: { digest: () => new Promise<ArrayBuffer>(resolve => { resolveDigest = resolve }) },
    }
    const selected = selectedWorkspace(null, 41, 'https://public.example/page', true)
    if (!selected.selectedSource) throw new Error('Missing selected source fixture')
    selected.selectedSource.candidateSets = [{ decisionId: 'existing-approved', candidateSetFingerprint: H4, decision: 'approve', memberCount: 1, createdAt: '2026-10-08T01:00:00.000Z' }]
    selected.selectedSource.candidateAuthorities = [{ candidatePageIdentityHash: uncitedIdentity, canonicalPageHash: H1, websiteIdentityHash: H2, candidateSetFingerprint: H4, authorityBasis: 'manual_owner_attested_v1', citationStatus: 'not_cited', observation: null }]
    const source42 = { ...source, sourceRecordId: 42, model: 'other-reviewed-export' }
    const fetcher = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args: unknown[]) => {
      const [path, options] = args as [string, { query?: { sourceRecordId?: number } } | undefined]
      if (!path.endsWith('/workspace')) throw new Error('unexpected local request')
      if (!options?.query?.sourceRecordId) return { status: 'success', workspace: { sources: [source, source42], nextCursor: null, selectedSource: null } }
      return { status: 'success', workspace: options.query.sourceRecordId === 41 ? selected : selectedWorkspace(null, 42, 'https://source-b.example/current') }
    })
    const { app, root } = mount(compileComponent(fetcher, () => {}, delayedCrypto))
    await settle(); await select(root, '41')
    labeledInput(root, '已核准候選 URL', 'input', uncitedUrl)
    ;(button(root, '核對目前既有 authority').props.onClick as () => void)()
    await nextTick()
    await select(root, '42'); await select(root, '41')
    const urlLabel = all(root, node => node.type === 'label' && textContent(node).includes('已核准候選 URL'))[0]
    const urlInput = urlLabel && all(urlLabel, node => node.type === 'input')[0]
    expect(urlInput?.value).toBe('')
    resolveDigest?.(new Uint8Array(createHash('sha256').update(JSON.stringify({ canonicalCandidateUrl: uncitedUrl })).digest()).buffer)
    await settle()
    expect(textContent(root)).not.toContain('已和目前核准的未引用 authority 精確比對')
    expect(all(root, node => node.type === 'button' && textContent(node).includes('建立待審 observation'))).toHaveLength(0)
    expect(fetcher.mock.calls.some(call => (call[1] as { method?: string } | undefined)?.method === 'POST')).toBe(false)
    app.unmount()
  })
})
