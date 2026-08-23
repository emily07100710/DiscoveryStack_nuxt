<script setup lang="ts">
type Workspace = {
  diagnoses: Array<{ id: number, status: string, diagnosisKind: string, createdAt: string, inputFingerprint: string }>
  evidenceApprovals: Array<{ id: number, sourceId: number, artifactId: number | null, allowedFor: string, status: string, approvedAt: string | null }>
  briefs: Array<{ id: number, title: string, contentType: string, language: string, status: string, createdAt: string }>
  jobs: Array<{ id: number, briefId: number, operation: string, status: string, requestedAt: string, completedAt: string | null }>
  targets: Array<{ id: number, displayName: string, adapter: string, targetOrigin: string, status: string, allowPublish: boolean, createdAt: string }>
  deliveryNotice: string
}

definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: 'SEO / GEO Core · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const { data: workspaceData, pending, error: workspaceError, refresh } = await useAsyncData('seo-geo-owner-workspace', () => $fetch<Workspace>('/api/seo-geo/workspace'), { server: false, default: () => ({ diagnoses: [], evidenceApprovals: [], briefs: [], jobs: [], targets: [], deliveryNotice: '' }) })
const workspace = computed(() => workspaceData.value!)
const actionState = ref<'idle' | 'saving'>('idle')
const actionNotice = ref('')
const actionError = ref('')

const approvalForm = reactive({ sourceId: '', artifactId: '', allowedFor: 'content_draft' as 'diagnosis' | 'recommendation' | 'content_draft', reviewNote: '' })
const diagnosisForm = reactive({ url: '', sourceId: '', auditRunId: '' })
const briefForm = reactive({ diagnosisId: '', title: '', audience: '', contentType: 'article', language: 'zh-hant' as 'en' | 'zh-hant', goals: '', constraints: '', sourceId: '', artifactId: '', locator: '', reason: '' })
const jobForm = reactive({ briefId: '', operation: 'autogeo_recommendation' as 'autogeo_recommendation' | 'content_draft' | 'risk_scan' | 'delivery_preview' | 'delivery_publish', providerMode: 'reference_rules' as 'reference_rules' | 'autogeo_bailian_qwen' | 'autogeo_api' | 'manual' })
const recommendationForm = reactive({ briefId: '', title: '', content: '', language: 'zh-hant' as 'en' | 'zh-hant' })
const reviewForm = reactive({ jobId: '', draftId: '', decision: 'approved_for_preview' as 'approved_for_preview' | 'approved_for_delivery' | 'changes_requested' | 'rejected', reviewNote: '' })
const targetForm = reactive({ displayName: '', adapter: 'manual_export' as 'manual_export' | 'wordpress_rest' | 'generic_http', targetOrigin: '' })
const previewForm = reactive({ jobId: '', draftId: '', targetId: '' })

const numberOrUndefined = (value: string) => value.trim() ? Number(value) : undefined
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() || `seo-geo-${Date.now()}-${Math.random().toString(36).slice(2)}`
const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'

async function post(route: string, body: object, successMessage: string) {
  actionState.value = 'saving'; actionNotice.value = ''; actionError.value = ''
  try {
    await $fetch(route, { method: 'POST', body })
    actionNotice.value = successMessage
    await refresh()
  } catch (error: any) {
    actionError.value = error?.data?.message || error?.statusMessage || '此操作未完成；沒有執行未核准的後續動作。'
  } finally {
    actionState.value = 'idle'
  }
}

function saveEvidenceApproval() {
  return post('/api/seo-geo/evidence-approvals', { sourceId: Number(approvalForm.sourceId), artifactId: numberOrUndefined(approvalForm.artifactId), allowedFor: approvalForm.allowedFor, reviewNote: approvalForm.reviewNote }, 'Evidence approval 已寫入；它僅限本次明確用途。')
}
function runDiagnosis() {
  return post('/api/seo-geo/diagnose', { url: diagnosisForm.url, sourceId: numberOrUndefined(diagnosisForm.sourceId), auditRunId: numberOrUndefined(diagnosisForm.auditRunId) }, 'Diagnosis 已建立。若尚無核准模型 artifact，結果會明確標示 deterministic 或 not-ready。')
}
function saveBrief() {
  return post('/api/seo-geo/briefs', {
    diagnosisId: numberOrUndefined(briefForm.diagnosisId), title: briefForm.title, audience: briefForm.audience, contentType: briefForm.contentType, language: briefForm.language,
    goals: lines(briefForm.goals), constraints: lines(briefForm.constraints),
    evidenceRefs: [{ sourceId: Number(briefForm.sourceId), artifactId: numberOrUndefined(briefForm.artifactId), locator: briefForm.locator || undefined, reason: briefForm.reason }],
  }, 'Content Brief 已建立；只有已被 content_draft 核准的 evidence 可以進入下一步。')
}
function createJob() {
  return post('/api/seo-geo/jobs', { briefId: Number(jobForm.briefId), operation: jobForm.operation, providerMode: jobForm.providerMode, idempotencyKey: idempotencyKey() }, 'Content job 已建立。候選稿必須先通過風險 gate 與人工 review。')
}
function runRecommendation() {
  return post('/api/seo-geo/recommend', { briefId: Number(recommendationForm.briefId), title: recommendationForm.title, content: recommendationForm.content, language: recommendationForm.language, idempotencyKey: idempotencyKey() }, 'AutoGEO 候選稿已處理並寫入草稿與風險 gate；它現在仍停在人工審核前，不會被發布。')
}
function submitReview() {
  return post('/api/seo-geo/reviews', { jobId: Number(reviewForm.jobId), draftId: Number(reviewForm.draftId), decision: reviewForm.decision, reviewNote: reviewForm.reviewNote || undefined }, '人工 review 已記錄。此動作不會發布內容。')
}
function registerTarget() {
  return post('/api/seo-geo/delivery-targets', targetForm, 'Delivery target 已登錄為 disabled；未保存、未回傳任何 CMS 憑證，也沒有啟用發布。')
}
function preparePreview() {
  return post('/api/seo-geo/delivery-preview', { jobId: Number(previewForm.jobId), draftId: Number(previewForm.draftId), targetId: Number(previewForm.targetId), idempotencyKey: idempotencyKey() }, 'Preview ledger 已準備。系統沒有對 WordPress、CMS 或 HTTP target 發送請求。')
}
</script>

<template>
  <main class="core-workbench">
    <header class="hero">
      <NuxtLink to="/audit-lab" class="back-link">← 返回私有稽核實驗室</NuxtLink>
      <p class="eyebrow">OWNER-ONLY · SEO / GEO CORE V1</p>
      <h1>從診斷到內容決策，<em>每一步都可追溯。</em></h1>
      <p>此工作台把 Diagnosis、AutoGEO Recommendation 與 Content Operations 連成同一條 evidence-bound 流程。它不宣稱排名、流量或轉換成效；V1 不會自動發布，也不儲存或顯示 CMS 憑證。</p>
    </header>

    <section class="guardrail" aria-label="V1 安全邊界"><strong>V1 強制邊界</strong><span>來源須先核准 → 草稿須通過風險檢查 → owner 人工 review → 僅可準備 preview ledger → 外部 delivery 一律 disabled。</span></section>
    <p v-if="actionNotice" class="notice" role="status">{{ actionNotice }}</p><p v-if="actionError || workspaceError" class="error" role="alert">{{ actionError || '無法讀取工作台；請確認 owner 工作階段與資料庫 migration 是否已依獨立變更流程套用。' }}</p>

    <section class="flow-grid">
      <article class="flow-card"><p>01 · DIAGNOSIS</p><strong>找出結構與 journey 訊號</strong><span>僅使用 deterministic baseline 或已核准模型；未就緒時不冒充模型預測。</span></article>
      <article class="flow-card"><p>02 · AUTOGEO</p><strong>產生受證據約束的候選</strong><span>沿用 source-bound guard；不支持的案例、成效與背書會被擋下。</span></article>
      <article class="flow-card"><p>03 · GEOFLOW CORE</p><strong>讓內容運營可治理</strong><span>版本、風險、人工 review 與 preview ledger 全部保留。</span></article>
    </section>

    <section class="panel"><div><p class="eyebrow">EVIDENCE APPROVAL</p><h2>先限定證據可用範圍</h2><p>這不是授權發布；它只是把既有已審核的 Public Intelligence source／artifact 明確核准給特定用途。</p></div><form @submit.prevent="saveEvidenceApproval"><label>已核准 Source ID<input v-model="approvalForm.sourceId" inputmode="numeric" required></label><label>Artifact ID（選填）<input v-model="approvalForm.artifactId" inputmode="numeric"></label><label>允許用途<select v-model="approvalForm.allowedFor"><option value="diagnosis">Diagnosis</option><option value="recommendation">Recommendation</option><option value="content_draft">Content draft</option></select></label><label class="wide">核准註記<textarea v-model.trim="approvalForm.reviewNote" required minlength="2" maxlength="1000" rows="3" placeholder="為何此 evidence 可用於此單一用途？"></textarea></label><button :disabled="actionState === 'saving'">記錄用途核准</button></form></section>

    <section class="panel"><div><p class="eyebrow">DIAGNOSIS</p><h2>建立可追溯診斷</h2><p>僅分析允許的公開網站結構；結果是改善線索，不是搜尋引擎、LLM 或營收預測。</p></div><form @submit.prevent="runDiagnosis"><label class="wide">公開 HTTPS URL<input v-model.trim="diagnosisForm.url" type="url" required placeholder="https://example.com"></label><label>Source ID（選填）<input v-model="diagnosisForm.sourceId" inputmode="numeric"></label><label>Audit run ID（選填）<input v-model="diagnosisForm.auditRunId" inputmode="numeric"></label><button :disabled="actionState === 'saving'">建立 Diagnosis</button></form></section>

    <section class="panel"><div><p class="eyebrow">CONTENT BRIEF</p><h2>把診斷變成可約束的任務</h2><p>至少一項 `content_draft` evidence approval 是必需條件。目標、限制與來源會被快照到 brief。</p></div><form @submit.prevent="saveBrief"><label>Diagnosis ID（選填）<input v-model="briefForm.diagnosisId" inputmode="numeric"></label><label>標題<input v-model.trim="briefForm.title" required minlength="3" maxlength="180"></label><label>受眾<input v-model.trim="briefForm.audience" required minlength="2" maxlength="500"></label><label>內容類型<select v-model="briefForm.contentType"><option value="article">Article</option><option value="service_page">Service page</option><option value="faq">FAQ</option><option value="landing_page">Landing page</option><option value="brief">Brief</option></select></label><label>語言<select v-model="briefForm.language"><option value="zh-hant">繁體中文</option><option value="en">English</option></select></label><label>Evidence source ID<input v-model="briefForm.sourceId" required inputmode="numeric"></label><label>Evidence artifact ID（選填）<input v-model="briefForm.artifactId" inputmode="numeric"></label><label class="wide">Evidence locator（選填）<input v-model.trim="briefForm.locator" maxlength="2048" placeholder="已核准 source／artifact 的定位資訊"></label><label class="wide">為何可引用此 evidence<textarea v-model.trim="briefForm.reason" required minlength="2" maxlength="1000" rows="2"></textarea></label><label>目標（每行一項）<textarea v-model.trim="briefForm.goals" required rows="4" placeholder="回答一個特定問題&#10;補上可驗證的定義"></textarea></label><label>限制（每行一項）<textarea v-model.trim="briefForm.constraints" required rows="4" placeholder="不得宣稱未支持的成效&#10;需繁體中文"></textarea></label><button :disabled="actionState === 'saving'">建立 Evidence-bound Brief</button></form></section>

    <section class="panel"><div><p class="eyebrow">AUTOGEO JOB</p><h2>建立可重試的內容工作</h2><p>Job 會有 idempotency key 與狀態機。它不是自動發布請求，候選稿仍需 risk gate 與人工 review。</p></div><form @submit.prevent="createJob"><label>Brief ID<input v-model="jobForm.briefId" required inputmode="numeric"></label><label>操作<select v-model="jobForm.operation"><option value="autogeo_recommendation">AutoGEO recommendation</option><option value="content_draft">Content draft</option><option value="risk_scan">Risk scan</option><option value="delivery_preview">Delivery preview</option><option value="delivery_publish">Delivery publish (disabled in V1)</option></select></label><label>Provider mode<select v-model="jobForm.providerMode"><option value="reference_rules">Reference rules</option><option value="autogeo_bailian_qwen">AutoGEO + Bailian Qwen</option><option value="autogeo_api">Official AutoGEO API</option><option value="manual">Manual</option></select></label><button :disabled="actionState === 'saving'">建立受控 Job</button></form></section>

    <section class="panel"><div><p class="eyebrow">AUTOGEO RECOMMENDATION</p><h2>執行一次受控候選生成</h2><p>此為 owner 明確請求的前景處理，不是背景 worker。候選稿會記錄 provider／fallback provenance、evidence snapshot 與 risk gate，最後一律進入人工 review。</p></div><form @submit.prevent="runRecommendation"><label>已核准 Brief ID<input v-model="recommendationForm.briefId" required inputmode="numeric"></label><label>原文標題<input v-model.trim="recommendationForm.title" required minlength="3" maxlength="180"></label><label>語言<select v-model="recommendationForm.language"><option value="zh-hant">繁體中文</option><option value="en">English</option></select></label><label class="wide">原文（僅用於本次 candidate；會以草稿版本與可稽核 fingerprint 保存，不會自動發佈）<textarea v-model.trim="recommendationForm.content" required minlength="40" maxlength="12000" rows="8"></textarea></label><button :disabled="actionState === 'saving'">產生並風險檢查候選稿</button></form></section>

    <section class="panel"><div><p class="eyebrow">HUMAN REVIEW</p><h2>明確記錄人工決定</h2><p>Blocked draft 不能被核准。核准 preview 不是發布許可；外部傳送仍完全關閉。</p></div><form @submit.prevent="submitReview"><label>Job ID<input v-model="reviewForm.jobId" required inputmode="numeric"></label><label>Draft ID<input v-model="reviewForm.draftId" required inputmode="numeric"></label><label>決定<select v-model="reviewForm.decision"><option value="approved_for_preview">核准 preview</option><option value="approved_for_delivery">核准 delivery（V1 仍不發布）</option><option value="changes_requested">要求修改</option><option value="rejected">拒絕</option></select></label><label class="wide">Review note（選填）<textarea v-model.trim="reviewForm.reviewNote" maxlength="1000" rows="2"></textarea></label><button :disabled="actionState === 'saving'">寫入人工 Review</button></form></section>

    <section class="panel"><div><p class="eyebrow">DELIVERY TARGET / PREVIEW</p><h2>登錄目標，但不啟用發布</h2><p>只接受 public HTTPS origin 與不含憑證的 adapter metadata。V1 preview 僅寫入 ledger，不會送出 CMS、WordPress 或 HTTP request。</p></div><form @submit.prevent="registerTarget"><label>顯示名稱<input v-model.trim="targetForm.displayName" required maxlength="120"></label><label>Adapter<select v-model="targetForm.adapter"><option value="manual_export">Manual export</option><option value="wordpress_rest">WordPress REST</option><option value="generic_http">Generic HTTP</option></select></label><label>HTTPS origin<input v-model.trim="targetForm.targetOrigin" type="url" required placeholder="https://cms.example.com"></label><button :disabled="actionState === 'saving'">登錄為 disabled target</button></form><form class="subform" @submit.prevent="preparePreview"><label>已核准 Job ID<input v-model="previewForm.jobId" required inputmode="numeric"></label><label>非 blocked Draft ID<input v-model="previewForm.draftId" required inputmode="numeric"></label><label>Disabled Target ID<input v-model="previewForm.targetId" required inputmode="numeric"></label><button :disabled="actionState === 'saving'">準備零寫入 Preview</button></form></section>

    <section class="workspace" aria-live="polite"><header><div><p class="eyebrow">OWNER WORKSPACE</p><h2>目前可稽核的紀錄</h2></div><button class="quiet" type="button" :disabled="pending" @click="refresh">{{ pending ? '更新中…' : '重新整理' }}</button></header><p class="delivery-notice">{{ workspace.deliveryNotice }}</p><div class="ledger-grid"><article><h3>Diagnoses</h3><ol><li v-for="entry in workspace.diagnoses" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.diagnosisKind }} · {{ entry.status }}</span><small>{{ formatDate(entry.createdAt) }}</small></li><li v-if="!workspace.diagnoses.length">尚無紀錄</li></ol></article><article><h3>Evidence approvals</h3><ol><li v-for="entry in workspace.evidenceApprovals" :key="entry.id"><strong>#{{ entry.id }}</strong><span>source {{ entry.sourceId }} · {{ entry.allowedFor }}</span><small>artifact {{ entry.artifactId ?? '—' }} · {{ entry.status }}</small></li><li v-if="!workspace.evidenceApprovals.length">尚無紀錄</li></ol></article><article><h3>Content briefs</h3><ol><li v-for="entry in workspace.briefs" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.title }}</span><small>{{ entry.contentType }} · {{ entry.status }}</small></li><li v-if="!workspace.briefs.length">尚無紀錄</li></ol></article><article><h3>Content jobs</h3><ol><li v-for="entry in workspace.jobs" :key="entry.id"><strong>#{{ entry.id }}</strong><span>brief {{ entry.briefId }} · {{ entry.operation }}</span><small>{{ entry.status }} · {{ formatDate(entry.requestedAt) }}</small></li><li v-if="!workspace.jobs.length">尚無紀錄</li></ol></article><article><h3>Disabled targets</h3><ol><li v-for="entry in workspace.targets" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.displayName }} · {{ entry.adapter }}</span><small>{{ entry.status }} · publish {{ entry.allowPublish ? 'enabled' : 'disabled' }}</small></li><li v-if="!workspace.targets.length">尚無紀錄</li></ol></article></div></section>
  </main>
</template>

<style scoped>
.core-workbench{--ink:#15251f;--moss:#235b49;--paper:#f7f6ef;--line:#cad6ce;max-width:1180px;margin:0 auto;padding:3.5rem 1.5rem 6rem;color:var(--ink)}.hero{max-width:830px}.back-link{color:var(--moss);font-weight:750;text-decoration:none}.eyebrow{margin:1rem 0 .45rem;color:var(--moss);font-size:.72rem;font-weight:850;letter-spacing:.12em}.hero h1{max-width:760px;margin:.25rem 0 1rem;font-size:clamp(2.8rem,6vw,5.5rem);line-height:.92;letter-spacing:-.07em}.hero h1 em{color:var(--moss);font-family:Georgia,serif;font-weight:400}.hero>p:last-child{max-width:720px;font-size:1.08rem;line-height:1.7}.guardrail,.notice,.error{margin:2rem 0;padding:1rem 1.15rem;border-left:4px solid #a57422;background:#fff8e8}.guardrail{display:grid;gap:.35rem;border-color:var(--moss);background:#edf6f0}.notice{border-color:#287447;background:#eff8ef}.error{border-color:#a43d32;color:#7d211b}.flow-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin:2rem 0}.flow-card{min-height:150px;padding:1.2rem;border:1px solid var(--line);background:#fff}.flow-card p{margin:0 0 1rem;color:var(--moss);font-size:.72rem;font-weight:850}.flow-card strong,.flow-card span{display:block}.flow-card strong{font-size:1.15rem}.flow-card span{margin-top:.7rem;line-height:1.55}.panel{display:grid;grid-template-columns:minmax(210px,.7fr) minmax(0,1.5fr);gap:2rem;margin-top:1rem;padding:1.5rem;border:1px solid var(--line);background:var(--paper)}.panel h2,.workspace h2{margin:.25rem 0 .7rem;font-size:1.45rem}.panel>div>p:not(.eyebrow){margin:0;line-height:1.6}form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem;align-content:start}label{display:grid;gap:.38rem;font-size:.78rem;font-weight:800}input,select,textarea{box-sizing:border-box;width:100%;border:1px solid #aebcae;border-radius:4px;background:#fff;color:var(--ink);font:inherit;font-size:.92rem;padding:.68rem}textarea{resize:vertical;line-height:1.45}.wide{grid-column:1/-1}button{width:max-content;border:0;border-radius:3px;background:var(--moss);color:#fff;cursor:pointer;font:inherit;font-weight:800;padding:.72rem 1rem}button:disabled{cursor:wait;opacity:.6}.subform{grid-column:1/-1;margin-top:1rem;padding-top:1rem;border-top:1px dashed var(--line)}.workspace{margin-top:1rem;padding:1.5rem;border:1px solid var(--line);background:#fff}.workspace header{display:flex;justify-content:space-between;gap:1rem;align-items:center}.workspace .eyebrow{margin-top:0}.quiet{border:1px solid var(--moss);background:#fff;color:var(--moss)}.delivery-notice{padding:.8rem;border-left:3px solid #b6862f;background:#fff8e9;line-height:1.5}.ledger-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.ledger-grid article{border-top:1px solid var(--line)}.ledger-grid h3{margin-bottom:.5rem}.ledger-grid ol{margin:0;padding:0;list-style:none}.ledger-grid li{display:grid;gap:.2rem;padding:.7rem 0;border-top:1px solid #e2e8e3;font-size:.84rem}.ledger-grid li:first-child{border-top:0}.ledger-grid span{font-weight:700}.ledger-grid small{color:#64736c}@media(max-width:780px){.core-workbench{padding:2.25rem 1rem 4rem}.flow-grid,.panel,.ledger-grid,form{grid-template-columns:1fr}.panel{gap:1rem}.hero h1{font-size:clamp(2.7rem,14vw,4rem)}.workspace header{align-items:flex-start;flex-direction:column}}
</style>
