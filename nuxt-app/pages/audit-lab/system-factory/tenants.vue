<script setup lang="ts">
type FactoryTenantsFetch = <T = unknown>(path: string, options?: { method?: 'POST'; body?: Record<string, unknown> }) => Promise<T>
// Keep the existing Nuxt fetch runtime and these page-owned response DTOs.
const fetchFactoryTenants = $fetch as unknown as FactoryTenantsFetch
definePageMeta({ layout: 'owner' })
useHead({ title: 'System Factory 租戶運維｜DiscoveryStack Private Workbench', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type SystemRow = { id: number; specId: string; clientId: number; websiteId: string | null; managedSiteProjectId?: number | null; activeVersionId?: number | null; status: string; updatedAt: string }
type SystemList = { systems: SystemRow[] }
type SystemDetail = Record<string, any> & { system: SystemRow; versions: Array<Record<string, any>>; previews: Array<Record<string, any>>; tenant: Record<string, any> | null; invitations: Array<Record<string, any>>; receipts: Array<Record<string, any>>; events: Array<Record<string, any>>; limitations: string[] }

const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
const systems = ref<SystemRow[]>([])
const selectedId = ref<number | null>(null)
const detail = ref<SystemDetail | null>(null)
const templates = ref<Array<Record<string, any>>>([])
const templateClaims = ref<Record<string, any> | null>(null)
const provenance = ref<Record<string, any> | null>(null)
const health = ref<Record<string, any> | null>(null)
const healthClaims = ref<Record<string, any> | null>(null)
const audit = ref<Record<string, any> | null>(null)
const page = ref(1)
const pageSize = 8
const query = ref('')
const statusFilter = ref('')
const detailLoading = ref(false)
const acting = ref('')
const compiledPlan = ref<Record<string, any> | null>(null)
const previewResult = ref<Record<string, any> | null>(null)
const previewClaims = ref<Record<string, any> | null>(null)
const invitationTargets = reactive<Record<string, string>>({})
const inviteForm = reactive({ email: '', roleKey: '' })
const draftForm = reactive({ requirements: '', clientId: '', websiteId: '', managedSiteProjectId: '', businessType: '', industry: '', preferredTemplate: '' })
const provisionForm = reactive({ managedSiteDraftOrderId: '', managedSitePaymentEventId: '' })
const upgradeForm = reactive({ toVersionLockHash: '' })
const revokeInvitation = ref<Record<string, any> | null>(null)
type IssuedInvitation = { systemTenantId: string; invitationId: string; roleKey: string; expiresAt: string; token: string | null; replayed: boolean; email: string }
const lastInvitation = ref<IssuedInvitation | null>(null)
const lifecycleAction = ref<'suspend' | 'deprovision' | null>(null)
const confirmBusy = ref(false)
const confirmError = ref('')
type ActionScope = 'draft' | 'provision' | 'invite' | 'lifecycle' | 'upgrade'
const actionErrors = reactive<Record<ActionScope, string>>({ draft: '', provision: '', invite: '', lifecycle: '', upgrade: '' })
const detailError = ref('')

const statusOptions = computed(() => [...new Set(systems.value.map(system => system.status).filter(Boolean))])
const filteredSystems = computed(() => systems.value.filter(system => (!query.value || `${system.specId} ${system.clientId} ${system.websiteId || ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())) && (!statusFilter.value || system.status === statusFilter.value)))
const pagedSystems = computed(() => filteredSystems.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const selectedTenant = computed<Record<string, any> | null>(() => detail.value?.tenant || null)
const tenantName = computed(() => String(selectedTenant.value?.displayName || selectedTenant.value?.name || selectedTenant.value?.systemTenantId || '租戶'))
const currentVersion = computed(() => detail.value?.versions?.[0] || null)
const currentSpec = computed<Record<string, any> | null>(() => (currentVersion.value?.normalizedSpec as Record<string, any> | undefined) || null)
const roleKeys = computed(() => ((currentVersion.value?.compiledPlan?.materializationManifest?.units || []) as Array<Record<string, any>>).filter(unit => unit.kind === 'role' && unit.key).map(unit => String(unit.key)))
const sessionPlans = ref<Array<Record<string, any>>>([])
const sessionRuns = ref<Array<Record<string, any>>>([])
const provisioningPlans = computed(() => sessionPlans.value)
const provisioningRuns = computed(() => sessionRuns.value)
const provisioningListLimitation = '這個引擎沒有佈建計畫/run 的清單端點，系統詳情也不回傳這兩張表，所以下面只列出這次工作階段建立的計畫與 run；重新整理頁面後會清空，而且這些計畫與 run 也不會出現在下方稽核軌跡。'
const canPlanProvisioning = computed(() => Boolean(detail.value?.system?.activeVersionId && detail.value?.system?.managedSiteProjectId && Number(provisionForm.managedSiteDraftOrderId) > 0 && Number(provisionForm.managedSitePaymentEventId) > 0))
const canInvite = computed(() => Boolean(selectedTenant.value?.healthyReceiptFingerprint && selectedTenant.value?.state === 'invitation_pending' && inviteForm.email && inviteForm.roleKey))
const pageLimitation = '這一頁只呼叫既有 System Factory 端點，各區塊的實際影響不同：生命週期變更只改本地租戶狀態，方案／版本鎖定只寫本地意圖，但「建立佈建計畫」會排入一筆 queued 的佈建 run，排程開啟時會去嘗試執行（目前不會成功，詳見佈建區塊）。請以各區塊自己的說明為準，不要把整頁當成純模擬。'
const lifecycleLimitation = '暫停／恢復／終止只會更新本地租戶狀態並寫入一筆 systemEvents 稽核事件，本次請求不會呼叫任何外部控制平面，下方稽核軌跡看得到這些事件。方案／版本鎖定意圖只寫入本地 upgrade intent，稽核端點查的是 upgrade receipt，所以意圖本身不會出現在下方稽核軌跡。'
const provisioningLimitation = '「建立佈建計畫」會排入一筆 queued 的佈建 run，但未接真實對端，不會真的開通：排程開關 NUXT_SYSTEM_FACTORY_EXECUTION_ENABLED 沒開時，這筆 run 不會被執行；開了之後，排程可能領取它並嘗試第一步 create_site，但伺服器目前注入的主機控制通道是佔位實作，一律回 CONTROL_PLANE_TRANSPORT_UNAVAILABLE，所以這一步不會成功，也不會真的建立租戶主機。run 會停在 retry_wait 或 blocked（控制平面的 live 開關沒開時會直接 blocked）。'
const provisioningAuditLimitation = '建立佈建計畫除了寫入佈建計畫與 run，也會建立租戶與租戶綁定紀錄，並更新 SystemSpec；但租戶稽核端點只查 systemEvents、receipt 與 upgrade receipt，所以下方「稽核軌跡」看不到這裡建立的計畫與 run。'
const invitationLimitation = '建立邀請只會寫入一筆本地邀請紀錄與 token hash，不會寄出任何郵件，也不會通知受邀者。建立成功後，邀請 token 只會在這裡顯示一次，請用你自己的安全管道交給受邀者。注意：目前受邀者兌換一定會失敗，因為兌換需要的 frappe_internal_hmac 系統連線設定目前沒有任何 server 程式會建立。'
const invitationTokenNotice = 'server 只保存這個 token 的 hash，關閉這個區塊、離開或重新整理頁面後就無法再取回；請現在複製。邀請 72 小時後到期。'
const invitationRedeemNotice = '兌換方式：受邀者要從這個服務的同一網域（同源請求）呼叫 POST /api/system-factory/invitations/accept，送出 token、受邀 email、自己設定的密碼與一組 idempotencyKey；這個工作台目前沒有給受邀者用的兌換畫面。目前兌換一定會失敗：兌換需要這個租戶有一筆 frappe_internal_hmac 系統連線設定，否則會回 503 MISSING_CREDENTIAL，而目前沒有任何 server 程式會建立這筆設定；這項檢查發生在呼叫租戶應用之前，所以把 SYSTEM_FACTORY_TENANT_APP_LIVE_ENABLED 設成 true 也不會改變結果。另外，兌換時租戶必須仍是 invitation_pending，否則會回 409 ACTIVATION_LINEAGE。'
const invitationMissingTokenNotice = 'server 這次沒有回傳 token，這個邀請無法兌換；請撤銷後重新建立一個新邀請。'
const invitationReplayNotice = '這次請求是同一 idempotency key 的重播，server 不會再回傳 token，原本的 token 也無法取回。如果當初沒有保存，請撤銷這個邀請後重新建立一個新邀請。'

function key() { return crypto.randomUUID() }
function stateLabel(value: string | null | undefined) { const labels: Record<string, string> = { active: '運作中', suspended: '已暫停', terminated: '已終止', payment_verified: '付款已驗證', provisioning_planned: '已規劃佈建', invitation_pending: '等待邀請', queued: '排隊中', processing: '處理中', retry_wait: '等待重試', blocked: '已阻擋', completed: '完成', planned: '已規劃', pending: '待處理', accepted: '已接受', revoked: '已撤銷' }; return labels[value || ''] || value || '—' }
function pretty(value: unknown) { try { return JSON.stringify(value, null, 2) } catch { return '不可顯示' } }
function invitationLabel(invitation: Record<string, any>) { return invitationTargets[invitation.invitationId] || invitation.email || invitation.displayName || '' }
function retryAvailable(run: Record<string, any>) { return run.status === 'retry_wait' && Number(run.attempt) < Number(run.maxAttempts) && Boolean(run.retryEligibleAt) && new Date(run.retryEligibleAt).getTime() <= Date.now() }
function onPage(next: number) { page.value = next }
watch([query, statusFilter], () => { page.value = 1 })

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [list, templateResult, provenanceResult] = await Promise.all([
      fetchFactoryTenants<SystemList>('/api/system-factory/systems'),
      fetchFactoryTenants<{ templates: Array<Record<string, any>>; claims?: Record<string, any> }>('/api/system-factory/templates'),
      fetchFactoryTenants<{ provenance: Record<string, any> }>('/api/system-factory/provenance'),
    ])
    systems.value = list.systems || []
    templates.value = templateResult.templates || []
    templateClaims.value = templateResult.claims || null
    provenance.value = provenanceResult.provenance || null
    if (!draftForm.preferredTemplate && templates.value[0]?.key) draftForm.preferredTemplate = templates.value[0].key
    if (selectedId.value && !systems.value.some(system => system.id === selectedId.value)) { selectedId.value = null; detail.value = null }
  } catch (error: any) { errorMessage.value = error?.data?.message || 'System Factory 資料目前無法載入。' }
  finally { loading.value = false }
}

async function loadDetail(id = selectedId.value) {
  if (!id) return
  detailLoading.value = true
  detailError.value = ''
  health.value = null
  healthClaims.value = null
  audit.value = null
  try {
    const workspace = await fetchFactoryTenants<SystemDetail>(`/api/system-factory/systems/${id}`)
    detail.value = workspace
    if (!provisionForm.managedSiteDraftOrderId && workspace.binding?.managedSiteDraftOrderId) provisionForm.managedSiteDraftOrderId = String(workspace.binding.managedSiteDraftOrderId)
    if (!provisionForm.managedSitePaymentEventId && workspace.binding?.managedSitePaymentEventId) provisionForm.managedSitePaymentEventId = String(workspace.binding.managedSitePaymentEventId)
    const tenantId = workspace.tenant?.systemTenantId
    if (tenantId) {
      const [healthResult, auditResult] = await Promise.all([
        fetchFactoryTenants<{ health: Record<string, any>; claims?: Record<string, any> }>(`/api/system-factory/tenants/${tenantId}/health`),
        fetchFactoryTenants<Record<string, any>>(`/api/system-factory/tenants/${tenantId}/audit`),
      ])
      health.value = healthResult.health
      healthClaims.value = healthResult.claims || null
      audit.value = auditResult
    }
  } catch (error: any) { detail.value = null; detailError.value = error?.data?.message || '選取的系統詳情目前無法載入。' }
  finally { detailLoading.value = false }
}

async function selectSystem(system: SystemRow) { selectedId.value = system.id; sessionPlans.value = []; sessionRuns.value = []; detailError.value = ''; for (const scope of Object.keys(actionErrors) as ActionScope[]) actionErrors[scope] = ''; await loadDetail(system.id) }
async function createDraft() {
  acting.value = 'draft'; notice.value = ''; actionErrors.draft = ''
  try {
    const result: any = await fetchFactoryTenants('/api/system-factory/drafts', { method: 'POST', body: { requirements: draftForm.requirements, clientId: Number(draftForm.clientId), websiteId: draftForm.websiteId || null, managedSiteProjectId: draftForm.managedSiteProjectId ? Number(draftForm.managedSiteProjectId) : null, businessType: draftForm.businessType, industry: draftForm.industry, preferredTemplate: draftForm.preferredTemplate, idempotencyKey: key() } })
    notice.value = '草稿已建立；這只建立本地 SystemSpec 與紀錄，並未開通任何租戶。'
    await load()
    if (result?.system?.id) { selectedId.value = result.system.id; await loadDetail(result.system.id) }
  } catch (error: any) { actionErrors.draft = error?.data?.message || '草稿無法建立。' }
  finally { acting.value = '' }
}
async function compileDraft() {
  if (!currentSpec.value) return
  acting.value = 'compile'; notice.value = ''; actionErrors.draft = ''
  try { const result = await fetchFactoryTenants<{ compiledPlan: Record<string, any> }>('/api/system-factory/compile', { method: 'POST', body: { spec: currentSpec.value } }); compiledPlan.value = result.compiledPlan; notice.value = '已完成可重現的編譯檢查；沒有執行 shell、migration 或外部寫入。' }
  catch (error: any) { actionErrors.draft = error?.data?.message || '草稿編譯失敗。' }
  finally { acting.value = '' }
}
async function buildPreview() {
  if (!currentSpec.value) return
  acting.value = 'preview'; notice.value = ''; actionErrors.draft = ''
  try { const result = await fetchFactoryTenants<{ preview: Record<string, any>; claims?: Record<string, any> }>('/api/system-factory/previews', { method: 'POST', body: { spec: currentSpec.value, version: Number(currentVersion.value?.version || 1), parentPreviewId: null } }); previewResult.value = result.preview; previewClaims.value = result.claims || null; notice.value = 'Preview 已產生；它只包含 synthetic fixture，並非已部署服務。' }
  catch (error: any) { actionErrors.draft = error?.data?.message || 'Preview 無法建立。' }
  finally { acting.value = '' }
}
async function planProvisioning() {
  if (!detail.value) return
  acting.value = 'provision'; notice.value = ''; actionErrors.provision = ''
  try {
    const result = await fetchFactoryTenants<{ plan?: Record<string, any>; replayed?: boolean }>('/api/system-factory/provisioning-plans', { method: 'POST', body: { systemSpecId: detail.value.system.id, managedSiteDraftOrderId: Number(provisionForm.managedSiteDraftOrderId), managedSitePaymentEventId: Number(provisionForm.managedSitePaymentEventId), idempotencyKey: key() } })
    const plan = result?.plan || null
    if (plan?.planId && !sessionPlans.value.some(item => item.planId === plan.planId)) sessionPlans.value.push(plan)
    if (plan?.runId && !sessionRuns.value.some(item => item.runId === plan.runId)) sessionRuns.value.push({ runId: plan.runId, status: 'queued', attempt: 0, maxAttempts: 3, retryEligibleAt: null })
    notice.value = result?.replayed ? '佈建計畫為同一 idempotency key 的重播，未新增紀錄。' : `佈建計畫已建立，並排入一筆 queued 的佈建 run（plan ${plan?.planId || '未回報'}，run ${plan?.runId || '未回報'}）；佈建排程開啟時會領取它嘗試執行，但目前不會真的建立租戶主機。這兩筆不會出現在下方稽核軌跡。`
    await load(); await loadDetail()
  }
  catch (error: any) { actionErrors.provision = error?.data?.message || '佈建計畫無法建立。' }
  finally { acting.value = '' }
}
async function retryProvisioning(run: Record<string, any>) {
  acting.value = `retry-${run.runId}`; notice.value = ''; actionErrors.provision = ''
  try {
    const result = await fetchFactoryTenants<{ runId?: string; status?: string; replayed?: boolean; nextSafeAction?: string }>(`/api/system-factory/provisioning-runs/${run.runId}/retry`, { method: 'POST', body: {} })
    const tracked = sessionRuns.value.find(item => item.runId === run.runId)
    if (tracked) { tracked.status = result?.status || tracked.status; tracked.retryEligibleAt = null }
    notice.value = result?.replayed ? `Run ${run.runId} 已經在佇列中，這次沒有重新排入。` : `Run ${run.runId} 已重新排回 queued 佈建佇列，狀態 ${result?.status || '未回報'}，下一步 ${result?.nextSafeAction || '未回報'}；佈建排程開啟時會再次嘗試，但目前一樣不會真的建立租戶主機。`
    await loadDetail()
  }
  catch (error: any) { actionErrors.provision = error?.data?.message || '佈建重試無法排入。' }
  finally { acting.value = '' }
}
async function inviteOperator() {
  if (!selectedTenant.value) return
  acting.value = 'invite'; notice.value = ''; actionErrors.invite = ''
  try { const email = inviteForm.email; const systemTenantId = String(selectedTenant.value.systemTenantId); const result = await fetchFactoryTenants<{ invitation?: { invitationId?: string; roleKey?: string; expiresAt?: string }; token?: string | null; replayed?: boolean }>(`/api/system-factory/tenants/${systemTenantId}/invitations`, { method: 'POST', body: { email, roleKey: inviteForm.roleKey, idempotencyKey: key() } }); if (result?.invitation?.invitationId) invitationTargets[result.invitation.invitationId] = email; lastInvitation.value = { systemTenantId, invitationId: String(result?.invitation?.invitationId || ''), roleKey: String(result?.invitation?.roleKey || inviteForm.roleKey), expiresAt: String(result?.invitation?.expiresAt || ''), token: typeof result?.token === 'string' && result.token ? result.token : null, replayed: result?.replayed === true, email }; notice.value = lastInvitation.value.token ? '操作員邀請已建立（只寫入本地紀錄，不會寄信）；邀請 token 只會在下方顯示這一次，請現在複製。' : lastInvitation.value.replayed ? '這次是同一 idempotency key 的重播，server 沒有回傳新的 token。' : 'server 這次沒有回傳邀請 token。'; inviteForm.email = ''; await loadDetail() }
  catch (error: any) { actionErrors.invite = error?.data?.message || '操作員邀請無法建立。' }
  finally { acting.value = '' }
}
function beginRevoke(invitation: Record<string, any>) { revokeInvitation.value = invitation; confirmError.value = '' }
async function doRevoke() {
  if (!selectedTenant.value || !revokeInvitation.value) return
  confirmBusy.value = true; confirmError.value = ''
  try { await fetchFactoryTenants(`/api/system-factory/tenants/${selectedTenant.value.systemTenantId}/invitations/${revokeInvitation.value.invitationId}/revoke`, { method: 'POST', body: {} }); notice.value = '邀請已在本地紀錄中撤銷。'; revokeInvitation.value = null; await loadDetail() }
  catch (error: any) { confirmError.value = error?.data?.message || '邀請無法撤銷。' }
  finally { confirmBusy.value = false }
}
async function requestLifecycle(action: 'suspend' | 'reactivate' | 'deprovision') {
  if (!selectedTenant.value) return
  if (action !== 'reactivate') { lifecycleAction.value = action; confirmError.value = ''; return }
  await performLifecycle(action)
}
async function performLifecycle(action: 'suspend' | 'reactivate' | 'deprovision' | null = lifecycleAction.value) {
  if (!selectedTenant.value || !action) return
  confirmBusy.value = true; acting.value = 'lifecycle'; confirmError.value = ''; actionErrors.lifecycle = ''
  try { await fetchFactoryTenants(`/api/system-factory/tenants/${selectedTenant.value.systemTenantId}/lifecycle`, { method: 'POST', body: { action, idempotencyKey: key() } }); notice.value = action === 'reactivate' ? '租戶已在本地控制平面標記為恢復。' : action === 'deprovision' ? '租戶已標記為終止；此動作不可逆。' : '租戶已在本地控制平面標記為暫停。'; lifecycleAction.value = null; await load(); await loadDetail() }
  catch (error: any) { const message = error?.data?.message || '租戶生命週期無法更新。'; if (lifecycleAction.value) confirmError.value = message; else actionErrors.lifecycle = message }
  finally { confirmBusy.value = false; acting.value = '' }
}
async function changePlan() {
  if (!selectedTenant.value) return
  acting.value = 'upgrade'; notice.value = ''; actionErrors.upgrade = ''
  try { await fetchFactoryTenants(`/api/system-factory/tenants/${selectedTenant.value.systemTenantId}/upgrade-plan`, { method: 'POST', body: { toVersionLockHash: upgradeForm.toVersionLockHash, idempotencyKey: key() } }); notice.value = '方案／版本鎖定意圖已寫入本地 upgrade intent；不會更新真實環境，也不會出現在下方稽核軌跡（稽核端點只查 upgrade receipt）。'; await loadDetail() }
  catch (error: any) { actionErrors.upgrade = error?.data?.message || '方案變更意圖無法建立。' }
  finally { acting.value = '' }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="tenants-page">
    <div class="tenants-page__hero"><div><p class="eyebrow">PRIVATE / SYSTEM FACTORY OPERATIONS</p><h1>System Factory 租戶運維</h1><p class="lede">為已產出的系統檢視租戶狀態、佈建意圖、操作員邀請與稽核資料。</p><p class="limitation">{{ pageLimitation }}</p></div><button class="button button--primary" type="button" :disabled="loading" @click="load">{{ loading ? '載入中…' : '重新整理' }}</button></div>
    <p v-if="notice" class="notice notice--success" role="status">{{ notice }}</p><p v-if="errorMessage" class="notice notice--error" role="alert">{{ errorMessage }}</p>
    <OwnerAsyncState :loading="loading" :error="errorMessage" :empty="systems.length === 0" loading-label="正在載入 System Factory 系統…" empty-label="目前沒有 System Factory 系統。" @retry="load">
      <div class="master-detail">
        <section class="panel system-list"><div class="panel__heading"><div><p class="eyebrow">SYSTEMS</p><h2>系統清單</h2></div><span class="count">{{ filteredSystems.length }} systems</span></div><div class="toolbar"><input v-model="query" type="search" placeholder="搜尋 SystemSpec 或 client" aria-label="搜尋系統"><select v-model="statusFilter" aria-label="系統狀態"><option value="">全部狀態</option><option v-for="status in statusOptions" :key="status" :value="status">{{ stateLabel(status) }}</option></select></div><p v-if="!pagedSystems.length" class="empty-inline">沒有符合條件的系統。</p><div v-else class="system-rows"><button v-for="system in pagedSystems" :key="system.id" class="system-row" type="button" :aria-pressed="selectedId === system.id" @click="selectSystem(system)"><strong>{{ system.specId }}</strong><span class="status-badge" :data-status="system.status">{{ stateLabel(system.status) }}</span><small>client #{{ system.clientId }} · {{ system.websiteId || '未綁定網站' }}</small></button></div><OwnerPager :page="page" :page-size="pageSize" :total="filteredSystems.length" :disabled="loading" @update:page="onPage" /></section>
        <section class="detail-column"><p v-if="detailError" class="notice notice--error" role="alert">{{ detailError }}</p><p v-if="detailLoading" class="empty-state" role="status">正在載入系統詳情、健康與稽核資料…</p><p v-else-if="!detail" class="empty-state">從左側選擇一個系統，查看租戶運維資料。</p><template v-else>
          <section class="panel"><div class="panel__heading"><div><p class="eyebrow">SELECTED SYSTEM</p><h2>{{ detail.system.specId }}</h2></div><span class="status-badge" :data-status="detail.system.status">{{ stateLabel(detail.system.status) }}</span></div><dl class="facts"><div><dt>SystemSpec</dt><dd>#{{ detail.system.id }} · v{{ currentVersion?.version || '—' }}</dd></div><div><dt>限制</dt><dd>{{ detail.limitations?.length || 0 }} 項</dd></div><div><dt>Authority</dt><dd class="mono">{{ detail.authority?.payment || '—' }}</dd></div></dl></section>
          <section class="panel"><div class="panel__heading"><div><p class="eyebrow">TENANT</p><h2>租戶、健康與生命週期</h2></div><span v-if="selectedTenant" class="status-badge" :data-status="selectedTenant.state">{{ stateLabel(selectedTenant.state) }}</span></div><p class="limitation">{{ lifecycleLimitation }}</p><p v-if="!selectedTenant" class="empty-inline">尚未有租戶紀錄；需先通過既有付款與 lineage 驗證才能建立佈建計畫。</p><template v-else><dl class="facts"><div><dt>Tenant</dt><dd class="mono">{{ selectedTenant.systemTenantId }}</dd></div><div><dt>健康</dt><dd>{{ health?.verified ? '已有 verified receipt（本次沒有 live probe）' : '尚未驗證' }}</dd></div><div><dt>健康收據</dt><dd class="mono">{{ health?.receiptFingerprint || '—' }}</dd></div><div><dt>最近紀錄</dt><dd>{{ health?.observedAt ? new Date(health.observedAt).toLocaleString('zh-TW') : '—' }}</dd></div></dl><p v-if="healthClaims" class="limitation">健康端點宣告：本次讀取 {{ healthClaims.liveProbePerformedByThisRequest ? '有執行 live probe' : '未執行 live probe' }}。</p><p v-if="actionErrors.lifecycle" class="notice notice--error" role="alert">{{ actionErrors.lifecycle }}</p><div class="actions"><button v-if="selectedTenant.state === 'active'" class="button button--danger" type="button" :disabled="acting === 'lifecycle'" @click="requestLifecycle('suspend')">暫停租戶</button><button v-if="selectedTenant.state === 'suspended'" class="button" type="button" :disabled="acting === 'lifecycle'" @click="requestLifecycle('reactivate')">恢復租戶</button><button v-if="['active', 'suspended'].includes(selectedTenant.state)" class="button button--danger" type="button" :disabled="acting === 'lifecycle'" @click="requestLifecycle('deprovision')">終止租戶（不可逆）</button></div><form class="inline-form" @submit.prevent="changePlan"><label>方案／版本鎖定 hash<input v-model.trim="upgradeForm.toVersionLockHash" required pattern="[a-f0-9]{64}" maxlength="64" placeholder="64 位小寫 SHA-256"></label><button class="button" type="submit" :disabled="acting === 'upgrade' || selectedTenant.state !== 'active' || !health?.verified">{{ acting === 'upgrade' ? '處理中…' : '建立方案變更意圖' }}</button></form><p v-if="actionErrors.upgrade" class="notice notice--error" role="alert">{{ actionErrors.upgrade }}</p></template></section>
          <section class="panel"><div class="panel__heading"><div><p class="eyebrow">PROVISIONING</p><h2>佈建計畫與重試</h2></div><span class="count">{{ provisioningRuns.length }} runs</span></div><p v-if="actionErrors.provision" class="notice notice--error" role="alert">{{ actionErrors.provision }}</p><p class="limitation">{{ provisioningLimitation }}</p><p class="limitation">{{ provisioningAuditLimitation }}</p><p class="limitation">{{ provisioningListLimitation }}</p><form class="inline-form" @submit.prevent="planProvisioning"><label>Managed Site draft order ID<input v-model="provisionForm.managedSiteDraftOrderId" required inputmode="numeric"></label><label>Verified payment event ID<input v-model="provisionForm.managedSitePaymentEventId" required inputmode="numeric"></label><button class="button button--primary" type="submit" :disabled="!canPlanProvisioning || acting === 'provision'">{{ acting === 'provision' ? '建立中…' : '建立佈建計畫' }}</button></form><p v-if="!canPlanProvisioning" class="empty-inline">建立佈建計畫前，系統必須有 active version、Managed Site project，以及正整數的 order 與 verified payment event ID；server 會再次驗證完整付款 lineage。</p><div v-if="provisioningPlans.length" class="compact-list"><p v-for="plan in provisioningPlans" :key="plan.planId || plan.id"><strong>{{ plan.planId || `plan #${plan.id}` }}</strong><span>{{ stateLabel(plan.status) }}</span></p></div><p v-if="!provisioningRuns.length" class="empty-inline">這次工作階段還沒有建立佈建 run；控制平面只會允許 retry_wait、未用盡次數且已過 retryEligibleAt 的 run 重試。</p><div v-else class="compact-list"><article v-for="run in provisioningRuns" :key="run.runId || run.id"><strong class="mono">{{ run.runId || `run #${run.id}` }}</strong><span>{{ stateLabel(run.status) }} · attempt {{ run.attempt }}/{{ run.maxAttempts }}</span><button v-if="retryAvailable(run)" class="button" type="button" :disabled="acting === `retry-${run.runId}`" @click="retryProvisioning(run)">重試</button><small v-else>僅 retry_wait、未用盡次數且已到可重試時間的 run 可重試。</small></article></div></section>
          <section class="panel"><div class="panel__heading"><div><p class="eyebrow">INVITATIONS</p><h2>操作員邀請</h2></div><span class="count">{{ detail.invitations.length }} invitations</span></div><p v-if="actionErrors.invite" class="notice notice--error" role="alert">{{ actionErrors.invite }}</p><p class="limitation">{{ invitationLimitation }}</p><p v-if="!selectedTenant?.healthyReceiptFingerprint || selectedTenant?.state !== 'invitation_pending'" class="empty-inline">只有健康已驗證、狀態為 invitation_pending 的租戶可在這裡建立邀請。server 也接受對 active 租戶建立邀請，但兌換時租戶必須仍是 invitation_pending（否則回 409 ACTIVATION_LINEAGE），那種邀請無法兌換，所以這裡不提供。</p><form v-else class="inline-form" @submit.prevent="inviteOperator"><label>Email<input v-model.trim="inviteForm.email" type="email" required placeholder="operator@example.com"></label><label>角色<select v-model="inviteForm.roleKey" required><option value="" disabled>選擇已 materialize 的角色</option><option v-for="roleKey in roleKeys" :key="roleKey" :value="roleKey">{{ roleKey }}</option></select></label><button class="button" type="submit" :disabled="!canInvite || acting === 'invite'">{{ acting === 'invite' ? '建立中…' : '邀請操作員' }}</button></form><div v-if="lastInvitation && lastInvitation.systemTenantId === selectedTenant?.systemTenantId" class="invite-token" role="status"><strong>{{ lastInvitation.token ? '一次性邀請 token' : '這次沒有新的 token' }}</strong><p>受邀者 <span class="mono">{{ lastInvitation.email }}</span> · 角色 {{ lastInvitation.roleKey }} · 到期 {{ lastInvitation.expiresAt || '未回報' }}</p><template v-if="lastInvitation.token"><label>Token<input class="mono" :value="lastInvitation.token" readonly @focus="($event.target as HTMLInputElement).select()"></label><p>{{ invitationTokenNotice }}</p><p>{{ invitationRedeemNotice }}</p></template><p v-else>{{ lastInvitation.replayed ? invitationReplayNotice : invitationMissingTokenNotice }}</p><button class="button" type="button" @click="lastInvitation = null">{{ lastInvitation.token ? '我已保存，關閉' : '關閉' }}</button></div><p v-if="!roleKeys.length" class="empty-inline">目前詳情沒有可安全使用的 materialized role；邀請端點會拒絕未驗證角色。</p><div v-if="detail.invitations.length" class="compact-list"><article v-for="invitation in detail.invitations" :key="invitation.invitationId"><strong>{{ invitationLabel(invitation) || `${invitation.roleKey}（既有邀請的 email 不回傳）` }}</strong><span>{{ invitation.roleKey }} · {{ stateLabel(invitation.status) }}</span><button v-if="invitation.status === 'pending' && invitationLabel(invitation)" class="button button--danger" type="button" @click="beginRevoke(invitation)">撤銷邀請</button><small v-else-if="invitation.status === 'pending'">為保護資料，既有邀請不回傳 email；本次無法以 email 重新確認撤銷。</small></article></div></section>
          <section class="panel"><div class="panel__heading"><div><p class="eyebrow">AUDIT</p><h2>稽核軌跡</h2></div><span class="count">{{ (audit?.events?.length || 0) + (audit?.receipts?.length || 0) }} records</span></div><p v-if="!audit?.events?.length && !audit?.receipts?.length" class="empty-inline">尚無可顯示的租戶稽核紀錄。</p><div v-else class="compact-list"><p v-for="event in audit.events || []" :key="event.eventId || event.id"><strong>{{ event.eventType }}</strong><span>{{ event.previousState }} → {{ event.nextState }} · {{ new Date(event.occurredAt).toLocaleString('zh-TW') }}</span></p><p v-for="receipt in audit.receipts || []" :key="receipt.receiptId || receipt.id"><strong>{{ receipt.receiptType }}</strong><span>{{ stateLabel(receipt.status) }} · <span class="mono">{{ receipt.receiptFingerprint }}</span></span></p></div></section>
          <section class="panel"><div class="panel__heading"><div><p class="eyebrow">PROVENANCE</p><h2>來源與譜系</h2></div></div><p v-if="!provenance" class="empty-inline">來源資料目前無法顯示。</p><details v-else class="advanced"><summary>檢視來源與 lineage 資料</summary><pre>{{ pretty(provenance) }}</pre></details></section>
          <section class="panel"><div class="panel__heading"><div><p class="eyebrow">TEMPLATES / DRAFTS</p><h2>範本、草稿、編譯與預覽</h2></div><span class="count">{{ templates.length }} templates</span></div><p v-if="actionErrors.draft" class="notice notice--error" role="alert">{{ actionErrors.draft }}</p><p v-if="templateClaims" class="limitation">範本端點宣告：{{ templateClaims.executableGeneration ? '可執行產生' : '不可執行產生' }}；{{ templateClaims.erpNextCoreFork ? '包含 ERPNext core fork' : '不包含 ERPNext core fork' }}。</p><form class="draft-form" @submit.prevent="createDraft"><label>範本<select v-model="draftForm.preferredTemplate" required><option v-for="template in templates" :key="template.key" :value="template.key">{{ template.label }}</option></select></label><label>需求<textarea v-model.trim="draftForm.requirements" required minlength="8" maxlength="8000" rows="3" placeholder="描述需要的業務流程"></textarea></label><label>Client ID<input v-model="draftForm.clientId" required inputmode="numeric"></label><label>Business type<input v-model.trim="draftForm.businessType" required></label><label>Industry<input v-model.trim="draftForm.industry" required></label><label>Website ID（可留空）<input v-model.trim="draftForm.websiteId"></label><label>Managed Site project ID（可留空）<input v-model.trim="draftForm.managedSiteProjectId" inputmode="numeric"></label><button class="button button--primary" type="submit" :disabled="acting === 'draft'">{{ acting === 'draft' ? '建立中…' : '建立草稿' }}</button></form><div class="actions"><button class="button" type="button" :disabled="!currentSpec || acting === 'compile'" @click="compileDraft">編譯選取草稿</button><button class="button" type="button" :disabled="!currentSpec || acting === 'preview'" @click="buildPreview">建立 Preview</button></div><details v-if="compiledPlan || previewResult" class="advanced"><summary>檢視編譯／Preview 結果</summary><p v-if="previewClaims" class="limitation">Preview 宣告：{{ previewClaims.deployed ? '已部署' : '未部署' }}、{{ previewClaims.productionData ? '含 production data' : '不含 production data' }}。</p><pre>{{ pretty(compiledPlan || previewResult) }}</pre></details></section>
        </template></section>
      </div>
    </OwnerAsyncState>
    <OwnerConfirmAction :open="Boolean(revokeInvitation)" title="撤銷操作員邀請" :target="revokeInvitation ? invitationLabel(revokeInvitation) : ''" description="這會把此邀請的本地紀錄標為已撤銷，之後用這個 token 兌換會被拒絕。系統不會通知對方；如果你已經把 token 交給對方，請自行告知。" consequence="撤銷後這個邀請無法恢復；如仍要邀請對方，可以重新建立一個新邀請（會產生新的 token）。" confirm-label="撤銷邀請" :busy="confirmBusy" :error="confirmError" :simulated="true" @confirm="doRevoke" @cancel="revokeInvitation = null" />
    <OwnerConfirmAction :open="Boolean(lifecycleAction)" :title="lifecycleAction === 'deprovision' ? '終止租戶（不可逆）' : '暫停租戶'" :target="tenantName" description="這只會更新本地租戶狀態並寫入一筆稽核事件，不會呼叫外部控制平面。" :consequence="lifecycleAction === 'deprovision' ? '終止後無法復原：租戶會進入 deprovision_pending，之後不能再暫停或恢復。' : '暫停後可以在這個頁面用「恢復租戶」把租戶改回 active。'" :confirm-label="lifecycleAction === 'deprovision' ? '終止租戶' : '暫停租戶'" :busy="confirmBusy" :error="confirmError" :simulated="true" @confirm="performLifecycle()" @cancel="lifecycleAction = null" />
  </section>
</template>

<style scoped>
.tenants-page{max-width:1480px;margin:0 auto;padding:clamp(1.25rem,3vw,3.5rem);color:#17253d}.tenants-page__hero{display:flex;justify-content:space-between;align-items:flex-end;gap:2rem;margin-bottom:1.4rem}.eyebrow{margin:0 0 .45rem;color:#55708e;font-size:.68rem;font-weight:800;letter-spacing:.14em}.tenants-page h1{margin:0;color:#14243e;font-size:clamp(2rem,5vw,4.2rem);line-height:.98;letter-spacing:-.05em}.lede{max-width:760px;margin:1rem 0 0;color:#526174;font-size:1rem;line-height:1.7}.button{border:1px solid #c8d3df;border-radius:999px;background:#fff;color:#20324c;padding:.65rem .9rem;font:inherit;font-size:.78rem;font-weight:800;cursor:pointer}.button:hover,.button:focus-visible{border-color:#486d9d;outline:3px solid rgba(72,109,157,.18)}.button:disabled{cursor:not-allowed;opacity:.55}.button--primary{border-color:#1e4d79;background:#1e4d79;color:#fff}.button--danger{color:#a83f3f}.notice{border:1px solid;border-radius:12px;padding:.8rem 1rem;margin:0 0 1rem;font-size:.85rem}.notice--success{border-color:#9bc9b0;background:#effaf3;color:#205a38}.notice--error{border-color:#e3aaaa;background:#fff2f2;color:#873434}.empty-state,.empty-inline{border:1px dashed #b6c5d3;border-radius:14px;background:#fff;color:#637184;padding:1.1rem;text-align:center}.master-detail{display:grid;grid-template-columns:minmax(250px,.72fr) minmax(0,2fr);gap:1rem}.detail-column{min-width:0}.panel{border:1px solid #dbe3eb;border-radius:18px;background:#fff;box-shadow:0 12px 35px rgba(27,51,78,.06);padding:clamp(1rem,2vw,1.5rem);margin-bottom:1rem}.panel__heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}.panel h2{margin:0;color:#172c48;font-size:1.2rem}.count{color:#6b7b8d;font-size:.72rem;font-weight:800}.toolbar,.actions,.inline-form{display:flex;align-items:end;flex-wrap:wrap;gap:.6rem;margin:1rem 0}.toolbar input,.toolbar select,.inline-form input,.inline-form select,.draft-form input,.draft-form select,.draft-form textarea{border:1px solid #c8d3df;border-radius:9px;background:#fff;padding:.65rem;color:#17253d;font:inherit}.toolbar input{min-width:0;flex:1}.toolbar select{max-width:11rem}.system-rows,.compact-list{display:grid;gap:.65rem}.system-row{display:grid;grid-template-columns:1fr auto;gap:.3rem;text-align:left;border:1px solid #dbe3eb;border-radius:11px;background:#fff;padding:.75rem;cursor:pointer}.system-row[aria-pressed=true]{border-color:#486d9d;box-shadow:0 0 0 2px rgba(72,109,157,.15)}.system-row small{grid-column:1/-1;color:#66778a}.status-badge{display:inline-flex;align-items:center;width:max-content;border:1px solid #cbd6e2;border-radius:999px;padding:.28rem .55rem;color:#40546c;font-size:.66rem;font-weight:800;white-space:nowrap}.status-badge[data-status='active'],.status-badge[data-status='completed'],.status-badge[data-status='accepted']{border-color:#8fbca3;background:#effaf3;color:#205a38}.status-badge[data-status='suspended'],.status-badge[data-status='retry_wait'],.status-badge[data-status='payment_verified']{border-color:#d8bd84;background:#fff9eb;color:#745318}.status-badge[data-status='terminated'],.status-badge[data-status='blocked'],.status-badge[data-status='revoked']{border-color:#dfa1a1;background:#fff2f2;color:#873434}.facts{margin:1rem 0 0}.facts div{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-top:1px solid #edf1f4}.facts dt{color:#7a8797;font-size:.68rem}.facts dd{margin:0;color:#30445d;font-size:.72rem;text-align:right;overflow-wrap:anywhere}.limitation{border-left:3px solid #9cb8d4;margin:1rem 0;padding-left:.65rem;color:#5d6c7e;font-size:.75rem;line-height:1.5}.inline-form label,.draft-form label{display:grid;gap:.35rem;color:#526174;font-size:.72rem;font-weight:800}.inline-form label{min-width:12rem}.draft-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem}.draft-form label:nth-child(2){grid-column:span 2}.draft-form textarea{resize:vertical}.compact-list p,.compact-list article{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin:0;padding:.7rem 0;border-top:1px solid #edf1f4;color:#607086;font-size:.74rem}.compact-list strong{color:#28415e}.compact-list small{width:100%;color:#718196}.advanced{margin-top:1rem;border-top:1px solid #e7edf2;padding-top:.8rem}.advanced summary{color:#315a83;cursor:pointer;font-size:.76rem;font-weight:800}.advanced pre{max-width:100%;overflow:auto;margin:.65rem 0 0;padding:.75rem;border-radius:9px;background:#101319;color:#e8edf5;font-size:.67rem}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.66rem!important}.invite-token{display:grid;gap:.55rem;margin:1rem 0;padding:1rem;border:1px solid #d9b25f;border-radius:14px;background:#fff8e6;color:#5b4410}.invite-token p{margin:0;font-size:.78rem;line-height:1.6}.invite-token label{display:grid;gap:.35rem;font-size:.72rem;font-weight:800}.invite-token input{width:100%;box-sizing:border-box;border:1px solid #d9b25f;border-radius:9px;background:#fff;padding:.6rem .7rem}.invite-token .button{justify-self:start}@media(max-width:920px){.master-detail{grid-template-columns:1fr}.system-list{max-height:none}.draft-form{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.tenants-page__hero{display:block}.tenants-page__hero .button{margin-top:1rem}.draft-form{grid-template-columns:1fr}.draft-form label:nth-child(2){grid-column:auto}.panel__heading,.compact-list p,.compact-list article{align-items:flex-start;flex-direction:column}.inline-form{display:grid}.inline-form label{min-width:0}}
</style>
