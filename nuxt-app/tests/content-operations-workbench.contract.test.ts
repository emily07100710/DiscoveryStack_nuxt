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
    expect(source).toContain('const fetchContent = $fetch as unknown as WorkbenchFetch')
    expect(source).toContain('fetchContent<Workspace>')
    expect(source).not.toMatch(/(?:globalThis\.)?fetch\s*\(/)
    expect(source).not.toMatch(/\baxios\b/i)
  })

  it('uses the fixed workspace GET endpoint', () => {
    expect(page()).toContain("fetchContent<Workspace>('/api/content-operations/workspace')")
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

  it('offers the complete internal target framework matrix', () => {
    const source = page()
    for (const framework of ['astro', 'nuxt', 'wordpress', 'php_agent', 'generic_http', 'geoflow_local', 'static_site']) expect(source).toContain(`<option value="${framework}">`)
    expect(source).toContain('WordPress')
    expect(source).toContain('GEOFlow local')
  })

  it('offers the complete internal publication transport matrix', () => {
    const source = page()
    expect(source).toContain('transportOptionsForFramework')
    for (const transport of ['first_party_git', 'first_party_signed_api', 'wordpress_rest', 'geoflow_agent', 'generic_http', 'geoflow_local']) expect(source).toContain(transport)
    for (const label of ['First-party Git', 'First-party Signed API', 'WordPress REST', 'PHP / GEOFlow agent', 'Generic HTTP', 'GEOFlow local']) expect(source).toContain(label)
    expect(source).toContain('static_site: [\'geoflow_agent\']')
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

  it('renders capability state separately from external runtime availability', () => {
    const source = page()
    for (const message of ['排程工作尚未註冊', '排程工作已註冊；自動執行尚未啟用', '自動排程已啟用；主機持續執行仍待驗證', '目前沒有已配置的 provider runtime', '尚無 active publication target', 'Outcome persistence 尚未可用']) expect(source).toContain(message)
    for (const field of ['externalRuntimeAvailability', 'generationProviderConfigured', 'firstPartyTransportConfigured', 'nonFirstPartyTransportConfigured', 'credentialResolverAvailable']) expect(source).toContain(field)
    expect(source).toContain('workspace.capabilities')
    expect(source).toContain('workspace.value.readiness.schedulerEnabled')
    expect(source).toContain("workspace.readiness.outcomeCollectionStatus === 'unverified'")
    expect(source).toContain('workspace.readiness.outcomeCollectionConfigured')
    for (const message of ['設定尚未確認', '收數設定已備妥', '尚未設定自動收數', '真實收數、供應商權限與主機持續執行仍待驗證', '可保存成效資料不代表已自動收數']) expect(source).toContain(message)
    expect(source).not.toContain('workspace.capabilities.outcomeCollectionConfigured ?')
    expect(source).not.toContain('排程器已接通')
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

  it('keeps website-teacher draft review separate from internal review and publication', () => {
    const source = page()
    expect(source).toContain("awaiting_site_review: '網站已收稿；發布結果另見核驗紀錄'")
    expect(source).toContain("draft_received: '網站已收稿；發布結果另見核驗紀錄'")
    expect(source).toContain("{ key: 'awaiting_site_review', label: '網站審核／發布核驗' }")
    expect(source).toContain('網站已收稿；發布結果另見核驗紀錄')
    expect(source).toContain('draftReceipt?: FirstPartyDraftReceipt | null')
    expect(source).toContain('latestDraftReceipt?: FirstPartyDraftReceipt | null')
    expect(source).toContain('<OwnerDraftReceipt v-if="entry.latestDraftReceipt" :receipt="entry.latestDraftReceipt" />')
    expect(source).toContain('<OwnerDraftReceipt v-if="binding.latestAttempt?.draftReceipt"')
    expect(source).toContain('<OwnerSitePublicationState v-if="entry.latestSitePublication" :value="entry.latestSitePublication" />')
    expect(source).toContain('<OwnerSitePublicationState v-if="binding.latestAttempt?.sitePublication"')
    expect(source).toContain('latestSitePublication?: SitePublicationCheckState | null')
    expect(source).toContain('sitePublicationCheckAvailable?: boolean')
    expect(source).toContain('status === \'ready_to_publish\'')
    expect(source).toContain("'delivered', 'completed', 'cancelled', 'skipped', 'blocked', 'awaiting_site_review'")
    expect(source).not.toContain("status === 'awaiting_site_review' ? '已發布'")
  })

  it('offers only the server-backed read-only site status check with a retained two-field request', () => {
    const source = page()
    expect(source).toContain('/api/content-operations/entries/${encodeURIComponent(String(entry.id))}/site-publication-check')
    expect(source).toContain('body: { targetRowId: numericTargetRowId, idempotencyKey: requestKey }')
    expect(source).toContain('retainedRequestKey(sitePublicationCheckKeys, identity')
    expect(source).toContain('delete sitePublicationCheckKeys[identity]')
    expect(source).toContain('重新嘗試會沿用同一請求識別碼')
    expect(source).toContain('網站發布狀態未能確認；畫面不會推定文章已發布')
    expect(source).toContain("(response as Record<string, unknown>).status !== 'verified'")
    expect(source).toContain('(response as Record<string, unknown>).workflowChanged !== false')
    expect(source).toContain('(response as Record<string, unknown>).learningAuthorized !== false')
    expect(source).toContain('sitePublicationCheckAvailable === true')
    expect(source).toContain('binding.targetRowId')
    expect(source).toContain('entry.publicationTargetId')
    expect(source).not.toContain('我已發布')
    expect(source).not.toContain('confirmPublished')
  })

  it('keeps site measurement handoff per-target, explicit, version-bound and separate from delivery or training', () => {
    const source = page()
    expect(source).toContain('siteMeasurement?: SiteMeasurementHandoffState | null')
    expect(source).toContain('<OwnerSiteMeasurementHandoff')
    expect(source).toContain('@confirm="confirmSiteMeasurementHandoff(entry, entry.publicationTargetId, entry.siteMeasurement)"')
    expect(source).toContain('@confirm="confirmSiteMeasurementHandoff(entry, binding.targetRowId, binding.latestAttempt.siteMeasurement)"')
    expect(source).toContain('/api/content-operations/entries/${encodeURIComponent(String(entry.id))}/site-measurement-confirm')
    expect(source).toContain('body: { targetRowId: numericTargetRowId, expectedPublicationFingerprint: measurement.publicationFingerprint, confirmed: true, idempotencyKey: requestKey }')
    expect(source).toContain('siteMeasurementHandoffIdentity(entry.id, numericTargetRowId, measurement.publicationFingerprint)')
    expect(source).toContain('retainedRequestKey(siteMeasurementHandoffKeys, identity')
    expect(source).toContain('delete siteMeasurementHandoffKeys[identity]')
    expect(source).toContain("record.status === 'confirmed'")
    expect(source).toContain('record.workflowChanged === false')
    expect(source).toContain('record.learningAuthorized === false')
    expect(source).toContain('record.receiptIsCurrentAuthority === false')
    expect(source).toContain('projected?.state !== \'confirmed\'')
    expect(source).toContain('尚未收數，後續授權工作執行前仍會重新核驗')
    expect(source).toContain('entry.nextAction ||')
    const handoff = source.slice(source.indexOf('async function confirmSiteMeasurementHandoff'), source.indexOf('async function checkSitePublication'))
    expect(handoff).not.toContain('refreshLearningDataset')
    expect(handoff).not.toContain('executeEntry(')
    expect(handoff).not.toContain("status = 'delivered'")
    expect(handoff).toContain('接入確認尚未核實；目前不會宣告已收數')
  })

  it('renders calendar fields and entry fields required by the contract', () => {
    const source = page()
    for (const field of ['plannedLocalDate', 'title', 'topic', 'contentType', 'language', 'status', 'framework', 'target', 'hasApprovedDraft', 'hasPassedRiskGate', 'publicationTargetBindings', 'latestAttempt', 'receiptFingerprint', 'draftReceipt']) expect(source).toContain(field)
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
    expect(source).toContain('aria-label="工作台導覽"')
    expect(source).toContain('OWNER_NAVIGATION_GROUPS')
    expect(source).toContain(':to="item.to"')
    expect(source).toContain('resolveOwnerNavigation(route.path)')
    const navigation = readFileSync(new URL('../utils/owner-navigation.ts', import.meta.url), 'utf8')
    expect(navigation).toContain("to: '/audit-lab/content-operations'")
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
  it('keeps execution readiness projection and multi-channel target controls', () => {
    const source = page()
    expect(source).toContain('generationExecutorAvailable')
    expect(source).toContain('publicationTargetConfigured')
    expect(source).toContain('publicationExecutionEnabled')
    expect(source).toContain('credentialConfigured')
    expect(source).toContain('credential reference 已設定')
    expect(source).toContain('credential reference 未設定')
    expect(source).toContain('第一方 target 尚未設定')
    expect(source).toContain('First-party Git')
    expect(source).toContain('First-party Signed API')
    expect(source).toContain('publicationTargetBindings')
    expect(source).toContain('serviceReferenceConfigured')
    expect(source).toContain('destinationPublicationIdentityConfigured')
    expect(source).toContain('WordPress REST')
    expect(source).toContain('Generic HTTP')
  })

  it('shows the explicit execution warning and durable pipeline actions', () => {
    const source = page()
    expect(source).toContain('開啟後，通過正式 evidence/risk/policy gate 的內容才可送入對應 transport')
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
    expect(source).toContain('/api/content-operations/entries/${entry.id}/publication-targets')
    expect(source).toContain('bindEntryTargets(entry)')
    expect(source).toContain('正在讀取內容營運資料')
    expect(source).toContain('isSaving')
    expect(source).toContain('notice--success')
    expect(source).toContain('notice--error')
  })
})
