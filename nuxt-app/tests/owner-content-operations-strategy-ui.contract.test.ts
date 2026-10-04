import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../pages/audit-lab/content-operations/strategy.vue', import.meta.url), 'utf8')
const parent = readFileSync(new URL('../pages/audit-lab/content-operations.vue', import.meta.url), 'utf8')

describe('owner content operations strategy UI contract', () => {
  it('uses only the allowed content operations endpoints, including the literal-dot revoke route', () => {
    for (const endpoint of ['/api/content-operations/workspace', '/entity-strategy', '/entity-strategy/${confirmPayload.value.profileId}/revoke', '/query-ownership', '/query-ownership/${confirmPayload.value.fingerprint}/revoke', '/autopilot-policy', '/autopilot-policy.revoke', '/api/content-operations/outcomes']) expect(page).toContain(endpoint)
    const apiLiterals = [...page.matchAll(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/gu)].map(match => match[1]!)
    expect(apiLiterals.length).toBeGreaterThan(0)
    for (const literal of apiLiterals) expect(literal.startsWith('/api/content-operations/'), `unexpected API literal: ${literal}`).toBe(true)
  })
  it('keeps owner list states and real-row destructive confirmations', () => {
    for (const text of ["definePageMeta({ layout: 'owner' })", 'noindex, nofollow, noarchive', 'OwnerAsyncState', 'OwnerPager', 'OwnerConfirmAction', 'item.canonicalBrandName', 'item.normalizedQuery || item.fingerprint', 'selectedClient?.displayName']) expect(page).toContain(text)
    for (const forbidden of ['v-html', "credentials: 'include'", "from '../../server/", 'TODO']) expect(page).not.toContain(forbidden)
  })
  it('renders governance from policy fields the projection returns, not a limitations array it never has', () => {
    // policyProjection() in autopilot-service.ts returns no limitations key at all.
    expect(page).not.toContain('policy.limitations')
    expect(page).toContain('autopilotPolicyLimitation')
    expect(page).toContain('該端點不回傳任何 limitations 欄位')
    for (const field of ['policy.mode', 'policy.cadenceDays', 'policy.maximumRiskSeverity', 'policy.evidenceFreshnessHours', 'policy.requireApprovedForDelivery', 'policy.requirePassedRiskGate', 'policy.allowedDestinations']) expect(page).toContain(field)
    expect(page).toContain('policyCount.value = Number(policyResult.policyCount || 0)')
  })

  it('treats a missing autopilot policy as absent instead of falling back to the response envelope', () => {
    // getOwnerAutopilotPolicy legitimately answers { policy: null, policies: [], ... }; the envelope is truthy.
    expect(page).toContain('policy.value = policyResult.policy ?? null')
    expect(page).not.toContain('policyResult.policy || policyResult')
    expect(page).toContain('v-if="!policy"')
  })

  it('discloses that the autopilot revoke is client-wide and terminal, and reports the count the server returns', () => {
    // revokeOwnerAutopilot revokes every enabled or paused policy of the client and answers revokedCount (0 when none
    // was active); re-enabling on a revoked publication target is refused until a new target exists.
    expect(page).toContain('title="撤銷此客戶全部自動駕駛政策"')
    expect(page).toContain('description="這會一次撤銷這個客戶所有啟用中或暫停中的自動駕駛政策（不只上面顯示的這一筆），並為每一筆寫入一筆撤銷事件。"')
    expect(page).toContain('consequence="撤銷後是終止狀態，無法恢復；原本的發布目標之後不能再授權自動駕駛，必須先建立新的發布目標。"')
    expect(page).toContain('fetchStrategy<{ revokedCount?: number }>(`/api/content-operations/clients/${selectedClient.value.id}/autopilot-policy.revoke`')
    expect(page).toContain("autopilotMessage = result?.revokedCount ? `已撤銷此客戶 ${result.revokedCount} 筆自動駕駛政策。` : '此客戶沒有啟用中或暫停中的自動駕駛政策，這次沒有撤銷任何政策。'")
    expect(page).not.toContain('不會自動恢復這項政策')
  })

  it('puts the parent page client-wide autopilot revoke behind a typed-name confirmation that says it is terminal', () => {
    // revokeOwnerAutopilot revokes every enabled or paused policy of the client in one transaction; revoked is terminal.
    expect(parent).toContain('OwnerConfirmAction')
    expect(parent).toContain('@click="beginAutopilotRevoke(client)"')
    expect(parent).not.toContain('@click="revokeAutopilot(client)"')
    expect(parent).toContain('title="撤銷此客戶全部自動駕駛政策"')
    expect(parent).toContain(":target=\"autopilotRevokeClient ? autopilotRevokeClient.displayName || String(autopilotRevokeClient.id) : ''\"")
    expect(parent).toContain('consequence="撤銷後是終止狀態，無法恢復；原本的發布目標之後不能再授權自動駕駛，必須先建立新的發布目標。"')
    expect(parent).toContain('@confirm="revokeAutopilot" @cancel="closeAutopilotRevoke"')
    expect(parent).toContain('const fetchContent = $fetch as unknown as WorkbenchFetch')
    expect(parent).toContain('fetchContent<{ revokedCount?: number }>(`/api/content-operations/clients/${client.id}/autopilot-policy.revoke`')
    expect(parent).toContain("actionNotice.value = result?.revokedCount ? `已撤銷此客戶 ${result.revokedCount} 筆自動駕駛政策。` : '此客戶沒有啟用中或暫停中的自動駕駛政策，這次沒有撤銷任何政策。'")
    expect(parent).not.toContain('Governed autopilot 已撤銷；scheduler 不會自動復活。')
  })

  it('states before each governance revoke that it is permanent and what stops working', () => {
    // Profile and claim revokes are permanent (content-operations/repository.ts); the v4 autopilot reload in
    // orchestrator.ts needs an active profile and an active claim whose normalizedQuery is the entry topic cluster.
    expect(page).toContain('title="撤銷實體策略" :target="confirmTarget" description="撤銷後，這個策略不再可作為自動駕駛的治理依據。" consequence="撤銷後無法恢復：這份策略會永久標為已撤銷，綁定這份策略的自動駕駛政策（v4）之後會被擋下、不會再自動發布。你可以再建立一份新版本的策略，但原本的政策仍綁在這份已撤銷的策略上，不會自動改用新版本。"')
    expect(page).toContain('title="撤銷查詢主權" :target="confirmTarget" description="撤銷後，這個查詢不再由此頁面主張主權。" consequence="撤銷後無法恢復：這筆主張會永久標為已撤銷。之後用完全相同的內容重新送出不會生效（server 會回傳這筆已撤銷的紀錄），必須改動主要頁面、查詢群組、佐證文章或證據快照其中一項，才會建立新的主張。在有新的有效主張之前，自動駕駛（v4）不會自動發布以這個查詢為主題的內容。"')
  })

  it('reports a query-ownership save by the status the server returns instead of always calling it saved', () => {
    // Identical content to a revoked claim hits the (ownerUserId, fingerprint) unique index and returns that revoked row with replayed: false.
    expect(page).toContain('fetchStrategy<{ ownership?: { status?: string }; replayed?: boolean }>(`/api/content-operations/clients/${selectedClient.value.id}/query-ownership`')
    expect(page).toContain("if (status === 'revoked') { formErrors.claim = claimRevokedDuplicateMessage; return }")
    expect(page).toContain('沒有生效：你送出的內容和一筆已撤銷的查詢主權完全相同，server 回傳的是那筆已撤銷的紀錄，沒有建立新的主張。')
    expect(page).toContain("'這筆查詢主權已經存在而且仍然有效，server 沒有建立新紀錄。'")
    expect(page).toContain("'查詢主權已建立並生效。'")
    expect(page).toContain("'server 沒有回報這筆查詢主權的狀態，請重新整理後確認。'")
    expect(page).not.toContain('查詢主權已保存。')
  })

  it('describes outcome measurements as owner-entered JSON gated on a validated delivery receipt', () => {
    // recordOwnerOutcomeAssessment requires a validated delivered publication receipt and stores the values the owner submits.
    expect(page).toContain('這筆內容要先有通過驗證的交付發布收據才能記錄。前後測量值是你手動輸入的 JSON，不是系統自動蒐集的資料；不推定排名、流量、ROI 或因果。')
    expect(page).not.toContain('客觀資料')
  })

  it('closes the confirmation dialog on success so a revoke cannot be double-fired', () => {
    expect(page).toContain("function dismissConfirm() { confirmKind.value = null; confirmPayload.value = null; confirmError.value = '' }")
    expect(page).toContain('function closeConfirm() { if (!confirmBusy.value) dismissConfirm() }')
    expect(page).toContain('dismissConfirm(); await afterWrite(message)')
    expect(page).not.toMatch(/closeConfirm\(\); await afterWrite/u)
  })

  it('keeps form failures on the form that failed instead of blanking the page envelope', () => {
    expect(page).toContain("type FormScope = 'profile' | 'claim' | 'outcome'")
    expect(page).toContain("const formErrors = reactive<Record<FormScope, string>>({ profile: '', claim: '', outcome: '' })")
    for (const scope of ['profile', 'claim', 'outcome']) {
      expect(page, `missing per-form error render: ${scope}`).toContain(`v-if="formErrors.${scope}" class="notice notice--error" role="alert"`)
      expect(page, `missing per-form error write: ${scope}`).toContain(`formErrors.${scope} = errorFrom(error`)
    }
    // Only load() may write the page-level envelope error: one clear plus one catch, nothing else.
    expect([...page.matchAll(/errorMessage\.value = /gu)]).toHaveLength(2)
  })

  it('wires the nested route and its entry point on the parent page', () => {
    expect(parent).toContain('<NuxtPage v-if="isNestedRoute"')
    expect(parent).toContain('to="/audit-lab/content-operations/strategy"')
  })
})
