import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const page = () => read('pages/audit-lab/content-operations.vue')
const ownerLayout = () => read('layouts/owner.vue')

describe('Owner Content Operations Workbench V1 contract', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the owner layout and private robots policy', () => {
    const source = page()
    expect(source).toContain("definePageMeta({ i18n: false, layout: 'owner' })")
    expect(source).toContain("content: 'noindex, nofollow, noarchive'")
    expect(source).toContain("title: '內容營運 Workbench · DiscoveryStack'")
  })

  it('uses only mocked $fetch in the contract test boundary', () => {
    const source = page()
    const mockedFetch = vi.fn().mockResolvedValue({ clients: [], calendars: [], entries: [], runs: [], outcomeAssessments: [], capabilities: {}, limitations: [] })
    vi.stubGlobal('$fetch', mockedFetch)
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(source).toContain('$fetch<Workspace>')
    expect(source).not.toMatch(/(?:globalThis\.)?fetch\s*\(/)
    expect(source).not.toMatch(/\baxios\b/i)
  })

  it('uses the fixed workspace GET endpoint', () => {
    expect(page()).toContain("$fetch<Workspace>('/api/content-operations/workspace')")
  })

  it('uses the fixed clients POST endpoint and complete body contract', () => {
    const source = page()
    expect(source).toContain("post('/api/content-operations/clients'")
    for (const field of ['displayName', 'canonicalSiteOrigin', 'framework', 'publicationTransport', 'timeZone', 'defaultCadenceDays', 'defaultPublishLocalTime', 'monthlyBudgetUnits', 'idempotencyKey']) expect(source).toContain(`${field}:`)
  })

  it('uses the fixed calendars POST endpoint and complete body contract', () => {
    const source = page()
    expect(source).toContain("post('/api/content-operations/calendars'")
    for (const field of ['clientId', 'productionPlanId', 'planStartDate', 'planEndDate', 'publishLocalTime', 'cadenceDays', 'monthlyBudgetUnits', 'defaultCostUnits', 'maxItemsPerCalendarMonth', 'maximumTotalItems', 'catchUpPolicy', 'idempotencyKey']) expect(source).toContain(`${field}:`)
    expect(source).toContain('clientId: Number(calendarForm.clientId)')
    expect(source).toContain('productionPlanId: Number(calendarForm.productionPlanId)')
  })

  it('uses the fixed replan endpoint with an expected fingerprint', () => {
    const source = page()
    expect(source).toContain('/api/content-operations/calendars/${calendar.id}/replan')
    expect(source).toContain('expectedPlanFingerprint: calendar.planFingerprint')
    expect(source).toContain('replanFormFor(calendar)')
    expect(source).toContain('套用重新規劃')
  })

  it('uses the fixed materialize endpoint with an expected fingerprint', () => {
    const source = page()
    expect(source).toContain('/api/content-operations/calendars/${calendar.id}/materialize')
    expect(source).toContain('expectedPlanFingerprint: calendar.planFingerprint')
  })

  it('refreshes workspace after successful POST and blocks duplicate submits', () => {
    const source = page()
    expect(source).toContain('if (actionState.value === \'saving\') return undefined')
    expect(source).toContain('await refresh()')
    expect(source).toContain("actionState.value = 'saving'")
    expect(source).toContain("actionState.value = 'success'")
  })

  it('retains idempotency keys across uncertain failures and rotates them only after success', () => {
    const source = page()
    expect(source).toContain('const clientRequestKey = ref')
    expect(source).toContain('const calendarRequestKey = ref')
    expect(source).toContain('retainedRequestKey(replanRequestKeys')
    expect(source).toContain('retainedRequestKey(materializeRequestKeys')
    expect(source).toContain("if (result !== undefined) clientRequestKey.value = ''")
    expect(source).toContain("if (result !== undefined) calendarRequestKey.value = ''")
    expect(source).not.toContain('Math.random()')
  })

  it('limits framework options to Astro and Nuxt', () => {
    const source = page()
    expect(source).toContain('<option value="astro">Astro</option>')
    expect(source).toContain('<option value="nuxt">Nuxt</option>')
    expect(source).not.toContain('WordPress')
  })

  it('limits publication transport options to first-party Git and signed API', () => {
    const source = page()
    expect(source).toContain('value="first_party_git"')
    expect(source).toContain('First-party Git')
    expect(source).toContain('value="first_party_signed_api"')
    expect(source).toContain('First-party Signed API')
    expect(source).not.toMatch(/wordpress_rest|WordPress/i)
  })

  it('limits cadence options to 3, 7, 15 and 30 days', () => {
    const source = page()
    expect(source).toContain('const cadenceOptions: CadenceDays[] = [3, 7, 15, 30]')
    expect(source).toContain('每 {{ days }} 天')
    expect(source).not.toMatch(/每\s*(1|5|10|14|60)\s*天/)
  })

  it('limits catch-up policy to Skip missed and One catch-up', () => {
    const source = page()
    expect(source).toContain('value="skip_missed">Skip missed</option>')
    expect(source).toContain('value="one_catch_up">One catch-up</option>')
    expect(source).not.toContain('unlimited_catch_up')
  })

  it('renders all overview counts from workspace data without fake performance metrics', () => {
    const source = page()
    for (const label of ['啟用中的客戶', '本月預計內容', '下一篇發布日期', '等待人工 Review', 'Ready to publish', 'Retry wait / Failed', '已發布', 'Outcome 有資料']) expect(source).toContain(label)
    expect(source).not.toMatch(/排名提升|流量提升|轉換提升|ROI guarantee|LLM 提及數\s*[:：]/)
  })

  it('has an explicit empty state before any client or entry data exists', () => {
    const source = page()
    expect(source).toContain('還沒有內容營運資料')
    expect(source).toContain('尚未建立客戶網站')
    expect(source).toContain('尚未建立內容月曆')
    expect(source).toContain('還沒有內容項目')
  })

  it('has loading, error, unauthorized, saving and success copy', () => {
    const source = page()
    expect(source).toContain('正在讀取內容營運資料')
    expect(source).toContain('目前無法載入工作台')
    expect(source).toContain('這個工作台只對 owner 開放')
    expect(source).toContain('正在儲存')
    expect(source).toContain('已送出；畫面正在重新整理')
  })

  it('truthfully renders every false capability message', () => {
    const source = page()
    for (const message of ['排程器尚未接通', '自動內容生成尚未接通', '第一方網站發布器尚未設定', '成效資料尚未自動回收']) expect(source).toContain(message)
    expect(source).toContain('workspace.capabilities')
    expect(source).not.toContain('schedulerAvailable: true')
    expect(source).not.toContain('generationExecutorConfigured: true')
  })

  it('keeps blocked, failed and retry_wait as independent text statuses', () => {
    const source = page()
    for (const status of ['blocked', 'failed', 'retry_wait']) expect(source).toContain(status)
    for (const label of ['已阻擋', '執行失敗', '等待重試']) expect(source).toContain(label)
    expect(source).toContain('blocked、failed、retry_wait 會獨立顯示')
  })

  it('uses the durable runtime entry, run and outcome field names', () => {
    const source = page()
    for (const status of ['materialized', 'awaiting_generation', 'awaiting_review', 'ready_to_publish', 'publishing', 'delivered', 'completed', 'cancelled', 'skipped', 'blocked']) expect(source).toContain(status)
    expect(source).toContain('runForEntry(entry.id)!.state')
    expect(source).toContain('assessmentForEntry(entry.id)!.assessmentStatus')
    expect(source).toContain('entry.evidenceSnapshotHash')
    expect(source).not.toContain('entry.evidenceHash')
  })

  it('does not count paused clients as active or past terminal entries as the next publication', () => {
    const source = page()
    expect(source).toContain("client.status === 'active'")
    expect(source).toContain('entry.plannedLocalDate >= todayLocalDate')
    expect(source).toContain('!terminalEntryStatuses.has(entry.status)')
  })

  it('renders the plain-language content pipeline and status text', () => {
    const source = page()
    for (const step of ['已排程', '等待產生', '等待人工審核', '可以發布', '發布中', '已發布', '成效觀察', '學習候選']) expect(source).toContain(step)
    expect(source).toContain('下一動作')
    expect(source).toContain('pipeline-step')
  })

  it('renders calendar fields and entry fields required by the contract', () => {
    const source = page()
    for (const field of ['plannedLocalDate', 'title', 'topic', 'contentType', 'language', 'status', 'framework', 'target', 'hasApprovedDraft', 'hasPassedRiskGate']) expect(source).toContain(field)
    expect(source).toContain('plannedLocalDate')
    expect(source).toContain('frameworkLabel(entry.framework)')
  })

  it('uses text plus classes for status accessibility instead of color alone', () => {
    const source = page()
    expect(source).toContain('statusLabel')
    expect(source).toContain('class="status"')
    expect(source).toContain('status--danger')
    expect(source).toContain('status--positive')
    expect(source).toContain('aria-label="內容 pipeline"')
  })

  it('keeps technical identifiers inside collapsed Advanced details', () => {
    const source = page()
    expect(source).toContain('<details>')
    expect(source).toContain('<summary>Advanced details</summary>')
    for (const label of ['Client ID', 'Calendar ID', 'Entry ID', 'Plan fingerprint', 'Evidence hash', 'Content hash', 'Run ID']) expect(source).toContain(label)
    expect(source).not.toContain('open><summary>Advanced details')
  })

  it('keeps owner navigation private and includes the new owner-only link', () => {
    const source = ownerLayout()
    expect(source).toContain('aria-label="私有工作台導覽"')
    expect(source).toContain('to="/audit-lab/content-operations"')
    expect(source).toContain("activeSection === 'content-operations'")
    expect(source).not.toContain('to="/content-operations"')
    expect(source).not.toContain('公開導覽')
  })

  it('does not add customer login or change the public site navigation', () => {
    const source = page()
    expect(source).not.toMatch(/customer.?login|public.?login|登入客戶/i)
    expect(source).not.toContain('public-navigation')
    expect(source).toContain('owner-only')
  })

  it('has a mobile-friendly CSS contract without a new UI library', () => {
    const source = page()
    expect(source).toContain('@media(max-width:620px)')
    expect(source).toContain('grid-template-columns:1fr')
    expect(source).toContain('overflow:auto')
    expect(source).not.toMatch(/from ['"][^'"]+(vuetify|element-plus|ant-design|chakra|mui)/i)
  })

  it('keeps advanced technical IDs out of primary headings and KPI labels', () => {
    const source = page()
    expect(source).toContain('客戶網站')
    expect(source).toContain('內容月曆')
    expect(source).not.toMatch(/<h[1-3][^>]*>[^<]*(?:Client ID|Calendar ID|Entry ID|planFingerprint)/i)
  })
})

describe('Content Operations Execution Orchestrator workbench additions', () => {
  it('keeps the new execution readiness projection and first-party-only target controls', () => {
    const source = page()
    expect(source).toContain('generationExecutorAvailable')
    expect(source).toContain('publicationTargetConfigured')
    expect(source).toContain('publicationExecutionEnabled')
    expect(source).toContain('credentialConfigured')
    expect(source).toContain('credential reference 已設定')
    expect(source).toContain('credential reference 未設定')
    expect(source).toContain('第一方 target 尚未設定')
    expect(source).toContain('第一方 Git')
    expect(source).toContain('第一方 Signed API')
    expect(source).not.toMatch(/wordpress/i)
    expect(source).not.toMatch(/generic[_ -]?http/i)
  })

  it('shows the explicit execution warning and durable pipeline actions', () => {
    const source = page()
    expect(source).toContain('開啟後，通過正式 delivery approval 的內容可由 scheduler 發布到第一方網站')
    for (const status of ['awaiting_review', 'ready_to_publish', 'retry_wait', 'delivered', 'blocked']) expect(source).toContain(status)
    expect(source).toContain('執行下一步 dry-run')
    expect(source).toContain("executeEntry(entry, 'execute')")
    expect(source).toContain("mode: 'dry_run'")
    expect(source).toContain('mode },')
  })

  it('uses the allowed client target endpoint and keeps loading/saving/error behavior', () => {
    const source = page()
    expect(source).toContain('/api/content-operations/clients/${targetForm.clientId}/publication-target')
    expect(source).toContain('/api/content-operations/entries/${entry.id}/execute')
    expect(source).toContain('正在讀取內容營運資料')
    expect(source).toContain('isSaving')
    expect(source).toContain('notice--success')
    expect(source).toContain('notice--error')
  })
})
