<script setup lang="ts">
type Source = { id: number, sourceName: string | null, domain: string | null, allowedUse: string, reviewStatus: string, robotsStatus: string, termsStatus: string, copyrightRisk: string, piiStatus: string, removedAt: string | null }
type CrawlResult = { url: string, depth: number, status: string, httpStatus: number | null, cleanedCharacterCount: number | null, piiOutcome: string | null, artifactId: number | null, errorCode: string | null }
type Job = { id: number, sourceId: number, sourceName: string | null, requestedUrl: string, collectionMode: string, status: string, httpStatus: number | null, cleanedCharacterCount: number | null, piiOutcome: string, primaryArtifactId: number | null, maxPages: number | null, maxDepth: number | null, pagesFetched: number, pagesCleaned: number, artifactsCreated: number, crawlResults: CrawlResult[] | null, errorCode: string | null, requestedAt: string, completedAt: string | null }
type TrainingRun = { id: number, mode: string, provider: string, modelFamily: string, modelVersion: string, status: string, exampleCount: number, trainCount: number, validationCount: number, testCount: number, labelCounts: Record<string, number>, metrics: { validation?: Record<string, number | null>, test?: Record<string, number | null> } | null, modelArtifact: { engine?: string, modelRepo?: string, baseModel?: string, hardware?: string } | null, remoteJobId: string | null, remoteJobUrl: string | null, baseModelId: string | null, modelRepoId: string | null, errorCode: string | null, createdAt: string, completedAt: string | null }
type ProviderStatus = { firecrawl: { configured: boolean, last4?: string | null, source?: string }, huggingface: { configured: boolean, last4?: string | null, source?: string, namespace: string, baseModelId: string }, updatedAt?: string | null }

const state = ref<'loading' | 'signin' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const sources = ref<Source[]>([])
const jobs = ref<Job[]>([])
const trainingRuns = ref<TrainingRun[]>([])
const providerStatus = ref<ProviderStatus>({ firecrawl: { configured: false }, huggingface: { configured: false, namespace: '', baseModelId: '' } })
const providerForm = reactive({ firecrawlApiKey: '', huggingFaceApiToken: '', huggingFaceNamespace: '' })
const providerSaveStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const providerSaveMessage = ref('')
const crawlStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const trainingStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
const crawlMessage = ref('')
const trainingMessage = ref('')
const expandedJobId = ref<number | null>(null)
const trainingMode = ref<'development' | 'production'>('development')
const crawlForm = reactive({ sourceId: 0, requestedUrl: '', maxPages: 5, maxDepth: 1 })

useHead({ title: 'ML Workbench · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }, { name: 'description', content: 'Private bounded crawl, cleaning and supervised training workbench.' }] })
definePageMeta({ i18n: false })

const eligibleSources = computed(() => sources.value.filter(source => source.reviewStatus === 'approved' && !source.removedAt && source.allowedUse !== 'blocked' && source.robotsStatus === 'reviewed_allow' && ['allows_research', 'allows_evaluation', 'allows_training'].includes(source.termsStatus) && source.copyrightRisk === 'low' && source.piiStatus === 'none_detected'))
const completedJobs = computed(() => jobs.value.filter(job => job.status === 'completed'))
const cleanedPages = computed(() => jobs.value.reduce((sum, job) => sum + (job.pagesCleaned || 0), 0))
const latestRun = computed(() => trainingRuns.value[0] || null)
const latestCompletedRun = computed(() => trainingRuns.value.find(run => run.status === 'completed') || null)

async function loadWorkbench() {
  state.value = 'loading'
  try {
    const [sourceRows, jobRows, runRows, providerRows] = await Promise.all([
      $fetch<Source[]>('/api/intelligence/sources'),
      $fetch<Job[]>('/api/intelligence/ingestion-jobs'),
      $fetch<TrainingRun[]>('/api/intelligence/training-runs'),
      $fetch<ProviderStatus>('/api/intelligence/providers'),
    ])
    sources.value = sourceRows
    jobs.value = jobRows
    trainingRuns.value = runRows
    providerStatus.value = providerRows
    providerForm.huggingFaceNamespace = providerRows.huggingface.namespace || ''
    state.value = 'ready'
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number, status?: number }).statusCode ?? (error as { status?: number }).status
    if (statusCode === 401 || statusCode === 403) state.value = 'signin'
    else { state.value = 'error'; errorMessage.value = 'The ML Workbench is unavailable. Check the private service configuration and try again.' }
  }
}

function startSignIn() { window.location.assign(`/api/auth/login?origin=${encodeURIComponent(window.location.origin)}`) }

async function saveProviderSettings() {
  providerSaveStatus.value = 'saving'
  providerSaveMessage.value = ''
  try {
    const result = await $fetch<{ status: ProviderStatus }>('/api/intelligence/providers', { method: 'POST', body: { firecrawlApiKey: providerForm.firecrawlApiKey, huggingFaceApiToken: providerForm.huggingFaceApiToken, huggingFaceNamespace: providerForm.huggingFaceNamespace } })
    providerStatus.value = result.status
    providerForm.firecrawlApiKey = ''
    providerForm.huggingFaceApiToken = ''
    providerSaveStatus.value = 'success'
    providerSaveMessage.value = '已安全儲存。網站後端現在會使用這組設定；完整 key 不會再次顯示。'
  } catch (error: unknown) {
    providerSaveStatus.value = 'error'
    providerSaveMessage.value = (error as { statusMessage?: string }).statusMessage || '設定儲存失敗，請確認欄位後再試。'
  }
}

async function startCrawl() {
  crawlStatus.value = 'saving'
  crawlMessage.value = ''
  try {
    const result = await $fetch<{ message: string }>('/api/intelligence/ingestion-jobs', { method: 'POST', body: { mode: 'site', sourceId: crawlForm.sourceId, requestedUrl: crawlForm.requestedUrl, maxPages: crawlForm.maxPages, maxDepth: crawlForm.maxDepth } })
    crawlStatus.value = 'success'
    crawlMessage.value = result.message
    crawlForm.requestedUrl = ''
    await refreshJobs()
  } catch (error: unknown) {
    crawlStatus.value = 'error'
    crawlMessage.value = (error as { statusMessage?: string }).statusMessage || 'The bounded crawl could not start.'
  }
}

async function refreshJobs() { jobs.value = await $fetch<Job[]>('/api/intelligence/ingestion-jobs') }
async function refreshRuns() { trainingRuns.value = await $fetch<TrainingRun[]>('/api/intelligence/training-runs') }

async function startTraining() {
  trainingStatus.value = 'running'
  trainingMessage.value = ''
  try {
    const result = await $fetch<{ message: string, status: string }>('/api/intelligence/training-runs', { method: 'POST', body: { mode: trainingMode.value } })
    trainingStatus.value = result.status === 'blocked' || result.status === 'failed' ? 'error' : 'success'
    trainingMessage.value = result.message
    await refreshRuns()
  } catch (error: unknown) {
    trainingStatus.value = 'error'
    trainingMessage.value = (error as { statusMessage?: string }).statusMessage || 'The training run could not start.'
    await refreshRuns()
  }
}

function displayStatus(value: string) { return value.replaceAll('_', ' ') }
function formatDate(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function toggleJob(jobId: number) { expandedJobId.value = expandedJobId.value === jobId ? null : jobId }

onMounted(loadWorkbench)
</script>

<template>
  <main class="ml-workbench" aria-labelledby="workbench-title">
    <header class="workbench-header">
      <NuxtLink to="/en" class="workbench-mark" aria-label="Return to DiscoveryStack home">DISCOVERY<span>STACK</span></NuxtLink>
      <p class="workbench-route">PRIVATE SYSTEM / ML WORKBENCH</p>
      <NuxtLink to="/audit-lab" class="workbench-link">Open Audit Lab <span aria-hidden="true">↗</span></NuxtLink>
    </header>

    <div v-if="state === 'loading'" class="workbench-state" aria-live="polite">Loading the ML Workbench…</div>
    <section v-else-if="state === 'signin'" class="workbench-state workbench-auth">
      <p class="eyebrow">Owner session required</p>
      <h1>Run the pipeline.<br><em>Keep the evidence governed.</em></h1>
      <p>This workbench is private. It exposes source-approved crawling, in-memory cleaning and human-gated training records only after owner sign-in.</p>
      <button class="workbench-button" type="button" @click="startSignIn">Sign in to ML Workbench <span aria-hidden="true">↗</span></button>
    </section>
    <section v-else-if="state === 'error'" class="workbench-state workbench-error" role="alert">{{ errorMessage }}</section>

    <template v-else>
      <section class="workbench-hero">
        <div>
          <p class="eyebrow">Journey Intelligence / Operational layer</p>
          <h1 id="workbench-title">Crawl.<br><em>Clean. Train.</em></h1>
          <p class="workbench-lede">這裡是真正的機器學習工作區：先用受限 crawler 抓取已核准的公開頁面，再在記憶體中清洗並轉成 typed structural features，最後以人審、去識別且通過品質門檻的資料執行可重現的 training run。</p>
        </div>
        <aside class="workbench-boundary">
          <strong>Operational boundary</strong>
          <p>不追蹤整站、不跟隨 redirect、不保存 raw HTML 或清洗後正文；每一頁都會留下狀態、hash、PII 結果與 artifact lineage。</p>
          <NuxtLink to="/audit-lab" class="text-link">建立 Source Card 與人工標籤 <span aria-hidden="true">↗</span></NuxtLink>
        </aside>
      </section>

      <section class="workbench-stats" aria-label="ML pipeline counters">
        <article><span>Approved sources</span><strong>{{ eligibleSources.length }}</strong><p>通過 robots、terms、copyright 與 PII gate。</p></article>
        <article><span>Cleaned pages</span><strong>{{ cleanedPages }}</strong><p>已轉成 structural artifacts 的頁面數。</p></article>
        <article><span>Completed crawls</span><strong>{{ completedJobs.length }}</strong><p>每次 crawl 由 owner 明確觸發。</p></article>
        <article><span>Latest model</span><strong>{{ latestCompletedRun ? latestCompletedRun.modelVersion : 'Not trained' }}</strong><p>{{ latestCompletedRun ? '仍需檢視 holdout 與人審。' : '先建立足夠的合格標籤。' }}</p></article>
      </section>

      <section class="workbench-section" aria-labelledby="crawl-title">
        <div class="section-intro"><p class="eyebrow">01 / Crawl</p><h2 id="crawl-title">抓取受核准的頁面。</h2><p>這不是無限制爬蟲。起點必須屬於 Source Card 的 host，最多 10 頁、深度最多 2，只接受 HTTPS HTML，並以 manual redirect 防止意外離開範圍。</p></div>
        <div class="workbench-card">
          <form class="workbench-form" @submit.prevent="startCrawl">
            <label><span>Approved Source Card</span><select v-model.number="crawlForm.sourceId" required><option :value="0" disabled>Select a policy-cleared source</option><option v-for="source in eligibleSources" :key="source.id" :value="source.id">{{ source.sourceName || source.domain }} · {{ source.allowedUse.replaceAll('_', ' ') }}</option></select></label>
            <label><span>起始 URL</span><input v-model.trim="crawlForm.requestedUrl" required type="url" placeholder="https://approved-source.example/" inputmode="url"></label>
            <div class="form-grid"><label><span>Max pages</span><input v-model.number="crawlForm.maxPages" type="number" min="1" max="10"></label><label><span>Max depth</span><input v-model.number="crawlForm.maxDepth" type="number" min="0" max="2"></label></div>
            <button class="workbench-button" :disabled="crawlStatus === 'saving' || !eligibleSources.length" type="submit">{{ crawlStatus === 'saving' ? 'Crawling and cleaning…' : 'Start bounded crawl' }} <span aria-hidden="true">↗</span></button>
            <p v-if="!eligibleSources.length" class="workbench-hint">目前沒有通過自動抓取 gate 的 Source Card。先到 Audit Lab 建立並審核來源。</p>
            <p v-if="crawlMessage" class="workbench-feedback" :class="crawlStatus === 'error' ? 'is-error' : 'is-success'" aria-live="polite">{{ crawlMessage }}</p>
          </form>
          <dl class="boundary-list"><div><dt>Scope</dt><dd>Same approved host only</dd></div><div><dt>Acquisition</dt><dd>HTTPS HTML, one bounded run</dd></div><div><dt>Retention</dt><dd>Hashes + typed features, no page copy</dd></div><div><dt>PII</dt><dd>Potential findings skip artifact creation</dd></div></dl>
        </div>
      </section>

      <section class="workbench-section" aria-labelledby="clean-title">
        <div class="section-intro"><p class="eyebrow">02 / Clean</p><h2 id="clean-title">看見清洗，而不是黑盒子。</h2><p>每次 run 都會顯示 fetched、cleaned、artifact 數量與安全 error code。點開一列可查看各頁的 depth、PII 結果與 artifact id，但不會顯示原始正文。</p></div>
        <div class="workbench-card table-card">
          <div v-if="jobs.length" class="table-wrap"><table><thead><tr><th>Run</th><th>Mode / status</th><th>Pages</th><th>Cleaned chars</th><th>Requested</th><th></th></tr></thead><tbody><template v-for="job in jobs" :key="job.id"><tr><td><strong>#{{ job.id }}</strong><br><small>{{ job.sourceName || `Source #${job.sourceId}` }}</small></td><td>{{ displayStatus(job.collectionMode) }}<br><span class="status" :class="`status-${job.status}`">{{ displayStatus(job.status) }}</span></td><td>{{ job.pagesCleaned || 0 }} / {{ job.pagesFetched || 0 }}<br><small>{{ job.artifactsCreated || 0 }} artifacts</small></td><td>{{ job.cleanedCharacterCount || 0 }}</td><td><small>{{ formatDate(job.requestedAt) }}</small></td><td><button class="row-button" type="button" @click="toggleJob(job.id)">{{ expandedJobId === job.id ? 'Hide' : 'Inspect' }}</button></td></tr><tr v-if="expandedJobId === job.id" class="detail-row"><td colspan="6"><div class="page-results"><article v-for="page in (job.crawlResults || [])" :key="`${job.id}-${page.url}`"><strong>{{ page.status }}</strong><span>{{ page.depth }} · HTTP {{ page.httpStatus || '—' }}</span><small>{{ page.url }}</small><small>{{ page.cleanedCharacterCount || 0 }} chars · {{ page.piiOutcome || '—' }} · artifact {{ page.artifactId || 'none' }}<template v-if="page.errorCode"> · {{ page.errorCode }}</template></small></article></div></td></tr></template></tbody></table></div>
          <p v-else class="empty-state">尚未執行 crawl。通過 Source Card policy gate 後，第一個 bounded run 會出現在這裡。</p>
        </div>
      </section>

      <section class="workbench-section" aria-labelledby="train-title">
        <div class="section-intro"><p class="eyebrow">03 / Train</p><h2 id="train-title">用合格標籤訓練可檢查的模型。</h2><p>Crawl 產生的是 feature artifact，不是 label。Training 會讀取 Audit Lab 中明確 consent、人工 review、quality passed 且未撤回的 de-identified examples。development run 用於驗證流程；production gate 仍要求至少 150 筆、每個 journey stage 至少 20 筆。</p></div>
        <div class="workbench-card training-card">
          <div class="training-callout"><span class="eyebrow">Current training engine</span><strong>Hugging Face Transformers Trainer</strong><p>這裡會把合格的去識別 feature records 組成 dataset，提交到 Hugging Face Jobs 的 GPU，使用 multilingual DistilBERT 做 supervised fine-tuning，完成後把 private model artifact 上傳到 Hugging Face model repo。沒有成功提交或完成 remote job，就不會宣稱模型已訓練。</p><p class="provider-status">Firecrawl：<strong>{{ providerStatus.firecrawl.configured ? '已連接' : '未設定' }}</strong><template v-if="providerStatus.firecrawl.last4"> · ****{{ providerStatus.firecrawl.last4 }}</template> · Hugging Face Jobs：<strong>{{ providerStatus.huggingface.configured ? '已連接' : '未設定' }}</strong><template v-if="providerStatus.huggingface.last4"> · ****{{ providerStatus.huggingface.last4 }}</template><template v-if="providerStatus.huggingface.namespace"> · {{ providerStatus.huggingface.namespace }}</template></p><p class="workbench-hint">你可以直接在這裡設定；key 只會加密存放在 server database，瀏覽器不會拿到完整內容。</p></div>
          <form class="workbench-form provider-settings" @submit.prevent="saveProviderSettings"><label><span>Firecrawl API key</span><input v-model.trim="providerForm.firecrawlApiKey" type="password" autocomplete="off" placeholder="貼上 Firecrawl key；留白代表保留原設定"></label><label><span>Hugging Face token</span><input v-model.trim="providerForm.huggingFaceApiToken" type="password" autocomplete="off" placeholder="貼上 Hugging Face token；留白代表保留原設定"></label><label><span>Hugging Face 使用者名稱</span><input v-model.trim="providerForm.huggingFaceNamespace" type="text" autocomplete="username" placeholder="例如 your-name"></label><button class="workbench-button" :disabled="providerSaveStatus === 'saving'" type="submit">{{ providerSaveStatus === 'saving' ? '儲存中…' : '儲存 provider 設定' }} <span aria-hidden="true">↗</span></button><p v-if="providerSaveMessage" class="workbench-feedback" :class="providerSaveStatus === 'error' ? 'is-error' : 'is-success'" aria-live="polite">{{ providerSaveMessage }}</p></form>
          <form class="workbench-form training-form" @submit.prevent="startTraining"><label><span>Run mode</span><select v-model="trainingMode"><option value="development">Development · ≥ 5 examples, every stage covered</option><option value="production">Production · ≥ 150 examples, ≥ 20 per stage</option></select></label><button class="workbench-button" :disabled="trainingStatus === 'running'" type="submit">{{ trainingStatus === 'running' ? 'Submitting Hugging Face job…' : 'Run Hugging Face training' }} <span aria-hidden="true">↗</span></button><p v-if="trainingMessage" class="workbench-feedback" :class="trainingStatus === 'error' ? 'is-error' : 'is-success'" aria-live="polite">{{ trainingMessage }}</p></form>
          <div v-if="trainingRuns.length" class="run-list"><article v-for="run in trainingRuns" :key="run.id"><div><strong>#{{ run.id }} · {{ run.mode }}</strong><span class="status" :class="`status-${run.status}`">{{ displayStatus(run.status) }}</span><small>{{ formatDate(run.createdAt) }} · {{ run.exampleCount }} examples · train {{ run.trainCount }} / val {{ run.validationCount }} / test {{ run.testCount }}</small><small>Hugging Face · {{ run.modelFamily }} · {{ run.modelVersion }}</small><a v-if="run.remoteJobUrl" class="run-link" :href="run.remoteJobUrl" target="_blank" rel="noreferrer">Open remote job ↗</a><a v-if="run.modelRepoId" class="run-link" :href="`https://huggingface.co/${run.modelRepoId}`" target="_blank" rel="noreferrer">Open private model repo ↗</a></div><dl v-if="run.metrics?.test"><div><dt>Test accuracy</dt><dd>{{ run.metrics.test.accuracy ?? '—' }}</dd></div><div><dt>Test macro-F1</dt><dd>{{ run.metrics.test.macroF1 ?? '—' }}</dd></div><div><dt>Labels</dt><dd>{{ Object.values(run.labelCounts).reduce((sum, count) => sum + count, 0) }}</dd></div></dl><small v-if="run.errorCode" class="run-error">{{ run.errorCode }}</small></article></div><p v-else class="empty-state">尚未有 training run。先在 Audit Lab 完成人工觀察、review、quality gate 與 training approval。</p>
        </div>
      </section>

      <section class="workbench-footer-guardrail"><p class="eyebrow">Human gate</p><h2>能跑，不代表能宣稱。</h2><p>每個 Hugging Face run 都必須通過 de-identified dataset、policy、consent、quality、split 與 strategist review gate；只有 remote job 完成並留下 model artifact，才會顯示為 completed。它不代表 conversion prediction。</p><NuxtLink to="/audit-lab" class="workbench-button workbench-button-light">Open Audit Lab <span aria-hidden="true">↗</span></NuxtLink></section>
    </template>
  </main>
</template>

<style scoped>
.ml-workbench { min-height: 100vh; padding: 1.25rem var(--content-gutter) 5rem; background: linear-gradient(135deg, rgba(216,223,238,.46), transparent 38%), var(--paper); color: var(--ink); }
.workbench-header, .workbench-hero, .workbench-section, .workbench-stats { max-width: var(--content-max); margin-left: auto; margin-right: auto; }.workbench-header { min-height: 64px; display: flex; align-items: center; gap: 1rem; border-bottom: 1px solid rgba(22,38,63,.16); font: 600 .68rem/1 var(--font-mono); letter-spacing: .11em; text-transform: uppercase; }.workbench-mark { color: var(--ink); text-decoration: none; letter-spacing: .16em; }.workbench-mark span { color: var(--cobalt); }.workbench-route { flex: 1; text-align: center; margin: 0; color: var(--ink-muted); }.workbench-link, .text-link { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--cobalt); padding-bottom: .25rem; }.text-link { display: inline-block; margin-top: 1rem; }
.eyebrow { margin: 0; color: var(--cobalt); font: 600 .65rem/1.2 var(--font-mono); letter-spacing: .12em; text-transform: uppercase; }.workbench-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr); gap: clamp(2rem, 6vw, 7rem); padding: clamp(4rem, 9vw, 7rem) 0 3rem; align-items: end; }.workbench-hero h1, .workbench-auth h1 { margin: .5rem 0 1.3rem; font: 600 clamp(3.4rem, 8vw, 7.2rem)/.86 var(--font-display); letter-spacing: -.065em; }.workbench-hero h1 em, .workbench-auth h1 em, .workbench-footer-guardrail h2 em { color: var(--cobalt); font-weight: 500; }.workbench-lede { max-width: 680px; margin: 0; color: var(--ink-muted); line-height: 1.75; }.workbench-boundary { border-left: 2px solid var(--cobalt); padding: .5rem 0 .5rem 1.25rem; color: var(--ink-muted); line-height: 1.65; }.workbench-boundary strong { display: block; margin-bottom: .6rem; color: var(--ink); font: 700 .7rem/1 var(--font-mono); letter-spacing: .1em; text-transform: uppercase; }.workbench-boundary p { margin: 0; }
.workbench-stats { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid rgba(22,38,63,.18); border-bottom: 1px solid rgba(22,38,63,.18); }.workbench-stats article { min-height: 160px; padding: 1.4rem 1.25rem; border-right: 1px solid rgba(22,38,63,.18); }.workbench-stats article:last-child { border: 0; }.workbench-stats span { color: var(--cobalt); font: 600 .65rem/1 var(--font-mono); letter-spacing: .1em; text-transform: uppercase; }.workbench-stats strong { display: block; margin: 1.1rem 0 .5rem; font: 600 clamp(1.45rem, 2.5vw, 2.2rem)/1 var(--font-display); overflow-wrap: anywhere; }.workbench-stats p { margin: 0; color: var(--ink-muted); font-size: .84rem; line-height: 1.5; }
.workbench-section { display: grid; grid-template-columns: minmax(230px, .6fr) minmax(0, 1.4fr); gap: clamp(2rem, 7vw, 8rem); padding: clamp(4rem, 8vw, 7rem) 0; border-bottom: 1px solid rgba(22,38,63,.16); align-items: start; }.section-intro h2 { margin: .55rem 0 1rem; font: 600 clamp(2.2rem, 4vw, 4rem)/.95 var(--font-display); letter-spacing: -.05em; }.section-intro > p:last-child { margin: 0; max-width: 31rem; color: var(--ink-muted); line-height: 1.7; }.workbench-card { padding: clamp(1.2rem, 3vw, 2.2rem); background: rgba(248,244,235,.94); border: 1px solid rgba(22,38,63,.16); box-shadow: 12px 12px 0 rgba(22,38,63,.06); }.workbench-form { display: grid; gap: 1rem; }.workbench-form label { display: grid; gap: .4rem; color: var(--ink); font: 600 .68rem/1.3 var(--font-mono); letter-spacing: .05em; text-transform: uppercase; }.workbench-form input, .workbench-form select, .workbench-form textarea { width: 100%; min-height: 2.7rem; padding: .7rem .75rem; border: 1px solid rgba(22,38,63,.25); border-radius: 0; background: rgba(255,255,255,.5); color: var(--ink); font: 400 .95rem/1.35 var(--font-body); letter-spacing: normal; text-transform: none; }.workbench-form input:focus, .workbench-form select:focus, .workbench-form textarea:focus { outline: 2px solid var(--cobalt); outline-offset: 2px; }.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }.workbench-button { display: inline-flex; width: fit-content; align-items: center; gap: .6rem; margin-top: .35rem; padding: .8rem 1rem; border: 1px solid var(--ink); background: var(--ink); color: var(--paper); cursor: pointer; font: 600 .7rem/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; transition: transform .16s ease-out, background .16s ease-out; }.workbench-button:hover { background: var(--cobalt); border-color: var(--cobalt); }.workbench-button:active { transform: scale(.97); }.workbench-button:disabled { cursor: not-allowed; opacity: .48; }.workbench-hint, .workbench-feedback { margin: .2rem 0 0; color: var(--ink-muted); font-size: .85rem; line-height: 1.55; }.workbench-feedback.is-success { color: #21634a; }.workbench-feedback.is-error, .run-error { color: #a13d37; }.boundary-list { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 2rem 0 0; padding-top: 1.25rem; border-top: 1px solid rgba(22,38,63,.16); }.boundary-list div { min-width: 0; }.boundary-list dt, .run-list dt { color: var(--ink-muted); font: 600 .62rem/1.2 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }.boundary-list dd { margin: .35rem 0 0; font-size: .86rem; line-height: 1.4; }
.table-card { padding: 0; overflow: hidden; }.table-wrap { overflow-x: auto; }.table-wrap table { width: 100%; min-width: 700px; border-collapse: collapse; font-size: .86rem; }.table-wrap th, .table-wrap td { padding: 1rem .9rem; border-bottom: 1px solid rgba(22,38,63,.14); text-align: left; vertical-align: top; }.table-wrap th { color: var(--ink-muted); font: 600 .62rem/1.3 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }.table-wrap td small { color: var(--ink-muted); line-height: 1.45; }.row-button { padding: .45rem .6rem; border: 1px solid rgba(22,38,63,.3); background: transparent; color: var(--ink); cursor: pointer; font: 600 .62rem/1 var(--font-mono); text-transform: uppercase; }.status { display: inline-block; margin-top: .35rem; padding: .25rem .4rem; color: var(--ink); background: rgba(22,38,63,.08); font: 600 .62rem/1 var(--font-mono); text-transform: uppercase; }.status-completed { color: #21634a; background: rgba(33,99,74,.12); }.status-failed, .status-blocked { color: #a13d37; background: rgba(161,61,55,.1); }.status-processing, .status-running { color: #755d14; background: rgba(177,145,34,.15); }.detail-row td { background: rgba(216,223,238,.22); }.page-results { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .7rem; }.page-results article { display: grid; gap: .35rem; padding: .75rem; border-left: 2px solid var(--cobalt); background: rgba(248,244,235,.8); }.page-results strong { color: #21634a; font: 600 .68rem/1 var(--font-mono); text-transform: uppercase; }.page-results span, .page-results small { color: var(--ink-muted); overflow-wrap: anywhere; line-height: 1.4; }.empty-state { margin: 0; padding: 2rem; color: var(--ink-muted); line-height: 1.6; }
.training-card { display: grid; grid-template-columns: 1.1fr .9fr; gap: 1.5rem; }.training-callout { padding: 1rem; background: var(--ink); color: var(--paper); }.training-callout strong { display: block; margin: .6rem 0; font: 600 1.5rem/1 var(--font-display); }.training-callout p { margin: 0; color: rgba(248,244,235,.72); line-height: 1.6; font-size: .88rem; }.training-form { align-content: start; }.run-list { grid-column: 1 / -1; display: grid; gap: .75rem; padding-top: 1rem; border-top: 1px solid rgba(22,38,63,.16); }.run-list article { display: flex; align-items: start; justify-content: space-between; gap: 1rem; padding: .9rem 0; border-bottom: 1px solid rgba(22,38,63,.12); }.run-list article > div { display: grid; gap: .35rem; }.run-list article small { color: var(--ink-muted); line-height: 1.4; }.run-list dl { display: flex; gap: 1.1rem; margin: 0; }.run-list dd { margin: .35rem 0 0; font: 600 .95rem/1 var(--font-display); }.run-error { display: block; grid-column: 1 / -1; font: 600 .68rem/1.3 var(--font-mono); text-transform: uppercase; }
.workbench-footer-guardrail { max-width: var(--content-max); margin: clamp(4rem, 8vw, 7rem) auto 0; padding: clamp(3rem, 7vw, 6rem) clamp(1.25rem, 6vw, 7rem); background: var(--ink); color: var(--paper); }.workbench-footer-guardrail h2 { max-width: 800px; margin: .6rem 0 1rem; font: 600 clamp(2.3rem, 5vw, 5rem)/.95 var(--font-display); letter-spacing: -.055em; }.workbench-footer-guardrail p { max-width: 630px; color: rgba(248,244,235,.72); line-height: 1.7; }.workbench-button-light { color: var(--ink); background: var(--paper); border-color: var(--paper); text-decoration: none; }.workbench-button-light:hover { color: var(--paper); background: transparent; }
.workbench-state { max-width: var(--content-max); margin: 6rem auto; padding: 2rem; border: 1px solid rgba(22,38,63,.18); color: var(--ink-muted); }.workbench-auth { max-width: 900px; margin-top: 10vh; }.workbench-auth h1 { font-size: clamp(3rem, 7vw, 6rem); }.workbench-auth p:not(.eyebrow) { max-width: 580px; color: var(--ink-muted); line-height: 1.7; }.workbench-error { color: #a13d37; }
@media (max-width: 820px) { .ml-workbench { padding-left: 1.25rem; padding-right: 1.25rem; }.workbench-header { min-height: 54px; }.workbench-route { display: none; }.workbench-link { margin-left: auto; font-size: .58rem; }.workbench-hero, .workbench-section { grid-template-columns: 1fr; }.workbench-hero { padding-top: 4rem; }.workbench-stats { grid-template-columns: 1fr 1fr; }.workbench-stats article:nth-child(2) { border-right: 0; }.workbench-stats article:nth-child(-n+2) { border-bottom: 1px solid rgba(22,38,63,.18); }.training-card { grid-template-columns: 1fr; }.run-list article { display: grid; }.run-list dl { justify-content: space-between; }.boundary-list { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .workbench-stats { grid-template-columns: 1fr; }.workbench-stats article { border-right: 0; border-bottom: 1px solid rgba(22,38,63,.18); }.workbench-stats article:last-child { border-bottom: 0; }.form-grid { grid-template-columns: 1fr; } }
</style>
