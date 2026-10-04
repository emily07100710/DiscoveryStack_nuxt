<script setup lang="ts">
type Candidate = {
  id: number
  leadId: number
  company: string
  website: string | null
  language: string
  status: 'collection_failed' | 'ready_for_review' | 'approved' | 'rejected' | 'revoked'
  robotsStatus: string
  featureData: { scores?: Record<string, number>, checks?: Record<string, boolean | number | string>, rawHtmlStored?: boolean, contactPiiStored?: boolean }
  suggestedLabelData: Record<string, unknown>
  approvedLabelData: Record<string, unknown> | null
  consentVersion: string
  consentedAt: string
  collectionErrorCode: string | null
  publicArtifactId: number | null
  collectedAt: string | null
  reviewedAt: string | null
}
type PipelineResponse = {
  candidates: Candidate[]
  runs: Array<{ id: number, trigger: string, status: string, leadsExamined: number, collectedCandidates: number, duplicateCandidates: number, failedCandidates: number, startedAt: string }>
  readiness: { approvedHumanAnnotations: number, stageCounts: Record<string, number>, productionMinimum: number, productionMinimumPerStage: number, productionReady: boolean }
}

definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: '自動訓練資料管線 · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const state = ref<'loading' | 'signin' | 'ready' | 'error'>('loading')
const data = ref<PipelineResponse | null>(null)
const busy = ref<string | null>(null)
const notice = ref('')
type TrainingSnapshotRow = { id: number, split: 'train' | 'validation' | 'test', targets: Record<string, string | string[]>, manifestHash: string }
const snapshotRows = ref<TrainingSnapshotRow[]>([])
const snapshotLoading = ref(false)
const snapshotError = ref('')
const colabError = ref('')
const snapshotDatasetBuildId = ref(1)
const snapshotSplitFilter = ref('')
const snapshotPage = ref(1)
const snapshotPageSize = 10
const colabSubmitting = ref(false)
const colabForm = reactive({ datasetBuildId: 1, manifestHash: '', datasetDigest: '', checkpointSha256: '', artifactStorage: 'owner_browser_download' as 'owner_browser_download' | 'owner_controlled_google_drive', baseModelId: '', modelVersion: '', metrics: '{}', startedAt: '', completedAt: '', smokeExampleCount: '' as number | '', smokeResult: '' as '' | 'passed' | 'failed', smokeTaskHeads: [] as string[] })
const taskHeads = ['journeyStage', 'searchIntents', 'contentTypes', 'audienceRoles', 'geoSignals', 'citationReadiness', 'technicalSeoSignals', 'frictionSignals', 'actionPriority']
const approvedColabBaseModelId = 'distilbert-base-multilingual-cased'
const colabBlockers = computed(() => {
  const blockers: string[] = []
  if (!colabForm.baseModelId) blockers.push('請填入 Colab 實際使用的 base model ID。')
  else if (colabForm.baseModelId !== approvedColabBaseModelId) blockers.push(`server 只接受 ${approvedColabBaseModelId}；用其他 base model 訓練的結果不能提交。`)
  if (colabForm.smokeExampleCount === '') blockers.push('請填入 smoke test 實際使用的非訓練樣本數。')
  else if (colabForm.smokeExampleCount !== 5) blockers.push('server 只接受使用 5 筆非訓練資料的 smoke test；筆數不同請先在 Colab 重跑。')
  if (!colabForm.smokeResult) blockers.push('請選擇 smoke test 的實際結果。')
  else if (colabForm.smokeResult !== 'passed') blockers.push('Smoke test 未通過時不能提交；請先在 Colab 修正後重跑。')
  const coveredHeads = taskHeads.filter(head => colabForm.smokeTaskHeads.includes(head)).length
  if (coveredHeads < taskHeads.length) blockers.push(`請勾選 smoke test 實際涵蓋的 task heads；九個全部涵蓋才能提交（目前 ${coveredHeads} / ${taskHeads.length}）。`)
  return blockers
})
const filteredSnapshotRows = computed(() => snapshotRows.value.filter(row => !snapshotSplitFilter.value || row.split === snapshotSplitFilter.value))
const pagedSnapshotRows = computed(() => filteredSnapshotRows.value.slice((snapshotPage.value - 1) * snapshotPageSize, snapshotPage.value * snapshotPageSize))
const reviews = reactive<Record<number, { labels: string, note: string, rightsConfirmed: boolean }>>({})
const stages = ['discovery', 'understanding', 'response', 'progression', 'conversion']

async function loadPipeline() {
  state.value = 'loading'
  try {
    data.value = await $fetch<PipelineResponse, '/api/intelligence/model-improvement/pipeline'>('/api/intelligence/model-improvement/pipeline')
    for (const candidate of data.value.candidates) {
      reviews[candidate.id] ||= { labels: JSON.stringify(candidate.suggestedLabelData, null, 2), note: '', rightsConfirmed: false }
    }
    state.value = 'ready'
  } catch (error: unknown) {
    const status = (error as { statusCode?: number, status?: number }).statusCode || (error as { status?: number }).status
    state.value = status === 401 || status === 403 ? 'signin' : 'error'
  }
}

function signIn() {
  window.location.assign(`/api/auth/login?origin=${encodeURIComponent(window.location.origin)}`)
}

async function collectNow() {
  busy.value = 'collect'
  notice.value = ''
  try {
    const result = await $fetch<{ collection: { collectedCandidates: number, duplicateCandidates: number, failedCandidates: number } }, '/api/intelligence/model-improvement/collect'>('/api/intelligence/model-improvement/collect', { method: 'POST' })
    notice.value = `完成：新增 ${result.collection.collectedCandidates}、重複 ${result.collection.duplicateCandidates}、失敗 ${result.collection.failedCandidates}。`
    await loadPipeline()
  } catch {
    notice.value = '收集工作無法完成，請檢查資料庫、owner 設定與公開網站狀態。'
  } finally {
    busy.value = null
  }
}

async function review(candidate: Candidate, decision: 'approved' | 'rejected') {
  const form = reviews[candidate.id]!
  busy.value = `${decision}:${candidate.id}`
  notice.value = ''
  try {
    const labels = decision === 'approved' ? JSON.parse(form.labels) : undefined
    await $fetch<unknown, `/api/intelligence/model-improvement/candidates/${number}/review`>(`/api/intelligence/model-improvement/candidates/${candidate.id}/review`, {
      method: 'POST',
      body: { decision, reviewNote: form.note, rightsConfirmed: decision === 'approved' ? form.rightsConfirmed : false, labels },
    })
    notice.value = decision === 'approved' ? '候選已加入受治理資料池；若達門檻，系統會準備新版 manifest。' : '候選已拒絕，不會進入訓練。'
    await loadPipeline()
  } catch {
    notice.value = '審核失敗：請確認說明、權利確認與九個標籤的 JSON 格式。'
  } finally {
    busy.value = null
  }
}

async function prepareManifest() {
  busy.value = 'manifest'
  notice.value = ''
  try {
    const result = await $fetch<{ manifest: { status: string } }, '/api/intelligence/model-improvement/prepare-manifest'>('/api/intelligence/model-improvement/prepare-manifest', { method: 'POST' })
    notice.value = result.manifest.status === 'gate_blocked' ? '尚未達到 150 筆、每階段 20 筆的正式門檻。' : '新版 manifest 已檢查或建立，仍需 owner 核准。'
    await loadPipeline()
  } catch {
    notice.value = '目前無法準備 manifest。'
  } finally {
    busy.value = null
  }
}

// The snapshot is NDJSON, so it is read as text; error bodies then arrive as a JSON string too.
function textResponseErrorMessage(error: any, fallback: string) {
  if (typeof error?.data === 'string') {
    try { const body = JSON.parse(error.data) as { message?: unknown, statusMessage?: unknown }; if (typeof body?.message === 'string' && body.message) return body.message; if (typeof body?.statusMessage === 'string' && body.statusMessage) return body.statusMessage } catch {}
  }
  return error?.data?.message || error?.statusMessage || fallback
}
async function loadTrainingSnapshot() {
  snapshotLoading.value = true; snapshotError.value = ''
  try {
    const payload = await $fetch<string, '/api/intelligence/training-snapshot'>('/api/intelligence/training-snapshot', { query: { datasetBuildId: snapshotDatasetBuildId.value }, responseType: 'text' })
    snapshotRows.value = String(payload).trim().split('\n').filter(Boolean).map(line => { const row = JSON.parse(line) as TrainingSnapshotRow & { trainingText?: string }; return { id: row.id, split: row.split, targets: row.targets, manifestHash: row.manifestHash } })
  } catch (error: any) { snapshotRows.value = []; snapshotError.value = textResponseErrorMessage(error, '訓練快照目前無法載入。') }
  finally { snapshotLoading.value = false }
}
function onSnapshotPage(page: number) { snapshotPage.value = page }
async function submitColabResults() {
  colabError.value = ''; notice.value = ''
  if (colabBlockers.value.length) { colabError.value = `尚未符合提交條件：${colabBlockers.value.join(' ')}`; return }
  colabSubmitting.value = true
  try {
    const metrics = JSON.parse(colabForm.metrics) as Record<string, unknown>
    if (!metrics || Array.isArray(metrics) || typeof metrics !== 'object') throw new Error('Metrics 必須是 JSON 物件。')
    await $fetch<unknown, '/api/intelligence/colab-training-results'>('/api/intelligence/colab-training-results', { method: 'POST', body: { datasetBuildId: colabForm.datasetBuildId, manifestHash: colabForm.manifestHash, datasetDigest: colabForm.datasetDigest, checkpointSha256: colabForm.checkpointSha256, artifactStorage: colabForm.artifactStorage, baseModelId: colabForm.baseModelId, modelVersion: colabForm.modelVersion, metrics, smokeTest: { nonTrainingExampleCount: colabForm.smokeExampleCount, passed: colabForm.smokeResult === 'passed', taskHeads: taskHeads.filter(head => colabForm.smokeTaskHeads.includes(head)) }, startedAt: new Date(colabForm.startedAt).toISOString(), completedAt: new Date(colabForm.completedAt).toISOString() } })
    notice.value = 'Colab 訓練收據已記錄為 development run；正式 production gate 仍未通過。'
    snapshotDatasetBuildId.value = colabForm.datasetBuildId
    await loadTrainingSnapshot()
  } catch (error: any) { colabError.value = error?.data?.message || error?.statusMessage || error?.message || 'Colab 訓練結果無法提交。' }
  finally { colabSubmitting.value = false }
}

onMounted(() => { void loadPipeline(); void loadTrainingSnapshot() })
</script>

<template>
  <main class="pipeline">
    <header class="pipeline-head">
      <div><p class="eyebrow">PRIVATE / CONSENTED DATA PIPELINE</p><h1>每天自動整理，<br><em>不自動亂學。</em></h1><p>每日排程只處理另外同意模型改善的網站；保存的是去識別化結構訊號，不是客戶姓名、Email 或原始 HTML。每一筆標籤仍要由 owner 核准。</p></div>
      <nav><NuxtLink to="/leads">客戶名單</NuxtLink><NuxtLink to="/ml-lab-preview">ML 工作台</NuxtLink><NuxtLink to="/audit-lab">稽核實驗室</NuxtLink></nav>
    </header>

    <section v-if="state === 'loading'" class="state">正在讀取資料管線…</section>
    <section v-else-if="state === 'signin'" class="state"><h2>需要 owner 登入。</h2><button type="button" @click="signIn">登入後台 ↗</button></section>
    <section v-else-if="state === 'error' || !data" class="state"><h2>目前無法讀取資料管線。</h2><p>請確認資料庫已套用最新 migration。</p></section>
    <template v-else>
      <section class="controls">
        <div><span>每日排程</span><strong>18:00 UTC</strong><small>預設為台北隔日 02:00；可用環境變數調整</small></div>
        <div><span>正式訓練門檻</span><strong>{{ data.readiness.approvedHumanAnnotations }} / {{ data.readiness.productionMinimum }}</strong><small>每個旅程階段至少 {{ data.readiness.productionMinimumPerStage }} 筆</small></div>
        <button type="button" :disabled="busy === 'collect'" @click="collectNow">{{ busy === 'collect' ? '正在收集…' : '現在執行一次' }} ↗</button>
        <button type="button" class="secondary" :disabled="busy === 'manifest'" @click="prepareManifest">檢查重訓門檻</button>
      </section>
      <p class="notice" role="status" aria-live="polite">{{ notice }}</p>

      <section class="readiness">
        <article v-for="stage in stages" :key="stage"><span>{{ stage }}</span><strong>{{ data.readiness.stageCounts[stage] || 0 }}</strong><small>/ {{ data.readiness.productionMinimumPerStage }}</small></article>
      </section>

      <section class="runs" aria-labelledby="training-snapshot-title"><p class="eyebrow">COLAB TRAINING SNAPSHOT</p><h2 id="training-snapshot-title">不可變訓練快照</h2><p class="limitation">此快照只交給 owner-controlled Google Colab 作開發用途；畫面不顯示訓練文字，提交結果只記錄 owner 提供的收據，不會開通或驗證外部 Google Drive、模型服務或 production deployment。</p><div class="toolbar"><label>Dataset build ID<input v-model.number="snapshotDatasetBuildId" type="number" min="1"></label><label>Split<select v-model="snapshotSplitFilter" @change="snapshotPage = 1"><option value="">全部 split</option><option value="train">train</option><option value="validation">validation</option><option value="test">test</option></select></label><button type="button" :disabled="snapshotLoading" @click="loadTrainingSnapshot">重新取得快照</button></div><OwnerAsyncState :loading="snapshotLoading" :error="snapshotError" :empty="filteredSnapshotRows.length === 0" loading-label="正在載入訓練快照…" empty-label="目前沒有可用的不可變訓練快照。" @retry="loadTrainingSnapshot"><div class="snapshot-list"><article v-for="row in pagedSnapshotRows" :key="row.id"><span>#{{ row.id }} · {{ row.split }}</span><strong class="mono">{{ row.manifestHash }}</strong><small>{{ Object.keys(row.targets).length }} 個 task targets</small><details class="advanced"><summary>目標欄位</summary><pre>{{ JSON.stringify(row.targets, null, 2) }}</pre></details></article></div><OwnerPager :page="snapshotPage" :page-size="snapshotPageSize" :total="filteredSnapshotRows.length" :disabled="snapshotLoading" @update:page="onSnapshotPage" /></OwnerAsyncState></section>

      <section class="queue" aria-labelledby="colab-result-title"><header><div><p class="eyebrow">COLAB RESULT RECEIPT</p><h2 id="colab-result-title">提交 Colab 開發訓練結果</h2></div></header><p class="limitation">請依 Colab 實際執行結果填寫，下面的 base model 與 smoke test 欄位不會預先代填，沒填完不會送出。server 會重新計算這個 dataset build 的快照，manifest SHA-256 與 dataset digest 必須完全相符；base model 只接受 distilbert-base-multilingual-cased；smoke test 必須通過、使用 5 筆非訓練資料並涵蓋全部九個 task heads；完成時間不能早於開始時間。這些值由你自行填寫，server 不會回頭檢查 Colab 或 checkpoint 檔案本身。未接真實對端，不會真的開通：提交成功只會在本地新增一筆 development 訓練紀錄（production gate 標記為未通過），不會部署模型，也不會購買或變更外部服務。</p><form class="colab-form" @submit.prevent="submitColabResults"><label>Dataset build ID<input v-model.number="colabForm.datasetBuildId" type="number" min="1" required></label><label>Manifest SHA-256<input v-model.trim="colabForm.manifestHash" required pattern="[a-fA-F0-9]{64}"></label><label>Dataset digest<input v-model.trim="colabForm.datasetDigest" required pattern="[a-fA-F0-9]{64}"></label><label>Checkpoint SHA-256<input v-model.trim="colabForm.checkpointSha256" required pattern="[a-fA-F0-9]{64}"></label><label>Artifact storage<select v-model="colabForm.artifactStorage"><option value="owner_browser_download">owner browser download</option><option value="owner_controlled_google_drive">owner-controlled Google Drive</option></select></label><label>Base model（Colab 實際使用的模型 ID）<input v-model.trim="colabForm.baseModelId" required maxlength="120" autocomplete="off" spellcheck="false"></label><label>Model version<input v-model.trim="colabForm.modelVersion" required maxlength="120"></label><label>開始時間<input v-model="colabForm.startedAt" type="datetime-local" required></label><label>完成時間<input v-model="colabForm.completedAt" type="datetime-local" required></label><label class="wide">Metrics JSON object<textarea v-model.trim="colabForm.metrics" required rows="5"></textarea></label><fieldset class="wide smoke-test"><legend>Smoke test 實際結果（請依 Colab 輸出填寫）</legend><label>非訓練樣本數<input v-model.number="colabForm.smokeExampleCount" type="number" min="0" step="1" required></label><label>結果<select v-model="colabForm.smokeResult" required><option value="" disabled>請選擇</option><option value="passed">通過</option><option value="failed">未通過</option></select></label><div class="wide smoke-heads" role="group" aria-label="Smoke test 實際涵蓋的 task heads"><span>實際涵蓋的 task heads</span><label v-for="head in taskHeads" :key="head" class="check"><input v-model="colabForm.smokeTaskHeads" type="checkbox" :value="head"><span class="mono">{{ head }}</span></label></div></fieldset><div v-if="colabBlockers.length" class="wide colab-blockers" aria-live="polite"><strong>提交前還需要：</strong><ul><li v-for="blocker in colabBlockers" :key="blocker">{{ blocker }}</li></ul></div><button :disabled="colabSubmitting || colabBlockers.length > 0">{{ colabSubmitting ? '正在提交收據…' : '提交 Colab 結果' }}</button><p v-if="colabError" class="error" role="alert">{{ colabError }}</p></form></section>

      <section class="queue">
        <header><div><p class="eyebrow">REVIEW QUEUE</p><h2>待審候選</h2></div><p>{{ data.candidates.filter(item => item.status === 'ready_for_review').length }} 筆等待人工確認</p></header>
        <article v-for="candidate in data.candidates" :key="candidate.id" class="candidate">
          <div class="candidate-summary">
            <small>#{{ candidate.id }} · {{ candidate.status }} · robots {{ candidate.robotsStatus }}</small>
            <h3>{{ candidate.company }}</h3>
            <a v-if="candidate.website" :href="candidate.website" target="_blank" rel="noopener noreferrer">{{ candidate.website }}</a>
            <dl><div><dt>整體</dt><dd>{{ candidate.featureData.scores?.overall ?? '—' }}</dd></div><div><dt>SEO</dt><dd>{{ candidate.featureData.scores?.seo ?? '—' }}</dd></div><div><dt>GEO</dt><dd>{{ candidate.featureData.scores?.geo ?? '—' }}</dd></div><div><dt>原始 HTML</dt><dd>{{ candidate.featureData.rawHtmlStored === false ? '未保存' : '—' }}</dd></div></dl>
            <p v-if="candidate.collectionErrorCode" class="error">{{ candidate.collectionErrorCode }}</p>
          </div>
          <form v-if="candidate.status === 'ready_for_review'" @submit.prevent="review(candidate, 'approved')">
            <label><span>九頭標籤 JSON（必須人工檢查）</span><textarea v-model="reviews[candidate.id]!.labels" spellcheck="false"></textarea></label>
            <label><span>審核理由</span><textarea v-model.trim="reviews[candidate.id]!.note" required minlength="16" maxlength="3000"></textarea></label>
            <label class="confirm"><input v-model="reviews[candidate.id]!.rightsConfirmed" type="checkbox"><span>我已確認這筆同意仍有效、公開網站使用權與標籤內容。</span></label>
            <div class="actions"><button type="submit" :disabled="busy === `approved:${candidate.id}`">核准進入資料池</button><button type="button" class="secondary" :disabled="busy === `rejected:${candidate.id}`" @click="review(candidate, 'rejected')">拒絕</button></div>
          </form>
          <div v-else class="candidate-result"><strong>{{ candidate.status === 'approved' ? '已成為受治理訓練候選' : candidate.status === 'revoked' ? '同意已撤回' : candidate.status === 'rejected' ? '已拒絕' : '等待下一次收集' }}</strong><small v-if="candidate.publicArtifactId">artifact #{{ candidate.publicArtifactId }}</small></div>
        </article>
      </section>

      <section class="runs"><p class="eyebrow">COLLECTION LEDGER</p><h2>最近執行紀錄</h2><div><article v-for="run in data.runs" :key="run.id"><span>#{{ run.id }} · {{ run.trigger }} · {{ run.status }}</span><strong>新增 {{ run.collectedCandidates }}</strong><small>檢查 {{ run.leadsExamined }}／重複 {{ run.duplicateCandidates }}／失敗 {{ run.failedCandidates }}</small></article></div></section>
    </template>
  </main>
</template>

<style scoped>
.pipeline{min-height:100vh;padding:clamp(7rem,12vw,10rem) max(1.25rem,calc((100vw - 78rem)/2));background:var(--paper);color:var(--ink)}.pipeline-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2rem;padding-bottom:3rem;border-bottom:1px solid var(--line)}.pipeline-head h1{margin:1rem 0;font-size:clamp(2.8rem,7vw,6.5rem);line-height:.94}.pipeline-head h1 em{color:var(--cobalt);font-style:normal}.pipeline-head p:last-child{max-width:48rem;color:var(--ink-mid);line-height:1.8}.pipeline-head nav{display:flex;gap:1rem;flex-wrap:wrap}.pipeline-head nav a{color:var(--cobalt);font:500 .68rem/1.4 var(--font-mono)}.state{margin-top:2rem;padding:2rem;border:1px solid var(--line);background:var(--sand)}button{border:0;background:var(--cobalt);color:white;padding:.85rem 1rem;cursor:pointer}button.secondary{background:transparent;color:var(--cobalt);border:1px solid var(--cobalt)}button:disabled{opacity:.45;cursor:wait}.controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr)) auto auto;gap:1rem;align-items:center;padding:2rem 0;border-bottom:1px solid var(--line)}.controls div{display:grid;gap:.35rem}.controls span,.controls small,.candidate small,.runs span,.runs small{font:500 .65rem/1.5 var(--font-mono);color:var(--ink-soft)}.controls strong{font-size:1.4rem}.notice{min-height:2rem;padding:1rem 0;color:var(--cobalt)}.readiness{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid var(--line)}.readiness article{display:grid;gap:.5rem;padding:1rem;border-right:1px solid var(--line)}.readiness article:last-child{border-right:0}.readiness span{font:500 .6rem/1.3 var(--font-mono)}.readiness strong{font-size:2rem;color:var(--cobalt)}.queue{margin-top:4rem}.queue>header{display:flex;justify-content:space-between;align-items:end;padding-bottom:1.5rem;border-bottom:1px solid var(--line)}.queue h2,.runs h2{font-size:clamp(2rem,5vw,4rem)}.candidate{display:grid;grid-template-columns:minmax(16rem,.7fr) minmax(0,1fr);gap:2rem;padding:2rem 0;border-bottom:1px solid var(--line)}.candidate h3{margin:.5rem 0;font-size:1.8rem}.candidate a{color:var(--cobalt);overflow-wrap:anywhere}.candidate dl{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin-top:1.5rem}.candidate dt{font:500 .6rem/1.3 var(--font-mono);color:var(--ink-soft)}.candidate dd{margin:.2rem 0;font-size:1.2rem}.candidate form{display:grid;gap:1rem}.candidate label{display:grid;gap:.4rem}.candidate label>span{font:500 .64rem/1.4 var(--font-mono)}.candidate textarea{min-height:7rem;padding:.8rem;border:1px solid var(--line);background:var(--sand);color:var(--ink);font:400 .75rem/1.5 var(--font-mono)}.candidate label:first-child textarea{min-height:18rem}.candidate .confirm{display:flex;grid-template-columns:auto 1fr;align-items:start}.actions{display:flex;gap:.7rem}.candidate-result{display:grid;place-content:center;gap:.5rem;padding:2rem;background:var(--sand)}.error{color:#a33}.runs{margin-top:5rem}.runs>div{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:1.5rem}.runs article{display:grid;gap:.5rem;padding:1rem;border:1px solid var(--line)}@media(max-width:60rem){.pipeline-head,.candidate{grid-template-columns:1fr}.controls{grid-template-columns:repeat(2,1fr)}.runs>div{grid-template-columns:1fr 1fr}}@media(max-width:40rem){.controls,.readiness,.runs>div{grid-template-columns:1fr}.readiness article{border-right:0;border-bottom:1px solid var(--line)}.candidate dl{grid-template-columns:1fr 1fr}}
.toolbar{display:flex;flex-wrap:wrap;gap:.8rem;margin:1rem 0}.toolbar label,.colab-form label{display:grid;gap:.35rem;font:500 .68rem/1.4 var(--font-mono)}.toolbar input,.toolbar select,.colab-form input,.colab-form select,.colab-form textarea{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid var(--line);background:#fff;color:var(--ink);font:inherit}.snapshot-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-top:1rem}.snapshot-list article{display:grid;gap:.45rem;padding:1rem;border:1px solid var(--line);background:#fff}.mono{font:500 .65rem/1.45 var(--font-mono);overflow-wrap:anywhere}.limitation{max-width:70rem;color:var(--ink-mid);line-height:1.7}.advanced pre{overflow:auto;white-space:pre-wrap}.colab-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-top:1.25rem}.colab-form .wide{grid-column:1/-1}.smoke-test{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:0;padding:1rem;border:1px solid var(--line)}.smoke-test legend{padding:0 .4rem;font:500 .68rem/1.4 var(--font-mono)}.smoke-heads{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}.smoke-heads>span{grid-column:1/-1;font:500 .68rem/1.4 var(--font-mono)}.colab-form .check{display:flex;align-items:center;gap:.5rem}.colab-form .check input{width:auto;padding:0}.colab-blockers{color:#a33;line-height:1.6}.colab-blockers ul{margin:.35rem 0 0;padding-left:1.2rem}@media(max-width:40rem){.snapshot-list,.colab-form,.smoke-test,.smoke-heads{grid-template-columns:1fr}}
</style>
