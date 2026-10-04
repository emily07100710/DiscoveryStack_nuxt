<script setup lang="ts">
definePageMeta({ layout: 'owner' })
useHead({ title: '測量排程與重試｜DiscoveryStack Private Workbench', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type Client = { id: number; displayName: string; canonicalSiteOrigin: string; timeZone: string }
type Run = Record<string, any> & { id: number; clientId: number; entryId: number; targetId: number; source: string; checkpointDays: number; state: string; attemptNumber: number }
type Entry = Record<string, any> & { id?: number; entryId?: number; clientId: number; title?: string; status?: string; origin: 'content_operations' | 'existing_run' }
type ContentCalendar = Record<string, any> & { id: number; clientId: number }
type ContentEntry = Record<string, any> & { id: number; calendarId: number; status: string; topic?: string | null; topicCluster?: string | null; publicationPath?: string | null }
type ContentWorkspace = { calendars: ContentCalendar[]; entries: ContentEntry[] }
type ActionFeedback = { message: string; failed: boolean }
type Workspace = { clients: Client[]; connections: Array<Record<string, any>>; runs: Run[]; snapshots: Array<Record<string, any>>; checkpoints: Record<string, Record<string, any>>; capabilities: { schedulerAvailable: boolean; realGoogleOAuth: boolean; realProviderCalls: boolean; outcomeCollectionConfigured: boolean }; limitations: string[] }

type ScheduleResponse = { scheduled?: number }
type RetryResponse = { state?: string } | null
type DryRunResponse = { planned?: Array<Record<string, unknown>> }
type MeasurementFetchOptions = { method?: 'GET' | 'POST' }
type MeasurementFetch = <T = void>(path: string, options?: MeasurementFetchOptions) => Promise<T>
// Keep Nuxt's runtime fetch while avoiding the generated router's recursive response inference.
const fetchMeasurement = $fetch as unknown as MeasurementFetch

const workspace = ref<Workspace | null>(null)
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
const selectedClientId = ref<number | null>(null)
const runState = ref('')
const query = ref('')
const entriesPage = ref(1)
const runsPage = ref(1)
const pageSize = 8
const schedulingEntryId = ref<number | null>(null)
const retryingRunId = ref<number | null>(null)
const dryRunningId = ref<number | null>(null)
const scheduleFeedback = reactive<Record<number, ActionFeedback>>({})
const runFeedback = reactive<Record<number, ActionFeedback>>({})
const contentWorkspace = ref<ContentWorkspace | null>(null)
const contentEntriesError = ref('')
const checkpointDays = [7, 15, 30, 60, 90]
const capabilityLimitation = '這一組能力值裡，只有 Google OAuth 是依實際憑證計算的；schedulerAvailable、outcomeCollectionConfigured、realProviderCalls 三個都是 server 端寫死的常數（分別固定為 true、true、false），不會隨環境改變，也不代表這個系統實際上有沒有呼叫外部 provider。'
const providerCallLimitation = '特別是 realProviderCalls = false 不等於「不會對外呼叫」：已註冊的 content-operations:measurement-tick 排程在憑證就緒時，會透過 adapter 真的呼叫 Google API 取資料。請以上方 Google OAuth 憑證狀態與每一筆 run 的實際結果為準。'
const scheduleScopeLimitation = '排程端點不接受自訂天數，也不是「一個 entry 一組 checkpoint」：server 會為每一個狀態是 configured、且 allowedPageScope 命中此內容 canonical page 的測量連線，各建立 7、15、30、60、90 日 checkpoint。沒有任何連線符合時，端點仍會回 200，但實際建立 0 筆。'
const scheduleInvalidationLimitation = '送出排程也可能作廢既有紀錄：同一 entry 與 target 上尚未成功或取消的 run，只要 publication receipt、內容 hash、證據 hash 或 canonical page 和最新交付不一致，就會被改為 blocked。回報的筆數只算這次排程對應到的「測量連線 × checkpoint」組合（每組一筆：新建的，或同一 idempotency key 已存在的那筆），不是作廢的筆數；被作廢的 run 不一定會出現在回傳結果裡。各筆實際狀態請看下方 run 清單。'
const entrySourceLimitation = '測量 workspace 不回傳可排程 entry 清單，所以這裡合併兩個來源：內容營運 workspace 中狀態為 delivered／completed 的 entry，以及既有 run 反推出的 entry。送出時 server 仍會重新驗證 delivered publication receipt。'

const runStates = computed(() => [...new Set((workspace.value?.runs || []).map(run => run.state).filter(Boolean))])
const clientByCalendar = computed(() => new Map((contentWorkspace.value?.calendars || []).map(calendar => [Number(calendar.id), Number(calendar.clientId)])))
const knownEntries = computed<Entry[]>(() => {
  const entries = new Map<number, Entry>()
  for (const entry of contentWorkspace.value?.entries || []) {
    const id = Number(entry.id)
    if (!Number.isSafeInteger(id) || !['delivered', 'completed'].includes(String(entry.status))) continue
    entries.set(id, { entryId: id, clientId: clientByCalendar.value.get(Number(entry.calendarId)) ?? 0, title: entry.topic || entry.topicCluster || entry.publicationPath || '', status: String(entry.status), origin: 'content_operations' })
  }
  for (const run of workspace.value?.runs || []) if (!entries.has(run.entryId)) entries.set(run.entryId, { entryId: run.entryId, clientId: run.clientId, title: run.canonicalPage, status: 'known_from_existing_run', origin: 'existing_run' })
  return [...entries.values()]
})
const filteredEntries = computed(() => knownEntries.value.filter(entry => (selectedClientId.value === null || entry.clientId === selectedClientId.value) && (!query.value || `${entry.entryId} ${entry.title || ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()))))
const filteredRuns = computed(() => (workspace.value?.runs || []).filter(run => (selectedClientId.value === null || run.clientId === selectedClientId.value) && (!runState.value || run.state === runState.value) && (!query.value || `${run.id} ${run.entryId} ${run.targetId} ${run.source} ${run.errorCode || ''} ${run.errorSummary || ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()))))
const pagedEntries = computed(() => filteredEntries.value.slice((entriesPage.value - 1) * pageSize, entriesPage.value * pageSize))
const pagedRuns = computed(() => filteredRuns.value.slice((runsPage.value - 1) * pageSize, runsPage.value * pageSize))

function sourceLabel(source: string) { return source === 'google_search_console' ? 'Google Search Console' : source === 'first_party_analytics' ? 'GA4 第一方分析' : source === 'llm_visibility' ? 'LLM Visibility（API observation）' : source }
function stateLabel(value: string) { const labels: Record<string, string> = { queued: '排隊中', processing: '處理中', retry_wait: '等待重試', succeeded: '完成', insufficient_data: '資料不足', blocked: '已阻擋', failed: '失敗', cancelled: '已取消', delivered: '已交付', completed: '已完成' }; return labels[value] || value }
function pretty(value: unknown) { try { return JSON.stringify(value, null, 2) } catch { return '不可顯示' } }
function date(value: string | null | undefined) { return value ? new Date(value).toLocaleString('zh-TW') : '—' }
function runSnapshots(runId: number) { return (workspace.value?.snapshots || []).filter(snapshot => snapshot.runId === runId) }
function scheduleNote(id: number) { return scheduleFeedback[id]?.message || '' }
function scheduleFailed(id: number) { return scheduleFeedback[id]?.failed === true }
function runNote(id: number) { return runFeedback[id]?.message || '' }
function runFailed(id: number) { return runFeedback[id]?.failed === true }
function entryId(entry: Entry) { return Number(entry.entryId || entry.id) }
function canRetry(run: Run) { return run.state !== 'succeeded' && run.state !== 'processing' && Number(run.attemptNumber) < 3 }
function retryReason(run: Run) { if (run.state === 'succeeded') return '已完成的 run 是終態，handler 會拒絕重試。'; if (run.state === 'processing') return '正在處理中的 run 不可人工重試。'; if (Number(run.attemptNumber) >= 3) return '已用盡最多 3 次的重試額度。'; return '' }
function onEntriesPage(next: number) { entriesPage.value = next }
function onRunsPage(next: number) { runsPage.value = next }
watch([selectedClientId, runState, query], () => { entriesPage.value = 1; runsPage.value = 1 })

async function load() {
  loading.value = true
  errorMessage.value = ''
  contentEntriesError.value = ''
  const [measurement, content] = await Promise.allSettled([fetchMeasurement<Workspace>('/api/measurement-collection/workspace'), fetchMeasurement<ContentWorkspace>('/api/content-operations/workspace')])
  if (measurement.status === 'fulfilled') { workspace.value = measurement.value; if (selectedClientId.value !== null && !measurement.value.clients.some(client => client.id === selectedClientId.value)) selectedClientId.value = null }
  else { workspace.value = null; errorMessage.value = (measurement.reason as any)?.data?.message || '測量工作台目前無法載入。' }
  if (content.status === 'fulfilled') contentWorkspace.value = content.value
  else { contentWorkspace.value = null; contentEntriesError.value = (content.reason as any)?.data?.message || '內容營運 workspace 目前無法載入，因此下方只列得出既有 run 反推的 entry；尚未排程過的 delivered 項目不會出現。' }
  loading.value = false
}
async function schedule(entry: Entry) {
  const id = entryId(entry)
  if (!Number.isSafeInteger(id)) return
  schedulingEntryId.value = id; delete scheduleFeedback[id]
  try {
    const result = await fetchMeasurement<ScheduleResponse>(`/api/measurement-collection/entries/${id}/schedule`, { method: 'POST' })
    const scheduled = Number(result?.scheduled || 0)
    scheduleFeedback[id] = scheduled === 0
      ? { failed: true, message: '端點接受了這次請求，但沒有建立任何 checkpoint run：這個內容的 canonical page 沒有對應到任何狀態為 configured 的測量連線。請先讓該連線的 allowedPageScope 含這個頁面。' }
      : { failed: false, message: `回報 ${scheduled} 筆這次對應到的 checkpoint run（每個「測量連線 × checkpoint」組合一筆：新建的，或同一 idempotency key 已存在的那筆；那筆若輸入已變更且尚未成功，會被改為 blocked）。新建的 run 以 queued 狀態等 due 時間到了再由排程處理；各筆實際狀態請看下方 run 清單。` }
    notice.value = `entry #${id} 的測量排程已更新。`
    await load()
  }
  catch (error: any) { scheduleFeedback[id] = { failed: true, message: error?.data?.message || '此項目目前無法排程；需要有效的 delivered publication receipt。' } }
  finally { schedulingEntryId.value = null }
}
async function retry(run: Run) {
  retryingRunId.value = run.id; delete runFeedback[run.id]
  try { const result = await fetchMeasurement<RetryResponse>(`/api/measurement-collection/runs/${run.id}/retry`, { method: 'POST' }); runFeedback[run.id] = { failed: false, message: `已轉為 ${stateLabel(result?.state || 'retry_wait')}；目前 attempt ${run.attemptNumber}／3。` }; notice.value = `run #${run.id} 已排入重試。`; await load() }
  catch (error: any) { runFeedback[run.id] = { failed: true, message: error?.data?.message || '此 run 目前無法重試。' } }
  finally { retryingRunId.value = null }
}
async function dryRun(run: Run) {
  dryRunningId.value = run.id; delete runFeedback[run.id]
  try { const result = await fetchMeasurement<DryRunResponse>(`/api/measurement-collection/runs/${run.id}/dry-run`, { method: 'POST' }); runFeedback[run.id] = { failed: false, message: `Dry-run 完成：${Array.isArray(result?.planned) ? result.planned.length : 0} 筆 planned metadata；未呼叫任何 provider。` } }
  catch (error: any) { runFeedback[run.id] = { failed: true, message: error?.data?.message || 'Dry-run 目前無法執行。' } }
  finally { dryRunningId.value = null }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="runs-page">
    <div class="runs-page__hero"><div><p class="eyebrow">PRIVATE / MEASUREMENT OPERATIONS</p><h1>測量排程與重試</h1><p class="lede">建立已交付內容的固定 checkpoint 測量排程，並安全處理失敗或停滯的執行紀錄。</p></div><button class="button button--primary" type="button" :disabled="loading" @click="load">{{ loading ? '載入中…' : '重新整理' }}</button></div>
    <p v-if="notice" class="notice notice--success" role="status">{{ notice }}</p><p v-if="errorMessage" class="notice notice--error" role="alert">{{ errorMessage }}</p>
    <OwnerAsyncState :loading="loading" :error="errorMessage" :empty="!workspace" loading-label="正在載入測量 workspace…" empty-label="目前沒有可顯示的 workspace 資料。" @retry="load">
      <template v-if="workspace"><section class="panel"><div class="panel__heading"><div><p class="eyebrow">CAPABILITIES</p><h2>執行能力與限制</h2></div></div><dl class="facts"><div><dt>Google OAuth（實際計算）</dt><dd>{{ workspace.capabilities.realGoogleOAuth ? '已配置' : '未配置' }}</dd></div><div><dt>Scheduler 宣告（server 寫死）</dt><dd class="mono">schedulerAvailable = {{ workspace.capabilities.schedulerAvailable }}</dd></div><div><dt>Outcome collection 宣告（server 寫死）</dt><dd class="mono">outcomeCollectionConfigured = {{ workspace.capabilities.outcomeCollectionConfigured }}</dd></div><div><dt>Provider calls 宣告（server 寫死）</dt><dd class="mono">realProviderCalls = {{ workspace.capabilities.realProviderCalls }}</dd></div></dl><p class="limitation">{{ capabilityLimitation }}</p><p class="limitation">{{ providerCallLimitation }}</p><ul class="limitations"><li v-for="limitation in workspace.limitations" :key="limitation">{{ limitation }}</li></ul></section>
      <div class="toolbar"><label>客戶／網站<select v-model="selectedClientId"><option :value="null">全部 owner scope</option><option v-for="client in workspace.clients" :key="client.id" :value="client.id">{{ client.displayName }} · {{ client.canonicalSiteOrigin }}</option></select></label><label>執行狀態<select v-model="runState"><option value="">全部狀態</option><option v-for="state in runStates" :key="state" :value="state">{{ stateLabel(state) }}</option></select></label><label>搜尋<input v-model.trim="query" type="search" placeholder="entry、run、錯誤代碼"></label></div>
      <section class="panel"><div class="panel__heading"><div><p class="eyebrow">SCHEDULABLE ENTRIES</p><h2>可排程項目</h2></div><span class="count">{{ filteredEntries.length }} entries</span></div><p class="limitation">{{ scheduleScopeLimitation }}</p><p class="limitation">{{ scheduleInvalidationLimitation }}</p><p class="limitation">{{ entrySourceLimitation }}</p><p v-if="contentEntriesError" class="notice notice--error" role="alert">{{ contentEntriesError }}</p><p v-if="!pagedEntries.length" class="empty-inline">沒有符合目前篩選條件的可辨識項目。</p><div v-else class="entry-list"><article v-for="entry in pagedEntries" :key="entryId(entry)" class="entry-card"><div><h3>{{ entry.title || `entry #${entryId(entry)}` }}</h3><p>entry #{{ entryId(entry) }} · {{ entry.clientId ? `client #${entry.clientId}` : 'client 未對應' }} · {{ stateLabel(entry.status || 'delivered') }} · {{ entry.origin === 'content_operations' ? '來自內容營運 workspace' : '由既有 run 反推' }}</p></div><form class="schedule-form" @submit.prevent="schedule(entry)"><label>Checkpoint days<select disabled><option>{{ checkpointDays.join('／') }} 日（固定全部建立）</option></select></label><button class="button button--primary" type="submit" :disabled="schedulingEntryId === entryId(entry)">{{ schedulingEntryId === entryId(entry) ? '排程中…' : '建立測量排程' }}</button></form><p v-if="scheduleNote(entryId(entry))" class="notice" :class="scheduleFailed(entryId(entry)) ? 'notice--error' : 'notice--success'" :role="scheduleFailed(entryId(entry)) ? 'alert' : 'status'">{{ scheduleNote(entryId(entry)) }}</p></article></div><OwnerPager :page="entriesPage" :page-size="pageSize" :total="filteredEntries.length" :disabled="loading" @update:page="onEntriesPage" /></section>
      <section class="panel"><div class="panel__heading"><div><p class="eyebrow">RUNS</p><h2>執行紀錄</h2></div><span class="count">{{ filteredRuns.length }} runs</span></div><p v-if="!pagedRuns.length" class="empty-inline">沒有符合目前篩選條件的執行紀錄。</p><div v-else class="run-list"><article v-for="run in pagedRuns" :key="run.id" class="run-card"><div class="run-card__top"><div><h3>{{ sourceLabel(run.source) }} · {{ run.checkpointDays }} 天</h3><p>run #{{ run.id }} · entry #{{ run.entryId }} · target #{{ run.targetId }}</p></div><span class="status-badge" :data-status="run.state">{{ stateLabel(run.state) }}</span></div><dl class="facts"><div><dt>Baseline window</dt><dd>{{ date(run.baselineWindowStart) }} – {{ date(run.baselineWindowEnd) }}</dd></div><div><dt>Follow-up window</dt><dd>{{ date(run.followUpWindowStart) }} – {{ date(run.followUpWindowEnd) }}</dd></div><div><dt>Due</dt><dd>{{ date(run.dueAt) }}</dd></div><div><dt>Attempt</dt><dd>{{ run.attemptNumber }}／3</dd></div><div><dt>錯誤</dt><dd>{{ run.errorCode || 'none' }}{{ run.errorSummary ? ` · ${run.errorSummary}` : '' }}</dd></div></dl><div class="actions"><button class="button" type="button" :disabled="!canRetry(run) || retryingRunId === run.id" @click="retry(run)">{{ retryingRunId === run.id ? '重試排入中…' : '重試' }}</button><button class="button" type="button" :disabled="dryRunningId === run.id" @click="dryRun(run)">{{ dryRunningId === run.id ? 'Dry-run 中…' : 'Dry-run（不會呼叫 provider）' }}</button></div><p v-if="retryReason(run)" class="limitation">{{ retryReason(run) }}</p><p v-if="runNote(run.id)" class="notice" :class="runFailed(run.id) ? 'notice--error' : 'notice--success'" :role="runFailed(run.id) ? 'alert' : 'status'">{{ runNote(run.id) }}</p><details class="advanced"><summary>Advanced details</summary><div class="advanced__body"><dl class="facts"><div><dt>receipt fingerprint</dt><dd class="mono">{{ run.publicationReceiptFingerprint }}</dd></div><div><dt>content hash</dt><dd class="mono">{{ run.contentHash }}</dd></div><div><dt>evidence hash</dt><dd class="mono">{{ run.evidenceSnapshotHash }}</dd></div><div><dt>input fingerprint</dt><dd class="mono">{{ run.inputFingerprint }}</dd></div></dl><pre v-for="snapshot in runSnapshots(run.id)" :key="snapshot.id">{{ pretty(snapshot) }}</pre></div></details></article></div><OwnerPager :page="runsPage" :page-size="pageSize" :total="filteredRuns.length" :disabled="loading" @update:page="onRunsPage" /></section></template>
    </OwnerAsyncState>
  </section>
</template>

<style scoped>
.runs-page{max-width:1280px;margin:0 auto;padding:clamp(1.25rem,3vw,3.5rem);color:#17253d}.runs-page__hero{display:flex;justify-content:space-between;align-items:flex-end;gap:2rem;margin-bottom:1.4rem}.eyebrow{margin:0 0 .45rem;color:#55708e;font-size:.68rem;font-weight:800;letter-spacing:.14em}.runs-page h1{margin:0;color:#14243e;font-size:clamp(2rem,5vw,4.2rem);line-height:.98;letter-spacing:-.05em}.lede{max-width:760px;margin:1rem 0 0;color:#526174;font-size:1rem;line-height:1.7}.button{border:1px solid #c8d3df;border-radius:999px;background:#fff;color:#20324c;padding:.65rem .9rem;font:inherit;font-size:.78rem;font-weight:800;cursor:pointer}.button:hover,.button:focus-visible{border-color:#486d9d;outline:3px solid rgba(72,109,157,.18)}.button:disabled{cursor:not-allowed;opacity:.55}.button--primary{border-color:#1e4d79;background:#1e4d79;color:#fff}.notice{border:1px solid;border-radius:12px;padding:.8rem 1rem;margin:1rem 0;font-size:.8rem}.notice--success{border-color:#9bc9b0;background:#effaf3;color:#205a38}.notice--error{border-color:#e3aaaa;background:#fff2f2;color:#873434}.panel{border:1px solid #dbe3eb;border-radius:18px;background:#fff;box-shadow:0 12px 35px rgba(27,51,78,.06);padding:clamp(1rem,2vw,1.5rem);margin-top:1.2rem}.panel__heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}.panel h2{margin:0;color:#172c48;font-size:1.2rem}.count{color:#6b7b8d;font-size:.72rem;font-weight:800}.toolbar{display:flex;align-items:end;flex-wrap:wrap;gap:.75rem;margin:1.25rem 0}.toolbar label,.schedule-form label{display:grid;gap:.35rem;color:#526174;font-size:.72rem;font-weight:800}.toolbar select,.toolbar input,.schedule-form select{min-width:11rem;border:1px solid #c8d3df;border-radius:9px;background:#fff;padding:.65rem;color:#17253d;font:inherit}.toolbar input{min-width:15rem}.facts{margin:1rem 0 0}.facts div{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-top:1px solid #edf1f4}.facts dt{color:#7a8797;font-size:.68rem}.facts dd{margin:0;color:#30445d;font-size:.72rem;text-align:right;overflow-wrap:anywhere}.limitations{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem 1.5rem;margin:1rem 0 0;padding-left:1.2rem;color:#596a7d;font-size:.8rem;line-height:1.55}.limitation{border-left:3px solid #9cb8d4;margin:1rem 0;padding-left:.65rem;color:#5d6c7e;font-size:.75rem;line-height:1.5}.empty-inline{border:1px dashed #b6c5d3;border-radius:14px;background:#fff;color:#637184;padding:1.1rem;text-align:center}.entry-list,.run-list{display:grid;gap:.8rem}.entry-card,.run-card{border:1px solid #dbe3eb;border-radius:14px;padding:1rem}.entry-card{display:grid;grid-template-columns:1fr auto;gap:1rem}.entry-card h3,.run-card h3{margin:0;color:#193655;font-size:.95rem}.entry-card p,.run-card p{margin:.25rem 0 0;color:#718096;font-size:.73rem}.schedule-form{display:flex;align-items:end;gap:.6rem}.run-card__top{display:flex;justify-content:space-between;align-items:flex-start;gap:.8rem}.status-badge{display:inline-flex;align-items:center;border:1px solid #cbd6e2;border-radius:999px;padding:.28rem .55rem;color:#40546c;font-size:.66rem;font-weight:800;white-space:nowrap}.status-badge[data-status='succeeded']{border-color:#8fbca3;background:#effaf3;color:#205a38}.status-badge[data-status='retry_wait'],.status-badge[data-status='queued'],.status-badge[data-status='insufficient_data']{border-color:#d8bd84;background:#fff9eb;color:#745318}.status-badge[data-status='blocked'],.status-badge[data-status='failed'],.status-badge[data-status='cancelled']{border-color:#dfa1a1;background:#fff2f2;color:#873434}.actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.advanced{margin-top:1rem;border-top:1px solid #e7edf2;padding-top:.8rem}.advanced summary{color:#315a83;cursor:pointer;font-size:.76rem;font-weight:800}.advanced pre{max-width:100%;overflow:auto;margin:.6rem 0 0;padding:.75rem;border-radius:9px;background:#101319;color:#e8edf5;font-size:.65rem}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.66rem!important}@media(max-width:920px){.entry-card{grid-template-columns:1fr}.limitations{grid-template-columns:1fr}}@media(max-width:640px){.runs-page__hero{display:block}.runs-page__hero .button{margin-top:1rem}.toolbar,.schedule-form{display:grid}.toolbar input,.toolbar select{min-width:0;width:100%}.run-card__top{display:block}.status-badge{margin-top:.6rem}.facts div{display:block}.facts dd{text-align:left;margin-top:.25rem}}
</style>
