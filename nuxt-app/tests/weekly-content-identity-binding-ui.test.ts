import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// Use the already installed Nuxt/Vue compiler and renderer; no new UI dependency.
const requireHere = createRequire(import.meta.url)
const requireNuxt = createRequire(requireHere.resolve('nuxt/package.json'))
type Render = (...args: unknown[]) => unknown
type VueRuntime = {
  defineComponent(options: { setup?: () => Record<string, unknown>; render: Render; components?: Record<string, unknown> }): unknown
  createSSRApp(component: unknown): unknown
  h(tag: string): unknown
}
const Vue = requireNuxt('vue') as VueRuntime
const compiler = requireNuxt('@vue/compiler-sfc') as {
  parse(source: string): { descriptor: { template: { content: string } | null } }
  compileTemplate(options: Record<string, unknown>): { code: string; errors: unknown[] }
}
const requireVue = createRequire(requireNuxt.resolve('vue/package.json'))
const renderer = requireVue('@vue/server-renderer') as { renderToString(app: unknown): Promise<string> }

async function renderPage(path: string, context: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const template = compiler.parse(source).descriptor.template
  if (!template) throw new Error('Page template missing')
  const compiled = compiler.compileTemplate({ source: template.content, filename: path, id: 'identity-binding-ui', transformAssetUrls: false, compilerOptions: { mode: 'function' } })
  expect(compiled.errors).toEqual([])
  const render = new Function('Vue', compiled.code)(Vue) as Render
  const NuxtLink = Vue.defineComponent({ render: () => Vue.h('a') })
  return renderer.renderToString(Vue.createSSRApp(Vue.defineComponent({ setup: () => context, render, components: { NuxtLink } })))
}
function button(html: string, label: string) {
  const match = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(row => row[2]?.replace(/<[^>]+>/g, '').trim() === label)
  expect(match, `Expected button: ${label}`).toBeDefined()
  return match?.[1] || ''
}
const client = { id: 1, displayName: 'Synthetic Company', canonicalSiteOrigin: 'https://synthetic-company.taipei', status: 'active', lineBound: false, requiresCustomerApproval: false }
function ownerContext(change: Record<string, unknown> = {}) {
  return {
    workspace: { readiness: { enabled: true, lineConfigured: true, schedulerEnabled: false }, clients: [client], configs: [], requests: [], plans: [], policies: [], calendars: [] },
    current: client, config: null, policies: [], selected: '1', policyId: '', invitation: null, hasCalendar: false,
    replacementOpen: false, replacementConfirmed: false,
    pending: false, error: null, notice: '', failed: false, busy: false, planId: '', startDate: '2026-10-05', publishLocalTime: '10:00', monthlyArticleLimit: 4,
    time: (value: string) => value, addDo: () => {}, invite: () => {}, openReplacement: () => {}, cancelReplacement: () => {}, replaceLineRecipient: () => {}, requireApproval: () => {}, activate: () => {}, createCalendar: () => {}, pause: () => {}, refresh: () => {},
    ...change,
  }
}
function customerContext(change: Record<string, unknown> = {}) {
  return {
    state: 'ready', context: { mode: 'invitation', purpose: 'identity_binding', company: client, expiresAt: '2026-10-04T00:10:00Z', confirmationToken: 'synthetic-only-confirmation' },
    connectedCompany: null, invitation: '', consent: false, busy: false, message: '', login: () => {}, examine: () => {}, confirm: () => {}, clearConfirmation: () => {},
    ...change,
  }
}

describe('actual weekly owner and customer identity templates', () => {
  it('allows an active owner customer invitation with no weekly config, policy or approval opt-in', async () => {
    const html = await renderPage('../pages/audit-lab/weekly-content.vue', ownerContext())
    expect(button(html, '產生客戶 LINE 綁定邀請')).not.toContain('disabled')
    expect(button(html, '啟用每週文章送審')).toContain('disabled')
    expect(html).toContain('每週文章服務尚未啟用')
    expect(html).toContain('不會啟用每週寫稿、安排寄稿或授權文章發佈')
    expect(html).not.toContain('每週文章送審已啟用')
  })
  it('blocks an inactive company invitation independently of the article policy state', async () => {
    const html = await renderPage('../pages/audit-lab/weekly-content.vue', ownerContext({ current: { ...client, status: 'paused' } }))
    expect(button(html, '產生客戶 LINE 綁定邀請')).toContain('disabled')
    expect(html).toContain('不能產生新邀請')
  })
  it('shows identity binding without claiming a weekly service is active', async () => {
    const html = await renderPage('../pages/audit-lab/weekly-content.vue', ownerContext({ current: { ...client, lineBound: true } }))
    expect(html).toContain('客戶 LINE 已綁定（身分已連結）')
    expect(html).toContain('每週文章服務尚未啟用')
    expect(html).not.toContain('每週文章送審已啟用')
    expect(html).not.toContain('產生客戶 LINE 綁定邀請</button>')
    expect(button(html, '更換 LINE 收件人並產生新邀請')).not.toContain('disabled')
  })
  it('requires a second explicit confirmation before replacing a bound LINE recipient', async () => {
    const current = { ...client, lineBound: true }
    const unchecked = await renderPage('../pages/audit-lab/weekly-content.vue', ownerContext({ current, replacementOpen: true }))
    expect(unchecked).toContain('現在綁定的 LINE 會立即失去')
    expect(unchecked).toContain('所有尚未使用的舊邀請碼也會立即失效')
    expect(unchecked).toContain('不會啟用、停用或更改文章服務、排程與文章發佈狀態')
    expect(button(unchecked, '確認更換並產生新邀請')).toContain('disabled')
    const checked = await renderPage('../pages/audit-lab/weekly-content.vue', ownerContext({ current, replacementOpen: true, replacementConfirmed: true }))
    expect(button(checked, '確認更換並產生新邀請')).not.toContain('disabled')
  })
  it('uses the dedicated replacement endpoint and server confirmation literal without logging the invitation', () => {
    const source = readFileSync(new URL('../pages/audit-lab/weekly-content.vue', import.meta.url), 'utf8')
    expect(source).toContain('/replace-line-binding`')
    expect(source).toContain("body:{confirmation:'REPLACE_LINE_RECIPIENT'}")
    expect(source).toContain('current.value.lineBound||invitation.value')
    expect(source).toContain('!replacementConfirmed.value||invitation.value')
    expect(source).toContain('if(!replacementReturned){replacementOpen.value=false;replacementConfirmed.value=false}')
    expect(source).toContain('目前無法確認 LINE 收件人是否已完成更換')
    expect(source).not.toContain('原有綁定與文章設定維持不變')
    expect(source).not.toMatch(/console\.(?:log|info|debug|warn|error)/)
  })
  it('does not offer another invitation mutation while the one-time replacement invite is visible', async () => {
    const invitation = { purpose: 'identity_binding', invitationToken: 'synthetic-invite', expiresAt: '2026-10-05T00:10:00Z', connectUrl: 'https://example.test/connect' }
    const html = await renderPage('../pages/audit-lab/weekly-content.vue', ownerContext({ invitation }))
    expect(html).not.toContain('產生客戶 LINE 綁定邀請</button>')
    expect(html).not.toContain('更換 LINE 收件人並產生新邀請</button>')
    expect(html).toContain('一次性邀請碼（請私下交給指定客戶）')
  })
  it('keeps identity invitations available while only the weekly article service is paused', async () => {
    const html = await renderPage('../pages/audit-lab/weekly-content.vue', ownerContext({ config: { clientId: 1, status: 'paused', reviewTtlHours: 72 } }))
    expect(button(html, '產生客戶 LINE 綁定邀請')).not.toContain('disabled')
    expect(html).toContain('每週文章服務已暫停')
  })
  it('does not show mutation controls while the server module is disabled', async () => {
    const value = ownerContext()
    value.workspace.readiness.enabled = false
    const html = await renderPage('../pages/audit-lab/weekly-content.vue', value)
    expect(html).toContain('客戶連結尚未開放')
    expect(html).not.toContain('產生客戶 LINE 綁定邀請')
  })
  it('requires company confirmation and explains identity consent before enabling the LIFF action', async () => {
    const html = await renderPage('../pages/weekly-content/connect.vue', customerContext())
    expect(html).toContain(client.displayName);expect(html).toContain(client.canonicalSiteOrigin)
    expect(button(html, '確認連結這家公司')).toContain('disabled')
    expect(html).toContain('連結身分不代表啟用文章服務，也不代表同意任何一篇文章發佈')
  })
  it('enables only the company binding action after explicit identity consent', async () => {
    const html = await renderPage('../pages/weekly-content/connect.vue', customerContext({ consent: true }))
    expect(button(html, '確認連結這家公司')).not.toContain('disabled')
    expect(html).not.toContain('同意發佈</button>')
  })
  it('retains privacy/contact links and separate weekly approval after identity success', async () => {
    const html = await renderPage('../pages/weekly-content/connect.vue', customerContext({ state: 'success', connectedCompany: client, context: null }))
    expect(html).toContain('只完成身分連結，不會啟用每週寫稿或授權任何文章發佈')
    expect(html).toContain('逐篇同意原稿')
    expect(html).toContain('https://discoverystack-web.onrender.com/zh-hant/privacy')
    expect(html).toContain('https://discoverystack-web.onrender.com/zh-hant#fit')
  })
})
