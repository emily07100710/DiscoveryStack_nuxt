<script setup lang="ts">
type Framework = 'astro' | 'nuxt'
type PublicationTransport = 'first_party_git' | 'first_party_signed_api'
type CadenceDays = 3 | 7 | 15 | 30
type CatchUpPolicy = 'skip_missed' | 'one_catch_up'
type ActionState = 'idle' | 'saving' | 'success' | 'error'

type Client = {
  id: string | number
  displayName: string
  canonicalSiteOrigin: string
  framework: Framework
  publicationTransport: PublicationTransport
  timeZone: string
  defaultCadenceDays: CadenceDays
  defaultPublishLocalTime: string
  monthlyBudgetUnits: number
  status?: string
  publisherCapability?: string
}

type Calendar = {
  id: string | number
  clientId: string | number
  productionPlanId: number
  planStartDate: string
  planEndDate: string
  publishLocalTime: string
  cadenceDays: CadenceDays
  monthlyBudgetUnits: number
  defaultCostUnits: number
  maxItemsPerCalendarMonth: number
  maximumTotalItems: number
  catchUpPolicy: CatchUpPolicy
  planFingerprint?: string
  status?: string
}

type ContentEntry = {
  id: string | number
  calendarId?: string | number
  clientId?: string | number
  plannedLocalDate: string
  title?: string | null
  topic?: string | null
  contentType: string
  language: string
  status: string
  framework?: Framework | string
  target?: string | null
  hasApprovedDraft?: boolean
  hasPassedRiskGate?: boolean
  nextAction?: string | null
  draftId?: string | number | null
  reviewId?: string | number | null
  idempotencyKey?: string | null
  contentHash?: string | null
  evidenceSnapshotHash?: string | null
}

type Run = { id: string | number, entryId?: string | number, state: string, retryEligibleAt?: string | null }
type PublicationTarget = { id: string | number, clientId: string | number, targetId: string, framework: Framework | string, transport: PublicationTransport | string, targetOrigin: string, contentRoot: string, defaultBranch: string | null, status: string, activeSlot?: number | null, executionEnabled: boolean, credentialConfigured: boolean, repositoryOwner?: string | null, repositoryName?: string | null, endpointPath?: string | null, allowedContentTypes?: string[], allowedLanguages?: string[] }
type OutcomeAssessment = { id?: string | number, entryId?: string | number, assessmentStatus: string, learningReady?: boolean, validPairCount?: number, measuredAt?: string | null }
type AutopilotPolicy = { policyId: string, status: string, expiresAt: string, revokedAt?: string | null, allowedContentTypes: string[], allowedLanguages: string[], targetId: string, configurationFingerprint: string }
type LearningDataset = { status: 'ready_for_dataset_review' | 'gate_blocked', candidateResults: Array<{ candidateStatus: string, reasonCodes?: string[] }>, eligibleCandidates: unknown[], manifest: { status: string, eligibleCandidateCount: number, reasonCodes: string[], manifestFingerprint: string }, datasetDigest: string, limitations: string[] }
type Capabilities = { schedulerAvailable: boolean, generationExecutorConfigured: boolean, firstPartyPublisherConfigured: boolean, outcomeCollectionConfigured: boolean }
type Readiness = { schedulerAvailable: boolean, generationExecutorAvailable: boolean, publicationTargetConfigured: boolean, publicationExecutionEnabled: boolean, credentialReferenceConfigured: boolean, runtimeCredentialResolverAvailable: boolean, outcomeCollectionConfigured: boolean }
type Workspace = {
  clients: Client[]
  calendars: Calendar[]
  entries: ContentEntry[]
  runs: Run[]
  outcomeAssessments: OutcomeAssessment[]
  publicationTargets: PublicationTarget[]
  capabilities: Capabilities
  readiness: Readiness
  limitations: string[]
}

type ClientForm = {
  displayName: string
  canonicalSiteOrigin: string
  framework: Framework
  publicationTransport: PublicationTransport
  timeZone: string
  defaultCadenceDays: CadenceDays
  defaultPublishLocalTime: string
  monthlyBudgetUnits: number | null
}
type CalendarForm = {
  clientId: string
  productionPlanId: string
  planStartDate: string
  planEndDate: string
  publishLocalTime: string
  cadenceDays: CadenceDays
  monthlyBudgetUnits: number | null
  defaultCostUnits: number | null
  maxItemsPerCalendarMonth: number | null
  maximumTotalItems: number | null
  catchUpPolicy: CatchUpPolicy
}

const emptyWorkspace = (): Workspace => ({
  clients: [], calendars: [], entries: [], runs: [], outcomeAssessments: [], publicationTargets: [],
  capabilities: { schedulerAvailable: false, generationExecutorConfigured: false, firstPartyPublisherConfigured: false, outcomeCollectionConfigured: false },
  readiness: { schedulerAvailable: false, generationExecutorAvailable: false, publicationTargetConfigured: false, publicationExecutionEnabled: false, credentialReferenceConfigured: false, runtimeCredentialResolverAvailable: false, outcomeCollectionConfigured: false },
  limitations: [],
})
const emptyLearningDataset = (): LearningDataset => ({ status: 'gate_blocked', candidateResults: [], eligibleCandidates: [], manifest: { status: 'gate_blocked', eligibleCandidateCount: 0, reasonCodes: [], manifestFingerprint: '' }, datasetDigest: '', limitations: [] })

definePageMeta({ i18n: false, layout: 'owner' })
useHead({
  title: '內容營運 Workbench · DiscoveryStack',
  meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }],
})

const { data: workspaceData, pending, error: workspaceError, refresh } = await useAsyncData<Workspace>(
  'content-operations-owner-workspace',
  () => $fetch<Workspace>('/api/content-operations/workspace'),
  { server: false, default: emptyWorkspace },
)
const { data: learningData, refresh: refreshLearningDataset } = await useAsyncData<LearningDataset>(
  'content-operations-owner-learning-dataset',
  () => $fetch<LearningDataset>('/api/content-operations/learning-dataset'),
  { server: false, default: emptyLearningDataset },
)
const workspace = computed(() => workspaceData.value || emptyWorkspace())
const learningDataset = computed<LearningDataset>(() => learningData.value || emptyLearningDataset())
const actionState = ref<ActionState>('idle')
const autopilotPolicies = reactive<Record<string, AutopilotPolicy | null>>({})
const autopilotExpiry = reactive<Record<string, string>>({})
const autopilotLoading = ref('')
const defaultAutopilotExpiry = () => { const date = new Date(); date.setUTCDate(date.getUTCDate() + 30); return date.toISOString().slice(0, 10) }
const autopilotPolicyFor = (clientId: string | number) => autopilotPolicies[String(clientId)] || null
async function refreshAutopilotPolicies() {
  const clients = workspace.value.clients
  await Promise.all(clients.map(async client => {
    const key = String(client.id)
    autopilotExpiry[key] ||= defaultAutopilotExpiry()
    try { const response = await $fetch<{ policy: AutopilotPolicy | null }>(`/api/content-operations/clients/${client.id}/autopilot-policy`); autopilotPolicies[key] = response.policy } catch { autopilotPolicies[key] = null }
  }))
}
watch(workspaceData, () => { void refreshAutopilotPolicies() }, { immediate: true })
const actionNotice = ref('')
const actionError = ref('')

const clientForm = reactive<ClientForm>({
  displayName: '', canonicalSiteOrigin: '', framework: 'astro', publicationTransport: 'first_party_git',
  timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: null,
})
const calendarForm = reactive<CalendarForm>({
  clientId: '', productionPlanId: '', planStartDate: '', planEndDate: '', publishLocalTime: '09:00', cadenceDays: 7,
  monthlyBudgetUnits: null, defaultCostUnits: null, maxItemsPerCalendarMonth: null, maximumTotalItems: null, catchUpPolicy: 'skip_missed',
})
const targetForm = reactive({ clientId: '', targetOrigin: '', contentRoot: 'content', defaultBranch: 'main', credentialReference: '', repositoryOwner: '', repositoryName: '', endpointPath: '/api/first-party/content-ingest', maximumPayloadBytes: 1000000, executionEnabled: false })
const targetRequestKey = ref('')

const isSaving = computed(() => actionState.value === 'saving')
const isUnauthorized = computed(() => {
  const status = (workspaceError.value as { status?: number, statusCode?: number } | null)?.status ?? (workspaceError.value as { statusCode?: number } | null)?.statusCode
  return status === 401 || status === 403
})
const workspaceErrorMessage = computed(() => isUnauthorized.value ? '這個工作台只對 owner 開放，請先回到私有稽核實驗室登入。' : '目前無法載入內容營運資料；沒有任何資料被修改。')
const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
const todayLocalDate = dateKeyFormatter.format(new Date())
const currentMonth = todayLocalDate.slice(0, 7)
const monthEntries = computed(() => workspace.value.entries.filter(entry => entry.plannedLocalDate.startsWith(currentMonth)))
const terminalEntryStatuses = new Set(['delivered', 'completed', 'cancelled', 'skipped', 'blocked'])
const nextEntry = computed(() => workspace.value.entries.filter(entry => entry.plannedLocalDate >= todayLocalDate && !terminalEntryStatuses.has(entry.status)).sort((left, right) => left.plannedLocalDate.localeCompare(right.plannedLocalDate))[0] || null)
const reviewEntries = computed(() => workspace.value.entries.filter(entry => entry.status === 'awaiting_review'))
const readyEntries = computed(() => workspace.value.entries.filter(entry => entry.status === 'ready_to_publish'))
const retryEntries = computed(() => workspace.value.entries.filter(entry => entry.status === 'failed' || workspace.value.runs.some(run => String(run.entryId) === String(entry.id) && ['retry_wait', 'failed'].includes(run.state))))
const publishedEntries = computed(() => workspace.value.entries.filter(entry => ['delivered', 'completed'].includes(entry.status)))
const outcomeEntries = computed(() => {
  const assessedIds = new Set(workspace.value.outcomeAssessments.filter(assessment => ['ready', 'partial'].includes(assessment.assessmentStatus)).map(assessment => String(assessment.entryId)))
  return workspace.value.entries.filter(entry => assessedIds.has(String(entry.id)))
})

const capabilityItems = computed(() => [
  { key: 'schedulerAvailable', label: '排程器', falseMessage: '排程器尚未接通', trueMessage: '排程器已接通', available: workspace.value.capabilities.schedulerAvailable },
  { key: 'generationExecutorAvailable', label: '自動內容生成', falseMessage: '自動內容生成尚未接通', trueMessage: '自動內容生成已接通', available: workspace.value.readiness.generationExecutorAvailable },
  { key: 'publicationTargetConfigured', label: '第一方發布 target', falseMessage: '第一方網站發布器尚未設定', trueMessage: '第一方 target 已設定', available: workspace.value.readiness.publicationTargetConfigured },
  { key: 'publicationExecutionEnabled', label: '發布 execute gate', falseMessage: '目前只允許 dry-run 或尚未啟用', trueMessage: 'target execution flag 已啟用', available: workspace.value.readiness.publicationExecutionEnabled },
  { key: 'runtimeCredentialResolverAvailable', label: 'Server credential resolver', falseMessage: 'runtime credential registry 尚未可用', trueMessage: 'runtime credential registry parser 已可用（不代表 reference 有效）', available: workspace.value.readiness.runtimeCredentialResolverAvailable },
  { key: 'outcomeCollectionConfigured', label: '成效資料回收', falseMessage: '成效資料尚未自動回收', trueMessage: '成效資料回收已接通', available: workspace.value.capabilities.outcomeCollectionConfigured },
])

const cadenceOptions: CadenceDays[] = [3, 7, 15, 30]
const statusLabels: Record<string, string> = {
  planned: '已排程', materialized: '已建立工作', awaiting_generation: '等待產生', awaiting_review: '等待人工審核', ready_to_publish: '可以發布',
  publishing: '發布中', delivered: '已發布', completed: '已完成', cancelled: '已取消', skipped: '已略過', blocked: '已阻擋',
  queued: '已排隊', processing: '處理中', succeeded: '已成功', failed: '執行失敗', retry_wait: '等待重試',
}
const statusClass = (status: string) => ['blocked', 'failed', 'retry_wait', 'cancelled'].includes(status) ? 'status status--danger' : ['delivered', 'completed', 'succeeded'].includes(status) ? 'status status--positive' : status === 'ready_to_publish' ? 'status status--ready' : 'status status--neutral'
const statusLabel = (status: string) => statusLabels[status] || status || '未提供狀態'
const clientName = (clientId: string | number | undefined) => workspace.value.clients.find(client => String(client.id) === String(clientId))?.displayName || '未指定客戶'
const selectedTargetClient = computed(() => workspace.value.clients.find(client => String(client.id) === String(targetForm.clientId)))
const formatLocalDate = (value: string | null | undefined) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value || '尚未提供'
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  return new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium' }).format(new Date(year, month - 1, day))
}
const frameworkLabel = (framework: Framework | string | undefined) => framework === 'astro' ? 'Astro' : framework === 'nuxt' ? 'Nuxt' : 'Framework 未提供'
const calendarName = (calendarId: string | number | undefined) => workspace.value.calendars.find(calendar => String(calendar.id) === String(calendarId))?.productionPlanId || '未指定月曆'
const runForEntry = (entryId: string | number) => workspace.value.runs.find(run => String(run.entryId) === String(entryId))
const assessmentForEntry = (entryId: string | number) => workspace.value.outcomeAssessments.find(assessment => String(assessment.entryId) === String(entryId))
const entryNextAction = (entry: ContentEntry) => entry.nextAction || (entry.status === 'awaiting_review' ? '請人工審核草稿' : entry.status === 'ready_to_publish' ? '等待第一方發布器處理' : entry.status === 'failed' ? '檢查失敗原因並決定是否重試' : entry.status === 'delivered' ? '等待成效資料' : entry.status === 'completed' ? '查看 Outcome assessment' : entry.status === 'awaiting_generation' ? '等待內容生成工作' : '查看內容詳細狀態')
const pipelineSteps = [
  { key: 'scheduled', label: '已排程' }, { key: 'awaiting_generation', label: '等待產生' }, { key: 'awaiting_review', label: '等待人工審核' },
  { key: 'ready_to_publish', label: '可以發布' }, { key: 'publishing', label: '發布中' }, { key: 'delivered', label: '已發布' },
  { key: 'measurement', label: '成效觀察' }, { key: 'learning', label: '學習候選' },
]
const pipelineStage = (entry: ContentEntry) => {
  const assessment = assessmentForEntry(entry.id)
  if (assessment?.learningReady) return 'learning'
  if (assessment) return 'measurement'
  if (entry.status === 'planned') return 'scheduled'
  if (entry.status === 'materialized') return 'awaiting_generation'
  if (entry.status === 'completed') return 'delivered'
  return entry.status
}

type ReplanForm = Pick<Calendar, 'planStartDate' | 'planEndDate' | 'publishLocalTime' | 'cadenceDays' | 'monthlyBudgetUnits' | 'defaultCostUnits' | 'maxItemsPerCalendarMonth' | 'maximumTotalItems' | 'catchUpPolicy'>
const replanForms = reactive<Record<string, ReplanForm>>({})
function replanFormFor(calendar: Calendar): ReplanForm {
  const key = String(calendar.id)
  return replanForms[key] || (replanForms[key] = {
    planStartDate: calendar.planStartDate, planEndDate: calendar.planEndDate, publishLocalTime: calendar.publishLocalTime,
    cadenceDays: calendar.cadenceDays, monthlyBudgetUnits: calendar.monthlyBudgetUnits, defaultCostUnits: calendar.defaultCostUnits,
    maxItemsPerCalendarMonth: calendar.maxItemsPerCalendarMonth, maximumTotalItems: calendar.maximumTotalItems, catchUpPolicy: calendar.catchUpPolicy,
  })
}

function idempotencyKey(prefix: string) {
  const value = globalThis.crypto?.randomUUID?.()
  if (!value) throw new Error('Secure idempotency key generation is unavailable.')
  return `${prefix}-${value}`
}

const clientRequestKey = ref('')
const calendarRequestKey = ref('')
const replanRequestKeys = reactive<Record<string, string>>({})
const materializeRequestKeys = reactive<Record<string, string>>({})
const executeRequestKeys = reactive<Record<string, string>>({})
function retainedRequestKey(store: Record<string, string>, identity: string, prefix: string) {
  return store[identity] || (store[identity] = idempotencyKey(prefix))
}

async function post<T = unknown>(route: string, body: Record<string, unknown>, successMessage: string): Promise<T | undefined> {
  if (actionState.value === 'saving') return undefined
  actionState.value = 'saving'; actionNotice.value = ''; actionError.value = ''
  try {
    const result = await $fetch<T>(route, { method: 'POST', body })
    await refresh()
    await refreshLearningDataset()
    await refreshAutopilotPolicies()
    actionState.value = 'success'; actionNotice.value = successMessage
    return result as T
  } catch (error: unknown) {
    const failure = error as { statusMessage?: string, message?: string, data?: { statusMessage?: string, message?: string } } | null
    actionState.value = 'error'; actionError.value = failure?.data?.statusMessage || failure?.data?.message || failure?.statusMessage || failure?.message || '這個操作沒有完成；請先檢查欄位與目前能力限制。'
    return undefined
  } finally {
    if (actionState.value === 'saving') actionState.value = 'idle'
  }
}

async function createClient() {
  const requestKey = clientRequestKey.value || (clientRequestKey.value = idempotencyKey('client'))
  const result = await post('/api/content-operations/clients', {
    displayName: clientForm.displayName.trim(), canonicalSiteOrigin: clientForm.canonicalSiteOrigin.trim(), framework: clientForm.framework,
    publicationTransport: clientForm.publicationTransport, timeZone: clientForm.timeZone, defaultCadenceDays: clientForm.defaultCadenceDays,
    defaultPublishLocalTime: clientForm.defaultPublishLocalTime, monthlyBudgetUnits: clientForm.monthlyBudgetUnits, idempotencyKey: requestKey,
  }, '客戶網站設定已送出；畫面正在重新整理。')
  if (result !== undefined) clientRequestKey.value = ''
  return result
}

async function createCalendar() {
  const requestKey = calendarRequestKey.value || (calendarRequestKey.value = idempotencyKey('calendar'))
  const result = await post('/api/content-operations/calendars', {
    clientId: Number(calendarForm.clientId), productionPlanId: Number(calendarForm.productionPlanId), planStartDate: calendarForm.planStartDate,
    planEndDate: calendarForm.planEndDate, publishLocalTime: calendarForm.publishLocalTime, cadenceDays: calendarForm.cadenceDays,
    monthlyBudgetUnits: calendarForm.monthlyBudgetUnits, defaultCostUnits: calendarForm.defaultCostUnits,
    maxItemsPerCalendarMonth: calendarForm.maxItemsPerCalendarMonth, maximumTotalItems: calendarForm.maximumTotalItems,
    catchUpPolicy: calendarForm.catchUpPolicy, idempotencyKey: requestKey,
  }, '內容月曆已送出；畫面正在重新整理。')
  if (result !== undefined) calendarRequestKey.value = ''
  return result
}

async function replanCalendar(calendar: Calendar) {
  const form = replanFormFor(calendar)
  const identity = String(calendar.id)
  const result = await post(`/api/content-operations/calendars/${calendar.id}/replan`, {
    expectedPlanFingerprint: calendar.planFingerprint, ...form, idempotencyKey: retainedRequestKey(replanRequestKeys, identity, 'replan'),
  }, '月曆重新規劃已送出；畫面正在重新整理。')
  if (result !== undefined) delete replanRequestKeys[identity]
  return result
}

async function materializeCalendar(calendar: Calendar) {
  const identity = String(calendar.id)
  const result = await post(`/api/content-operations/calendars/${calendar.id}/materialize`, {
    expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey: retainedRequestKey(materializeRequestKeys, identity, 'materialize'),
  }, '月曆內容項目建立已送出；畫面正在重新整理。')
  if (result !== undefined) delete materializeRequestKeys[identity]
  return result
}

async function createPublicationTarget() {
  const requestKey = targetRequestKey.value || (targetRequestKey.value = idempotencyKey('publication-target'))
  const client = workspace.value.clients.find(item => String(item.id) === String(targetForm.clientId))
  if (!client) return undefined
  const isGit = client.publicationTransport === 'first_party_git'
  const result = await post(`/api/content-operations/clients/${targetForm.clientId}/publication-target`, { idempotencyKey: requestKey, framework: client.framework, transport: client.publicationTransport, targetOrigin: targetForm.targetOrigin.trim(), contentRoot: targetForm.contentRoot.trim(), defaultBranch: isGit ? targetForm.defaultBranch.trim() : null, repositoryOwner: isGit ? targetForm.repositoryOwner.trim() || null : null, repositoryName: isGit ? targetForm.repositoryName.trim() || null : null, endpointPath: isGit ? null : targetForm.endpointPath.trim() || null, credentialReference: targetForm.credentialReference.trim(), allowedContentTypes: ['article', 'faq', 'service_page'], allowedLanguages: ['en', 'zh-hant'], maximumPayloadBytes: targetForm.maximumPayloadBytes, executionEnabled: targetForm.executionEnabled }, '第一方 publication target 已送出；畫面正在重新整理。')
  if (result !== undefined) targetRequestKey.value = ''
  return result
}

async function enableAutopilot(client: Client) {
  const key = String(client.id)
  autopilotLoading.value = key
  const expiryDate = autopilotExpiry[key] || defaultAutopilotExpiry()
  const expiresAt = new Date(`${expiryDate}T23:59:59.000Z`).toISOString()
  const result = await post(`/api/content-operations/clients/${client.id}/autopilot-policy`, { expiresAt, allowedContentTypes: ['article', 'faq', 'service_page'], allowedLanguages: ['en', 'zh-hant'] }, 'Governed autopilot authorization 已送出；policy 會重新載入。')
  if (result !== undefined) await refreshAutopilotPolicies()
  autopilotLoading.value = ''
}

async function revokeAutopilot(client: Client) {
  const key = String(client.id)
  autopilotLoading.value = key
  const result = await post(`/api/content-operations/clients/${client.id}/autopilot-policy/revoke`, {}, 'Governed autopilot 已撤銷；scheduler 不會自動復活。')
  if (result !== undefined) await refreshAutopilotPolicies()
  autopilotLoading.value = ''
}

async function executeEntry(entry: ContentEntry, mode: 'dry_run' | 'execute') {
  const identity = String(entry.id)
  const requestKey = executeRequestKeys[identity] || (executeRequestKeys[identity] = idempotencyKey(`entry-${identity}`))
  const result = await post(`/api/content-operations/entries/${entry.id}/execute`, { idempotencyKey: requestKey, mode }, mode === 'dry_run' ? 'Entry dry-run 已記錄；沒有對 customer site 發出寫入。' : 'Entry publication execution 已送出；畫面正在重新整理。')
  if (result !== undefined) delete executeRequestKeys[identity]
  return result
}
</script>

<template>
  <main class="operations-page">
    <header class="operations-hero">
      <NuxtLink class="back-link" to="/audit-lab">← 返回私有稽核實驗室</NuxtLink>
      <p class="eyebrow">OWNER-ONLY · CONTENT OPERATIONS V1</p>
      <h1>把內容營運，<em>排得清楚。</em></h1>
      <p class="hero-copy">在同一個私有工作台查看客戶網站、內容月曆、文章流程與成效資料是否已足夠。這裡只呈現 API 回傳的實際狀態，不把尚未接通的能力說成已完成，也不顯示虛構的排名、流量、ROI 或 LLM 提及數。</p>
    </header>

    <section v-if="pending" class="state-card" role="status" aria-live="polite"><strong>正在讀取內容營運資料…</strong><span>請稍候，尚未執行任何寫入操作。</span></section>
    <section v-else-if="workspaceError" class="state-card state-card--error" role="alert"><strong>{{ isUnauthorized ? '這是 owner-only 工作台' : '目前無法載入工作台' }}</strong><span>{{ workspaceErrorMessage }}</span><NuxtLink v-if="isUnauthorized" to="/audit-lab">回到私有稽核實驗室</NuxtLink></section>
    <template v-else>
      <section v-if="actionNotice || actionError" class="notice-stack" aria-live="polite">
        <p v-if="actionNotice" class="notice notice--success" role="status">{{ actionNotice }}</p>
        <p v-if="actionError" class="notice notice--error" role="alert">{{ actionError }}</p>
      </section>

      <section class="overview-section" aria-labelledby="overview-title">
        <div class="section-heading"><div><p class="eyebrow">OVERVIEW</p><h2 id="overview-title">現在需要注意什麼？</h2></div><span class="data-note">只根據 workspace response</span></div>
        <div v-if="workspace.clients.length === 0 && workspace.entries.length === 0" class="empty-card"><strong>還沒有內容營運資料</strong><span>先建立一個客戶網站，再建立內容月曆；完成後資料會從 workspace 重新整理。</span></div>
        <div v-else class="kpi-grid">
          <article class="kpi-card"><span>啟用中的客戶</span><strong>{{ workspace.clients.filter(client => client.status === 'active').length }}</strong><small>只計算 API 回傳 active 的客戶</small></article>
          <article class="kpi-card"><span>本月預計內容</span><strong>{{ monthEntries.length }}</strong><small>依 plannedLocalDate 計算</small></article>
          <article class="kpi-card"><span>下一篇發布日期</span><strong class="kpi-date">{{ nextEntry ? formatLocalDate(nextEntry.plannedLocalDate) : '尚未排程' }}</strong><small>{{ nextEntry?.title || nextEntry?.topic || '沒有下一篇資料' }}</small></article>
          <article class="kpi-card"><span>等待人工 Review</span><strong>{{ reviewEntries.length }}</strong><small>只計算 awaiting_review 項目</small></article>
          <article class="kpi-card"><span>Ready to publish</span><strong>{{ readyEntries.length }}</strong><small>草稿與 risk gate 需以資料為準</small></article>
          <article class="kpi-card"><span>Retry wait / Failed</span><strong>{{ retryEntries.length }}</strong><small>失敗不會偽裝成成功</small></article>
          <article class="kpi-card"><span>已發布</span><strong>{{ publishedEntries.length }}</strong><small>包含 delivered 與 completed 項目</small></article>
          <article class="kpi-card"><span>Outcome 有資料</span><strong>{{ outcomeEntries.length }}</strong><small>不代表因果成效或模型品質</small></article>
        </div>
      </section>

      <section class="capability-panel" aria-labelledby="capability-title">
        <div class="section-heading"><div><p class="eyebrow">CAPABILITIES</p><h2 id="capability-title">哪些能力現在真的可用？</h2></div></div>
        <div class="capability-grid">
          <article v-for="item in capabilityItems" :key="item.key" class="capability-card" :class="item.available ? 'capability-card--available' : 'capability-card--unavailable'">
            <span class="capability-mark" aria-hidden="true">{{ item.available ? '✓' : '—' }}</span><div><strong>{{ item.label }}</strong><p>{{ item.available ? item.trueMessage : item.falseMessage }}</p></div>
          </article>
        </div>
        <ul v-if="workspace.limitations.length" class="limitation-list"><li v-for="limitation in workspace.limitations" :key="limitation">{{ limitation }}</li></ul>
      </section>

      <section class="section-block governance-section" aria-labelledby="governance-title"><div class="section-heading"><div><p class="eyebrow">GOVERNED AUTOMATION</p><h2 id="governance-title">自動化與學習，現在是否被授權？</h2></div><span class="data-note">owner authorization · fail-closed</span></div><div class="governance-grid"><article class="work-card"><h3>Owner-scoped autopilot</h3><p class="section-copy">Autopilot 只會針對 owner 的 active publication target 生效，並且每次 scheduler tick 重新驗證 target、review、risk gate、expiry 與 allowlist。撤銷是 terminal，不會自動復活。</p><div v-if="workspace.clients.length === 0" class="empty-card"><strong>尚無可授權的客戶</strong><span>先建立 client 與 publication target。</span></div><div v-else class="policy-list"><article v-for="client in workspace.clients" :key="`policy-${client.id}`" class="policy-card"><div class="policy-card__top"><div><strong>{{ client.displayName }}</strong><small>{{ client.publicationTransport }} · client {{ client.id }}</small></div><span :class="statusClass(autopilotPolicyFor(client.id)?.status || 'not_configured')">{{ autopilotPolicyFor(client.id)?.status || 'not_configured' }}</span></div><template v-if="autopilotPolicyFor(client.id)"><p class="policy-facts">Target：{{ autopilotPolicyFor(client.id)!.targetId }} · 到期：{{ formatLocalDate(autopilotPolicyFor(client.id)!.expiresAt.slice(0, 10)) }} · content allowlist：{{ autopilotPolicyFor(client.id)!.allowedContentTypes.join(', ') }} · language：{{ autopilotPolicyFor(client.id)!.allowedLanguages.join(', ') }}</p><button v-if="!['revoked', 'expired'].includes(autopilotPolicyFor(client.id)!.status)" class="secondary-button" type="button" :disabled="isSaving || autopilotLoading === String(client.id)" @click="revokeAutopilot(client)">{{ autopilotLoading === String(client.id) ? '正在撤銷…' : '撤銷 autopilot' }}</button><span v-else class="inline-help">此 policy 已停止；若需重新授權，請依 server policy 建立新的 publication target。</span></template><template v-else><label class="policy-expiry">授權到期日<input v-model="autopilotExpiry[String(client.id)]" type="date" :min="todayLocalDate"></label><button class="primary-button" type="button" :disabled="isSaving || autopilotLoading === String(client.id) || !workspace.publicationTargets.some(target => String(target.clientId) === String(client.id) && target.status === 'active' && target.executionEnabled)" @click="enableAutopilot(client)">{{ autopilotLoading === String(client.id) ? '正在授權…' : '啟用 governed autopilot' }}</button><span v-if="!workspace.publicationTargets.some(target => String(target.clientId) === String(client.id) && target.status === 'active' && target.executionEnabled)" class="inline-help">需要 active 且 execution-enabled 的 publication target；沒有 target 時維持 fail-closed。</span></template></article></div></article><article class="work-card learning-card"><div class="section-heading"><div><p class="eyebrow">GEO CONTENT LEARNING</p><h3>Dataset review gate</h3></div><span :class="statusClass(learningDataset.manifest.status)">{{ learningDataset.manifest.status }}</span></div><p class="section-copy">Learning runtime 只建立 owner outcome 的去識別化、hash-only dataset review artifact；未達 admission gate 時不會 training、upload、promotion，也不會把 provider observation 當成 consumer truth。</p><div class="learning-facts"><span><strong>{{ learningDataset.manifest.eligibleCandidateCount }}</strong> eligible candidates</span><span><strong>{{ learningDataset.candidateResults.filter(candidate => candidate.candidateStatus === 'blocked').length }}</strong> blocked candidates</span><span><strong>{{ learningDataset.manifest.reasonCodes.length }}</strong> gate reasons</span></div><dl class="hash-facts"><div><dt>Dataset digest</dt><dd>{{ learningDataset.datasetDigest || '尚未產生' }}</dd></div><div><dt>Manifest fingerprint</dt><dd>{{ learningDataset.manifest.manifestFingerprint || '尚未產生' }}</dd></div></dl><ul v-if="learningDataset.manifest.reasonCodes.length" class="limitation-list"><li v-for="reason in learningDataset.manifest.reasonCodes" :key="reason">{{ reason }}</li></ul><button class="secondary-button" type="button" :disabled="pending" @click="refreshLearningDataset">重新讀取 learning gate</button></article></div></section>

      <section class="work-grid" aria-label="網站與內容月曆設定">
        <article class="work-card"><div class="section-heading"><div><p class="eyebrow">CLIENT SITE</p><h2>新增客戶網站設定</h2></div></div><p class="section-copy">用客戶看得懂的設定開始。網站必須是 HTTPS origin；發布方式只提供第一方 Git 或第一方 Signed API。</p>
          <form class="form-grid" @submit.prevent="createClient">
            <label>客戶／專案名稱<input v-model.trim="clientForm.displayName" required maxlength="120" autocomplete="off"></label>
            <label>網站 HTTPS origin<input v-model.trim="clientForm.canonicalSiteOrigin" required type="url" placeholder="https://example.com" autocomplete="url"></label>
            <label>Framework<select v-model="clientForm.framework"><option value="astro">Astro</option><option value="nuxt">Nuxt</option></select></label>
            <label>發布方式<select v-model="clientForm.publicationTransport"><option value="first_party_git">First-party Git</option><option value="first_party_signed_api">First-party Signed API</option></select></label>
            <label>時區<input v-model.trim="clientForm.timeZone" required placeholder="Asia/Taipei"></label>
            <label>預設發布時間<input v-model="clientForm.defaultPublishLocalTime" required type="time"></label>
            <label>預設頻率<select v-model.number="clientForm.defaultCadenceDays"><option v-for="days in cadenceOptions" :key="days" :value="days">每 {{ days }} 天</option></select></label>
            <label>每月預算單位<input v-model.number="clientForm.monthlyBudgetUnits" required type="number" min="1" step="1"></label>
            <button class="primary-button" type="submit" :disabled="isSaving">{{ isSaving ? '正在儲存…' : '建立客戶網站' }}</button>
          </form>
        </article>

        <article class="work-card"><div class="section-heading"><div><p class="eyebrow">CONTENT CALENDAR</p><h2>建立內容月曆</h2></div></div><p class="section-copy">選擇客戶、Production Plan 與發布節奏。Missed content policy 只會是 Skip missed 或 One catch-up。</p>
          <form class="form-grid" @submit.prevent="createCalendar">
            <label>客戶<select v-model="calendarForm.clientId" required><option disabled value="">請選擇客戶</option><option v-for="client in workspace.clients" :key="client.id" :value="String(client.id)">{{ client.displayName }}</option></select></label>
            <label>Production Plan ID<input v-model="calendarForm.productionPlanId" required type="number" min="1" step="1" autocomplete="off"></label>
            <label>開始日期<input v-model="calendarForm.planStartDate" required type="date"></label>
            <label>結束日期<input v-model="calendarForm.planEndDate" required type="date"></label>
            <label>發布時間<input v-model="calendarForm.publishLocalTime" required type="time"></label>
            <label>發布頻率<select v-model.number="calendarForm.cadenceDays"><option v-for="days in cadenceOptions" :key="days" :value="days">每 {{ days }} 天</option></select></label>
            <label>每月預算<input v-model.number="calendarForm.monthlyBudgetUnits" required type="number" min="1" step="1"></label>
            <label>單篇預設成本<input v-model.number="calendarForm.defaultCostUnits" required type="number" min="1" step="1"></label>
            <label>每月最多篇數<input v-model.number="calendarForm.maxItemsPerCalendarMonth" required type="number" min="1" step="1"></label>
            <label>全計畫最多篇數<input v-model.number="calendarForm.maximumTotalItems" required type="number" min="1" step="1"></label>
            <label>Missed content policy<select v-model="calendarForm.catchUpPolicy"><option value="skip_missed">Skip missed</option><option value="one_catch_up">One catch-up</option></select></label>
            <button class="primary-button" type="submit" :disabled="isSaving || workspace.clients.length === 0">{{ isSaving ? '正在儲存…' : '建立內容月曆' }}</button>
          </form>
          <p v-if="workspace.clients.length === 0" class="inline-help">請先建立客戶網站，才能建立內容月曆。</p>
        </article>
      </section>

      <section class="section-block" aria-labelledby="targets-title"><div class="section-heading"><div><p class="eyebrow">FIRST-PARTY TARGETS</p><h2 id="targets-title">Publication target registry</h2></div><span class="data-note">credential reference 只在 server-side 保存</span></div><div class="work-grid"><article class="work-card"><p class="section-copy">Target 必須與 client 的 framework、transport 一致。這裡只建立 target metadata；execute 仍會重新驗證 owner approval、risk gate、artifact identity 與 target guard。</p><form class="form-grid" @submit.prevent="createPublicationTarget"><label>客戶<select v-model="targetForm.clientId" required><option disabled value="">請選擇客戶</option><option v-for="client in workspace.clients" :key="client.id" :value="String(client.id)">{{ client.displayName }} · {{ frameworkLabel(client.framework) }} · {{ client.publicationTransport }}</option></select></label><label>Target origin<input v-model.trim="targetForm.targetOrigin" required type="url" placeholder="https://github.com"></label><label>Content root<input v-model.trim="targetForm.contentRoot" required placeholder="content"></label><label v-if="selectedTargetClient?.publicationTransport === 'first_party_git'">Branch<input v-model.trim="targetForm.defaultBranch" required placeholder="main"></label><label v-if="selectedTargetClient?.publicationTransport === 'first_party_git'">Repository owner<input v-model.trim="targetForm.repositoryOwner" required autocomplete="off"></label><label v-if="selectedTargetClient?.publicationTransport === 'first_party_git'">Repository name<input v-model.trim="targetForm.repositoryName" required autocomplete="off"></label><label v-else-if="selectedTargetClient?.publicationTransport === 'first_party_signed_api'">Signed API endpoint path<input v-model.trim="targetForm.endpointPath" required placeholder="/api/first-party/content-ingest"></label><label>Credential reference<input v-model.trim="targetForm.credentialReference" required autocomplete="off" placeholder="server-ref-only"></label><label>最大 payload bytes<input v-model.number="targetForm.maximumPayloadBytes" required type="number" min="1" max="10000000"></label><label class="checkbox-label"><input v-model="targetForm.executionEnabled" type="checkbox">允許 execute（預設只 dry-run）</label><p v-if="targetForm.executionEnabled" class="notice notice--warning">開啟後，通過正式 delivery approval 的內容可由 scheduler 發布到第一方網站；本 branch 不進行真實 connection test。</p><button class="primary-button" type="submit" :disabled="isSaving || workspace.clients.length === 0">建立 publication target</button></form></article><article class="work-card"><h3>目前 targets</h3><div v-if="workspace.publicationTargets.length === 0" class="empty-card"><strong>尚未設定 target</strong><span>先建立 client，再建立 owner-scoped target。</span></div><dl v-else class="target-list"><div v-for="target in workspace.publicationTargets" :key="target.id"><dt>{{ clientName(target.clientId) }} · {{ frameworkLabel(target.framework) }}</dt><dd>{{ target.transport }} · {{ target.targetOrigin }} · {{ target.contentRoot }}/{{ target.defaultBranch }} · {{ target.executionEnabled ? 'execute enabled' : 'dry-run only' }} · {{ target.status }} · {{ target.credentialConfigured ? 'credential reference 已設定' : 'credential reference 未設定' }}</dd></div></dl></article></div></section>

      <section class="section-block" aria-labelledby="clients-title"><div class="section-heading"><div><p class="eyebrow">CLIENTS</p><h2 id="clients-title">客戶網站</h2></div></div><div v-if="workspace.clients.length === 0" class="empty-card"><strong>尚未建立客戶網站</strong><span>完成上面的表單後，客戶會在這裡顯示。</span></div><div v-else class="client-grid"><article v-for="client in workspace.clients" :key="client.id" class="client-card"><div class="client-card__top"><div><h3>{{ client.displayName }}</h3><p>{{ frameworkLabel(client.framework) }} · {{ client.timeZone }} · 每 {{ client.defaultCadenceDays }} 天</p></div><span class="status" :class="client.status === 'active' ? 'status--positive' : 'status--neutral'">{{ client.status || '狀態未提供' }}</span></div><p class="site-origin">{{ client.canonicalSiteOrigin }}</p><div class="client-capability"><strong>發布能力</strong><span>{{ client.publisherCapability || (workspace.readiness.publicationTargetConfigured ? '第一方 target 已設定' : '第一方 target 尚未設定') }}</span></div><details><summary>Advanced details</summary><dl><div><dt>Client ID</dt><dd>{{ client.id }}</dd></div><div><dt>發布方式</dt><dd>{{ client.publicationTransport }}</dd></div><div><dt>每月預算單位</dt><dd>{{ client.monthlyBudgetUnits }}</dd></div></dl></details></article></div></section>

      <section class="section-block" aria-labelledby="calendar-title"><div class="section-heading"><div><p class="eyebrow">CALENDARS</p><h2 id="calendar-title">內容月曆</h2></div></div><div v-if="workspace.calendars.length === 0" class="empty-card"><strong>尚未建立內容月曆</strong><span>建立後會在這裡看到計畫期間、發布頻率與下一步操作。</span></div><div v-else class="calendar-list"><article v-for="calendar in workspace.calendars" :key="calendar.id" class="calendar-card"><div class="calendar-card__top"><div><h3>{{ clientName(calendar.clientId) }}</h3><p>{{ calendar.planStartDate }} → {{ calendar.planEndDate }} · 每 {{ calendar.cadenceDays }} 天</p></div><span :class="statusClass(calendar.status || '')">{{ calendar.status || '狀態未提供' }}</span></div><div class="calendar-facts"><span><strong>發布時間</strong>{{ calendar.publishLocalTime }}</span><span><strong>每月預算</strong>{{ calendar.monthlyBudgetUnits }}</span><span><strong>單篇成本</strong>{{ calendar.defaultCostUnits }}</span><span><strong>Missed policy</strong>{{ calendar.catchUpPolicy === 'one_catch_up' ? 'One catch-up' : 'Skip missed' }}</span></div><details class="replan-panel"><summary>調整排程</summary><form class="form-grid replan-form" @submit.prevent="replanCalendar(calendar)"><label>開始日期<input v-model="replanFormFor(calendar).planStartDate" required type="date"></label><label>結束日期<input v-model="replanFormFor(calendar).planEndDate" required type="date"></label><label>發布時間<input v-model="replanFormFor(calendar).publishLocalTime" required type="time"></label><label>發布頻率<select v-model.number="replanFormFor(calendar).cadenceDays"><option v-for="days in cadenceOptions" :key="days" :value="days">每 {{ days }} 天</option></select></label><label>每月預算<input v-model.number="replanFormFor(calendar).monthlyBudgetUnits" required type="number" min="1" step="1"></label><label>單篇成本<input v-model.number="replanFormFor(calendar).defaultCostUnits" required type="number" min="1" step="1"></label><label>每月最多篇數<input v-model.number="replanFormFor(calendar).maxItemsPerCalendarMonth" required type="number" min="1" step="1"></label><label>全計畫最多篇數<input v-model.number="replanFormFor(calendar).maximumTotalItems" required type="number" min="1" step="1"></label><label>Missed policy<select v-model="replanFormFor(calendar).catchUpPolicy"><option value="skip_missed">Skip missed</option><option value="one_catch_up">One catch-up</option></select></label><button class="secondary-button" type="submit" :disabled="isSaving || !calendar.planFingerprint">套用重新規劃</button></form></details><div class="button-row"><button class="secondary-button" type="button" :disabled="isSaving || !calendar.planFingerprint || ['blocked', 'paused', 'archived'].includes(calendar.status || '')" @click="materializeCalendar(calendar)">建立到期內容工作</button></div><details><summary>Advanced details</summary><dl><div><dt>Calendar ID</dt><dd>{{ calendar.id }}</dd></div><div><dt>Production Plan ID</dt><dd>{{ calendar.productionPlanId }}</dd></div><div><dt>Plan fingerprint</dt><dd>{{ calendar.planFingerprint || '尚未提供' }}</dd></div></dl></details></article></div></section>

      <section class="section-block" aria-labelledby="entries-title"><div class="section-heading"><div><p class="eyebrow">CONTENT PIPELINE</p><h2 id="entries-title">每篇內容目前走到哪裡？</h2></div><span class="data-note">blocked、failed、retry_wait 會獨立顯示</span></div><div v-if="workspace.entries.length === 0" class="empty-card"><strong>還沒有內容項目</strong><span>先建立月曆，再由 runtime materialize 內容項目。</span></div><div v-else class="entry-list"><article v-for="entry in workspace.entries" :key="entry.id" class="entry-card"><div class="entry-card__header"><div><p class="entry-date">{{ formatLocalDate(entry.plannedLocalDate) }}</p><h3>{{ entry.title || entry.topic || '未命名內容' }}</h3><p>{{ entry.contentType }} · {{ entry.language }} · {{ frameworkLabel(entry.framework) }}{{ entry.target ? ` · ${entry.target}` : '' }}</p></div><span :class="statusClass(entry.status)">{{ statusLabel(entry.status) }}</span></div><div class="pipeline" aria-label="內容 pipeline"><span v-for="step in pipelineSteps" :key="step.key" class="pipeline-step" :class="{ 'pipeline-step--active': pipelineStage(entry) === step.key, 'pipeline-step--complete': pipelineSteps.findIndex(item => item.key === pipelineStage(entry)) > pipelineSteps.findIndex(item => item.key === step.key) }">{{ step.label }}</span></div><div class="entry-checks"><span :class="entry.hasApprovedDraft === true ? 'check check--yes' : 'check check--no'">{{ entry.hasApprovedDraft === true ? '✓ 已有 approved draft' : '— 尚無 approved draft' }}</span><span :class="entry.hasPassedRiskGate === true ? 'check check--yes' : 'check check--no'">{{ entry.hasPassedRiskGate === true ? '✓ risk gate passed' : '— risk gate 尚未通過' }}</span><span v-if="runForEntry(entry.id)" class="check">Run：{{ statusLabel(runForEntry(entry.id)!.state) }}</span></div><div v-if="!['delivered', 'completed', 'cancelled', 'skipped', 'blocked'].includes(entry.status)" class="button-row entry-actions"><button class="secondary-button" type="button" :disabled="isSaving || !workspace.readiness.generationExecutorAvailable" @click="executeEntry(entry, 'dry_run')">執行下一步 dry-run</button><button v-if="entry.status === 'ready_to_publish'" class="primary-button" type="button" :disabled="isSaving || !workspace.readiness.publicationExecutionEnabled" @click="executeEntry(entry, 'execute')">執行 publication</button></div><p class="next-action"><strong>下一動作</strong>{{ entryNextAction(entry) }}</p><div v-if="assessmentForEntry(entry.id)" class="outcome-note"><strong>Outcome Learning</strong><span>{{ assessmentForEntry(entry.id)!.assessmentStatus }}<template v-if="assessmentForEntry(entry.id)!.validPairCount !== undefined"> · {{ assessmentForEntry(entry.id)!.validPairCount }} 個有效資料配對</template></span></div><details><summary>Advanced details</summary><dl><div><dt>Entry ID</dt><dd>{{ entry.id }}</dd></div><div><dt>Calendar</dt><dd>{{ calendarName(entry.calendarId) }}</dd></div><div><dt>Draft ID</dt><dd>{{ entry.draftId || '尚未提供' }}</dd></div><div><dt>Review ID</dt><dd>{{ entry.reviewId || '尚未提供' }}</dd></div><div><dt>Evidence hash</dt><dd>{{ entry.evidenceSnapshotHash || '尚未提供' }}</dd></div><div><dt>Content hash</dt><dd>{{ entry.contentHash || '尚未提供' }}</dd></div><div><dt>Idempotency key</dt><dd>{{ entry.idempotencyKey || '尚未提供' }}</dd></div><div v-if="runForEntry(entry.id)"><dt>Run ID</dt><dd>{{ runForEntry(entry.id)!.id }}</dd></div></dl></details></article></div></section>

      <section v-if="workspace.entries.length" class="section-block outcome-summary" aria-labelledby="outcome-title"><div class="section-heading"><div><p class="eyebrow">OUTCOME LEARNING</p><h2 id="outcome-title">成效資料是否足夠？</h2></div></div><div class="outcome-grid"><article><strong>{{ outcomeEntries.length }}</strong><span>目前具有 ready 或 partial assessment 的內容</span></article><article><strong>{{ workspace.capabilities.outcomeCollectionConfigured ? '已接通' : '尚未接通' }}</strong><span>{{ workspace.capabilities.outcomeCollectionConfigured ? '資料回收能力已由 API 標示可用' : '成效資料尚未自動回收' }}</span></article></div><p class="section-copy">這裡只呈現資料是否存在與 assessment 狀態，不把 observational signal 說成因果成效，也不推估排名、流量、轉換或 ROI。</p></section>
    </template>
  </main>
</template>

<style scoped>
.operations-page{--ink:#14231f;--moss:#254b3f;--moss-dark:#18372e;--paper:#faf9f3;--line:#d5ddd4;--muted:#617069;--danger:#9e3535;max-width:1240px;margin:0 auto;padding:3.5rem clamp(1rem,4vw,3rem) 6rem;color:var(--ink)}.operations-hero{max-width:820px;margin-bottom:3rem}.back-link{color:var(--moss);font-weight:800;text-decoration:none}.eyebrow{margin:0 0 .55rem;color:var(--moss);font-size:.7rem;font-weight:900;letter-spacing:.14em}.operations-hero h1{margin:.75rem 0 1.25rem;font-size:clamp(2.8rem,7vw,5.8rem);line-height:.9;letter-spacing:-.065em}.operations-hero h1 em{color:var(--moss);font-family:Georgia,serif;font-weight:400}.hero-copy,.section-copy{max-width:760px;color:#50605a;line-height:1.75}.state-card,.empty-card{display:grid;gap:.35rem;padding:1.35rem 1.5rem;border:1px dashed #aebdb2;background:#fff;color:#34443d}.state-card--error{border-color:#d39b9b;background:#fff5f5}.state-card a{width:max-content;margin-top:.45rem;color:var(--moss);font-weight:800}.notice-stack{display:grid;gap:.6rem;margin-bottom:1.2rem}.notice{margin:0;padding:.8rem 1rem;border-left:4px solid;font-weight:700}.notice--success{border-color:#368456;background:#eff8f0;color:#235e39}.notice--error{border-color:#b44a4a;background:#fff1f1;color:#873333}.section-block,.overview-section,.capability-panel{margin-top:3.2rem}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin-bottom:1.1rem}.section-heading h2{margin:0;font-size:clamp(1.5rem,3vw,2.1rem);letter-spacing:-.035em}.data-note{color:var(--muted);font-size:.78rem}.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem}.kpi-card{min-height:8.6rem;padding:1rem;border:1px solid var(--line);background:var(--paper)}.kpi-card span,.kpi-card small{display:block;color:var(--muted);font-size:.78rem}.kpi-card strong{display:block;margin:.55rem 0 .35rem;color:var(--moss-dark);font-size:2rem;line-height:1}.kpi-card .kpi-date{font-size:1.1rem;line-height:1.2}.capability-panel{padding:1.5rem;border:1px solid var(--line);background:#edf5ee}.capability-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem}.capability-card{display:flex;gap:.7rem;align-items:flex-start;min-height:5.2rem;padding:1rem;background:#fff;border:1px solid var(--line)}.capability-card--available{border-color:#8db99a}.capability-card--unavailable{border-color:#d4b1a7;background:#fffaf7}.capability-mark{display:grid;place-items:center;width:1.5rem;height:1.5rem;border-radius:50%;background:#d7e8d9;color:#23623c;font-weight:900}.capability-card--unavailable .capability-mark{background:#f2ded7;color:#9e493d}.capability-card strong{font-size:.9rem}.capability-card p{margin:.35rem 0 0;color:var(--muted);font-size:.78rem;line-height:1.4}.limitation-list{margin:1.2rem 0 0;padding:1rem 1rem 1rem 2rem;border-top:1px solid #c7d7c9;color:#52655a;font-size:.84rem;line-height:1.6}.work-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:3.2rem}.governance-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:1rem}.policy-list{display:grid;gap:.7rem}.policy-card{display:grid;gap:.7rem;padding:.9rem;border:1px solid #d6e0d6;background:#fff}.policy-card__top{display:flex;align-items:flex-start;justify-content:space-between;gap:.8rem}.policy-card small{display:block;margin-top:.25rem;color:var(--muted);font-size:.72rem}.policy-facts{margin:0!important;color:#52655a;font-size:.78rem!important;line-height:1.55!important}.policy-expiry{display:grid;gap:.4rem;color:#30453b;font-size:.8rem;font-weight:800}.policy-expiry input{border:1px solid #b8c6bb;border-radius:4px;background:#fff;color:var(--ink);font:inherit;padding:.65rem}.learning-card{background:#f6faf6}.learning-facts{display:grid;grid-template-columns:repeat(3,1fr);gap:.55rem;margin:1rem 0}.learning-facts span{display:grid;gap:.25rem;padding:.7rem;background:#fff;border:1px solid #dce6dc;color:var(--muted);font-size:.75rem}.learning-facts strong{color:var(--moss);font-size:1.35rem}.hash-facts{display:grid;gap:.5rem;margin:1rem 0}.hash-facts div{display:grid;grid-template-columns:9rem 1fr;gap:.6rem;font-size:.72rem}.hash-facts dt{color:var(--muted)}.hash-facts dd{margin:0;word-break:break-all}.work-card{padding:1.5rem;border:1px solid var(--line);background:var(--paper)}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}.form-grid label{display:grid;gap:.4rem;color:#30453b;font-size:.8rem;font-weight:800}.form-grid input,.form-grid select{width:100%;box-sizing:border-box;border:1px solid #b8c6bb;border-radius:4px;background:#fff;color:var(--ink);font:inherit;padding:.72rem}.primary-button,.secondary-button{width:max-content;border:0;border-radius:4px;cursor:pointer;font:inherit;font-weight:900;padding:.75rem 1rem}.primary-button{background:var(--moss);color:#fff}.secondary-button{border:1px solid #91a79a;background:#fff;color:var(--moss)}button:disabled{cursor:wait;opacity:.55}.inline-help{margin:.9rem 0 0;color:var(--muted);font-size:.8rem}.client-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem}.client-card,.calendar-card,.entry-card{padding:1.35rem;border:1px solid var(--line);background:var(--paper)}.client-card__top,.calendar-card__top,.entry-card__header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}.client-card h3,.calendar-card h3,.entry-card h3{margin:0;font-size:1.15rem}.client-card p,.calendar-card p,.entry-card p{margin:.35rem 0 0;color:var(--muted);font-size:.82rem;line-height:1.5}.site-origin{word-break:break-all}.status{display:inline-flex;align-items:center;justify-content:center;width:max-content;padding:.3rem .55rem;border:1px solid;border-radius:999px;font-size:.7rem;font-weight:900;white-space:nowrap}.status--positive{border-color:#78a886;background:#eef7ef;color:#24623a}.status--ready{border-color:#7794b6;background:#eef4fa;color:#2c547d}.status--danger{border-color:#d49797;background:#fff0f0;color:#963737}.status--neutral{border-color:#b5c1b8;background:#f1f4f1;color:#4e6257}.client-capability{display:grid;gap:.25rem;margin:1rem 0;padding:.8rem;border-left:3px solid #94b69d;background:#eff6ef;font-size:.8rem}.client-capability span{color:#52655a}.calendar-list,.entry-list{display:grid;gap:.9rem}.calendar-facts{display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem;margin:1.1rem 0}.calendar-facts span{display:grid;gap:.25rem;padding:.7rem;background:#fff;border:1px solid #e1e6e1;color:var(--muted);font-size:.78rem}.calendar-facts strong{color:var(--ink);font-size:.7rem}.button-row{display:flex;gap:.6rem;flex-wrap:wrap}.pipeline{display:flex;gap:.35rem;overflow:auto;margin:1.1rem 0;padding-bottom:.35rem}.pipeline-step{flex:0 0 auto;padding:.38rem .55rem;border:1px solid #cad4cc;background:#fff;color:#718078;font-size:.68rem;font-weight:800}.pipeline-step--complete{border-color:#a9c5ad;background:#edf7ee;color:#39704a}.pipeline-step--active{border-color:var(--moss);background:var(--moss);color:#fff}.entry-date{color:var(--moss)!important;font-size:.75rem!important;font-weight:900}.entry-checks{display:flex;gap:.55rem;flex-wrap:wrap;margin-top:1rem}.check{padding:.38rem .55rem;border:1px solid #cbd5cd;background:#fff;color:#64736b;font-size:.72rem;font-weight:800}.check--yes{border-color:#9fc2a5;background:#eff8f0;color:#2f7042}.check--no{border-color:#dfc0bb;background:#fff7f4;color:#8f5b54}.next-action{display:flex;gap:.5rem;align-items:baseline;margin-top:1rem!important;padding:.7rem;border-left:3px solid #a9bda9;background:#f2f6f1}.outcome-note{display:flex;gap:.5rem;align-items:baseline;margin-top:.7rem;padding:.7rem;border-left:3px solid #8caab9;background:#f0f6fa;font-size:.8rem}.outcome-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.outcome-grid article{display:grid;gap:.4rem;padding:1.2rem;border:1px solid var(--line);background:#f4f7f4}.outcome-grid strong{color:var(--moss);font-size:1.75rem}.outcome-grid span{color:var(--muted);font-size:.82rem}.client-card details,.calendar-card details,.entry-card details{margin-top:1rem;border-top:1px solid var(--line);padding-top:.8rem}.client-card summary,.calendar-card summary,.entry-card summary{cursor:pointer;color:var(--moss);font-size:.75rem;font-weight:900}.client-card dl,.calendar-card dl,.entry-card dl{display:grid;gap:.45rem;margin:.8rem 0 0}.client-card dl div,.calendar-card dl div,.entry-card dl div{display:grid;grid-template-columns:9rem 1fr;gap:.6rem;font-size:.74rem}.client-card dt,.calendar-card dt,.entry-card dt{color:var(--muted)}.client-card dd,.calendar-card dd,.entry-card dd{margin:0;word-break:break-all}.empty-card{margin-top:.5rem}.empty-card span{color:var(--muted);font-size:.84rem;line-height:1.5}@media(max-width:900px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.capability-grid{grid-template-columns:repeat(2,1fr)}.work-grid,.governance-grid{grid-template-columns:1fr}.calendar-facts{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.operations-page{padding:2.2rem 1rem 4rem}.section-heading{display:grid;align-items:start}.kpi-grid,.capability-grid,.client-grid,.outcome-grid,.form-grid,.learning-facts{grid-template-columns:1fr}.client-card__top,.calendar-card__top,.entry-card__header{display:grid}.calendar-facts{grid-template-columns:1fr}.pipeline{margin-right:-.5rem}.data-note{font-size:.72rem}.client-card dl div,.calendar-card dl div,.entry-card dl div{grid-template-columns:1fr;gap:.15rem}}
.replan-form{margin-top:1rem;padding:1rem;background:#fff;border:1px solid #e1e6e1}
</style>
