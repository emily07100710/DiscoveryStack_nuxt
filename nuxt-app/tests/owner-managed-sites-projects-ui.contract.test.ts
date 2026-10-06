import { existsSync, readFileSync } from 'node:fs'
import { createApp, createRouter, defineEventHandler, getRouterParam, toWebHandler } from 'h3'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../pages/audit-lab/managed-sites/projects.vue', import.meta.url), 'utf8')
const parent = readFileSync(new URL('../pages/audit-lab/managed-sites.vue', import.meta.url), 'utf8')

describe('owner managed sites projects UI contract', () => {
  it('uses only the allowed managed-site project endpoints', () => {
    for (const endpoint of ['/api/managed-sites/projects', '/api/managed-sites/projects/${project.id}', '/audit', '/members', '/provisioning-workspace', '/provisioning-plans', '/dry-run', '/domain-intents', '/integrations', '/gates', '/domain-quote', '/approve', '/deploy', '/content-operations-link', '/api/managed-sites/live-connectors/readiness']) expect(page).toContain(endpoint)
    for (const removed of ['/domain-release', '/releases/rollback']) expect(page).not.toContain(removed)
    // The invitee uses the browser confirmation page; the owner page itself never consumes a token.
    const acceptNotice = page.match(/const memberAcceptNotice = '([^']*)'/u)?.[1] ?? ''
    expect(acceptNotice).toContain('按下「進入網站後台」的 POST')
    expect(page).not.toMatch(/(?:\$fetch|fetchManagedProjects)[^(]*\(\s*['"`]\/api\/managed-sites\/invitations\/accept/u)
    const apiLiterals = [...page.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/gu)].map(match => match[1]!).filter(literal => literal !== acceptNotice)
    expect(apiLiterals.length).toBeGreaterThan(0)
    for (const literal of apiLiterals) expect(literal.startsWith('/api/managed-sites/projects') || literal === '/api/managed-sites/live-connectors/readiness', `unexpected API literal: ${literal}`).toBe(true)
  })
  it('keeps the owner envelope, list states, destructive confirmation, and truthful local-only disclosure', () => {
    for (const text of ["definePageMeta({ layout: 'owner' })", 'noindex, nofollow, noarchive', 'OwnerAsyncState', 'OwnerPager', 'OwnerConfirmAction', ':target="confirmTarget"']) expect(page).toContain(text)
    for (const forbidden of ['v-html', "credentials: 'include'", "from '../../server/", 'TODO']) expect(page).not.toContain(forbidden)
  })

  it('describes each local-only action by what its handler actually writes', () => {
    // The provisioning dry-run writes one planned event per step and invokes no adapter; a domain intent is one local row per project.
    expect(page).toContain('執行 dry-run 只會為每個步驟寫入一筆 planned 事件，不會呼叫任何 adapter，也不會對外連線')
    expect(page).toContain('記錄網域意圖只會在本地寫入一筆網域意圖（每個專案只能有一筆），不會查詢或購買網域，也不會變更 DNS')
    expect(page).toContain('<p class="limitation">{{ provisioningLimitation }}</p>')
    expect(page).toContain('<p class="limitation">{{ domainIntentLimitation }}</p>')
    expect(page).not.toContain('broker sidecar')
  })

  it('offers no domain release while no endpoint lists the claim that would be released', () => {
    // domain-connectors.ts moves the claim to released for good and nulls activeCanonicalDomainKey, freeing the global
    // unique key; no GET endpoint returns domain claims, so the page cannot show or confirm which domain it would release.
    expect(page).not.toContain('domainReleaseForm')
    expect(page).not.toContain("openConfirm('domain'")
    expect(page).not.toContain("confirmKind === 'domain'")
    expect(page).not.toContain('>釋出網域</button>')
    expect(page).not.toContain(':description="domainReleaseLimitation"')
    expect(page).toContain('<p class="limitation">{{ domainReleaseLimitation }}</p>')
    expect(page).toContain('這裡不提供釋出網域：目前沒有任何端點會列出網域宣告（domain claim），頁面無法顯示、也無法讓你確認實際會釋出哪一個網域。')
    expect(page).toContain('釋出是永久的：宣告會永久變成 released，這個網域的全域唯一鎖定會解除，其他專案之後就能宣告同一個網域')
    expect(page).toContain('server 只會在本地寫入一筆 domain_claim_released receipt，不會呼叫網域註冊商')
  })

  it('reports automatic invitation delivery and keeps a one-time manual link as a bounded fallback', () => {
    // The route sends the browser confirmation URL when email is ready and strips the bearer from a successful
    // owner response. An unconfigured or failed transport returns one manual URL; pending replays use re-access.
    expect(page).toContain('const lastMemberInvitation = ref<IssuedMemberInvitation | null>(null)')
    expect(page).toContain("deliveryStatus === 'sent'")
    expect(page).toContain("deliveryStatus === 'delivery_failed'")
    expect(page).toContain("deliveryStatus === 'already_pending'")
    expect(page).toContain("/managed-site-access?token=${encodeURIComponent(result.invitationToken)}")
    expect(page).toContain('<div v-if="lastMemberInvitation && lastMemberInvitation.projectId === selectedProject?.id" class="invite-token" role="status">')
    expect(page).toContain('<input class="mono" :value="lastMemberInvitation.invitationUrl" readonly')
    expect(page).toContain('<p>{{ memberTokenNotice }}</p><p>{{ memberAcceptNotice }}</p>')
    expect(page).toContain('<p v-else-if="lastMemberInvitation.deliveryStatus === \'sent\'">')
    expect(page).toContain('{{ lastMemberInvitation.replayed ? memberReplayNotice : memberMissingTokenNotice }}')
    expect(page).toContain('<p class="limitation">{{ memberInvitationLimitation }}</p>')
    expect(page).toContain('server 只保存 token 的 hash')
    expect(page).toContain('邀請 72 小時後到期')
    expect(page).toContain('系統會直接寄出完整邀請連結')
    expect(page).toContain('郵件掃描器或連結預覽不會把邀請提早用掉')
    expect(page).toContain('不必等待原邀請到期')
    expect(page).toContain('開啟客戶重新登入頁')
  })

  it('says a dry_run domain quote only checks eligibility and never shows a quote the server did not return', () => {
    // domain-quote in dry_run returns quote: null; only a returned quote may be reported as one.
    expect(page).toContain('網域報價選 dry_run 時，server 只做資格檢查、不會產生報價（回傳的 quote 是 null）')
    expect(page).toContain('const mode = quoteForm.executionMode')
    expect(page).toContain("result?.quote ? '已取得網域報價。' : mode === 'dry_run' ? '資格檢查已完成；dry_run 不會產生報價（server 回傳的 quote 是 null）。' : 'server 沒有回傳報價。'")
    expect(page).not.toContain('只做驗證與報價')
  })

  it('confirms the exact active non-owner member and retains one revoke key for an uncertain retry', () => {
    expect(page).toContain("const confirmKind = ref<'deploy' | 'member' | null>(null)")
    expect(page).toContain("member.role !== 'owner' && member.status === 'active'")
    expect(page).toContain('@click="openMemberRevoke(member)"')
    expect(page).toContain("confirmPayload.value = { projectId: selectedProject.value.id, membershipId: member.id, idempotencyKey: key('member-revoke') }")
    expect(page).toContain('/members/${payload.membershipId}/revoke')
    expect(page).toContain('query: { idempotencyKey: payload.idempotencyKey }')
    expect(page).toContain('!confirmKind.value || confirmBusy.value')
    expect(page).toContain(`:open="confirmKind === 'member'"`)
    expect(page).toContain('同一專案目前所有客戶登入會話失效')
    expect(page).not.toContain('撤銷成員暫時無法使用')
  })

  it('routes revoke as a nested POST without shadowing the existing member PATCH', async () => {
    const routeFile = '../server/api/managed-sites/projects/[id]/members/[membershipId]/revoke.post.ts'
    expect(existsSync(new URL(routeFile, import.meta.url))).toBe(true)
    expect(existsSync(new URL('../server/api/managed-sites/projects/[id]/members/[membershipId].revoke.post.ts', import.meta.url))).toBe(false)
    const source = readFileSync(new URL(routeFile, import.meta.url), 'utf8')
    expect(source).toContain('await requireOwner(event)')
    expect(source).toContain('getOwnerDatabaseUserId(owner.openId)')
    expect(source).toContain("parsePathId(getRouterParam(event, 'membershipId')")
    const router = createRouter()
    router.patch('/api/managed-sites/projects/:id/members/:membershipId', defineEventHandler(event => ({ action: 'role', member: getRouterParam(event, 'membershipId') })))
    const route = routeFile.replace('../server/api', '/api').replace(/\[([^\]]+)\]/gu, ':$1').replace(/\.post\.ts$/u, '')
    router.post(route, defineEventHandler(event => ({ action: 'revoke', project: getRouterParam(event, 'id'), member: getRouterParam(event, 'membershipId') })))
    const handle = toWebHandler(createApp().use(router))
    const revoke = await handle(new Request('https://owner.example/api/managed-sites/projects/10/members/20/revoke', { method: 'POST' }))
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toEqual({ action: 'revoke', project: '10', member: '20' })
    const role = await handle(new Request('https://owner.example/api/managed-sites/projects/10/members/20', { method: 'PATCH' }))
    expect(role.status).toBe(200)
    expect(await role.json()).toEqual({ action: 'role', member: '20' })
  })
  it('reads only fields the managed-sites projections actually return', () => {
    // projectProjection() exposes canonicalClientIdentity / canonicalWebsiteIdentity and no slug;
    // managedSiteAuditEvents has occurredAt and no createdAt.
    expect(page).not.toContain('item.slug')
    expect(page).not.toContain('project.slug')
    expect(page).not.toContain('搜尋專案名稱或 slug')
    expect(page).toContain("`${item.canonicalClientIdentity || ''} ${item.canonicalWebsiteIdentity || ''}`")
    expect(page).toContain('placeholder="搜尋客戶識別或網站識別"')
    expect(page).toContain('{{ event.occurredAt }} · {{ event.authority }}')
    expect(page).not.toContain('event.createdAt')
  })

  it('reads the provisioning dry-run result from the shape that handler returns', () => {
    // executeManagedSiteProvisioningPlan returns externalCalls/providerConfigured at the top level,
    // while createManagedSiteDomainIntent nests them under execution.
    expect(page).toContain("Dry-run 已完成。${result?.externalCalls === false ? '未呼叫外部服務。' : ''}")
    expect(page).not.toContain("Dry-run 已完成。${result?.execution?.externalCalls")
    expect(page).toContain("網域意圖已保存。${result?.execution?.externalCalls === false ? '未呼叫外部服務。' : ''}")
  })

  it('never sends the test-only mocked execution mode and gates real deployments on provider readiness', () => {
    // deployment-orchestrator.ts and domain-connectors.ts both answer 503 for 'mocked' when NODE_ENV !== 'test'.
    expect(page).not.toContain("executionMode: 'mocked'")
    expect(page).toContain("body: { executionMode: 'live', idempotencyKey: key('deploy') }")
    expect(page).toContain("fetchManagedProjects<Readiness>('/api/managed-sites/live-connectors/readiness')")
    expect(page).toContain("item.capability === 'deployment'")
    expect(page).toContain('liveMutationAllowed === true')
    expect(page).toContain(':disabled="!releaseId || !deploymentReady"')
    expect(page).toContain('<option v-if="mockedAllowed" value="mocked">')
    expect(page).toContain('<option v-if="domainLiveReady" value="live">')
  })

  it('offers no rollback while the deployment broker cannot perform one', () => {
    // broker-fetch.ts answers every rollback with 503; deployment-orchestrator.ts first moves the live release to
    // rollback_pending and then to retry_wait / ROLLBACK_FAILED, so the site is not rolled back and loses live_verified.
    expect(page).not.toContain('rollbackForm')
    expect(page).not.toContain("openConfirm('rollback'")
    expect(page).not.toContain("confirmKind === 'rollback'")
    expect(page).not.toMatch(/<button[^>]*>Rollback<\/button>/u)
    expect(page).toContain('<p class="limitation">{{ rollbackLimitation }}</p>')
    expect(page).toContain('這裡不提供 rollback：內部部署 broker（internal deployment broker）沒有實作 rollback，rollback 請求一律回 503。')
    expect(page).toContain('server 會先把線上的 release 改成 rollback_pending，失敗後再改成 retry_wait（錯誤碼 ROLLBACK_FAILED）：站台不會真的回滾，線上那個 release 反而會失去 live_verified 狀態。')
    expect(page).not.toContain('會把線上站台切回目標 release')
    expect(page).not.toContain('部署與 rollback')
    expect(page).not.toContain('部署、rollback 與 live 報價')
    expect(page).toContain('consequence="部署後無法在這個頁面復原：這裡不提供 rollback（原因見發佈區塊的說明）。"')
    expect(page).toContain('describeDeployment')
    expect(page).toContain('result?.receipt?.receiptType')
    expect(page).toContain('result?.release?.status')
  })

  it('describes the publish sub-panel truthfully and stops calling a real deployment simulated', () => {
    expect(page).toMatch(/<h3>發佈<\/h3>[^\n]*?<p class="limitation">\{\{ publishLimitation \}\}<\/p>/u)
    expect(page).toContain('mocked 模式只在測試環境開放（server 端非測試環境一律回 503）')
    expect(page).toContain('這是 live 模式的真實部署')
    expect(page).not.toContain('這是 live 模式的真實 rollback')
    expect(page).not.toContain('未接真實對端：部署只會以 mocked 模式寫入發佈紀錄')
    expect(page).toMatch(/confirmKind === 'deploy'[^\n]*confirm-label="部署" :busy="confirmBusy" :error="confirmError" @confirm/u)
  })

  it('closes the confirmation dialog on success so an irreversible action cannot be double-fired', () => {
    expect(page).toContain("function dismissConfirm() { confirmKind.value = null; confirmPayload.value = null; confirmError.value = '' }")
    expect(page).toContain('function closeConfirm() { if (!confirmBusy.value) dismissConfirm() }')
    expect(page).toContain('dismissConfirm(); await afterWrite(message)')
    expect(page).not.toMatch(/closeConfirm\(\); await afterWrite/u)
  })

  it('reports write failures beside the control that failed instead of blanking the page envelope', () => {
    expect(page).toContain("type ActionScope = 'create' | 'member' | 'provisioning' | 'domain' | 'release' | 'integration' | 'content'")
    expect(page).toContain('function beginAction(scope: ActionScope) { actionErrors[scope] = \'\' }')
    expect(page).toContain("function operationError(scope: ActionScope, error: any, fallback: string) { actionErrors[scope] = error?.data?.message || fallback }")
    for (const scope of ['create', 'member', 'provisioning', 'domain', 'release', 'integration', 'content']) {
      expect(page, `missing per-scope error render: ${scope}`).toContain(`v-if="actionErrors.${scope}" class="notice notice--error" role="alert"`)
      expect(page, `missing per-scope error write: ${scope}`).toContain(`operationError('${scope}'`)
    }
    expect(page).toContain('<p v-if="detailError" class="notice notice--error" role="alert">{{ detailError }}</p>')
    // Only load() may write the page-level envelope error: one clear plus one catch, nothing else.
    expect([...page.matchAll(/errorMessage\.value = /gu)]).toHaveLength(2)
  })

  it('wires the nested route and its entry point on the parent page', () => {
    expect(parent).toContain('<NuxtPage v-if="isNestedRoute"')
    expect(parent).toContain('to="/audit-lab/managed-sites/projects"')
  })
})
