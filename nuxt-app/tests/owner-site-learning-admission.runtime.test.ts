import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { buildSiteLearningRelease, getSiteLearningWorkspace, type SiteLearningOptions } from '../server/content-operations/site-learning'
import type { ContentOperationOutcomeAssessmentRow } from '../server/content-operations/types'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'
import { learningFixture } from './support/learning-loop-memory-repository'

const nodeRequire = createRequire(import.meta.url)
const nuxtRequire = createRequire(nodeRequire.resolve('nuxt/package.json'))
const vue = nuxtRequire('vue') as typeof import('vue')
const { createRenderer, defineComponent, h, nextTick } = vue
const { compileScript, parse } = nuxtRequire('vue/compiler-sfc')
const componentPath = new URL('../components/OwnerSiteLearningAdmission.vue', import.meta.url)

type HostNode = { type: string; props: Record<string, unknown>; children: HostNode[]; text: string; parent: HostNode | null }
function node(type: string, text = ''): HostNode { return { type, props: {}, children: [], text, parent: null } }
function all(root: HostNode, predicate: (item: HostNode) => boolean): HostNode[] { return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))] }
function textContent(item: HostNode): string { return item.text + item.children.map(textContent).join('') }

const confirmationFingerprint = 'a'.repeat(64)
const authorizationFingerprint = 'b'.repeat(64)
const grantFingerprint = 'c'.repeat(64)
const assessmentFingerprint = 'd'.repeat(64)
const workspace = (options: { granted?: boolean; authorizations?: boolean; outcomes?: boolean; extra?: boolean; training?: boolean } = {}) => {
  const entry: Record<string, unknown> = {
    entryId: 11, targetRowId: 22, clientId: 3, label: '合成網站版本｜每日練習', confirmationFingerprint,
    grant: options.granted ? { state: 'active', fingerprint: grantFingerprint, authorizationId: 44 } : null,
    authorizations: options.authorizations === false ? [] : [{ id: 44, fingerprint: authorizationFingerprint, consentVersion: 'site-learning-v1', expiresAt: '2026-12-01T00:00:00.000Z' }],
  }
  if (options.extra) entry.customerId = 'must-not-render'
  return {
    entries: [entry],
    outcomes: options.outcomes === false ? [] : [{ id: 55, entryId: 11, targetRowId: 22, assessmentFingerprint, grantFingerprint, state: 'pending' }],
    release: { state: 'not_generated', status: 'gate_blocked', eligibleCandidateCount: 0, blockedOutcomeCount: 1, modelTrainingAllowed: options.training === true, citationTrainingEligible: false, limitations: ['synthetic_gate_fixture'] },
  }
}

function mountAdmission(value: unknown, releaseResult: unknown = null) {
  const source = readFileSync(componentPath, 'utf8')
  const parsed = parse(source, { filename: componentPath.pathname })
  if (parsed.errors.length) throw new Error('Owner site learning admission component did not parse.')
  const compiled = compileScript(parsed.descriptor, { id: 'owner-site-learning-admission-runtime', inlineTemplate: true })
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = { module, exports: module.exports, require: (id: string) => id === 'vue' ? vue : nuxtRequire(id) }
  sandbox.globalThis = sandbox
  sandbox.serializedValue = JSON.stringify(value)
  sandbox.serializedRelease = JSON.stringify(releaseResult)
  const propValue = value === undefined ? undefined : runInNewContext('JSON.parse(serializedValue)', sandbox)
  const parsedRelease = releaseResult === undefined ? undefined : runInNewContext('JSON.parse(serializedRelease)', sandbox)
  runInNewContext(javascript, sandbox)
  const renderer = createRenderer<HostNode, HostNode>({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _previous, next) => { item.props[key] = next },
    insert: (child, parent, anchor) => { child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(child) : parent.children.splice(index, 0, child) },
    remove: child => { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child) },
    parentNode: item => item.parent, nextSibling: item => { if (!item.parent) return null; const siblings = item.parent.children; return siblings[siblings.indexOf(item) + 1] || null },
    insertStaticContent: (content, parent, anchor) => { const item = node('#static', content); item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; index < 0 ? parent.children.push(item) : parent.children.splice(index, 0, item); return [item, item] },
  })
  const root = node('root')
  const events: { optIn: unknown[]; revoke: unknown[]; review: unknown[]; release: unknown[]; refresh: unknown[] } = { optIn: [], revoke: [], review: [], release: [], refresh: [] }
  const Component = module.exports.default
  const app = renderer.createApp(defineComponent({ setup: () => () => h(Component as never, {
    workspace: propValue, releaseResult: parsedRelease,
    onOptIn: (value: unknown) => events.optIn.push(value), onRevoke: (value: unknown) => events.revoke.push(value),
    onReview: (value: unknown) => events.review.push(value), onBuildRelease: () => events.release.push(true), onRefresh: () => events.refresh.push(true),
  }) }))
  app.mount(root)
  return { app, root, events }
}
function click(item: HostNode) { const handler = item.props.onClick; if (typeof handler === 'function') (handler as () => void)() }
function change(item: HostNode, checked: boolean) { const handler = item.props.onChange; if (typeof handler === 'function') (handler as (event: unknown) => void)({ target: { checked, value: item.props.value } }) }
function buttons(root: HostNode, label: string) { return all(root, item => item.type === 'button' && textContent(item).includes(label)) }
function checkboxes(root: HostNode) { return all(root, item => item.type === 'input' && item.props.type === 'checkbox') }

describe('OwnerSiteLearningAdmission mounted behavior', () => {
  it('keeps owner evidence and scope attestations unchecked, requires both, and emits exact selected authority', async () => {
    const { app, root, events } = mountAdmission(workspace())
    await nextTick()
    expect(textContent(root)).toContain('擁有人申明已有客戶模型用途同意證明，不是代客戶同意')
    expect(textContent(root)).toContain('LINE 發文同意、發布核准或網站公開均不等於模型用途同意')
    expect(textContent(root)).toContain('不會自動收數、訓練或部署模型')
    expect(checkboxes(root)).toHaveLength(2)
    expect(checkboxes(root).every(item => item.props.checked === false)).toBe(true)
    expect(buttons(root, '確認此網站版本接入成效資料')).toHaveLength(1)
    click(buttons(root, '確認此網站版本接入成效資料')[0]!)
    await nextTick()
    expect(checkboxes(root)).toHaveLength(4)
    const submit = buttons(root, '保存此版本接入授權')[0]!
    expect(submit.props.disabled).toBe(true)
    change(checkboxes(root)[0]!, true)
    await nextTick()
    expect(submit.props.disabled).toBe(true)
    change(checkboxes(root)[1]!, true)
    await nextTick()
    expect(submit.props.disabled).toBe(false)
    click(submit)
    await nextTick()
    expect(events.optIn).toEqual([{ entryId: 11, targetRowId: 22, confirmationFingerprint, authorizationId: 44, authorizationFingerprint }])
    expect(events.revoke).toHaveLength(0)
    app.unmount()
  })

  it('supports explicit opt-in cancellation without emitting a mutation', async () => {
    const { app, root, events } = mountAdmission(workspace())
    await nextTick()
    click(buttons(root, '確認此網站版本接入成效資料')[0]!)
    await nextTick()
    change(checkboxes(root)[0]!, true)
    change(checkboxes(root)[1]!, true)
    await nextTick()
    click(buttons(root, '取消')[0]!)
    await nextTick()
    expect(events.optIn).toHaveLength(0)
    expect(buttons(root, '確認此網站版本接入成效資料')).toHaveLength(1)
    expect(checkboxes(root).slice(0, 2).every(item => item.props.checked === false)).toBe(true)
    app.unmount()
  })

  it('permits explicit revocation when source authorizations are absent, with a second confirmation', async () => {
    const { app, root, events } = mountAdmission(workspace({ granted: true, authorizations: false, outcomes: false }))
    await nextTick()
    expect(textContent(root)).toContain('目前授權版本不可用')
    expect(buttons(root, '撤銷此網站版本的成效資料授權')).toHaveLength(1)
    click(buttons(root, '撤銷此網站版本的成效資料授權')[0]!)
    await nextTick()
    expect(buttons(root, '明確撤銷此授權')).toHaveLength(1)
    click(buttons(root, '取消')[0]!)
    await nextTick()
    expect(events.revoke).toHaveLength(0)
    click(buttons(root, '撤銷此網站版本的成效資料授權')[0]!)
    await nextTick()
    click(buttons(root, '明確撤銷此授權')[0]!)
    await nextTick()
    expect(events.revoke).toEqual([{ entryId: 11, targetRowId: 22, grantFingerprint }])
    app.unmount()
  })

  it('requires PII and limitations checks before approving or rejecting a data candidate', async () => {
    const { app, root, events } = mountAdmission(workspace())
    await nextTick()
    const approve = buttons(root, '核准這份資料准入候選')[0]!, reject = buttons(root, '排除此筆候選')[0]!
    expect(approve.props.disabled).toBe(true)
    expect(reject.props.disabled).toBe(true)
    const boxes = checkboxes(root)
    change(boxes[0]!, true)
    await nextTick()
    expect(approve.props.disabled).toBe(true)
    change(boxes[1]!, true)
    await nextTick()
    expect(approve.props.disabled).toBe(false)
    click(approve)
    await nextTick()
    expect(events.review).toEqual([{ id: 55, entryId: 11, targetRowId: 22, assessmentFingerprint, grantFingerprint, decision: 'approve' }])
    app.unmount()
  })

  it('requires a separate explicit release confirmation and shows non-training limits', async () => {
    const { app, root, events } = mountAdmission(workspace())
    await nextTick()
    expect(textContent(root)).toContain('模型訓練權限：未授予')
    expect(textContent(root)).toContain('引用模型准入：不適用')
    expect(buttons(root, '重新核對並建立最新成效資料釋出')).toHaveLength(1)
    click(buttons(root, '重新核對並建立最新成效資料釋出')[0]!)
    await nextTick()
    expect(buttons(root, '明確建立本次釋出')).toHaveLength(1)
    click(buttons(root, '取消')[0]!)
    await nextTick()
    expect(events.release).toHaveLength(0)
    click(buttons(root, '重新核對並建立最新成效資料釋出')[0]!)
    await nextTick()
    click(buttons(root, '明確建立本次釋出')[0]!)
    await nextTick()
    expect(events.release).toEqual([true])
    app.unmount()
  })

  it.each([
    ['unknown authority field', workspace({ extra: true })],
    ['contradictory training permission', workspace({ training: true })],
    ['missing workspace', undefined],
  ])('fails closed for %s without showing mutation controls', async (_label, value) => {
    const { app, root, events } = mountAdmission(value)
    await nextTick()
    expect(textContent(root)).toContain('目前無法確認網站成效資料准入狀態')
    expect(all(root, item => item.type === 'button').filter(item => ['確認此網站版本接入成效資料', '重新核對並建立最新成效資料釋出'].some(label => textContent(item).includes(label)))).toHaveLength(0)
    expect(events.optIn).toHaveLength(0)
    app.unmount()
  })

  it('does not present unknown release response as a successful candidate count', async () => {
    const invalidResult = { status: 'ready_for_review', eligibleCandidateCount: 99, candidateResults: [], datasetDigest: 'not-a-hash', releaseFingerprint: 'not-a-hash', modelTrainingAllowed: false, citationTrainingEligible: false, manifest: {} }
    const { app, root } = mountAdmission(workspace(), invalidResult)
    await nextTick()
    expect(textContent(root)).toContain('釋出回應不完整或格式未知')
    expect(textContent(root)).not.toContain('符合候選 99')
    app.unmount()
  })

  it('accepts real core workspace and release DTOs, retaining a blocked legacy outcome with nullable proof fields without review controls', async () => {
    const operations = new ContentOperationsFixture()
    const learning = learningFixture()
    const legacyOutcome = {
      id: 801, ownerUserId: 1, entryId: 52, runId: null, targetId: null, draftId: null,
      publicationReceiptFingerprint: null, publishedUrl: null, contentHash: null, evidenceSnapshotHash: null,
      assessmentStatus: 'blocked', assessmentFingerprint: 'e'.repeat(64), baselineSnapshot: [], followUpSnapshot: [],
      assessmentSnapshot: { evidenceKind: 'site_publication_confirmation', learningCandidate: false },
      consentLineageSnapshot: { consentStatus: 'unknown' }, idempotencyKey: 'synthetic-legacy-outcome-0001',
      measuredAt: new Date('2026-10-08T06:00:00.000Z'), createdAt: new Date('2026-10-08T06:00:00.000Z'),
    } as unknown as ContentOperationOutcomeAssessmentRow
    operations.outcomes.push(legacyOutcome)
    const options: SiteLearningOptions = {
      operations: operations.repository, learning: learning.repository, now: new Date('2026-10-08T07:00:00.000Z'),
      resolveSiteLineages: async () => [],
    }
    const projectedWorkspace = await getSiteLearningWorkspace(1, options)
    const projectedRelease = await buildSiteLearningRelease(1, options)
    expect(projectedWorkspace.outcomes).toContainEqual(expect.objectContaining({
      id: 801, state: 'blocked', targetRowId: null, grantFingerprint: null,
    }))
    expect(Object.keys(projectedRelease).sort()).toEqual([
      'blockedOutcomeCount', 'candidateResults', 'citationTrainingEligible', 'datasetDigest', 'eligibleCandidateCount',
      'limitations', 'manifest', 'modelTrainingAllowed', 'releaseFingerprint', 'status',
    ].sort())
    expect(projectedRelease).toMatchObject({ modelTrainingAllowed: false, citationTrainingEligible: false, blockedOutcomeCount: 1 })
    expect(projectedRelease).not.toHaveProperty('state')

    const { app, root } = mountAdmission(projectedWorkspace, projectedRelease)
    await nextTick()
    expect(textContent(root)).not.toContain('目前無法確認網站成效資料准入狀態')
    expect(textContent(root)).toContain('目前阻擋')
    expect(textContent(root)).toContain('這筆舊資料缺少網站目標或准入證明指紋；保留為受阻紀錄，不提供審查操作。')
    expect(textContent(root)).toContain(`符合候選 ${projectedRelease.eligibleCandidateCount}`)
    expect(buttons(root, '核准這份資料准入候選')).toHaveLength(0)
    expect(buttons(root, '排除此筆候選')).toHaveLength(0)
    app.unmount()
  })
})
