import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { articleReadyForPublication, articleStatus, cloneDocument, documentSignature, needsProgressReload, plainArticleDocument, safeArticleUrl, workbenchError, workspaceIdIsValid } from '../components/article-workbench/types'
import type { ArticleDocument, ArticleWorkspace } from '../components/article-workbench/types'

const requireHere = createRequire(import.meta.url), requireNuxt = createRequire(requireHere.resolve('nuxt/package.json'))
type Render = (...args: unknown[]) => unknown
const Vue = requireNuxt('vue') as { defineComponent(options: { setup?: () => Record<string, unknown>; render: Render; components?: Record<string, unknown> }): unknown; createSSRApp(component: unknown): unknown; h(tag: string): unknown }
const compiler = requireNuxt('@vue/compiler-sfc') as { parse(source: string): { descriptor: { template: { content: string } | null } }; compileTemplate(options: Record<string, unknown>): { code: string; errors: unknown[] } }
const renderer = createRequire(requireNuxt.resolve('vue/package.json'))('@vue/server-renderer') as { renderToString(app: unknown): Promise<string> }
const typescript = requireHere('typescript') as { transpileModule(source: string, options: Record<string, unknown>): { outputText: string } }
const file = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
async function render(path: string, context: Record<string, unknown>) {
  const source = compiler.parse(file(path)).descriptor.template?.content
  if (!source) throw new Error('missing template')
  const compiled = compiler.compileTemplate({ source, filename: path, id: 'article-workbench-ui', transformAssetUrls: false, compilerOptions: { mode: 'function' } })
  expect(compiled.errors).toEqual([])
  const preview = Vue.defineComponent({ render: () => Vue.h('article') })
  const code = typescript.transpileModule(compiled.code, { compilerOptions: { target: 99, module: 0 } }).outputText
  const component = Vue.defineComponent({ setup: () => context, render: new Function('Vue', code)(Vue) as Render, components: { ArticlePreview: preview } })
  return renderer.renderToString(Vue.createSSRApp(component))
}
const document: ArticleDocument = { schemaVersion: 1, title: '合成正式文章', slug: 'synthetic-formal-article', summary: '合成摘要', category: '練習日常', takeaways: [], coverMediaId: null, blocks: [{ id: '11111111-1111-4111-8111-111111111111', type: 'paragraph', runs: [{ text: '合成段落' }] }] }
const workspace: ArticleWorkspace = { workspaceId: `aw_${'a'.repeat(32)}`, version: 2, documentHash: 'a'.repeat(64), document, status: 'editing', expiresAt: '2099-10-10T00:00:00Z', media: [], feedback: [], notificationStatus: 'sent', publicationUrl: null, canEdit: true, canApprove: true, company: { displayName: '合成公司', canonicalSiteOrigin: 'https://synthetic.example' } }
function customer(overrides: Record<string, unknown> = {}) {
  return { state: 'ready', workspace, draft: document, mode: 'preview', mobilePreview: false, busy: false, message: '', failed: false, dirty: false, canEdit: true, canApprove: false, publicationReady: true, missingImages: false, approvalConfirmed: false, rightsConfirmed: false, showFeedback: false, feedbackNote: '', conflict: false, conflictRefreshed: false, imageUrls: {}, imageLoading: false, publicationUrl: null, selectedMediaId: '', takeawaysText: '', expiry: '台灣時間', articleStatus, blockText: (block: { runs: { text: string }[] }) => block.runs.map(item => item.text).join(''), login: () => {}, refreshProgress: () => {}, save: () => {}, sendFeedback: () => {}, approve: () => {}, changeText: () => {}, setEmphasis: () => {}, addBlock: () => {}, moveBlock: () => {}, removeBlock: () => {}, insertImage: () => {}, uploadImage: () => {}, useServerVersion: () => {}, keepLocalDraft: () => {}, ...overrides }
}
function owner(overrides: Record<string, unknown> = {}) {
  return { clientId: 1, clientName: '合成公司', lineBound: true, clientActive: true, title: '', body: '', slug: '', summary: '', category: '', confirmed: false, busy: false, loading: false, loaded: true, failed: false, notice: '', workspaces: [], state: 'idle', reloadedAfterUncertain: false, valid: false, revision: null, revisionDraft: null, revisionConfirmed: false, revisionPreview: false, revisionDirty: false, revisionUnknown: false, retryConfirmations: {}, retryNeeded: (item: ArticleWorkspace) => item.status === 'retry_wait', retryWorkspace: () => {}, send: () => {}, refreshProgress: () => {}, articleStatus, safeArticleUrl, date: (value: string) => value, notify: () => 'LINE 已接受通知', openRevision: () => {}, closeRevision: () => {}, saveRevision: () => {}, sendRevision: () => {}, ...overrides }
}
function button(html: string, text: string) { const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(item => item[2]?.replace(/<[^>]+>/g, '').trim() === text); expect(found, text).toBeDefined(); return found?.[1] || '' }

describe('formal article workbench actual templates', () => {
  it('opens in reading preview, with explicit formal publication confirmation', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer())
    expect(html).toContain('閱讀預覽'); expect(html).toContain('這不是先前的流程測試稿'); expect(html).toContain('授權正式發布到公司網站')
    expect(button(html, '確認並正式發布')).toContain('disabled'); expect(html).not.toContain('文章基本資料')
    expect(html).not.toContain('撤回'); expect(html).not.toContain('停止發布')
  })
  it('requires saved content and explicit final confirmation before approval', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer({ dirty: true }))
    expect(html).toContain('有未儲存的修改'); expect(button(html, '確認並正式發布')).toContain('disabled')
    const approved = await render('../pages/weekly-content/workbench.vue', customer({ canApprove: true, approvalConfirmed: true }))
    expect(button(approved, '確認並正式發布')).not.toContain('disabled')
  })
  it('locks edit, feedback and approval controls after the version is approved', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer({ workspace: { ...workspace, status: 'approved', canEdit: false, canApprove: false }, canEdit: false }))
    expect(html).toContain('已核准，等待發布'); expect(html).toContain('這一版已鎖定')
    expect(html).not.toContain('編輯文字與配圖'); expect(html).not.toContain('確認並正式發布</button>'); expect(html).not.toContain('請服務人員協助修改')
  })
  it('does not describe approved or processing as already publicly published', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer({ workspace: { ...workspace, status: 'processing', canEdit: false, canApprove: false } }))
    expect(html).toContain('尚未取得已公開文章網址'); expect(html).not.toContain('開啟已發布文章 ↗')
    const published = await render('../pages/weekly-content/workbench.vue', customer({ workspace: { ...workspace, status: 'published', canEdit: false, canApprove: false }, publicationUrl: 'https://synthetic.example/journal/article' }))
    expect(published).toContain('開啟已發布文章 ↗'); expect(published).toContain('rel="noopener noreferrer"')
  })
  it('offers human revision feedback without promising automatic AI changes', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer({ showFeedback: true, feedbackNote: '請縮短第二段' }))
    expect(html).toContain('交由服務人員改稿'); expect(html).toContain('不會立即自動改寫或發布'); expect(button(html, '送出修改意見')).not.toContain('disabled')
  })
  it('blocks approval until all referenced private images are visible for review', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer({ missingImages: true }))
    expect(html).toContain('配圖尚未完整載入')
    expect(button(html, '確認並正式發布')).toContain('disabled')
  })
  it('offers block editing, image rights, cover and image descriptions before approval', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer({ mode: 'editor' }))
    expect(html).toContain('文章基本資料'); expect(html).toContain('段落編排'); expect(html).toContain('我有權使用與發布這些圖片')
    expect(button(html, '上傳圖片（自動縮圖）')).toContain('disabled'); expect(html).toContain('儲存這一版')
  })
  it('preserves local draft conflicts and requires a fresh read before conflict choices', async () => {
    const html = await render('../pages/weekly-content/workbench.vue', customer({ conflict: true, conflictRefreshed: false }))
    expect(html).toContain('未儲存草稿仍保留'); expect(button(html, '改用最新版本')).toContain('disabled'); expect(button(html, '保留我的草稿繼續編輯')).toContain('disabled')
  })
  it('requires bound LINE, valid content, loaded progress and explicit owner formal-send checkbox', async () => {
    const unchecked = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ valid: true }))
    expect(button(unchecked, '傳送正式文章審稿通知')).toContain('disabled'); expect(unchecked).toContain('這裡不是測試稿')
    const checked = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ valid: true, confirmed: true }))
    expect(button(checked, '傳送正式文章審稿通知')).not.toContain('disabled')
    const unbound = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ lineBound: false }))
    expect(unbound).not.toContain('傳送正式文章審稿通知')
  })
  it('keeps unknown owner send results blocked until progress is reloaded', async () => {
    const unknown = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ state: 'uncertain' }))
    expect(unknown).toContain('請先更新進度'); expect(unknown).not.toContain('使用同一識別碼安全重試</button>')
    const reloaded = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ state: 'uncertain', reloadedAfterUncertain: true, valid: true, confirmed: true }))
    expect(button(reloaded, '使用同一識別碼安全重試')).not.toContain('disabled')
  })
  it('offers same-article owner revision only while it is editable', async () => {
    const html = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ workspaces: [workspace, { ...workspace, workspaceId: `aw_${'b'.repeat(32)}`, status: 'published', canEdit: false }] }))
    expect([...html.matchAll(/編輯這篇／整理修改意見/g)]).toHaveLength(1)
  })
  it('requires explicit owner confirmation for retries and does not promise an automatic retry', async () => {
    const retry = { ...workspace, status: 'retry_wait', canEdit: false } as ArticleWorkspace
    const html = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ workspaces: [retry] }))
    expect(html).toContain('等待管理者重試發布'); expect(button(html, '安全重試這篇的待完成步驟')).toContain('disabled')
    const confirmed = await render('../components/article-workbench/ArticleWorkbenchOwner.vue', owner({ workspaces: [retry], retryConfirmations: { [retry.workspaceId]: true } }))
    expect(button(confirmed, '安全重試這篇的待完成步驟')).not.toContain('disabled')
  })
  it('renders plain structured content instead of executable HTML', async () => {
    const html = await render('../components/article-workbench/ArticlePreview.vue', { document: { ...document, title: '<script>unsafe</script>', blocks: [{ id: 'text', type: 'paragraph', runs: [{ text: '<img src=x onerror=unsafe()>' }] }] }, media: [], imageUrls: {}, compact: false, imageUrl: () => null, textStyle: () => undefined })
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;'); expect(html).toContain('&lt;img src=x onerror=unsafe()&gt;'); expect(html).not.toContain('<script>')
  })
})

describe('article workbench browser boundaries', () => {
  it.each(['/weekly-content/workbench', '/weekly-content/connect/workbench'])('keeps %s private, unindexed and without referrer leakage', async (path) => {
    // Evaluate the real Nuxt configuration without starting Nuxt or loading credentials.
    vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
    try {
      const config = (await import('../nuxt.config')).default as unknown as { routeRules: Record<string, { headers?: Record<string, string> }> }
      expect(config.routeRules[path]?.headers).toMatchObject({
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('only accepts the opaque workspace ID, not customer or company selection authority', () => { expect(workspaceIdIsValid(`aw_${'a'.repeat(32)}`)).toBe(true); expect(workspaceIdIsValid('1')).toBe(false); expect(workspaceIdIsValid(`aw_${'a'.repeat(31)}`)).toBe(false) })
  it('never stores, logs or embeds LINE ID tokens into navigation or images', () => {
    const source = file('../pages/weekly-content/workbench.vue')
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\.(log|warn|error|info|debug)/)
    expect(source).toContain("alias: ['/weekly-content/connect/workbench']")
    expect(source).toContain('await sdk.init({ liffId: result.liffId }); workspaceId =')
    expect(source).toContain("'/api/article-workbench/customer/media-preview'")
    expect(source).toContain('URL.revokeObjectURL(url)'); expect(source).toContain('operationKeys.clear()')
    expect(source).not.toContain('v-html'); expect(source).not.toMatch(/redirectUri:[^\n]*idToken/)
  })
  it('pins the saved document hash and expected version for formal approval', () => {
    const source = file('../pages/weekly-content/workbench.vue')
    expect(source).toContain('expectedVersion: workspace.value.version, documentHash: workspace.value.documentHash')
    expect(source).toContain("confirmation: 'APPROVE_AND_PUBLISH'")
    expect(source).toContain('!dirty.value && !conflict.value && !busy.value && !missingImages.value && publicationReady.value && approvalConfirmed.value')
    expect(source).toContain("operationKey('approve', payload)")
  })
  it('separates saved owner revisions from explicit revised LINE notifications', () => {
    const source = file('../components/article-workbench/ArticleWorkbenchOwner.vue')
    expect(source).toContain("'/api/article-workbench/owner/save'"); expect(source).toContain("'/api/article-workbench/owner/send-revision'")
    expect(source).toContain("confirmation: 'SEND_REVISED_FORMAL_ARTICLE'")
    expect(source).toContain('revisionKeys.get(signature)'); expect(source).toContain('revisionUnknown.value = true')
  })
  it('independently clones a structured draft and splits manual body paragraphs', () => {
    const clone = cloneDocument(document); clone.blocks.push({ id: 'x', type: 'paragraph', runs: [{ text: 'new' }] })
    expect(document.blocks).toHaveLength(1); expect(documentSignature(clone)).not.toBe(documentSignature(document))
    const manual = plainArticleDocument({ title: ' title ', slug: 'article', body: '第一段\n\n第二段', summary: '摘要', category: '日常' }, () => 'synthetic-id')
    expect(manual.blocks).toHaveLength(2); expect(manual.title).toBe('title'); expect(manual.coverMediaId).toBeNull()
  })
  it('only renders HTTPS publication links without credentials and sanitizes errors', () => {
    expect(safeArticleUrl('javascript:alert(1)')).toBeNull(); expect(safeArticleUrl('http://example.com')).toBeNull(); expect(safeArticleUrl('https://user:pass@example.com')).toBeNull()
    expect(safeArticleUrl('https://example.com/journal/a')).toBe('https://example.com/journal/a')
    expect(workbenchError({ statusCode: 409, data: { token: 'private' } })).toContain('草稿仍保留'); expect(workbenchError(new Error('secret'))).not.toContain('secret')
  })
  it('rejects incomplete publish metadata and blank image descriptions before approval', () => {
    expect(articleReadyForPublication(document)).toBe(true)
    expect(articleReadyForPublication({ ...document, summary: '' })).toBe(false)
    expect(articleReadyForPublication({ ...document, blocks: [...document.blocks, { id: 'image', type: 'image', mediaId: '11111111-1111-4111-8111-111111111111', alt: '', caption: '', layout: 'auto' }] })).toBe(false)
  })
  it('keeps validation errors editable while unknown/conflicting mutations require a progress reload', () => {
    expect(needsProgressReload({ statusCode: 422 })).toBe(false); expect(needsProgressReload({ statusCode: 413 })).toBe(false)
    expect(needsProgressReload({ statusCode: 409 })).toBe(true); expect(needsProgressReload({ statusCode: 503 })).toBe(true); expect(needsProgressReload(new Error('unknown'))).toBe(true)
  })
})
