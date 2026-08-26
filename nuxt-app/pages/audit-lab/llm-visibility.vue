<script setup lang="ts">
type Project = { id: number, name: string, canonicalWebsiteUrl: string, canonicalDomain: string, locale: 'en' | 'zh-hant', brandName: string, brandAliases: string[], competitorBrands: string[], status: string }
type Query = { id: number, projectId: number, promptText: string, intent: string, locale: 'en' | 'zh-hant', active: boolean }
type Observation = { id: number, projectId: number, queryId: number, provider: string, modelLabel: string, observationMode: string, observedAt: string, brandMentioned: boolean, exactMentionCount: number, firstMentionPosition: number | null, citationUrls: string[], boundedExcerpt: string, evidenceLocator: string, reviewerNote: string, limitationCode: string }
type Slice = { status: 'ready' | 'not_ready', totalQueries: number, observedQueries: number, brandMentionRate: number | null, citationRate: number | null, exactCitationRate: number | null, competitorShareOfVoice: number | null, averageFirstMentionPosition: number | null }
type Workspace = { projects: Project[], queries: Query[], recentObservations: Observation[], limitations: string[], projection: string }
type Summary = { project: Project, queries: Query[], metrics: { current: Slice, previous: Slice, delta: Record<string, number | null>, byMode: Record<'manual_verified' | 'provider_api_observation', Slice>, byProvider: Record<string, Slice>, byLocale: Record<string, Slice>, period: Record<string, string> }, recentObservations: Observation[], limitations: string[], projection: string, metricBasis: 'manual_verified_v1', prohibitedClaims: string[] }

definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: 'LLM Visibility Monitor · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const emptyWorkspace = (): Workspace => ({ projects: [], queries: [], recentObservations: [], limitations: [], projection: 'traceable_model_observations_v1' })
const { data: workspaceData, pending, error: workspaceError, refresh } = await useAsyncData('llm-visibility-workspace', () => $fetch<Workspace>('/api/llm-visibility/workspace'), { server: false, default: emptyWorkspace })
const workspace = computed(() => workspaceData.value || emptyWorkspace())
const selectedProjectId = ref<number | null>(null)
const summary = ref<Summary | null>(null)
const saving = ref(false)
const notice = ref('')
const actionError = ref('')

const projectForm = reactive({ name: '', canonicalWebsiteUrl: '', locale: 'zh-hant' as 'en' | 'zh-hant', brandName: '', brandAliases: '', competitorBrands: '' })
const queryForm = reactive({ promptText: '', intent: 'brand_discovery', locale: 'zh-hant' as 'en' | 'zh-hant' })
const observationForm = reactive({
  queryId: '', provider: 'manual_other' as 'chatgpt' | 'gemini' | 'perplexity' | 'google_ai_overview' | 'manual_other', modelLabel: 'owner manual check', observedAt: new Date().toISOString().slice(0, 16),
  fullResponse: '', boundedExcerpt: '', evidenceLocator: '', reviewerNote: '', brandMentioned: false, exactMentionCount: 0, firstMentionPosition: '', citedDomain: '', citationUrls: '', competitorMentions: '', limitationCode: 'manual_snapshot_not_consumer_ui',
})

const selectedProject = computed(() => workspace.value.projects.find(project => project.id === selectedProjectId.value) || null)
const selectedQueries = computed(() => workspace.value.queries.filter(query => query.projectId === selectedProjectId.value))
const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)
const percentage = (value: number | null) => value === null ? 'not_ready' : `${(value * 100).toFixed(1)}%`
const numberMetric = (value: number | null) => value === null ? 'not_ready' : String(value)
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalNameKey(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
}

function parseCompetitors(value: string) {
  const result: Record<string, number> = Object.create(null)
  const seen = new Set<string>()
  for (const line of lines(value)) {
    const separator = line.lastIndexOf('=')
    if (separator < 1) throw new Error('競品提及請用「品牌=次數」，每行一筆。')
    const name = line.slice(0, separator).trim().replace(/\s+/gu, ' ')
    const canonicalKey = canonicalNameKey(name)
    if (!canonicalKey) throw new Error('競品名稱不可為空。')
    if (seen.has(canonicalKey)) throw new Error(`競品「${name}」與前一筆名稱等價；請只保留一筆，避免覆蓋計數。`)
    const count = Number(line.slice(separator + 1).trim())
    if (!Number.isInteger(count) || count < 0) throw new Error('競品提及次數必須是 0 以上整數。')
    seen.add(canonicalKey)
    result[name] = count
  }
  return result
}

async function runAction<T>(action: () => Promise<T>, success: string): Promise<T | undefined> {
  saving.value = true; actionError.value = ''; notice.value = ''
  try { const result = await action(); notice.value = success; return result } catch (error: any) { actionError.value = error?.data?.message || error?.statusMessage || error?.message || '操作未完成。'; return undefined } finally { saving.value = false }
}

async function loadSummary() {
  if (!selectedProjectId.value) { summary.value = null; return }
  summary.value = await runAction(() => $fetch<Summary>(`/api/llm-visibility/projects/${selectedProjectId.value}/summary`), '已更新可追溯 observation 指標。') || null
}

async function createProject() {
  const result = await runAction(() => $fetch<Project>('/api/llm-visibility/projects', { method: 'POST', body: { name: projectForm.name, canonicalWebsiteUrl: projectForm.canonicalWebsiteUrl, locale: projectForm.locale, brandName: projectForm.brandName, brandAliases: lines(projectForm.brandAliases), competitorBrands: lines(projectForm.competitorBrands) } }), 'Step 1 完成：私人品牌 project 已建立。')
  if (result) { await refresh(); selectedProjectId.value = result.id; await loadSummary() }
}

async function createQuery() {
  if (!selectedProjectId.value) return
  const result = await runAction(() => $fetch<{ id: number }>('/api/llm-visibility/queries', { method: 'POST', body: { projectId: selectedProjectId.value, promptText: queryForm.promptText, intent: queryForm.intent, locale: queryForm.locale, active: true } }), 'Step 2 完成：固定 tracking prompt 已加入。')
  if (result) { queryForm.promptText = ''; await refresh(); await loadSummary() }
}

async function importObservation() {
  if (!selectedProjectId.value || !observationForm.queryId) return
  if (!observationForm.fullResponse.trim()) { actionError.value = '請貼上 owner 已核對的完整 response；它只在本頁記憶體中計算 hash，不會送到 server。'; return }
  const excerpt = observationForm.boundedExcerpt.trim()
  if (!excerpt || excerpt.length > 1000) { actionError.value = '請提供 1–1000 字的 bounded excerpt。'; return }
  const observedAt = new Date(observationForm.observedAt)
  const responseHash = await sha256(observationForm.fullResponse)
  const requestFingerprint = await sha256(JSON.stringify({ projectId: selectedProjectId.value, queryId: Number(observationForm.queryId), provider: observationForm.provider, modelLabel: observationForm.modelLabel, observedAt: observedAt.toISOString(), evidenceLocator: observationForm.evidenceLocator }))
  let competitorMentions: Record<string, number>
  try { competitorMentions = parseCompetitors(observationForm.competitorMentions) } catch (error: any) { actionError.value = error.message; return }
  const result = await runAction(() => $fetch<{ runId: number, observationId: number }>('/api/llm-visibility/observations', { method: 'POST', body: {
    projectId: selectedProjectId.value, queryId: Number(observationForm.queryId), provider: observationForm.provider, modelLabel: observationForm.modelLabel, observationMode: 'manual_verified', status: 'completed', observedAt: observedAt.toISOString(), requestFingerprint, limitationCode: observationForm.limitationCode,
    brandMentioned: observationForm.brandMentioned, exactMentionCount: Number(observationForm.exactMentionCount), firstMentionPosition: observationForm.brandMentioned ? Number(observationForm.firstMentionPosition) : null, citedDomain: observationForm.citedDomain.trim() || null, citationUrls: lines(observationForm.citationUrls), competitorMentions,
    boundedExcerpt: excerpt, responseHash, evidenceLocator: observationForm.evidenceLocator, reviewerNote: observationForm.reviewerNote, verifiedByOwner: true,
  } }), 'Step 3 完成：只保存 hash、bounded excerpt、結構化欄位與 evidence locator。')
  if (result) { observationForm.fullResponse = ''; observationForm.boundedExcerpt = ''; await refresh(); await loadSummary() }
}

watch(selectedProjectId, () => { if (selectedProjectId.value) loadSummary(); else summary.value = null })
watch(() => observationForm.fullResponse, value => { if (!observationForm.boundedExcerpt) observationForm.boundedExcerpt = value.slice(0, 1000) })
</script>

<template>
  <div class="monitor">
    <header class="hero">
      <NuxtLink to="/audit-lab" class="back">← 返回 Audit Lab</NuxtLink>
      <p class="eyebrow">OWNER-ONLY · TRACEABLE OBSERVATIONS V1</p>
      <h1>LLM Visibility Monitor</h1>
      <p class="lede">V1 runtime 分開呈現 owner 人工核對的 primary observation 與 server-side provider API 的 secondary observation，分清楚「看見了什麼」與「無法證明什麼」。這不是搜尋排名，也不代表 consumer ChatGPT／Gemini 介面的真實曝光。</p>
      <div class="truth-band"><strong>資料邊界</strong><span>owner-only API</span><span>provider API：secondary-only</span><span>無 consumer UI scraping</span><span>不儲存完整 response</span></div>
    </header>

    <div v-if="workspaceError" class="alert alert--error">私人 workspace 無法載入；請確認 owner session 與 database 設定。</div>
    <div v-if="actionError" class="alert alert--error">{{ actionError }}</div>
    <div v-if="notice" class="alert alert--ok">{{ notice }}</div>
    <p v-if="pending" class="loading">正在讀取 owner-scoped workspace…</p>

    <section class="guided" aria-labelledby="guided-title">
      <div class="section-heading"><p>GUIDED FLOW</p><h2 id="guided-title">三步建立可審查 observation</h2></div>
      <article class="step">
        <div class="step__number">1</div><div class="step__body"><h3>建立品牌 project</h3><p>網站只接受公開 HTTPS；aliases 與競品會用 deterministic matching。</p>
          <form class="form-grid" @submit.prevent="createProject">
            <label>Project 名稱<input v-model="projectForm.name" required maxlength="160"></label>
            <label>公開 HTTPS 網址<input v-model="projectForm.canonicalWebsiteUrl" required type="url" placeholder="https://example.com/"></label>
            <label>品牌名稱<input v-model="projectForm.brandName" required maxlength="160"></label>
            <label>主要語系<select v-model="projectForm.locale"><option value="zh-hant">繁中</option><option value="en">English</option></select></label>
            <label>品牌 aliases（每行一個）<textarea v-model="projectForm.brandAliases" rows="3" maxlength="3000"></textarea></label>
            <label>競品品牌（每行一個）<textarea v-model="projectForm.competitorBrands" rows="3" maxlength="3000"></textarea></label>
            <button :disabled="saving">建立 project</button>
          </form></div>
      </article>

      <article class="step">
        <div class="step__number">2</div><div class="step__body"><h3>建立固定追蹤 prompts</h3><p>正規化後相同的 prompt 在同一 project 會被拒絕，不會悄悄建立重複分母。</p>
          <label class="project-picker">目前 project<select v-model.number="selectedProjectId"><option :value="null">請選擇</option><option v-for="project in workspace.projects" :key="project.id" :value="project.id">#{{ project.id }} · {{ project.name }}</option></select></label>
          <form class="form-grid" @submit.prevent="createQuery">
            <label class="wide">固定 prompt<textarea v-model="queryForm.promptText" required rows="4" maxlength="2000"></textarea></label>
            <label>Intent<input v-model="queryForm.intent" required maxlength="120"></label>
            <label>語系<select v-model="queryForm.locale"><option value="zh-hant">繁中</option><option value="en">English</option></select></label>
            <button :disabled="saving || !selectedProjectId">加入 prompt</button>
          </form></div>
      </article>

      <article class="step">
        <div class="step__number">3</div><div class="step__body"><h3>匯入 owner 已核對的 observation</h3><p>完整 response 僅在本頁記憶體以 Web Crypto 計算 SHA-256；server 只收到 hash、最多 1000 字 excerpt 與結構化 evidence。</p>
          <form class="form-grid" @submit.prevent="importObservation">
            <label>Tracking prompt<select v-model="observationForm.queryId" required><option value="">請選擇</option><option v-for="query in selectedQueries" :key="query.id" :value="String(query.id)">#{{ query.id }} · {{ query.promptText }}</option></select></label>
            <label>Provider<select v-model="observationForm.provider"><option value="manual_other">Manual other</option><option value="chatgpt">ChatGPT</option><option value="gemini">Gemini</option><option value="perplexity">Perplexity</option><option value="google_ai_overview">Google AI Overview</option></select></label>
            <label>觀測時間<input v-model="observationForm.observedAt" type="datetime-local" required></label>
            <label>Model label<input v-model="observationForm.modelLabel" required maxlength="160"></label>
            <label>Evidence locator<input v-model="observationForm.evidenceLocator" required maxlength="1000" placeholder="例如 owner screenshot ID / review record"></label>
            <label class="wide sensitive">完整 response（不傳送、不儲存）<textarea v-model="observationForm.fullResponse" required rows="6"></textarea></label>
            <label class="wide">Bounded excerpt（最多 1000 字）<textarea v-model="observationForm.boundedExcerpt" required rows="4" maxlength="1000"></textarea></label>
            <label class="check"><input v-model="observationForm.brandMentioned" type="checkbox"> 品牌有被明確提及</label>
            <label>Exact mention 次數<input v-model.number="observationForm.exactMentionCount" type="number" min="0" max="10000" required></label>
            <label>首次提及位置<input v-model="observationForm.firstMentionPosition" type="number" min="1" :required="observationForm.brandMentioned" :disabled="!observationForm.brandMentioned"></label>
            <label>引用 hostname<input v-model="observationForm.citedDomain" maxlength="253" placeholder="example.com"></label>
            <label class="wide">Citation URLs（每行一個公開 HTTPS）<textarea v-model="observationForm.citationUrls" rows="3" maxlength="10000"></textarea></label>
            <label>競品提及（每行 品牌=次數）<textarea v-model="observationForm.competitorMentions" rows="3" maxlength="3000"></textarea><small v-if="selectedProject?.competitorBrands.length">已設定：{{ selectedProject.competitorBrands.join('、') }}</small></label>
            <label>Owner review note<textarea v-model="observationForm.reviewerNote" required rows="3" maxlength="2000"></textarea></label>
            <details class="wide advanced"><summary>進階 provenance</summary><label>Limitation code<input v-model="observationForm.limitationCode" required maxlength="120"></label><p>Request fingerprint 會由 project、query、provider、model、時間與 evidence locator 在瀏覽器產生；重複 fingerprint 會 fail closed。</p></details>
            <button :disabled="saving || !selectedProjectId">匯入 observation</button>
          </form></div>
      </article>
    </section>

    <section class="results" aria-labelledby="results-title">
      <div class="section-heading"><p>OBSERVATION METRICS</p><h2 id="results-title">目前 30 天 vs 前一個 30 天</h2><p>主要比例、delta、provider 與 locale breakdown 只計 owner 人工核對的 manual_verified observation rows。Observed queries 是其中不重複的 active query 數，比例分母則是 observation rows。</p></div>
      <div v-if="!summary || summary.metrics.current.status === 'not_ready'" class="not-ready"><strong>not_ready</strong><p>目前沒有符合期間的已核對 observation；系統不會把空分母顯示成 0%。</p></div>
      <template v-else>
        <div class="metrics">
          <article><span>Observed queries</span><strong>{{ summary.metrics.current.observedQueries }} / {{ summary.metrics.current.totalQueries }}</strong></article>
          <article><span>Brand mention rate</span><strong>{{ percentage(summary.metrics.current.brandMentionRate) }}</strong></article>
          <article><span>Citation rate</span><strong>{{ percentage(summary.metrics.current.citationRate) }}</strong></article>
          <article><span>Exact-domain citation</span><strong>{{ percentage(summary.metrics.current.exactCitationRate) }}</strong></article>
          <article><span>Competitor share of voice</span><strong>{{ percentage(summary.metrics.current.competitorShareOfVoice) }}</strong></article>
          <article><span>Avg first mention position</span><strong>{{ numberMetric(summary.metrics.current.averageFirstMentionPosition) }}</strong></article>
        </div>
        <div class="table-wrap"><table><caption>Provider breakdown（只計 owner 人工核對 observation；各 provider 分母獨立）</caption><thead><tr><th>Provider</th><th>Status</th><th>Observed</th><th>Brand mention</th><th>Exact citation</th></tr></thead><tbody><tr v-for="(row, provider) in summary.metrics.byProvider" :key="provider"><th>{{ provider }}</th><td>{{ row.status }}</td><td>{{ row.observedQueries }}</td><td>{{ percentage(row.brandMentionRate) }}</td><td>{{ percentage(row.exactCitationRate) }}</td></tr></tbody></table></div>
      </template>
      <div v-if="summary" class="table-wrap"><table><caption>Mode breakdown（兩種 mode 分母完全分開；provider API observation 永遠不會混入 primary manual_verified metrics）</caption><thead><tr><th>Mode</th><th>Status</th><th>Observed queries</th><th>Brand mention rate</th></tr></thead><tbody><tr><th>manual_verified</th><td>{{ summary.metrics.byMode.manual_verified.status }}</td><td>{{ summary.metrics.byMode.manual_verified.observedQueries }}</td><td>{{ percentage(summary.metrics.byMode.manual_verified.brandMentionRate) }}</td></tr><tr><th>provider API（secondary-only observation）</th><td>{{ summary.metrics.byMode.provider_api_observation.status }}</td><td>{{ summary.metrics.byMode.provider_api_observation.observedQueries }}</td><td>{{ percentage(summary.metrics.byMode.provider_api_observation.brandMentionRate) }}</td></tr></tbody></table></div>
    </section>

    <section class="tables">
      <div class="table-wrap"><table><caption>固定 tracking prompts</caption><thead><tr><th>ID</th><th>Prompt</th><th>Intent</th><th>Locale</th><th>狀態</th></tr></thead><tbody><tr v-for="query in selectedQueries" :key="query.id"><td>#{{ query.id }}</td><td>{{ query.promptText }}</td><td>{{ query.intent }}</td><td>{{ query.locale }}</td><td>{{ query.active ? 'active' : 'inactive' }}</td></tr><tr v-if="!selectedQueries.length"><td colspan="5">尚無 prompt。</td></tr></tbody></table></div>
      <div class="table-wrap"><table><caption>最近 observations</caption><thead><tr><th>時間</th><th>Provider / mode</th><th>品牌</th><th>引用</th><th>Evidence</th></tr></thead><tbody><tr v-for="row in summary?.recentObservations || []" :key="row.id"><td>{{ formatDate(row.observedAt) }}</td><td>{{ row.provider }}<small>{{ row.observationMode }}</small></td><td>{{ row.brandMentioned ? `${row.exactMentionCount} 次` : '未提及' }}</td><td>{{ row.citationUrls.length ? `${row.citationUrls.length} 筆` : '無' }}</td><td>{{ row.evidenceLocator }}</td></tr><tr v-if="!(summary?.recentObservations || []).length"><td colspan="5">尚無 observation。</td></tr></tbody></table></div>
    </section>

    <section class="secondary-note"><p>SECONDARY EVIDENCE</p><h2>Provider API observation 的位置</h2><p>Server-side provider adapter 只使用固定官方 endpoint、bounded response 與 opaque credential resolver；缺少明確 feature flag 或 credential 時會 fail-closed。成功的 provider_api_observation 會保留 provider、model、時間、hash、bounded excerpt、citation 與 provenance，但 <strong>不會被當成 consumer-surface truth</strong>，也不會進入 manual_verified primary metrics。</p><div class="secondary-note__facts"><span><strong>secondary_only</strong> metrics eligibility</span><span><strong>verifiedByOwner=false</strong> until owner review</span><span><strong>raw response</strong> never persisted</span></div></section>

    <aside class="limitations"><p>LIMITATIONS</p><h2>閱讀這些數字前</h2><ul><li v-for="item in workspace.limitations" :key="item">{{ item }}</li></ul><details><summary>Advanced details</summary><p>Projection: <code>{{ workspace.projection }}</code></p><p>Metric basis: <code>{{ summary?.metricBasis || 'manual_verified_v1' }}</code></p><p>V1 primary metric basis 是 manual_verified_v1；provider_api_observation 只作 secondary-only evidence，且不等同 consumer UI truth。Exact citation 使用 URL parser 後的 canonical hostname 完全相等，不做 substring matching。</p></details></aside>
  </div>
</template>

<style scoped>
.monitor{max-width:1180px;margin:0 auto;padding:clamp(2rem,5vw,5rem) clamp(1rem,4vw,3rem) 6rem;color:#17253d}.hero{padding-bottom:2.5rem;border-bottom:1px solid #cad2dc}.back{color:#48627d;text-decoration:none;font-size:.82rem}.eyebrow,.section-heading>p,.limitations>p{margin:2rem 0 .6rem;color:#60768e;font-size:.72rem;font-weight:800;letter-spacing:.14em}.hero h1{margin:.3rem 0;font-size:clamp(2.4rem,7vw,5rem);letter-spacing:-.055em}.lede{max-width:820px;color:#4e6175;font-size:1.08rem;line-height:1.75}.truth-band{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.5rem}.truth-band>*{padding:.42rem .7rem;border:1px solid #c4ced8;border-radius:999px;font-size:.72rem}.truth-band strong{background:#17253d;color:#fff;border-color:#17253d}.alert,.loading{margin:1rem 0;padding:1rem;border-left:3px solid}.alert--error{border-color:#b23b3b;background:#fff1f1;color:#7b2525}.alert--ok{border-color:#2e7358;background:#edf8f3;color:#205c45}.guided,.results,.tables,.limitations,.secondary-note{margin-top:3.5rem}.section-heading h2,.limitations h2{margin:0;font-size:clamp(1.7rem,4vw,2.7rem);letter-spacing:-.035em}.step{display:grid;grid-template-columns:3rem 1fr;gap:1.2rem;padding:2rem 0;border-bottom:1px solid #d5dce4}.step__number{display:grid;place-items:center;width:2.4rem;height:2.4rem;border-radius:50%;background:#17253d;color:white;font-weight:800}.step h3{margin:.2rem 0;font-size:1.3rem}.step p{color:#617286}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-top:1.3rem}.form-grid label,.project-picker{display:grid;gap:.4rem;color:#40556c;font-size:.8rem;font-weight:700}.form-grid input,.form-grid textarea,.form-grid select,.project-picker select{width:100%;box-sizing:border-box;padding:.72rem;border:1px solid #b9c5d1;border-radius:.35rem;background:#fff;color:#17253d;font:inherit}.wide{grid-column:1/-1}.check{display:flex!important;grid-template-columns:auto 1fr!important;align-items:center}.check input{width:auto}.form-grid button{justify-self:start;padding:.75rem 1.1rem;border:0;border-radius:.35rem;background:#17253d;color:white;font-weight:800;cursor:pointer}.form-grid button:disabled{opacity:.45;cursor:not-allowed}.project-picker{max-width:34rem;margin-top:1.2rem}.sensitive{padding:1rem;border:1px dashed #9babbb;background:#eef2f6}.advanced{padding:1rem;border:1px solid #ccd4dd}.advanced summary,.limitations summary{cursor:pointer;font-weight:800}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:1.5rem}.metrics article{padding:1.2rem;border-top:3px solid #698aaa;background:#fff;box-shadow:0 8px 28px rgba(27,42,57,.06)}.metrics span,.metrics strong{display:block}.metrics span{color:#687a8c;font-size:.76rem}.metrics strong{margin-top:.6rem;font-size:1.55rem}.not-ready{margin-top:1.5rem;padding:2rem;border:1px dashed #9facb9;background:#edf1f5}.not-ready strong{font-family:monospace}.tables{display:grid;gap:2rem}.table-wrap{overflow-x:auto;margin-top:1.5rem;background:white;border:1px solid #d2d9e1}table{width:100%;border-collapse:collapse;text-align:left;font-size:.84rem}caption{padding:1rem;text-align:left;font-weight:800;font-size:1rem}th,td{padding:.75rem;border-top:1px solid #e0e5ea;vertical-align:top}thead th{color:#5f7183;background:#f1f4f7;font-size:.72rem;text-transform:uppercase}td small{display:block;color:#718295}.secondary-note{padding:1.5rem;border-left:4px solid #6687a8;background:#eef4f9}.secondary-note>p:first-child{margin:0 0 .55rem;color:#60768e;font-size:.72rem;font-weight:800;letter-spacing:.14em}.secondary-note h2{margin:0;font-size:clamp(1.5rem,3vw,2.3rem);letter-spacing:-.035em}.secondary-note>p:not(:first-child){color:#4e6175;line-height:1.7}.secondary-note__facts{display:grid;grid-template-columns:repeat(3,1fr);gap:.7rem}.secondary-note__facts span{display:grid;gap:.25rem;padding:.8rem;background:#fff;border:1px solid #c9d7e3;color:#687a8c;font-size:.76rem}.secondary-note__facts strong{color:#2c547d;font-size:.86rem}.limitations{padding:2rem;border-left:4px solid #6d879f;background:#e9eef3}.limitations li{margin:.7rem 0;line-height:1.6}.limitations code{word-break:break-all}@media(max-width:760px){.form-grid,.metrics,.secondary-note__facts{grid-template-columns:1fr}.wide{grid-column:auto}.step{grid-template-columns:1fr}.truth-band{align-items:flex-start}}
</style>
