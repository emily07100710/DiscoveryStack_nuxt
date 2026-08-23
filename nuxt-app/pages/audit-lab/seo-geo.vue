<script setup lang="ts">
type Workspace = {
  diagnoses: Array<{ id: number, status: string, diagnosisKind: string, createdAt: string, inputFingerprint: string }>
  evidenceApprovals: Array<{ id: number, sourceId: number, artifactId: number | null, allowedFor: string, status: string, approvedAt: string | null }>
  strategies: Array<{ id: number, diagnosisId: number, issueCode: string, recommendationKey: string, priority: string, status: string, ruleIds: unknown, contentOpportunities: unknown, createdAt: string }>
  plans: Array<{ id: number, diagnosisId: number | null, title: string, language: string, status: string, evidenceSnapshotHash: string, createdAt: string }>
  deliverables: Array<{ id: number, planId: number, title: string, contentType: string, status: string, briefId: number | null, jobId: number | null, createdAt: string }>
  briefs: Array<{ id: number, title: string, contentType: string, language: string, status: string, productionPlanId: number | null, productionDeliverableId: number | null, createdAt: string }>
  jobs: Array<{ id: number, briefId: number, productionPlanId: number | null, productionDeliverableId: number | null, operation: string, status: string, requestedAt: string, completedAt: string | null }>
  targets: Array<{ id: number, displayName: string, adapter: string, targetOrigin: string, status: string, allowPublish: boolean, createdAt: string }>
  deliveryNotice: string
}

definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: 'SEO / GEO Core · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const { data: workspaceData, pending, error: workspaceError, refresh } = await useAsyncData('seo-geo-owner-workspace', () => $fetch<Workspace>('/api/seo-geo/workspace'), { server: false, default: () => ({ diagnoses: [], evidenceApprovals: [], strategies: [], plans: [], deliverables: [], briefs: [], jobs: [], targets: [], deliveryNotice: '' }) })
const workspace = computed(() => workspaceData.value!)
const actionState = ref<'idle' | 'saving'>('idle')
const guided = reactive({ homepageUrl: '', sourceId: '', diagnosisId: '', selectedStrategyIds: [] as number[], planId: '', planTitle: '', language: 'zh-hant' as 'en' | 'zh-hant' })
type GuidedStrategy = { id: number, diagnosisId: number, issueCode: string, recommendationKey: string, priority: string, rationale: string, recommendedActions: string[], ruleIds: string[], rules: Array<{ id: string, title: string, instruction: string, rationale: string, priority: string }>, contentOpportunities: Array<{ key: string, deliverableType: string, title: string, audience: string, goals: string[], constraints: string[] }> }
type GuidedDeliverable = { id: number, title: string, contentType: string, audience?: string, status: string, brief?: any, job?: any, baseDraft?: any, optimizedDraft?: any, riskGate?: any, reviews?: any[], previews?: any[], eligibility?: { canReview: boolean, canPreview: boolean, canExport: boolean } }
type GuidedPlanDetail = { plan: { id: number, status: string, title?: string, language?: string }, diagnosis: { result?: { summary?: string, findings?: any[], limitations?: string[] }, status?: string } | null, strategies: GuidedStrategy[], deliverables: GuidedDeliverable[], previewTargets?: Array<{ id: number, displayName: string, adapter: string, targetOrigin: string }>, eligibility?: { canExport: boolean, allApproved: boolean }, deliveryNotice?: string }
const guidedDiagnosis = ref<{ id: number, status: string, result: { summary: string, findings: any[], limitations: string[], measurementNotice: string } } | null>(null)
const guidedStrategies = ref<GuidedStrategy[]>([])
const guidedPlan = ref<GuidedPlanDetail | null>(null)
const guidedTargetId = ref('')
const guidedSources = computed(() => [...new Set(workspace.value.evidenceApprovals.filter(entry => entry.status === 'approved' && entry.allowedFor === 'diagnosis').map(entry => entry.sourceId))])
const guidedEvidenceReady = computed(() => {
  if (!guided.sourceId) return false
  const sourceApprovals = workspace.value.evidenceApprovals.filter(entry => entry.status === 'approved' && entry.sourceId === Number(guided.sourceId) && entry.artifactId)
  const recommendationArtifacts = new Set(sourceApprovals.filter(entry => entry.allowedFor === 'recommendation').map(entry => entry.artifactId))
  return sourceApprovals.some(entry => entry.allowedFor === 'content_draft' && recommendationArtifacts.has(entry.artifactId))
})
const actionNotice = ref('')
const actionError = ref('')

const approvalForm = reactive({ sourceId: '', artifactId: '', allowedFor: 'content_draft' as 'diagnosis' | 'recommendation' | 'content_draft', reviewNote: '' })
const diagnosisForm = reactive({ url: '', sourceId: '', auditRunId: '' })
const briefForm = reactive({ title: '', audience: '', contentType: 'article', language: 'zh-hant' as 'en' | 'zh-hant', goals: '', constraints: '', sourceId: '', artifactId: '', locator: '', reason: '' })
const jobForm = reactive({ briefId: '', operation: 'content_draft' as 'autogeo_recommendation' | 'content_draft' | 'risk_scan' | 'delivery_preview' | 'delivery_publish', providerMode: 'reference_rules' as 'reference_rules' | 'autogeo_bailian_qwen' | 'autogeo_api' | 'manual' })
const recommendationForm = reactive({ briefId: '', jobId: '', idempotencyKey: '', title: '', content: '', language: 'zh-hant' as 'en' | 'zh-hant' })
const reviewForm = reactive({ jobId: '', draftId: '', decision: 'approved_for_preview' as 'approved_for_preview' | 'approved_for_delivery' | 'changes_requested' | 'rejected', reviewNote: '' })
const targetForm = reactive({ displayName: '', adapter: 'manual_export' as 'manual_export' | 'wordpress_rest' | 'generic_http', targetOrigin: '' })
const previewForm = reactive({ jobId: '', draftId: '', targetId: '' })

const numberOrUndefined = (value: string) => value.trim() ? Number(value) : undefined
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() || `seo-geo-${Date.now()}-${Math.random().toString(36).slice(2)}`
const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean)
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'

async function post<T = unknown>(route: string, body: object, successMessage: string): Promise<T | undefined> {
  actionState.value = 'saving'; actionNotice.value = ''; actionError.value = ''
  try {
    const result = await $fetch<T>(route, { method: 'POST', body })
    actionNotice.value = successMessage
    await refresh()
    return result as T
  } catch (error: any) {
    actionError.value = error?.data?.message || error?.statusMessage || '此操作未完成；沒有執行未核准的後續動作。'
    return undefined
  } finally {
    actionState.value = 'idle'
  }
}

function saveEvidenceApproval() {
  return post('/api/seo-geo/evidence-approvals', { sourceId: Number(approvalForm.sourceId), artifactId: numberOrUndefined(approvalForm.artifactId), allowedFor: approvalForm.allowedFor, reviewNote: approvalForm.reviewNote }, 'Evidence approval 已寫入；它僅限本次明確用途。')
}
function runDiagnosis() {
  return post('/api/seo-geo/diagnose', { homepageUrl: diagnosisForm.url, sourceId: numberOrUndefined(diagnosisForm.sourceId), auditRunId: numberOrUndefined(diagnosisForm.auditRunId) }, 'Diagnosis 已建立。若尚無核准模型 artifact，結果會明確標示 deterministic 或 not-ready。')
}
async function guidedDiagnose() {
  const result = await post<{ diagnosisId: number, diagnosis: { status: string, summary: string, findings: any[], limitations: string[], measurementNotice: string }, strategyRecommendations: Array<{ id: number, diagnosisId: number, issueCode: string, recommendationKey: string, priority: string, rationale: string, recommendedActions: string[], ruleIds: unknown, rules: unknown, contentOpportunities: unknown[] }> }>('/api/seo-geo/diagnose', { homepageUrl: guided.homepageUrl, sourceId: numberOrUndefined(guided.sourceId) }, 'Step 1 完成：Diagnosis 與可選 Strategy recommendations 已建立。')
  if (result) {
    guided.diagnosisId = String(result.diagnosisId)
    guidedDiagnosis.value = { id: result.diagnosisId, status: result.diagnosis.status, result: result.diagnosis }
    guidedStrategies.value = result.strategyRecommendations.map(strategy => {
      const rules = Array.isArray(strategy.rules) ? strategy.rules.filter((rule): rule is Record<string, unknown> => Boolean(rule && typeof rule === 'object')).map(rule => ({ id: String(rule.id || ''), title: String(rule.title || ''), instruction: String(rule.instruction || ''), rationale: String(rule.rationale || ''), priority: String(rule.priority || 'medium') })).filter(rule => rule.id && rule.title) : []
      const contentOpportunities = Array.isArray(strategy.contentOpportunities) ? strategy.contentOpportunities.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')).map(item => ({ key: String(item.key || ''), deliverableType: String(item.deliverableType || ''), title: String(item.title || ''), audience: String(item.audience || ''), goals: Array.isArray(item.goals) ? item.goals.filter((goal): goal is string => typeof goal === 'string') : [], constraints: Array.isArray(item.constraints) ? item.constraints.filter((constraint): constraint is string => typeof constraint === 'string') : [] })).filter(item => item.key && item.title) : []
      return { ...strategy, recommendedActions: Array.isArray(strategy.recommendedActions) ? strategy.recommendedActions : [], ruleIds: Array.isArray(strategy.ruleIds) ? strategy.ruleIds.filter((item): item is string => typeof item === 'string') : [], rules, contentOpportunities }
    })
    guided.selectedStrategyIds = []
    guided.planId = ''
    guidedPlan.value = null
  }
}
async function guidedCreatePlan() {
  if (!guided.diagnosisId || !guided.selectedStrategyIds.length) return
  if (!guidedEvidenceReady.value) {
    actionError.value = '請先在 owner workspace 核准同一來源的 recommendation 與 content_draft artifact，才能建立 Production Plan。'
    return
  }
  const result = await post<{ plan: { id: number, status: string }, detail: GuidedPlanDetail }>('/api/seo-geo/production-plans', { diagnosisId: Number(guided.diagnosisId), strategyRecommendationIds: guided.selectedStrategyIds, title: guided.planTitle.trim() || `SEO/GEO production plan · ${guidedStrategies.value[0]?.recommendationKey || 'selected strategy'}`, language: guided.language, idempotencyKey: idempotencyKey() }, 'Step 2 完成：Production Plan 與 bounded deliverables 已建立。')
  if (result) {
    guided.planId = String(result.plan.id)
    guidedPlan.value = result.detail
    guidedTargetId.value = String(result.detail.previewTargets?.[0]?.id || '')
  }
}
async function guidedGeneratePlan() {
  if (!guided.planId) return
  const result = await post<{ detail: GuidedPlanDetail }>(`/api/seo-geo/production-plans/${guided.planId}/generate`, {}, 'Step 3 已完成 base draft、selected-rule optimization 與 risk gate；現在請逐項人工 review。')
  if (result?.detail) { guidedPlan.value = result.detail; guidedTargetId.value = String(result.detail.previewTargets?.[0]?.id || '') }
}
function saveBrief() {
  return post('/api/seo-geo/briefs', {
    title: briefForm.title, audience: briefForm.audience, contentType: briefForm.contentType, language: briefForm.language,
    goals: lines(briefForm.goals), constraints: lines(briefForm.constraints),
    evidenceRefs: [{ sourceId: Number(briefForm.sourceId), artifactId: numberOrUndefined(briefForm.artifactId), locator: briefForm.locator || undefined, reason: briefForm.reason }],
  }, 'Content Brief 已建立；只有已被 content_draft 核准的 evidence 可以進入下一步。')
}
async function refreshGuidedPlan() {
  if (!guided.planId) return
  try { guidedPlan.value = await $fetch<GuidedPlanDetail>(`/api/seo-geo/production-plans/${guided.planId}`); guidedTargetId.value ||= String(guidedPlan.value.previewTargets?.[0]?.id || '') } catch (error: any) { actionError.value = error?.data?.message || error?.statusMessage || '無法讀取 Production Plan detail。' }
}
async function guidedReview(deliverable: GuidedDeliverable, decision: 'approved_for_preview' | 'approved_for_delivery' | 'changes_requested' | 'rejected') {
  if (!deliverable.job?.id || !deliverable.optimizedDraft?.id) return
  const result = await post<{ plan?: GuidedPlanDetail }>('/api/seo-geo/reviews', { jobId: deliverable.job.id, draftId: deliverable.optimizedDraft.id, decision, reviewNote: decision === 'changes_requested' ? 'Owner requested changes from guided review.' : 'Owner reviewed the evidence-bound optimized draft.' }, 'Owner review 已記錄，未發出外部寫入。')
  if (result?.plan) guidedPlan.value = result.plan
  else await refreshGuidedPlan()
}
async function guidedPreview(deliverable: GuidedDeliverable) {
  if (!deliverable.job?.id || !deliverable.optimizedDraft?.id || !guidedTargetId.value) { actionError.value = '請先在進階操作登錄一個 disabled preview target，並由 guided flow 選取。'; return }
  const result = await post<{ plan?: GuidedPlanDetail }>('/api/seo-geo/delivery-preview', { jobId: deliverable.job.id, draftId: deliverable.optimizedDraft.id, targetId: Number(guidedTargetId.value), idempotencyKey: idempotencyKey() }, 'Preview ledger 已準備；系統沒有對外部 target 發送請求。')
  if (result?.plan) guidedPlan.value = result.plan
  else await refreshGuidedPlan()
}
function guidedExportUrl(deliverable: GuidedDeliverable, format: 'markdown' | 'json') {
  return guided.planId && deliverable.id ? `/api/seo-geo/production-plans/${guided.planId}/export/${deliverable.id}?format=${format}` : '#'
}
async function createJob() {
  const jobKey = idempotencyKey()
  const created = await post<{ id: number }>('/api/seo-geo/jobs', { briefId: Number(jobForm.briefId), operation: jobForm.operation, providerMode: jobForm.providerMode, idempotencyKey: jobKey }, 'Content job 已建立。候選稿必須先通過風險 gate 與人工 review。')
  if (created?.id) {
    recommendationForm.briefId = jobForm.briefId
    recommendationForm.jobId = String(created.id)
    recommendationForm.idempotencyKey = jobKey
  }
}
function runRecommendation() {
  return post('/api/seo-geo/recommend', { briefId: Number(recommendationForm.briefId), jobId: numberOrUndefined(recommendationForm.jobId), title: recommendationForm.title, content: recommendationForm.content, language: recommendationForm.language, idempotencyKey: recommendationForm.idempotencyKey || idempotencyKey() }, 'AutoGEO 候選稿已處理並寫入草稿與風險 gate；它現在仍停在人工審核前，不會被發布。')
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

    <section class="guided-flow" aria-label="三步 SEO GEO guided flow">
      <header><p class="eyebrow">GUIDED FLOW · OWNER ONLY</p><h2>三步把公開訊號變成可治理的內容計畫</h2><p>主要流程不要求你手動輸入資料庫 ID。每一步都會從上一個步驟的 server-owned record 繼續，並在下一步前檢查 owner、evidence snapshot、rule version 與 status。</p></header>
      <article class="guided-step"><div class="step-marker">01</div><div><h3>Diagnosis</h3><p>輸入一個公開 HTTPS homepage；系統只做 deterministic structural analysis，並自動保存可選 Strategy recommendations。</p><form @submit.prevent="guidedDiagnose"><label class="wide">公開 HTTPS homepage<input v-model.trim="guided.homepageUrl" type="url" required placeholder="https://example.com"></label><label>Diagnosis evidence source（選填）<select v-model="guided.sourceId"><option value="">只做 homepage baseline</option><option v-for="sourceId in guidedSources" :key="sourceId" :value="String(sourceId)">已核准來源 {{ sourceId }}</option></select></label><p v-if="!guidedSources.length" class="inline-hint">若要進入內容計畫，請先在進階操作中完成同一來源的 diagnosis、recommendation 與 content_draft approval。</p><button :disabled="actionState === 'saving'">分析並建立 Strategy 選項</button></form><section v-if="guidedDiagnosis" class="guided-diagnosis"><strong>{{ guidedDiagnosis.status }} · {{ guidedDiagnosis.result.summary }}</strong><p>Scope URL：{{ guided.homepageUrl }}</p><p>{{ guidedDiagnosis.result.measurementNotice }}</p><ul><li v-for="finding in guidedDiagnosis.result.findings" :key="finding.id"><strong>{{ finding.title }}</strong><span>{{ finding.area }} · {{ finding.severity }} · {{ finding.priority }}</span><small>{{ finding.explanation }}</small><small>Affected URLs：{{ finding.affectedUrls?.join('、') || '—' }}</small><small>Evidence：{{ finding.evidence?.length || 0 }} 項；限制：{{ finding.limitations?.join('；') || '—' }}</small></li></ul><p class="inline-hint">Diagnosis limitations：{{ guidedDiagnosis.result.limitations.join('；') || '—' }}</p></section></div></article>
      <article class="guided-step"><div class="step-marker">02</div><div><h3>Strategy → Production Plan</h3><p v-if="guidedStrategies.length">請選擇要排程的改善方向（最多 10 項）。系統不會自動全選。</p><p v-if="guidedStrategies.length" class="inline-hint">Rules provenance：DiscoveryStack 自建 deterministic AutoGEO-compatible catalog；不是從官方 AutoGEO upstream extracted 的規則，也不代表排名或成效。</p><p v-else>完成 Step 1 後，這裡會顯示由 finding 對應出的 rules、actions 與 content opportunities。</p><p v-if="guidedStrategies.length && !guidedEvidenceReady" class="inline-hint">目前只有 baseline strategy；需要同一來源的 recommendation 與 content_draft approved artifact，才能建立 content plan。</p><div v-if="guidedStrategies.length" class="strategy-options"><label v-for="strategy in guidedStrategies" :key="strategy.id" class="strategy-option"><input v-model="guided.selectedStrategyIds" type="checkbox" :value="strategy.id"><span><strong>{{ strategy.issueCode }} · {{ strategy.priority }}</strong><small>{{ strategy.recommendationKey }} · {{ strategy.rationale }}</small><small v-if="strategy.recommendedActions.length">Actions：{{ strategy.recommendedActions.join('；') }}</small><small>Canonical rules：</small><span v-for="rule in strategy.rules" :key="rule.id" class="rule-detail"><b>{{ rule.title }}</b><small>{{ rule.instruction }} {{ rule.rationale }}</small></span><small v-for="opportunity in strategy.contentOpportunities" :key="opportunity.key" class="opportunity-detail">{{ opportunity.deliverableType }} · {{ opportunity.title }} · {{ opportunity.audience }} · goals：{{ opportunity.goals.join('；') }} · constraints：{{ opportunity.constraints.join('；') }}</small></span></label></div><form v-if="guidedStrategies.length" @submit.prevent="guidedCreatePlan"><label>Plan 名稱（選填）<input v-model.trim="guided.planTitle" maxlength="300" placeholder="依選取策略自動命名"></label><label>內容語言<select v-model="guided.language"><option value="zh-hant">繁體中文</option><option value="en">English</option></select></label><button :disabled="actionState === 'saving' || !guided.selectedStrategyIds.length || !guidedEvidenceReady">建立 Production Plan</button></form></div></article>
      <article class="guided-step"><div class="step-marker">03</div><div><h3>Base draft → AutoGEO optimization → owner review</h3><p v-if="guidedPlan">{{ guidedPlan.plan.title || 'Production Plan' }} · {{ guidedPlan.plan.status }} · {{ guidedPlan.deliverables.length }} 個 bounded deliverables。系統會先用 reviewed evidence 產生完整 base draft，再只套用選定 canonical rules 優化；兩階段都須通過 risk gate。</p><p v-else>完成 Step 2 後，這裡會顯示 bounded deliverables 與生成狀態。</p><button v-if="guidedPlan && !guidedPlan.deliverables.some(item => item.baseDraft || item.optimizedDraft)" :disabled="actionState === 'saving' || ['completed', 'blocked'].includes(guidedPlan.plan.status)" @click="guidedGeneratePlan">建立 Brief、產生 base draft 並進入人工 review</button><div v-if="guidedPlan?.previewTargets?.length" class="guided-target"><label>Preview target<select v-model="guidedTargetId"><option v-for="target in guidedPlan.previewTargets" :key="target.id" :value="String(target.id)">{{ target.displayName }} · {{ target.adapter }} · {{ target.targetOrigin }}</option></select></label></div><ol v-if="guidedPlan?.deliverables.length" class="deliverable-list"><li v-for="deliverable in guidedPlan.deliverables" :key="deliverable.id"><strong>{{ deliverable.title }}</strong><span>{{ deliverable.status }}</span><div v-if="deliverable.brief" class="draft-meta">Audience：{{ deliverable.brief.audience }} · goals：{{ deliverable.brief.goals?.join('；') }} · constraints：{{ deliverable.brief.constraints?.join('；') }}</div><div v-if="deliverable.baseDraft" class="draft-card"><b>Base draft · {{ deliverable.baseDraft.provenance?.generationMode || 'draft' }}</b><p>{{ deliverable.baseDraft.title }}</p><pre>{{ deliverable.baseDraft.body }}</pre></div><div v-if="deliverable.optimizedDraft" class="draft-card"><b>Optimized draft · selected rules {{ deliverable.optimizedDraft.provenance?.selectedRuleIds?.join(', ') || '—' }}</b><p>{{ deliverable.optimizedDraft.title }}</p><pre>{{ deliverable.optimizedDraft.body }}</pre></div><div v-if="deliverable.riskGate" class="risk-card"><b>Risk gate：{{ deliverable.riskGate.status }}</b><span v-for="finding in deliverable.riskGate.findings" :key="finding.id">{{ finding.severity }} · {{ finding.message }}</span></div><div class="guided-actions"><button v-if="deliverable.eligibility?.canReview" :disabled="actionState === 'saving'" @click="guidedReview(deliverable, 'approved_for_preview')">核准 preview</button><button v-if="deliverable.eligibility?.canReview" :disabled="actionState === 'saving'" @click="guidedReview(deliverable, 'approved_for_delivery')">核准 export</button><button v-if="deliverable.eligibility?.canReview" class="quiet" :disabled="actionState === 'saving'" @click="guidedReview(deliverable, 'changes_requested')">要求修改</button><button v-if="deliverable.eligibility?.canPreview" class="quiet" :disabled="actionState === 'saving'" @click="guidedPreview(deliverable)">準備 preview</button><a v-if="deliverable.eligibility?.canExport" class="button-link" :href="guidedExportUrl(deliverable, 'markdown')">下載 Markdown</a><a v-if="deliverable.eligibility?.canExport" class="button-link" :href="guidedExportUrl(deliverable, 'json')">下載 JSON</a></div></li></ol><p v-if="guidedPlan?.deliveryNotice" class="inline-hint">{{ guidedPlan.deliveryNotice }}</p></div></article>
    </section>

    <details class="advanced-operations"><summary>進階單筆操作（需要 technical IDs；主要 guided flow 不使用此區）</summary>
    <section class="panel"><div><p class="eyebrow">EVIDENCE APPROVAL</p><h2>先限定證據可用範圍</h2><p>這不是授權發布；它只是把既有已審核的 Public Intelligence source／artifact 明確核准給特定用途。</p></div><form @submit.prevent="saveEvidenceApproval"><label>已核准 Source ID<input v-model="approvalForm.sourceId" inputmode="numeric" required></label><label>Artifact ID（content draft 必填）<input v-model="approvalForm.artifactId" inputmode="numeric" :required="approvalForm.allowedFor === 'content_draft'"></label><label>允許用途<select v-model="approvalForm.allowedFor"><option value="diagnosis">Diagnosis</option><option value="recommendation">Recommendation</option><option value="content_draft">Content draft</option></select></label><label class="wide">核准註記<textarea v-model.trim="approvalForm.reviewNote" required minlength="2" maxlength="1000" rows="3" placeholder="為何此 evidence 可用於此單一用途？"></textarea></label><button :disabled="actionState === 'saving'">記錄用途核准</button></form></section>

    <section class="panel"><div><p class="eyebrow">DIAGNOSIS</p><h2>建立可追溯診斷</h2><p>僅分析允許的公開網站結構；結果是改善線索，不是搜尋引擎、LLM 或營收預測。</p></div><form @submit.prevent="runDiagnosis"><label class="wide">公開 HTTPS URL<input v-model.trim="diagnosisForm.url" type="url" required placeholder="https://example.com"></label><label>Source ID（選填）<input v-model="diagnosisForm.sourceId" inputmode="numeric"></label><label>Audit run ID（選填）<input v-model="diagnosisForm.auditRunId" inputmode="numeric"></label><button :disabled="actionState === 'saving'">建立 Diagnosis</button></form></section>

    <section class="panel"><div><p class="eyebrow">CONTENT BRIEF</p><h2>把診斷變成可約束的任務</h2><p>至少一項 `content_draft` evidence approval 是必需條件。目標、限制與來源會被快照到 brief。</p></div><form @submit.prevent="saveBrief"><label>標題<input v-model.trim="briefForm.title" required minlength="3" maxlength="180"></label><label>受眾<input v-model.trim="briefForm.audience" required minlength="2" maxlength="500"></label><label>內容類型<select v-model="briefForm.contentType"><option value="article">Article</option><option value="service_page">Service page</option><option value="faq">FAQ</option><option value="landing_page">Landing page</option><option value="brief">Brief</option></select></label><label>語言<select v-model="briefForm.language"><option value="zh-hant">繁體中文</option><option value="en">English</option></select></label><label>Evidence source ID<input v-model="briefForm.sourceId" required inputmode="numeric"></label><label>Evidence artifact ID（必填）<input v-model="briefForm.artifactId" inputmode="numeric" required></label><label class="wide">Evidence locator（選填）<input v-model.trim="briefForm.locator" maxlength="2048" placeholder="已核准 source／artifact 的定位資訊"></label><label class="wide">為何可引用此 evidence<textarea v-model.trim="briefForm.reason" required minlength="2" maxlength="1000" rows="2"></textarea></label><label>目標（每行一項）<textarea v-model.trim="briefForm.goals" required rows="4" placeholder="回答一個特定問題&#10;補上可驗證的定義"></textarea></label><label>限制（每行一項）<textarea v-model.trim="briefForm.constraints" required rows="4" placeholder="不得宣稱未支持的成效&#10;需繁體中文"></textarea></label><button :disabled="actionState === 'saving'">建立 Evidence-bound Brief</button></form></section>

    <section class="panel"><div><p class="eyebrow">AUTOGEO JOB</p><h2>建立可重試的內容工作</h2><p>Job 會有 idempotency key 與狀態機。它不是自動發布請求，候選稿仍需 risk gate 與人工 review。</p></div><form @submit.prevent="createJob"><label>Brief ID<input v-model="jobForm.briefId" required inputmode="numeric"></label><label>操作<select v-model="jobForm.operation"><option value="content_draft">Content draft</option><option value="risk_scan">Risk scan</option><option value="delivery_preview">Delivery preview</option><option value="delivery_publish">Delivery publish (disabled in V1)</option></select></label><label>Provider mode<select v-model="jobForm.providerMode"><option value="reference_rules">Reference rules</option><option value="autogeo_bailian_qwen">AutoGEO + Bailian Qwen</option><option value="autogeo_api">Official AutoGEO API</option><option value="manual">Manual</option></select></label><button :disabled="actionState === 'saving'">建立受控 Job</button></form></section>

    <section class="panel"><div><p class="eyebrow">AUTOGEO RECOMMENDATION</p><h2>執行一次受控候選生成</h2><p>此為 owner 明確請求的前景處理，不是背景 worker。候選稿會記錄 provider／fallback provenance、evidence snapshot 與 risk gate，最後一律進入人工 review。</p></div><form @submit.prevent="runRecommendation"><label>已核准 Brief ID<input v-model="recommendationForm.briefId" required inputmode="numeric"></label><label>Queued Job ID（選填；可由上方建立後自動帶入）<input v-model="recommendationForm.jobId" inputmode="numeric"></label><label>原文標題<input v-model.trim="recommendationForm.title" required minlength="3" maxlength="180"></label><label>語言<select v-model="recommendationForm.language"><option value="zh-hant">繁體中文</option><option value="en">English</option></select></label><label class="wide">原文（僅用於本次 candidate；會以草稿版本與可稽核 fingerprint 保存，不會自動發佈）<textarea v-model.trim="recommendationForm.content" required minlength="40" maxlength="12000" rows="8"></textarea></label><button :disabled="actionState === 'saving'">產生並風險檢查候選稿</button></form></section>

    <section class="panel"><div><p class="eyebrow">HUMAN REVIEW</p><h2>明確記錄人工決定</h2><p>Blocked draft 不能被核准。核准 preview 不是發布許可；外部傳送仍完全關閉。</p></div><form @submit.prevent="submitReview"><label>Job ID<input v-model="reviewForm.jobId" required inputmode="numeric"></label><label>Draft ID<input v-model="reviewForm.draftId" required inputmode="numeric"></label><label>決定<select v-model="reviewForm.decision"><option value="approved_for_preview">核准 preview</option><option value="approved_for_delivery">核准 delivery（V1 仍不發布）</option><option value="changes_requested">要求修改</option><option value="rejected">拒絕</option></select></label><label class="wide">Review note（選填）<textarea v-model.trim="reviewForm.reviewNote" maxlength="1000" rows="2"></textarea></label><button :disabled="actionState === 'saving'">寫入人工 Review</button></form></section>

    <section class="panel"><div><p class="eyebrow">DELIVERY TARGET / PREVIEW</p><h2>登錄目標，但不啟用發布</h2><p>只接受 public HTTPS origin 與不含憑證的 adapter metadata。V1 preview 僅寫入 ledger，不會送出 CMS、WordPress 或 HTTP request。</p></div><form @submit.prevent="registerTarget"><label>顯示名稱<input v-model.trim="targetForm.displayName" required maxlength="120"></label><label>Adapter<select v-model="targetForm.adapter"><option value="manual_export">Manual export</option><option value="wordpress_rest">WordPress REST</option><option value="generic_http">Generic HTTP</option></select></label><label>HTTPS origin<input v-model.trim="targetForm.targetOrigin" type="url" required placeholder="https://cms.example.com"></label><button :disabled="actionState === 'saving'">登錄為 disabled target</button></form><form class="subform" @submit.prevent="preparePreview"><label>已核准 Job ID<input v-model="previewForm.jobId" required inputmode="numeric"></label><label>非 blocked Draft ID<input v-model="previewForm.draftId" required inputmode="numeric"></label><label>Disabled Target ID<input v-model="previewForm.targetId" required inputmode="numeric"></label><button :disabled="actionState === 'saving'">準備零寫入 Preview</button></form></section>

    </details>

    <section class="workspace" aria-live="polite"><header><div><p class="eyebrow">OWNER WORKSPACE</p><h2>目前可稽核的紀錄</h2></div><button class="quiet" type="button" :disabled="pending" @click="refresh">{{ pending ? '更新中…' : '重新整理' }}</button></header><p class="delivery-notice">{{ workspace.deliveryNotice }}</p><div class="ledger-grid"><article><h3>Diagnoses</h3><ol><li v-for="entry in workspace.diagnoses" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.diagnosisKind }} · {{ entry.status }}</span><small>{{ formatDate(entry.createdAt) }}</small></li><li v-if="!workspace.diagnoses.length">尚無紀錄</li></ol></article><article><h3>Strategy recommendations</h3><ol><li v-for="entry in workspace.strategies" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.issueCode }} · {{ entry.priority }}</span><small>{{ entry.recommendationKey }} · {{ entry.status }}</small></li><li v-if="!workspace.strategies.length">尚無紀錄</li></ol></article><article><h3>Production plans</h3><ol><li v-for="entry in workspace.plans" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.title }}</span><small>{{ entry.language }} · {{ entry.status }} · diagnosis {{ entry.diagnosisId ?? '—' }}</small></li><li v-if="!workspace.plans.length">尚無紀錄</li></ol></article><article><h3>Plan deliverables</h3><ol><li v-for="entry in workspace.deliverables" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.title }}</span><small>plan {{ entry.planId }} · {{ entry.contentType }} · {{ entry.status }}</small></li><li v-if="!workspace.deliverables.length">尚無紀錄</li></ol></article><article><h3>Evidence approvals</h3><ol><li v-for="entry in workspace.evidenceApprovals" :key="entry.id"><strong>#{{ entry.id }}</strong><span>source {{ entry.sourceId }} · {{ entry.allowedFor }}</span><small>artifact {{ entry.artifactId ?? '—' }} · {{ entry.status }}</small></li><li v-if="!workspace.evidenceApprovals.length">尚無紀錄</li></ol></article><article><h3>Content briefs</h3><ol><li v-for="entry in workspace.briefs" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.title }}</span><small>plan {{ entry.productionPlanId ?? '—' }} · {{ entry.contentType }} · {{ entry.status }}</small></li><li v-if="!workspace.briefs.length">尚無紀錄</li></ol></article><article><h3>Content jobs</h3><ol><li v-for="entry in workspace.jobs" :key="entry.id"><strong>#{{ entry.id }}</strong><span>brief {{ entry.briefId }} · {{ entry.operation }}</span><small>deliverable {{ entry.productionDeliverableId ?? '—' }} · {{ entry.status }} · {{ formatDate(entry.requestedAt) }}</small></li><li v-if="!workspace.jobs.length">尚無紀錄</li></ol></article><article><h3>Disabled targets</h3><ol><li v-for="entry in workspace.targets" :key="entry.id"><strong>#{{ entry.id }}</strong><span>{{ entry.displayName }} · {{ entry.adapter }}</span><small>{{ entry.status }} · publish {{ entry.allowPublish ? 'enabled' : 'disabled' }}</small></li><li v-if="!workspace.targets.length">尚無紀錄</li></ol></article></div></section>
  </main>
</template>

<style scoped>
.guided-flow{display:grid;gap:1rem;margin-top:1rem;padding:1.5rem;border:2px solid var(--moss);background:#f0f7f1}.guided-flow>header{max-width:760px}.guided-flow h2{margin:.25rem 0 .7rem;font-size:1.7rem}.guided-flow header p:not(.eyebrow){margin:0;line-height:1.6}.guided-step{display:grid;grid-template-columns:54px minmax(0,1fr);gap:1rem;padding:1rem;border-top:1px solid var(--line);background:#fff}.step-marker{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:var(--moss);color:#fff;font-weight:900}.guided-step h3{margin:.1rem 0 .45rem}.guided-step>div>p{margin:.2rem 0 .8rem;line-height:1.55}.inline-hint{grid-column:1/-1;margin:0;padding:.65rem .8rem;border-left:3px solid #b6862f;background:#fff8e9;color:#694d18;font-size:.84rem;line-height:1.5}.strategy-options{display:grid;gap:.6rem;margin:.9rem 0}.strategy-option{display:flex;grid-template-columns:none;gap:.7rem;align-items:flex-start;padding:.75rem;border:1px solid var(--line);background:#f8fbf7}.strategy-option input{width:auto;margin-top:.25rem}.strategy-option span{display:grid;gap:.25rem}.strategy-option small{color:#52645b;line-height:1.45}.deliverable-list{display:grid;gap:.35rem;margin:.9rem 0 0;padding:0;list-style:none}.deliverable-list li{display:flex;justify-content:space-between;gap:1rem;padding:.55rem .7rem;border-top:1px solid var(--line);font-size:.85rem}.deliverable-list span{color:var(--moss);font-weight:800}.advanced-operations{margin-top:1rem;border:1px dashed var(--line);background:#fbfbf6}.advanced-operations summary{padding:1rem;color:var(--moss);cursor:pointer;font-weight:800}.advanced-operations[open] summary{border-bottom:1px dashed var(--line)}

.guided-diagnosis,.draft-card,.risk-card{margin-top:1rem;padding:.85rem;border:1px solid var(--line);background:#f8fbf7}.guided-diagnosis ul{display:grid;gap:.55rem;padding:0;list-style:none}.guided-diagnosis li{display:grid;gap:.2rem;padding:.65rem;border-top:1px solid var(--line)}.guided-diagnosis li span,.guided-diagnosis li small,.draft-meta,.risk-card span{color:#52645b;line-height:1.45}.rule-detail,.opportunity-detail{display:grid;gap:.2rem;margin-top:.25rem;padding:.45rem;border-left:2px solid #bdd1c1;background:#fff}.draft-card pre{max-height:280px;overflow:auto;white-space:pre-wrap;font:inherit;line-height:1.55}.draft-meta{margin-top:.5rem}.risk-card{display:grid;gap:.3rem;border-color:#b6862f;background:#fff8e9}.guided-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}.button-link{display:inline-flex;align-items:center;border-radius:3px;background:var(--moss);color:#fff;font-weight:800;padding:.72rem 1rem;text-decoration:none}.guided-target{margin-top:.75rem;max-width:480px}.core-workbench{--ink:#15251f;--moss:#235b49;--paper:#f7f6ef;--line:#cad6ce;max-width:1180px;margin:0 auto;padding:3.5rem 1.5rem 6rem;color:var(--ink)}.hero{max-width:830px}.back-link{color:var(--moss);font-weight:750;text-decoration:none}.eyebrow{margin:1rem 0 .45rem;color:var(--moss);font-size:.72rem;font-weight:850;letter-spacing:.12em}.hero h1{max-width:760px;margin:.25rem 0 1rem;font-size:clamp(2.8rem,6vw,5.5rem);line-height:.92;letter-spacing:-.07em}.hero h1 em{color:var(--moss);font-family:Georgia,serif;font-weight:400}.hero>p:last-child{max-width:720px;font-size:1.08rem;line-height:1.7}.guardrail,.notice,.error{margin:2rem 0;padding:1rem 1.15rem;border-left:4px solid #a57422;background:#fff8e8}.guardrail{display:grid;gap:.35rem;border-color:var(--moss);background:#edf6f0}.notice{border-color:#287447;background:#eff8ef}.error{border-color:#a43d32;color:#7d211b}.flow-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin:2rem 0}.flow-card{min-height:150px;padding:1.2rem;border:1px solid var(--line);background:#fff}.flow-card p{margin:0 0 1rem;color:var(--moss);font-size:.72rem;font-weight:850}.flow-card strong,.flow-card span{display:block}.flow-card strong{font-size:1.15rem}.flow-card span{margin-top:.7rem;line-height:1.55}.panel{display:grid;grid-template-columns:minmax(210px,.7fr) minmax(0,1.5fr);gap:2rem;margin-top:1rem;padding:1.5rem;border:1px solid var(--line);background:var(--paper)}.panel h2,.workspace h2{margin:.25rem 0 .7rem;font-size:1.45rem}.panel>div>p:not(.eyebrow){margin:0;line-height:1.6}form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem;align-content:start}label{display:grid;gap:.38rem;font-size:.78rem;font-weight:800}input,select,textarea{box-sizing:border-box;width:100%;border:1px solid #aebcae;border-radius:4px;background:#fff;color:var(--ink);font:inherit;font-size:.92rem;padding:.68rem}textarea{resize:vertical;line-height:1.45}.wide{grid-column:1/-1}button{width:max-content;border:0;border-radius:3px;background:var(--moss);color:#fff;cursor:pointer;font:inherit;font-weight:800;padding:.72rem 1rem}button:disabled{cursor:wait;opacity:.6}.subform{grid-column:1/-1;margin-top:1rem;padding-top:1rem;border-top:1px dashed var(--line)}.workspace{margin-top:1rem;padding:1.5rem;border:1px solid var(--line);background:#fff}.workspace header{display:flex;justify-content:space-between;gap:1rem;align-items:center}.workspace .eyebrow{margin-top:0}.quiet{border:1px solid var(--moss);background:#fff;color:var(--moss)}.delivery-notice{padding:.8rem;border-left:3px solid #b6862f;background:#fff8e9;line-height:1.5}.ledger-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.ledger-grid article{border-top:1px solid var(--line)}.ledger-grid h3{margin-bottom:.5rem}.ledger-grid ol{margin:0;padding:0;list-style:none}.ledger-grid li{display:grid;gap:.2rem;padding:.7rem 0;border-top:1px solid #e2e8e3;font-size:.84rem}.ledger-grid li:first-child{border-top:0}.ledger-grid span{font-weight:700}.ledger-grid small{color:#64736c}@media(max-width:780px){.core-workbench{padding:2.25rem 1rem 4rem}.flow-grid,.panel,.ledger-grid,form{grid-template-columns:1fr}.panel{gap:1rem}.hero h1{font-size:clamp(2.7rem,14vw,4rem)}.workspace header{align-items:flex-start;flex-direction:column}}
</style>
