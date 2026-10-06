<script setup lang="ts">
type ManagedProjectsFetch = <T = unknown>(path: string, options?: { method?: 'POST' | 'PATCH'; body?: Record<string, unknown>; query?: Record<string, string> }) => Promise<T>
// Keep the existing Nuxt fetch runtime and these page-owned response DTOs.
const fetchManagedProjects = $fetch as unknown as ManagedProjectsFetch
definePageMeta({ layout: 'owner' })
useHead({ title: 'Managed Sites 專案交付｜DiscoveryStack Private Workbench', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type Row = Record<string, any> & { id: number; canonicalClientIdentity: string; status: string }
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
const projects = ref<Row[]>([])
const selectedProject = ref<Row | null>(null)
const detail = ref<any>(null)
const audit = ref<any[]>([])
const members = ref<any[]>([])
const provisioning = ref<any>(null)
const provisioningPlans = ref<any[]>([])
const integrations = ref<any>(null)
const gates = ref<any>(null)
const detailLoading = ref(false)
const query = ref('')
const status = ref('all')
const page = ref(1)
const pageSize = 8
const releaseId = ref('')
const confirmKind = ref<'deploy' | 'member' | null>(null)
const confirmTarget = ref('')
const confirmPayload = ref<any>(null)
const confirmBusy = ref(false)
const confirmError = ref('')
const createForm = reactive({ canonicalClientIdentity: '', canonicalWebsiteIdentity: '', siteType: 'one_page', idempotencyKey: '' })
const memberForm = reactive({ email: '', role: 'editor', idempotencyKey: '' })
const planForm = reactive({ versionId: '', domainIntentId: '', platform: 'vercel', deploymentMode: 'preview_only', idempotencyKey: '' })
const domainForm = reactive({ mode: 'customer_owned', requestedDomain: '', providerKey: '', idempotencyKey: '' })
const integrationForm = reactive({ moduleKey: 'bounded_ai_assistant', providerKey: '', redactedConfig: '{}', idempotencyKey: '' })
const quoteForm = reactive({ requestedDomain: '', executionMode: 'dry_run', idempotencyKey: '' })
type MemberInvitationDeliveryStatus = 'sent' | 'manual_required' | 'delivery_failed' | 'already_pending'
type IssuedMemberInvitation = { projectId: number; email: string; role: string; expiresAt: string; invitationUrl: string | null; reaccessPath: string; deliveryStatus: MemberInvitationDeliveryStatus; replayed: boolean }
const lastMemberInvitation = ref<IssuedMemberInvitation | null>(null)
const linkForm = reactive({ displayName: '', canonicalSiteOrigin: '', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 12, idempotencyKey: '' })
const deployLimitation = '這是 live 模式的真實部署：會呼叫已設定的 deployment provider 改動線上站台，不可逆。'
const rollbackLimitation = '這裡不提供 rollback：內部部署 broker（internal deployment broker）沒有實作 rollback，rollback 請求一律回 503。如果照樣送出，server 會先把線上的 release 改成 rollback_pending，失敗後再改成 retry_wait（錯誤碼 ROLLBACK_FAILED）：站台不會真的回滾，線上那個 release 反而會失去 live_verified 狀態。要等部署通道支援 rollback 之後才會開放。'
const publishLimitation = 'mocked 模式只在測試環境開放（server 端非測試環境一律回 503），所以只有 server 回報允許時才會出現在選單。網域報價選 dry_run 時，server 只做資格檢查、不會產生報價（回傳的 quote 是 null），也不會購買網域或推站。部署與 live 報價要等對應 provider 的憑證通過驗證才會啟用。'
const provisioningLimitation = '未接真實對端，不會真的開通：建立佈建計畫只會在本地寫入計畫與步驟紀錄；執行 dry-run 只會為每個步驟寫入一筆 planned 事件，不會呼叫任何 adapter，也不會對外連線。'
const domainIntentLimitation = '未接真實對端，不會真的開通：記錄網域意圖只會在本地寫入一筆網域意圖（每個專案只能有一筆），不會查詢或購買網域，也不會變更 DNS。'
const domainReleaseLimitation = '這裡不提供釋出網域：目前沒有任何端點會列出網域宣告（domain claim），頁面無法顯示、也無法讓你確認實際會釋出哪一個網域。釋出是永久的：宣告會永久變成 released，這個網域的全域唯一鎖定會解除，其他專案之後就能宣告同一個網域；server 只會在本地寫入一筆 domain_claim_released receipt，不會呼叫網域註冊商。要等 server 端提供可讀取網域宣告的端點後才會開放。'
const memberInvitationLimitation = '邀請會先建立受控成員資格與單次 token。私有入口與寄信服務都已設定時，系統會直接寄出完整邀請連結，owner response 不會再帶回 token；尚未設定或寄送失敗時，才會在這裡顯示一次人工備援連結。'
const memberTokenNotice = 'server 只保存 token 的 hash；完整備援連結關閉、離開或重新整理後就無法再取回，請現在用可信任的管道交給受邀者。邀請 72 小時後到期。'
const memberAcceptNotice = '受邀者開啟連結後會先看到確認頁；只有按下「進入網站後台」的 POST 才會消耗單次 token，因此郵件掃描器或連結預覽不會把邀請提早用掉。'
const memberReplayNotice = '這個 Email 已有一筆尚未到期的邀請，server 不會揭露原 token。請受邀者先找先前的邀請信；若連結遺失或已使用，可到重新登入頁輸入同一個 Email 取得 30 分鐘短效連結，不必等待原邀請到期。'
const memberMissingTokenNotice = '這次沒有可交付的邀請連結；請確認寄信設定與成員狀態後再試。'
const memberRevokeLimitation = '撤銷會將這位成員設為 revoked，並讓同一專案目前所有客戶登入會話失效；不會刪除專案、付款紀錄或呼叫外部服務。'
type ReadinessItem = { capability: string; status: string; liveMutationAllowed: boolean; missing: string[] }
type Readiness = { capabilities: ReadinessItem[]; liveReady: boolean; dryRunAllowed: boolean; mockedAllowed: boolean; truthfulBoundary: string[] }
const readiness = ref<Readiness | null>(null)
const deployCapability = computed(() => readiness.value?.capabilities?.find(item => item.capability === 'deployment') || null)
const domainCapability = computed(() => readiness.value?.capabilities?.find(item => item.capability === 'domain_registration') || null)
const deploymentReady = computed(() => deployCapability.value?.liveMutationAllowed === true)
const domainLiveReady = computed(() => domainCapability.value?.liveMutationAllowed === true)
const mockedAllowed = computed(() => readiness.value?.mockedAllowed === true)
const deploymentBlockedReason = computed(() => !readiness.value
  ? 'deployment provider 的就緒狀態尚未載入，部署暫時停用。'
  : `deployment provider 尚未就緒，部署已停用。缺少：${(deployCapability.value?.missing || ['provider_configuration']).join('、')}。`)
type DeploymentResult = { release?: { id?: number; status?: string }; receipt?: { receiptType?: string; receiptStatus?: string; externalReference?: string | null }; replayed?: boolean }
function describeDeployment(result: DeploymentResult) {
  const parts = [`release 狀態 ${result?.release?.status || '未回報'}`, `receipt ${result?.receipt?.receiptType || '未回報'} / ${result?.receipt?.receiptStatus || '未回報'}`]
  if (result?.receipt?.externalReference) parts.push(`provider 部署編號 ${result.receipt.externalReference}`)
  if (result?.replayed) parts.push('（此次為同一 idempotency key 的重播，未再次呼叫 provider）')
  return `${parts.join('，')}。`
}
const key = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const statuses = computed(() => [...new Set(projects.value.map(item => String(item.status || 'unknown')))])
const filtered = computed(() => projects.value.filter(item => (status.value === 'all' || item.status === status.value) && `${item.canonicalClientIdentity || ''} ${item.canonicalWebsiteIdentity || ''}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const rows = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const selectedName = computed(() => detail.value?.project?.canonicalClientIdentity || selectedProject.value?.canonicalClientIdentity || '')
function parseJson(value: string) { try { return JSON.parse(value) } catch { return {} } }
function refreshKey(form: { idempotencyKey: string }, prefix: string) { form.idempotencyKey = key(prefix) }
function onPage(value: number) { page.value = value }
type ActionScope = 'create' | 'member' | 'provisioning' | 'domain' | 'release' | 'integration' | 'content'
const actionErrors = reactive<Record<ActionScope, string>>({ create: '', member: '', provisioning: '', domain: '', release: '', integration: '', content: '' })
const detailError = ref('')
function beginAction(scope: ActionScope) { actionErrors[scope] = '' }
function operationError(scope: ActionScope, error: any, fallback: string) { actionErrors[scope] = error?.data?.message || fallback }
async function load() {
  loading.value = true; errorMessage.value = ''
  try { projects.value = (await fetchManagedProjects<{ projects: Row[] }>('/api/managed-sites/projects')).projects || [] }
  catch (error: any) { projects.value = []; errorMessage.value = error?.data?.message || '專案清單目前無法載入。' }
  finally { loading.value = false }
}
async function loadDetail(project: Row) {
  selectedProject.value = project; detailLoading.value = true; detailError.value = ''; gates.value = null
  try {
    const [projectResult, auditResult, memberResult, provisioningResult, integrationResult] = await Promise.all([
      fetchManagedProjects<any>(`/api/managed-sites/projects/${project.id}`), fetchManagedProjects<any>(`/api/managed-sites/projects/${project.id}/audit`), fetchManagedProjects<any>(`/api/managed-sites/projects/${project.id}/members`), fetchManagedProjects<any>(`/api/managed-sites/projects/${project.id}/provisioning-workspace`), fetchManagedProjects<any>(`/api/managed-sites/projects/${project.id}/integrations`),
    ])
    detail.value = projectResult; audit.value = auditResult.events || []; members.value = memberResult.members || []; provisioning.value = provisioningResult.workspace || provisioningResult; integrations.value = integrationResult.workspace || integrationResult
  } catch (error: any) { detailError.value = error?.data?.message || '專案詳細資料目前無法載入。' }
  finally { detailLoading.value = false }
}
async function afterWrite(message: string) { notice.value = message; await load(); if (selectedProject.value) await loadDetail(selectedProject.value) }
async function createProject() { refreshKey(createForm, 'project'); beginAction('create'); try { const result: any = await fetchManagedProjects('/api/managed-sites/projects', { method: 'POST', body: createForm }); await afterWrite('專案已建立。'); if (result?.project) await loadDetail(result.project) } catch (error: any) { operationError('create', error, '建立專案失敗。') } }
async function inviteMember() {
  if (!selectedProject.value) return
  const projectId = selectedProject.value.id
  refreshKey(memberForm, 'member'); beginAction('member')
  try {
    const result = await fetchManagedProjects<{ invitation?: { recipientEmail?: string; role?: string; expiresAt?: string }; invitationToken?: string | null; invitationUrl?: string | null; reaccessPath?: string; delivery?: { status?: MemberInvitationDeliveryStatus }; replayed?: boolean }>(`/api/managed-sites/projects/${projectId}/members`, { method: 'POST', body: memberForm })
    const fallbackPath = typeof result?.invitationToken === 'string' && result.invitationToken ? `/managed-site-access?token=${encodeURIComponent(result.invitationToken)}` : null
    const deliveryStatus = result?.delivery?.status || (fallbackPath ? 'manual_required' : result?.replayed ? 'already_pending' : 'manual_required')
    lastMemberInvitation.value = { projectId, email: String(result?.invitation?.recipientEmail || memberForm.email), role: String(result?.invitation?.role || memberForm.role), expiresAt: String(result?.invitation?.expiresAt || ''), invitationUrl: typeof result?.invitationUrl === 'string' && result.invitationUrl ? result.invitationUrl : fallbackPath, reaccessPath: typeof result?.reaccessPath === 'string' && result.reaccessPath ? result.reaccessPath : '/managed-site-access', deliveryStatus, replayed: result?.replayed === true }
    const message = deliveryStatus === 'sent'
      ? '成員邀請信已送出；server response 沒有回傳單次 token。'
      : deliveryStatus === 'delivery_failed'
        ? '成員邀請已建立，但寄信暫時失敗；請立即複製下方備援連結並用可信任的管道交付。'
        : deliveryStatus === 'already_pending'
          ? '這個 Email 已有尚未到期的邀請；可請受邀者找先前信件，或從重新登入頁恢復入口。'
          : '成員邀請已建立；寄信設定尚未就緒，請立即複製下方備援連結。'
    memberForm.email = ''
    await afterWrite(message)
  } catch (error: any) { operationError('member', error, '邀請成員失敗。') }
}
async function changeRole(member: any, role: string) { if (!selectedProject.value) return; beginAction('member'); try { await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/members/${member.id}`, { method: 'PATCH', body: { role, idempotencyKey: key('role') } }); await afterWrite('成員角色已更新。') } catch (error: any) { operationError('member', error, '更新成員角色失敗。') } }
async function createPlan() { if (!selectedProject.value) return; refreshKey(planForm, 'plan'); beginAction('provisioning'); try { const result: any = await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/provisioning-plans`, { method: 'POST', body: { ...planForm, versionId: Number(planForm.versionId), domainIntentId: Number(planForm.domainIntentId) } }); if (result?.plan && !provisioningPlans.value.some(item => item.id === result.plan.id)) provisioningPlans.value.push(result.plan); await afterWrite('佈建計畫已寫入本地紀錄。') } catch (error: any) { operationError('provisioning', error, '建立佈建計畫失敗。') } }
async function dryRun(plan: any) { if (!selectedProject.value) return; beginAction('provisioning'); try { const result: any = await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/provisioning-plans/${plan.id}/dry-run`, { method: 'POST' }); notice.value = `Dry-run 已完成。${result?.externalCalls === false ? '未呼叫外部服務。' : ''}${result?.providerConfigured === false ? ' 尚未接上任何佈建 provider。' : ''}`; await loadDetail(selectedProject.value) } catch (error: any) { operationError('provisioning', error, '佈建 dry-run 失敗。') } }
async function recordDomainIntent() { if (!selectedProject.value) return; refreshKey(domainForm, 'domain'); beginAction('domain'); try { const result: any = await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/domain-intents`, { method: 'POST', body: { ...domainForm, providerKey: domainForm.providerKey || null } }); notice.value = `網域意圖已保存。${result?.execution?.externalCalls === false ? '未呼叫外部服務。' : ''}`; await loadDetail(selectedProject.value) } catch (error: any) { operationError('domain', error, '保存網域意圖失敗。') } }
async function saveIntegration() { if (!selectedProject.value) return; refreshKey(integrationForm, 'integration'); beginAction('integration'); try { const result: any = await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/integrations`, { method: 'POST', body: { ...integrationForm, redactedConfig: parseJson(integrationForm.redactedConfig), providerKey: integrationForm.providerKey || null } }); notice.value = `整合意圖已保存。${result?.externalCalls === false ? '未呼叫第三方服務。' : ''}`; await loadDetail(selectedProject.value) } catch (error: any) { operationError('integration', error, '保存整合意圖失敗。') } }
async function loadGates() { if (!selectedProject.value || !releaseId.value) return; beginAction('release'); try { gates.value = await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/releases/${releaseId.value}/gates`); notice.value = '已讀取發佈閘門狀態。' } catch (error: any) { operationError('release', error, '讀取發佈閘門失敗。') } }
async function approveRelease() { if (!selectedProject.value || !releaseId.value) return; beginAction('release'); try { await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/releases/${releaseId.value}/approve`, { method: 'POST', body: { idempotencyKey: key('approve') } }); await afterWrite('發佈已核准。') } catch (error: any) { operationError('release', error, '核准發佈失敗。') } }
async function quoteDomain() { if (!selectedProject.value || !releaseId.value) return; refreshKey(quoteForm, 'quote'); beginAction('release'); const mode = quoteForm.executionMode; try { const result: any = await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/releases/${releaseId.value}/domain-quote`, { method: 'POST', body: quoteForm }); notice.value = `${result?.quote ? '已取得網域報價。' : mode === 'dry_run' ? '資格檢查已完成；dry_run 不會產生報價（server 回傳的 quote 是 null）。' : 'server 沒有回傳報價。'}${result?.externalCalls === false ? '未呼叫外部服務。' : ''}` } catch (error: any) { operationError('release', error, '取得網域報價失敗。') } }
async function linkContentOperations() { if (!selectedProject.value) return; refreshKey(linkForm, 'content'); beginAction('content'); try { await fetchManagedProjects(`/api/managed-sites/projects/${selectedProject.value.id}/content-operations-link`, { method: 'POST', body: linkForm }); await afterWrite('已連接 Content Operations client。') } catch (error: any) { operationError('content', error, '連接 Content Operations 失敗。') } }
function openConfirm(kind: 'deploy', target: string, payload: any) { confirmKind.value = kind; confirmTarget.value = target; confirmPayload.value = payload; confirmError.value = '' }
function openMemberRevoke(member: any) {
  if (!selectedProject.value || member.role === 'owner' || member.status !== 'active' || confirmBusy.value) return
  confirmKind.value = 'member'; confirmTarget.value = String(member.principalEmail || member.displayName || `成員 #${member.id}`)
  confirmPayload.value = { projectId: selectedProject.value.id, membershipId: member.id, idempotencyKey: key('member-revoke') }; confirmError.value = ''
}
function dismissConfirm() { confirmKind.value = null; confirmPayload.value = null; confirmError.value = '' }
function closeConfirm() { if (!confirmBusy.value) dismissConfirm() }
async function confirmAction() {
  if (!selectedProject.value || !confirmKind.value || confirmBusy.value) return
  confirmBusy.value = true; confirmError.value = ''
  try {
    if (confirmKind.value === 'member') {
      const payload = confirmPayload.value
      if (!payload) return
      const result = await fetchManagedProjects<{ replayed?: boolean }>(`/api/managed-sites/projects/${payload.projectId}/members/${payload.membershipId}/revoke`, { method: 'POST', query: { idempotencyKey: payload.idempotencyKey } })
      const message = result.replayed ? '這位成員先前已撤銷；同專案的客戶登入會話已失效。' : '成員已撤銷；同專案的客戶登入會話已失效。'
      dismissConfirm(); await afterWrite(message)
      return
    }
    const outcome = describeDeployment(await fetchManagedProjects<DeploymentResult>(`/api/managed-sites/projects/${selectedProject.value.id}/releases/${releaseId.value}/deploy`, { method: 'POST', body: { executionMode: 'live', idempotencyKey: key('deploy') } }))
    const message = `部署已以 live 模式對 provider 執行：release #${releaseId.value}，${outcome}`
    dismissConfirm(); await afterWrite(message)
  } catch (error: any) { confirmError.value = error?.data?.message || '此操作失敗。' }
  finally { confirmBusy.value = false }
}
async function loadReadiness() {
  try { readiness.value = await fetchManagedProjects<Readiness>('/api/managed-sites/live-connectors/readiness') }
  catch { readiness.value = null }
}
onMounted(() => { void load(); void loadReadiness() })
</script>

<template>
  <section class="delivery-page">
    <div class="delivery-page__hero"><div><p class="eyebrow">OWNER / MANAGED SITES</p><h1>Managed Sites 專案交付</h1><p class="lede">查看每個網站專案的成員、佈建、網域、發佈與稽核紀錄；所有狀態均以 server response 為準。</p></div><button class="button button--primary" type="button" :disabled="loading" @click="load">重新整理</button></div>
    <p v-if="notice" class="notice notice--success" role="status">{{ notice }}</p><p v-if="errorMessage" class="notice notice--error" role="alert">{{ errorMessage }}</p>
    <section class="panel"><div class="panel__heading"><div><p class="eyebrow">CREATE</p><h2>新增專案</h2></div></div><p v-if="actionErrors.create" class="notice notice--error" role="alert">{{ actionErrors.create }}</p><form class="form-grid" @submit.prevent="createProject"><label>客戶名稱<input v-model="createForm.canonicalClientIdentity" required></label><label>網站識別<input v-model="createForm.canonicalWebsiteIdentity" required></label><label>網站類型<select v-model="createForm.siteType"><option value="one_page">one_page</option><option value="brand_blog">brand_blog</option><option value="simple_commerce">simple_commerce</option></select></label><button class="button button--primary" type="submit">建立專案</button></form></section>
    <OwnerAsyncState :loading="loading" :error="errorMessage" :empty="projects.length === 0" loading-label="正在載入專案…" empty-label="目前沒有 Managed Sites 專案。" @retry="load"><div class="master-detail"><section class="panel"><div class="panel__heading"><div><p class="eyebrow">PROJECTS</p><h2>專案清單</h2></div><span class="count">{{ filtered.length }} 筆</span></div><div class="toolbar"><input v-model="query" type="search" placeholder="搜尋客戶識別或網站識別" @input="page = 1"><select v-model="status" @change="page = 1"><option value="all">所有狀態</option><option v-for="item in statuses" :key="item" :value="item">{{ item }}</option></select></div><div class="row-list"><button v-for="project in rows" :key="project.id" class="row-button" type="button" :class="{ 'row-button--selected': selectedProject?.id === project.id }" @click="loadDetail(project)"><strong>{{ project.canonicalClientIdentity }}</strong><span class="status-badge" :data-status="project.status">{{ project.status }}</span><small class="mono">#{{ project.id }} · {{ project.canonicalWebsiteIdentity }}</small></button></div><OwnerPager :page="page" :page-size="pageSize" :total="filtered.length" :disabled="loading" @update:page="onPage" /></section>
      <section class="panel detail"><div class="panel__heading"><div><p class="eyebrow">DETAIL</p><h2>{{ selectedName || '選擇一個專案' }}</h2></div><span v-if="detailLoading" class="count">載入中…</span></div><p v-if="detailError" class="notice notice--error" role="alert">{{ detailError }}</p><p v-if="!selectedProject" class="empty-inline">從左側選擇專案即可管理其交付流程。</p><template v-else><dl v-if="detail?.project" class="facts"><div><dt>專案狀態</dt><dd>{{ detail.project.status }}</dd></div><div><dt>網站識別</dt><dd>{{ detail.project.canonicalWebsiteIdentity }}</dd></div><div><dt>目前版本</dt><dd>{{ detail.project.activeVersionId || '尚未指定' }}</dd></div></dl>
        <section class="subpanel"><h3>成員</h3><p v-if="actionErrors.member" class="notice notice--error" role="alert">{{ actionErrors.member }}</p><p class="limitation">{{ memberInvitationLimitation }}</p><form class="form-grid" @submit.prevent="inviteMember"><label>Email<input v-model="memberForm.email" type="email" required></label><label>角色<select v-model="memberForm.role"><option value="administrator">administrator</option><option value="editor">editor</option><option value="reviewer">reviewer</option><option value="analyst">analyst</option></select></label><button class="button" type="submit">邀請成員</button></form><div v-if="lastMemberInvitation && lastMemberInvitation.projectId === selectedProject?.id" class="invite-token" role="status"><strong>{{ lastMemberInvitation.deliveryStatus === 'sent' ? '邀請信已送出' : lastMemberInvitation.invitationUrl ? '一次性邀請連結' : '已有待處理邀請' }}</strong><p>受邀者 <span class="mono">{{ lastMemberInvitation.email }}</span> · 角色 {{ lastMemberInvitation.role }} · 到期 {{ lastMemberInvitation.expiresAt || '未回報' }}</p><template v-if="lastMemberInvitation.invitationUrl"><label>完整邀請連結<input class="mono" :value="lastMemberInvitation.invitationUrl" readonly @focus="($event.target as HTMLInputElement).select()"></label><p>{{ memberTokenNotice }}</p><p>{{ memberAcceptNotice }}</p></template><p v-else-if="lastMemberInvitation.deliveryStatus === 'sent'">信件已交給已設定的寄信服務；基於最小揭露，這次 response 不再回傳 token 或完整連結。</p><p v-else>{{ lastMemberInvitation.replayed ? memberReplayNotice : memberMissingTokenNotice }}</p><p><a :href="lastMemberInvitation.reaccessPath" target="_blank" rel="noopener noreferrer">開啟客戶重新登入頁</a></p><button class="button" type="button" @click="lastMemberInvitation = null">{{ lastMemberInvitation.invitationUrl ? '我已保存，關閉' : '關閉' }}</button></div><p v-if="!members.length" class="empty-inline">目前沒有成員資料。</p><article v-for="member in members" :key="member.id" class="item"><strong>{{ member.displayName || member.principalEmail }}</strong><span class="mono">{{ member.principalEmail }}</span><select :value="member.role" :disabled="member.role === 'owner'" @change="changeRole(member, ($event.target as HTMLSelectElement).value)"><option value="administrator">administrator</option><option value="editor">editor</option><option value="reviewer">reviewer</option><option value="analyst">analyst</option></select><button v-if="member.role !== 'owner' && member.status === 'active'" class="button button--danger" type="button" :disabled="confirmBusy" @click="openMemberRevoke(member)">撤銷成員</button></article><p class="limitation">{{ memberRevokeLimitation }}</p></section>
        <section class="subpanel"><h3>佈建</h3><p v-if="actionErrors.provisioning" class="notice notice--error" role="alert">{{ actionErrors.provisioning }}</p><p class="limitation">{{ provisioningLimitation }}</p><p v-for="item in provisioning?.truthfulBoundary || []" :key="item" class="limitation">{{ item }}</p><form class="form-grid" @submit.prevent="createPlan"><label>Version ID<input v-model="planForm.versionId" inputmode="numeric" required></label><label>Domain intent ID<input v-model="planForm.domainIntentId" inputmode="numeric" required></label><label>平台<select v-model="planForm.platform"><option value="vercel">vercel</option><option value="cloudflare_pages">cloudflare_pages</option><option value="manual_export">manual_export</option></select></label><label>模式<select v-model="planForm.deploymentMode"><option value="preview_only">preview_only</option><option value="customer_authorized">customer_authorized</option><option value="owner_authorized">owner_authorized</option></select></label><button class="button" type="submit">建立佈建計畫</button></form><p v-if="!provisioningPlans.length" class="empty-inline">此頁沒有既有計畫清單端點；新建計畫會在此顯示並可執行 dry-run。</p><article v-for="plan in provisioningPlans" :key="plan.id" class="item"><strong>計畫 #{{ plan.id }} · {{ plan.status }}</strong><span>{{ plan.platform }} · {{ plan.deploymentMode }}</span><button class="button" type="button" @click="dryRun(plan)">執行 dry-run</button></article></section>
        <section class="subpanel"><h3>網域</h3><p v-if="actionErrors.domain" class="notice notice--error" role="alert">{{ actionErrors.domain }}</p><p class="limitation">{{ domainIntentLimitation }}</p><form class="form-grid" @submit.prevent="recordDomainIntent"><label>模式<select v-model="domainForm.mode"><option value="customer_owned">customer_owned</option><option value="new_registration">new_registration</option><option value="assisted">assisted</option></select></label><label>網域<input v-model="domainForm.requestedDomain" required placeholder="example.com"></label><label>Provider key（可選）<input v-model="domainForm.providerKey"></label><button class="button" type="submit">記錄網域意圖</button></form></section>
        <section class="subpanel"><h3>發佈</h3><p v-if="actionErrors.release" class="notice notice--error" role="alert">{{ actionErrors.release }}</p><p class="limitation">{{ publishLimitation }}</p><p v-if="!deploymentReady" class="notice notice--error">{{ deploymentBlockedReason }}</p><div class="form-grid"><label>Release ID<input v-model="releaseId" inputmode="numeric"></label><button class="button" type="button" :disabled="!releaseId" @click="loadGates">查看閘門</button><button class="button" type="button" :disabled="!releaseId" @click="approveRelease">核准發佈</button><button class="button button--danger" type="button" :disabled="!releaseId || !deploymentReady" @click="openConfirm('deploy', selectedName, {})">部署發佈</button></div><pre v-if="gates" class="mono">{{ JSON.stringify(gates, null, 2) }}</pre><form class="form-grid" @submit.prevent="quoteDomain"><label>報價網域<input v-model="quoteForm.requestedDomain" required></label><label>模式<select v-model="quoteForm.executionMode"><option value="dry_run">dry_run</option><option v-if="mockedAllowed" value="mocked">mocked</option><option v-if="domainLiveReady" value="live">live</option></select></label><button class="button" type="submit">取得網域報價</button></form><p class="limitation">{{ rollbackLimitation }}</p><p class="limitation">{{ domainReleaseLimitation }}</p></section>
        <section class="subpanel"><h3>整合</h3><p v-if="actionErrors.integration" class="notice notice--error" role="alert">{{ actionErrors.integration }}</p><form class="form-grid" @submit.prevent="saveIntegration"><label>模組<select v-model="integrationForm.moduleKey"><option value="bounded_ai_assistant">bounded_ai_assistant</option><option value="shopify_commerce">shopify_commerce</option><option value="payment">payment</option></select></label><label>Provider key<input v-model="integrationForm.providerKey"></label><label>Redacted config JSON<textarea v-model="integrationForm.redactedConfig"></textarea></label><button class="button" type="submit">保存整合意圖</button></form><p v-for="item in integrations?.truthfulBoundary || []" :key="item" class="limitation">{{ item }}</p><article v-for="item in integrations?.modules || []" :key="item.moduleKey" class="item"><strong>{{ item.moduleKey }}</strong><span>{{ item.status }} · {{ item.limitation }}</span></article></section>
        <section class="subpanel"><h3>連接 Content Operations</h3><p v-if="actionErrors.content" class="notice notice--error" role="alert">{{ actionErrors.content }}</p><form class="form-grid" @submit.prevent="linkContentOperations"><label>Client 名稱<input v-model="linkForm.displayName" required></label><label>Canonical origin<input v-model="linkForm.canonicalSiteOrigin" required></label><label>Framework<select v-model="linkForm.framework"><option value="astro">astro</option><option value="nuxt">nuxt</option></select></label><label>Transport<select v-model="linkForm.publicationTransport"><option value="first_party_git">first_party_git</option><option value="first_party_signed_api">first_party_signed_api</option></select></label><label>時區<input v-model="linkForm.timeZone" required></label><label>Cadence<select v-model.number="linkForm.defaultCadenceDays"><option :value="3">3</option><option :value="7">7</option><option :value="15">15</option><option :value="30">30</option></select></label><label>發布時間<input v-model="linkForm.defaultPublishLocalTime" required></label><label>月預算<input v-model.number="linkForm.monthlyBudgetUnits" type="number" min="0" required></label><button class="button" type="submit">連接</button></form></section>
        <section class="subpanel"><h3>稽核軌跡</h3><p v-if="!audit.length" class="empty-inline">目前沒有稽核紀錄。</p><article v-for="event in audit" :key="event.id" class="item"><strong>{{ event.action }}</strong><span>{{ event.occurredAt }} · {{ event.authority }}</span><small class="mono">{{ event.eventFingerprint }}</small></article></section>
      </template></section></div></OwnerAsyncState>
    <OwnerConfirmAction :open="confirmKind === 'member'" title="撤銷成員" :target="confirmTarget" :description="memberRevokeLimitation" confirm-label="撤銷成員" :busy="confirmBusy" :error="confirmError" @confirm="confirmAction" @cancel="closeConfirm" />
    <OwnerConfirmAction :open="confirmKind === 'deploy'" title="部署發佈" :target="confirmTarget" :description="deployLimitation" consequence="部署後無法在這個頁面復原：這裡不提供 rollback（原因見發佈區塊的說明）。" confirm-label="部署" :busy="confirmBusy" :error="confirmError" @confirm="confirmAction" @cancel="closeConfirm" />
  </section>
</template>

<style scoped>.delivery-page{max-width:1320px;margin:0 auto;padding:clamp(1.25rem,3vw,3.5rem);color:#17253d}.delivery-page__hero,.panel__heading{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;margin-bottom:1.2rem}.eyebrow{margin:0 0 .45rem;color:#55708e;font-size:.68rem;font-weight:800;letter-spacing:.14em}.delivery-page h1{margin:0;color:#14243e;font-size:clamp(2rem,5vw,4rem);line-height:.98;letter-spacing:-.05em}.delivery-page h2,.delivery-page h3{margin:0;color:#172c48}.lede{max-width:720px;margin:1rem 0 0;color:#526174;line-height:1.7}.button{border:1px solid #c8d3df;border-radius:999px;background:#fff;color:#20324c;padding:.65rem .9rem;font:inherit;font-size:.78rem;font-weight:800;cursor:pointer}.button--primary{border-color:#1e4d79;background:#1e4d79;color:#fff}.button--danger{color:#a83f3f}.button:disabled{cursor:not-allowed;opacity:.55}.panel,.subpanel{border:1px solid #dbe3eb;background:#fff;box-shadow:0 12px 35px rgba(27,51,78,.06)}.panel{border-radius:18px;padding:clamp(1rem,2vw,1.5rem);margin-top:1.2rem}.subpanel{border-radius:12px;padding:1rem;margin-top:1rem}.count{color:#6b7b8d;font-size:.72rem;font-weight:800}.notice{border:1px solid;border-radius:12px;padding:.8rem 1rem;margin:0 0 1rem;font-size:.85rem}.notice--success{border-color:#9bc9b0;background:#effaf3;color:#205a38}.notice--error{border-color:#e3aaaa;background:#fff2f2;color:#873434}.empty-inline{border:1px dashed #b6c5d3;border-radius:14px;background:#fff;color:#637184;padding:1rem;text-align:center}.toolbar,.form-grid{display:flex;align-items:end;flex-wrap:wrap;gap:.7rem;margin:1rem 0}.toolbar input,.toolbar select,.form-grid input,.form-grid select,.form-grid textarea{border:1px solid #c8d3df;border-radius:9px;background:#fff;padding:.65rem;color:#17253d;font:inherit}.form-grid label{display:grid;gap:.35rem;min-width:10rem;color:#637184;font-size:.72rem;font-weight:800}.form-grid textarea{min-height:3rem}.master-detail{display:grid;grid-template-columns:minmax(18rem,.72fr) minmax(0,1.65fr);gap:1.2rem}.row-list{display:grid;gap:.55rem}.row-button{display:grid;grid-template-columns:1fr auto;gap:.35rem;text-align:left;border:1px solid #dbe3eb;border-radius:10px;background:#fff;padding:.75rem;cursor:pointer}.row-button--selected{border-color:#486d9d;background:#f1f7fc}.row-button small{grid-column:1/-1;color:#718196}.status-badge{display:inline-flex;height:max-content;border:1px solid #cbd6e2;border-radius:999px;padding:.28rem .55rem;color:#40546c;font-size:.66rem;font-weight:800}.facts{margin:1rem 0}.facts div{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-top:1px solid #edf1f4}.facts dt{color:#7a8797;font-size:.68rem}.facts dd{margin:0;color:#30445d;font-size:.72rem;text-align:right;overflow-wrap:anywhere}.item{display:grid;gap:.35rem;margin-top:.65rem;border-top:1px solid #edf1f4;padding-top:.65rem;font-size:.78rem}.item span,.item small{color:#637184}.limitation{border-left:3px solid #9cb8d4;margin:.8rem 0;padding-left:.65rem;color:#5d6c7e;font-size:.75rem;line-height:1.5}.mono{max-width:100%;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.68rem}.invite-token{display:grid;gap:.55rem;margin:1rem 0;padding:1rem;border:1px solid #d9b25f;border-radius:14px;background:#fff8e6;color:#5b4410}.invite-token p{margin:0;font-size:.78rem;line-height:1.6}.invite-token label{display:grid;gap:.35rem;font-size:.72rem;font-weight:800}.invite-token input{width:100%;box-sizing:border-box;border:1px solid #d9b25f;border-radius:9px;background:#fff;padding:.6rem .7rem}.invite-token .button{justify-self:start}@media(max-width:920px){.master-detail{grid-template-columns:1fr}}@media(max-width:640px){.delivery-page__hero,.panel__heading{display:block}.delivery-page__hero .button{margin-top:1rem}.form-grid{display:grid;grid-template-columns:1fr}.form-grid label{min-width:0}}</style>
