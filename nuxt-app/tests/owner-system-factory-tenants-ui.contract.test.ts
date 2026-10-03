import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../pages/audit-lab/system-factory/tenants.vue', import.meta.url), 'utf8')
const parent = readFileSync(new URL('../pages/audit-lab/system-factory.vue', import.meta.url), 'utf8')

describe('owner System Factory tenants UI contract', () => {
  it('uses only the approved System Factory API surface', () => {
    for (const endpoint of [
      '/api/system-factory/systems',
      '/api/system-factory/systems/${id}',
      '/api/system-factory/templates',
      '/api/system-factory/provenance',
      '/api/system-factory/drafts',
      '/api/system-factory/compile',
      '/api/system-factory/previews',
      '/api/system-factory/provisioning-plans',
      '/api/system-factory/provisioning-runs/${run.runId}/retry',
      '/api/system-factory/tenants/${tenantId}/health',
      '/api/system-factory/tenants/${tenantId}/audit',
      '/api/system-factory/tenants/${selectedTenant.value.systemTenantId}/invitations',
      '/api/system-factory/tenants/${selectedTenant.value.systemTenantId}/invitations/${revokeInvitation.value.invitationId}/revoke',
      '/api/system-factory/tenants/${selectedTenant.value.systemTenantId}/lifecycle',
      '/api/system-factory/tenants/${selectedTenant.value.systemTenantId}/upgrade-plan',
    ]) expect(page).toContain(endpoint)
    // invitationRedeemNotice names the invitee's accept endpoint in copy; the page itself never calls it.
    const redeemNotice = page.match(/const invitationRedeemNotice = '([^']*)'/u)?.[1] ?? ''
    expect(redeemNotice).toContain('POST /api/system-factory/invitations/accept')
    expect(page).not.toMatch(/(?:\$fetch|fetchFactoryTenants)[^(]*\(\s*['"`]\/api\/system-factory\/invitations\/accept/u)
    const apiLiterals = [...page.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/gu)].map(match => match[1]!).filter(literal => literal !== redeemNotice)
    expect(apiLiterals.length).toBeGreaterThan(0)
    for (const literal of apiLiterals) expect(literal.startsWith('/api/system-factory/'), `unexpected API literal: ${literal}`).toBe(true)
  })

  it('keeps this owner page private, pageable, and safe to render', () => {
    expect(page).toContain("definePageMeta({ layout: 'owner' })")
    expect(page).toContain("'noindex, nofollow, noarchive'")
    expect(page).toContain('OwnerAsyncState')
    expect(page).toContain('OwnerPager')
    expect(page).toContain('filteredSystems')
    expect(page).toContain('statusFilter')
    for (const forbidden of ['v-html', "credentials: 'include'", "from '../../server/", 'TODO']) expect(page).not.toContain(forbidden)
  })

  it('requires retyping the invitee or tenant name before destructive local-record controls', () => {
    expect(page).toContain('OwnerConfirmAction')
    expect(page).toContain(':target="revokeInvitation ? invitationLabel(revokeInvitation) : \'\'"')
    expect(page).toContain(':target="tenantName"')
    expect(page).toContain(':simulated="true"')
    expect(page).toContain('終止租戶（不可逆）')
  })

  it('discloses that planning queues a run, and that the injected control-plane transport cannot complete it', () => {
    // planSystemProvisioning inserts a queued systemProvisioningRuns row; the tick only executes when
    // NUXT_SYSTEM_FACTORY_EXECUTION_ENABLED is 'true', and the injected transport answers create_site with
    // CONTROL_PLANE_TRANSPORT_UNAVAILABLE (or CONTROL_PLANE_DISABLED while the live flag is off).
    expect(page).not.toContain('控制平面目前是可重現的模擬實作')
    expect(page).not.toContain('不會真的建立或關閉任何主機或租戶')
    expect(page).not.toContain('simulatedMessage')
    expect(page).toContain('provisioningLimitation')
    expect(page).toContain('「建立佈建計畫」會排入一筆 queued 的佈建 run，但未接真實對端，不會真的開通')
    expect(page).toContain('NUXT_SYSTEM_FACTORY_EXECUTION_ENABLED')
    expect(page).toContain('一律回 CONTROL_PLANE_TRANSPORT_UNAVAILABLE，所以這一步不會成功，也不會真的建立租戶主機')
    expect(page).toContain('run 會停在 retry_wait 或 blocked')
    expect(page).toContain('排程開啟時會去嘗試執行（目前不會成功，詳見佈建區塊）')
    expect(page).not.toContain('會導致真的建立租戶主機')
    expect(page).not.toContain('只寫入佈建資料表')
    expect(page).not.toContain('已重新排入本地控制平面')
  })

  it('shows a newly issued invitation token exactly once and explains how it is redeemed', () => {
    // The invitation handler stores only the token hash and returns the raw token once; an idempotent replay returns token: null.
    expect(page).toContain('const lastInvitation = ref<IssuedInvitation | null>(null)')
    expect(page).toContain("token: typeof result?.token === 'string' && result.token ? result.token : null, replayed: result?.replayed === true")
    expect(page).toContain('<div v-if="lastInvitation && lastInvitation.systemTenantId === selectedTenant?.systemTenantId" class="invite-token" role="status">')
    expect(page).toContain('<input class="mono" :value="lastInvitation.token" readonly')
    expect(page).toContain('<p>{{ invitationTokenNotice }}</p><p>{{ invitationRedeemNotice }}</p>')
    expect(page).toContain('<p v-else>{{ lastInvitation.replayed ? invitationReplayNotice : invitationMissingTokenNotice }}</p>')
    expect(page).toContain('server 只保存這個 token 的 hash')
    expect(page).toContain('邀請 72 小時後到期')
    expect(page).toContain('這個工作台目前沒有給受邀者用的兌換畫面')
    expect(page).toContain('目前兌換一定會失敗：兌換需要這個租戶有一筆 frappe_internal_hmac 系統連線設定，否則會回 503 MISSING_CREDENTIAL，而目前沒有任何 server 程式會建立這筆設定')
    expect(page).toContain('這項檢查發生在呼叫租戶應用之前，所以把 SYSTEM_FACTORY_TENANT_APP_LIVE_ENABLED 設成 true 也不會改變結果')
    expect(page).toContain('兌換時租戶必須仍是 invitation_pending，否則會回 409 ACTIVATION_LINEAGE')
    expect(page).not.toContain('SYSTEM_FACTORY_TENANT_APP_LIVE_ENABLED 不是 true 時兌換一定會失敗')
    expect(page).toContain('server 不會再回傳 token，原本的 token 也無法取回')
    expect(page).toContain('邀請 token 只會在這裡顯示一次，請用你自己的安全管道交給受邀者')
    expect(page).not.toContain('把連結交給對方')
    expect(page).not.toContain('本來就沒有寄出任何郵件')
  })

  it('offers invitations only to invitation_pending tenants and warns that redemption currently fails', () => {
    // claim() in invitation-repository-drizzle.ts needs an invitation_pending tenant (409 ACTIVATION_LINEAGE) and an active
    // frappe_internal_hmac connection ref (503 MISSING_CREDENTIAL); no server code writes systemConnectionRefs.
    expect(page).toContain("selectedTenant.value?.healthyReceiptFingerprint && selectedTenant.value?.state === 'invitation_pending' && inviteForm.email")
    expect(page).not.toContain("['active', 'invitation_pending'].includes")
    expect(page).toContain(`<p v-if="!selectedTenant?.healthyReceiptFingerprint || selectedTenant?.state !== 'invitation_pending'" class="empty-inline">`)
    expect(page).toContain('server 也接受對 active 租戶建立邀請，但兌換時租戶必須仍是 invitation_pending（否則回 409 ACTIVATION_LINEAGE），那種邀請無法兌換，所以這裡不提供。')
    expect(page).not.toContain('只有健康已驗證、狀態為 active 或 invitation_pending 的租戶可建立邀請。')
    expect(page).toContain('注意：目前受邀者兌換一定會失敗，因為兌換需要的 frappe_internal_hmac 系統連線設定目前沒有任何 server 程式會建立。')
  })

  it('states per action whether a confirmed change can be undone', () => {
    // Invitation revoke and deprovision are terminal; suspend can be reversed with reactivate.
    expect(page).toContain('consequence="撤銷後這個邀請無法恢復；如仍要邀請對方，可以重新建立一個新邀請（會產生新的 token）。"')
    expect(page).toContain("'終止後無法復原：租戶會進入 deprovision_pending，之後不能再暫停或恢復。'")
    expect(page).toContain("'暫停後可以在這個頁面用「恢復租戶」把租戶改回 active。'")
    expect(page).toContain('description="這會把此邀請的本地紀錄標為已撤銷，之後用這個 token 兌換會被拒絕。系統不會通知對方；')
  })

  it('scopes the honest limitation per panel instead of reusing one page-wide claim', () => {
    expect(page).toContain('pageLimitation')
    expect(page).toContain('lifecycleLimitation')
    expect(page).toContain('invitationLimitation')
    // requestSystemLifecycle only writes systemEvents plus local tenant state; the invitation only writes a row.
    expect(page).toContain('只會更新本地租戶狀態並寫入一筆 systemEvents 稽核事件')
    expect(page).toContain('不會寄出任何郵件')
    expect(page).toContain('沒有執行 shell、migration 或外部寫入')
    expect(page).toContain('email 不回傳')
  })

  it('does not promise the audit panel will show provisioning plans or upgrade intents', () => {
    // /api/system-factory/tenants/{id}/audit reads systemEvents, systemReceipts and systemUpgradeReceipts only.
    // planSystemProvisioning writes provisioning tables; planSystemUpgrade writes systemUpgradeIntents.
    expect(page).toContain('provisioningAuditLimitation')
    expect(page).toContain('下方「稽核軌跡」看不到這裡建立的計畫與 run')
    expect(page).toContain('這兩筆不會出現在下方稽核軌跡')
    expect(page).toContain('稽核端點只查 upgrade receipt')
    expect(page).not.toContain('佈建計畫已寫入本地紀錄與稽核軌跡')
    expect(page).not.toContain('方案／版本鎖定意圖已記入本地稽核軌跡')
    expect(page).toContain('重新整理頁面後會清空，而且這些計畫與 run 也不會出現在下方稽核軌跡')
    expect(page).not.toContain('完整歷程請看稽核軌跡')
  })

  it('does not read provisioning fields the system workspace never returns, and matches the server retry rule', () => {
    // /api/system-factory/systems/{id} returns getSystemWorkspace, which has no provisioning plans or runs.
    expect(page).not.toContain('detail.value?.provisioningPlans')
    expect(page).not.toContain('detail.value?.provisioning?.plans')
    expect(page).not.toContain('detail.value?.provisioningRuns')
    expect(page).not.toContain('detail.value?.provisioning?.runs')
    expect(page).toContain('const provisioningPlans = computed(() => sessionPlans.value)')
    expect(page).toContain('const provisioningRuns = computed(() => sessionRuns.value)')
    expect(page).toContain('這個引擎沒有佈建計畫/run 的清單端點')
    // service.ts retrySystemProvisioning answers 409 when retryEligibleAt is missing.
    expect(page).toContain('Boolean(run.retryEligibleAt) && new Date(run.retryEligibleAt).getTime() <= Date.now()')
    expect(page).not.toContain('!run.retryEligibleAt ||')
  })

  it('never hides the filter toolbar when a filter matches nothing', () => {
    expect(page).toContain(':empty="systems.length === 0"')
    expect(page).toContain('empty-label="目前沒有 System Factory 系統。"')
    expect(page).not.toContain(':empty="filteredSystems.length === 0"')
    expect(page).toContain('<p v-if="!pagedSystems.length" class="empty-inline">沒有符合條件的系統。</p>')
  })

  it('reports write failures beside the control that failed instead of blanking the page envelope', () => {
    expect(page).toContain("type ActionScope = 'draft' | 'provision' | 'invite' | 'lifecycle' | 'upgrade'")
    expect(page).toContain("const actionErrors = reactive<Record<ActionScope, string>>({ draft: '', provision: '', invite: '', lifecycle: '', upgrade: '' })")
    for (const scope of ['draft', 'provision', 'invite', 'lifecycle', 'upgrade']) {
      expect(page, `missing per-scope error render: ${scope}`).toContain(`v-if="actionErrors.${scope}" class="notice notice--error" role="alert"`)
      expect(page, `missing per-scope error write: ${scope}`).toContain(`actionErrors.${scope} = `)
    }
    expect(page).toContain('<p v-if="detailError" class="notice notice--error" role="alert">{{ detailError }}</p>')
    expect(page).toContain("detailError.value = ''; for (const scope of Object.keys(actionErrors) as ActionScope[]) actionErrors[scope] = ''")
    // Only load() may write the page-level envelope error: one clear plus one catch, nothing else.
    expect([...page.matchAll(/errorMessage\.value = /gu)]).toHaveLength(2)
  })

  it('wires the parent to render its nested tenant route and provides an entry link', () => {
    expect(parent).toContain('<NuxtPage v-if="isNestedRoute"')
    expect(parent).toContain("route.path.startsWith('/audit-lab/system-factory/')")
    expect(parent).toContain('to="/audit-lab/system-factory/tenants"')
  })
})
