import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const portal = readFileSync(new URL('../pages/customer/managed-sites/index.vue', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../pages/customer/managed-sites/editor.vue', import.meta.url), 'utf8')
const logoutRoute = readFileSync(new URL('../server/api/managed-sites/customer/logout.post.ts', import.meta.url), 'utf8')

describe('managed-site customer session UI', () => {
  it('offers re-access only when signed out and a real logout while the portal session is active', () => {
    expect(portal).toContain("fetchCustomerPortal('/api/managed-sites/customer/logout', { method: 'POST' })")
    expect(portal).toContain('v-if="projection"')
    expect(portal).toContain("window.location.assign('/managed-site-access')")
    expect(portal).toContain('目前無法安全登出，請稍後再試。')
  })

  it('lets an editor explicitly revoke the same customer session', () => {
    expect(editor).toContain("fetchCustomerEditor('/api/managed-sites/customer/logout', { method: 'POST' })")
    expect(editor).toContain("window.location.assign('/managed-site-access')")
    expect(editor).toContain("{{ signingOut ? '登出中…' : '登出' }}")
  })

  it('explains why a paid editor can save drafts but cannot publish them', () => {
    expect(editor).toContain("workspace.capabilities.canWrite ? '你可以編輯草稿；正式發布需網站管理員確認。'")
    expect(editor).toContain(':disabled="!workspace?.capabilities.canPublish')
  })

  it('protects logout with the same exact-origin mutation guard as other customer writes', () => {
    expect(logoutRoute).toContain("import { assertSameOriginManagedSiteMutation }")
    expect(logoutRoute).toContain('assertSameOriginManagedSiteMutation(event)')
    expect(logoutRoute.indexOf('assertSameOriginManagedSiteMutation(event)')).toBeLessThan(logoutRoute.indexOf('revokeManagedSiteSession(token)'))
    expect(logoutRoute).toContain('clearManagedSiteSessionCookie(event)')
  })
})
