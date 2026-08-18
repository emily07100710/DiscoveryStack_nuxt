<script setup lang="ts">
type Readiness = {
  contracts: { feature: string, taxonomy: string, label: string }
  stageCoverage: Record<string, number>
  approvedHumanAnnotations: number
  manifestAdmission: { status: string, minimumCandidates: number, minimumPerStage: number, requiresHumanReview: boolean, requiresImmutableManifest: boolean }
  bgeM3: { model: string, status: 'token_not_configured' | 'needs_two_consented_candidates' | 'pilot_ready' }
}
type Overview = { owner: { name: string, role: string }, workspaces: Array<{ id: number, displayName: string, targetDomain: string, language: string, publicAuditAuthorization: boolean, trainingConsent: boolean, consentRevokedAt: string | null }>, readiness: Readiness, researchCases: Array<{ id: string, market: string, category: string, sourceName: string, sourceUrl: string, signals: Record<string, boolean>, researchNote: string, status: string, restrictions: readonly string[] }> }
type PublicSource = { id: number, sourceName: string | null, sourceUrl: string, domain: string | null, sourceType: string, allowedUse: string, reviewStatus: string, robotsStatus: string, termsStatus: string, copyrightRisk: string, piiStatus: string, lastReviewedAt: string | null, retentionUntil: string | null, removedAt: string | null }
type SourceHistory = { id: number, action: string, previousAllowedUse: string | null, nextAllowedUse: string, previousReviewStatus: string | null, nextReviewStatus: string, reviewNote: string | null, createdAt: string }
type PublicArtifact = { id: number, sourceId: number, sourceName: string | null, sourceUrl: string, artifactType: string, useSnapshot: string, qualityStatus: string, sourceLocator: string | null, sourceSpanHash: string | null, capturedAt: string }
type PublicDataset = { id: number, datasetName: string, datasetVersion: string, intendedUse: string, status: string, featureContractVersion: string, labelTaxonomyVersion: string | null, splitVersion: string | null, manifestHash: string, artifactCount: number, createdAt: string, approvedAt: string | null }
type IngestionJob = { id: number, sourceId: number, sourceName: string | null, requestedUrl: string, finalUrl: string | null, status: string, httpStatus: number | null, cleanedCharacterCount: number | null, piiOutcome: string, piiFindingCounts: Record<string, number>, primaryArtifactId: number | null, errorCode: string | null, requestedAt: string, completedAt: string | null }
type PublicInference = { id: number, sourceId: number, sourceName: string | null, ingestionJobId: number | null, analysisKind: string, modelFamily: string, modelVersion: string, status: string, requiresHumanReview: boolean, createdAt: string }

const state = ref<'loading' | 'signin' | 'ready' | 'error'>('loading')
const overview = ref<Overview | null>(null)
const errorMessage = ref('')
const formStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const workspaceForm = reactive({ displayName: '', targetUrl: '', language: 'zh-hant' as 'en' | 'zh-hant', publicAuditAuthorization: false, trainingConsent: false })
const manualStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const reviewStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const pilotStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
const manualForm = reactive({ workspaceId: 0, targetUrl: '', authorizationConfirmed: false })
const signalLabels: Record<string, string> = { 'seo.title_present': 'SEO 標題存在', 'content.h1_present': '主要 H1 存在', 'content.service_language': '服務說明文字清楚', 'content.faq_present': '存在常見問題或引導主題', 'journey.contact_route': '存在真人聯絡途徑', 'journey.booking_route': '存在預約途徑', 'journey.cta_present': '存在主要行動呼籲' }
const signalValues = reactive<Record<string, boolean | null>>(Object.fromEntries(Object.keys(signalLabels).map(key => [key, null])))
const lastAudit = ref<{ auditRunId: number, assessments: Array<{ journeyStage: string, priorityRank: number, score: number, assessmentStatus: string, summary: string }> } | null>(null)
const reviewForm = reactive({ decision: 'confirmed' as 'confirmed' | 'amended' | 'rejected', correctedPrimaryStage: 'discovery', reviewNote: '', qualityCheckStatus: 'passed' as 'pending' | 'passed' | 'needs_revision' | 'rejected', approvedForTraining: false })
const pilotMessage = ref('')
const publicSources = ref<PublicSource[]>([])
const sourceStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const artifactStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const artifactQualityStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const artifactQualityMessage = ref('')
const sourceForm = reactive({ sourceType: 'website' as 'website' | 'api' | 'dataset' | 'publication' | 'document', sourceUrl: '', sourceName: '', language: '', region: '', discoveryMethod: 'owner_research' as 'owner_research' | 'public_search' | 'api_catalogue' | 'licensed_import', robotsStatus: 'unreviewed' as 'unreviewed' | 'reviewed_allow' | 'reviewed_restrict' | 'unavailable' | 'not_applicable', robotsUrl: '', termsStatus: 'unreviewed' as 'unreviewed' | 'allows_research' | 'allows_evaluation' | 'allows_training' | 'prohibits_automation' | 'prohibits_training' | 'unknown', termsUrl: '', licenceReference: '', copyrightRisk: 'unreviewed' as 'unreviewed' | 'low' | 'medium' | 'high' | 'blocked', piiStatus: 'unreviewed' as 'unreviewed' | 'none_detected' | 'possible' | 'restricted', reviewNote: '' })
const sourceFilters = reactive({ search: '', reviewStatus: '', allowedUse: '', includeRemoved: false })
const activeSourceReview = ref<PublicSource | null>(null)
const sourceReviewStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const sourceHistory = ref<SourceHistory[]>([])
const sourceReviewForm = reactive({ requestedUse: 'research_only' as 'research_only' | 'evaluation_candidate' | 'training_candidate' | 'blocked', robotsStatus: 'unreviewed' as 'unreviewed' | 'reviewed_allow' | 'reviewed_restrict' | 'unavailable' | 'not_applicable', robotsUrl: '', termsStatus: 'unreviewed' as 'unreviewed' | 'allows_research' | 'allows_evaluation' | 'allows_training' | 'prohibits_automation' | 'prohibits_training' | 'unknown', termsUrl: '', licenceReference: '', copyrightRisk: 'unreviewed' as 'unreviewed' | 'low' | 'medium' | 'high' | 'blocked', piiStatus: 'unreviewed' as 'unreviewed' | 'none_detected' | 'possible' | 'restricted', reviewNote: '' })
const labelMap: Record<string, string> = {
  approved: '已核准', pending: '待處理', blocked: '已阻擋', removed: '已停用', confirmed: '已確認', amended: '已修訂', rejected: '已拒絕',
  passed: '品質通過', needs_revision: '需要修訂', unreviewed: '未審核', reviewed_allow: '已審核：允許公開路徑', reviewed_restrict: '已審核：有限制',
  unavailable: '無法取得', not_applicable: '不適用', allows_research: '允許研究', allows_evaluation: '允許評估', allows_training: '允許訓練',
  prohibits_automation: '禁止自動化', prohibits_training: '禁止訓練', unknown: '未知', none_detected: '未偵測到', possible: '可能存在', restricted: '受限制',
  low: '低', medium: '中', high: '高', research_only: '僅限研究', evaluation_candidate: '評估候選', training_candidate: '訓練候選',
  discovery: '探索', understanding: '理解', response: '回應', progression: '推進', conversion: '轉換',
  completed: '已完成', running: '處理中', failed: '失敗', queued: '排隊中', human_annotation: '人工註記',
  pilot_ready: '可執行試行分析', needs_two_consented_candidates: '需要兩筆已同意候選資料', not_ready: '尚未就緒', collecting_public_examples: '持續收集公開範例', ready_for_manifest_review: '可建立資料集 manifest',
  website: '網站', dataset: '資料集', publication: '出版品', document: '文件', owner_research: '擁有者研究', public_search: '公開搜尋', api_catalogue: 'API 目錄', licensed_import: '授權匯入',
  page_manifest: '頁面清單', structural_features: '結構特徵', topic_map: '主題地圖', entity_map: '實體地圖', semantic_features: '語意特徵', technical_seo: '技術 SEO', derived_excerpt: '衍生摘錄',
  home: '首頁', service: '服務頁', insight: '洞察頁', case: '案例頁', contact: '聯絡頁', pricing: '定價頁', faq: '常見問答', other: '其他',
  informational: '資訊型', commercial: '商業型', transactional: '交易型', navigational: '導覽型', organisation: '組織', person: '人物', industry: '產業', location: '地點', product: '產品', concept: '概念',
  indexable: '可索引', noindex: '禁止索引', positioning: '定位', service_definition: '服務定義', cta_pattern: '行動呼籲模式', faq_answer: '常見問答答案', technical_signal: '技術訊號',
  strategy_interpretation: '策略解讀', taxonomy_label: '分類標籤', quality_note: '品質備註', policy_note: '政策備註',
}
function displayLabel(value: string | null | undefined) { return value ? (labelMap[value] || value.replaceAll('_', ' ')) : '—' }
function requestFailureMessage(error: unknown, fallback: string) {
  const failure = error as { statusCode?: number, status?: number, statusMessage?: string, data?: { statusMessage?: string, message?: string }, message?: string }
  const statusCode = failure.statusCode ?? failure.status
  const message = failure.statusMessage || failure.data?.statusMessage || failure.data?.message || failure.message || fallback
  return statusCode ? `HTTP ${statusCode}：${message}` : message
}
const artifactForm = reactive({ sourceId: 0, sourceUrl: '', artifactType: 'structural_features' as 'page_manifest' | 'structural_features' | 'topic_map' | 'entity_map' | 'semantic_features' | 'technical_seo' | 'derived_excerpt' | 'human_annotation', sourceLocator: '', sourceSpanText: '', language: '', requestedUse: 'research_only' as 'research_only' | 'evaluation_candidate' | 'training_candidate' })
const artifactFeatures = reactive({ pageType: 'service' as 'home' | 'service' | 'insight' | 'case' | 'contact' | 'pricing' | 'faq' | 'other', hierarchyDepth: 0, market: '', navigationDepth: 0, serviceRoutes: 0, primaryJourneyStage: 'understanding' as 'discovery' | 'understanding' | 'response' | 'progression' | 'conversion', primaryCta: false, serviceRouting: false, expertContact: false, insights: false, trustSignals: false, priceOrEstimator: false, faqOrGuidedTopics: false, topics: '', primaryTopic: '', searchIntent: 'informational' as 'informational' | 'commercial' | 'transactional' | 'navigational', entityName: '', entityType: 'organisation' as 'organisation' | 'person' | 'service' | 'industry' | 'location' | 'product' | 'concept', entityRelationship: '', semanticSummary: '', embeddingModel: '', hasH1: false, canonicalPresent: false, indexability: 'unknown' as 'indexable' | 'noindex' | 'unknown', schemaTypes: '', internalLinkCount: 0, excerptPurpose: 'positioning' as 'positioning' | 'service_definition' | 'cta_pattern' | 'faq_answer' | 'technical_signal' | 'other', annotationKind: 'strategy_interpretation' as 'strategy_interpretation' | 'taxonomy_label' | 'quality_note' | 'policy_note', observation: '', reviewerConfidence: 3 })
const publicArtifacts = ref<PublicArtifact[]>([])
const publicDatasets = ref<PublicDataset[]>([])
const datasetStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const datasetForm = reactive({ datasetName: 'public-intelligence', datasetVersion: 'v0.1.0', intendedUse: 'research' as 'research' | 'evaluation' | 'training', featureContractVersion: 'public-intelligence-v1', labelTaxonomyVersion: 'seo-geo-journey-v1', splitVersion: 'split-v1', reviewNote: '', artifactIds: [] as number[] })
const seoGeoStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const datasetApprovalStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const datasetApprovalNotes = reactive<Record<number, string>>({})
const seoGeoForm = reactive({ sourceId: 0, sourceUrl: '', sourceLocator: '', evidenceSpanText: '', language: 'en', primaryJourneyStage: 'understanding', journeyStages: 'discovery, understanding', searchIntents: 'informational', contentTypes: 'service', audienceRoles: 'buyer', topicClusters: '', entityName: '', entityType: 'concept', entityRelationship: '', geoSignals: 'global', citationReadiness: 'first_party_expertise', technicalSeoSignals: 'title_present, h1_present', frictionSignals: 'weak_cta', actionPriority: 'medium', annotationRationale: '', reviewerConfidence: 3 })
const ingestionJobs = ref<IngestionJob[]>([])
const publicInferences = ref<PublicInference[]>([])
const ingestionStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const analysisStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const mlMessage = ref('')
const ingestionForm = reactive({ sourceId: 0, requestedUrl: '', mode: 'site' as 'document' | 'site', maxPages: 10, maxDepth: 1 })
const bgeJobIds = ref<number[]>([])

definePageMeta({ i18n: false })
useHead({ title: '私有稽核實驗室 · 發現方式Stack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

async function loadOverview() {
  state.value = 'loading'
  try {
    overview.value = await $fetch<Overview>('/api/audit/overview')
    await loadPublicSources()
    await loadPublicArtifacts()
    await loadPublicDatasets()
    await loadIngestionJobs()
    await loadPublicInferences()
    state.value = 'ready'
  } catch (error: unknown) {
    const statusCode = (error as { statusCode?: number, status?: number }).statusCode ?? (error as { status?: number }).status
    if (statusCode === 401 || statusCode === 403) state.value = 'signin'
    else { state.value = 'error'; errorMessage.value = '稽核實驗室目前無法使用。請確認私有服務設定後再試。' }
  }
}

function startAuditSignIn() {
  const origin = window.location.origin
  window.location.assign(`/api/auth/login?origin=${encodeURIComponent(origin)}`)
}

async function createWorkspace() {
  formStatus.value = 'saving'
  try {
    await $fetch('/api/audit/workspaces', { method: 'POST', body: { ...workspaceForm, publicAuditAuthorization: workspaceForm.publicAuditAuthorization } })
    workspaceForm.displayName = ''
    workspaceForm.targetUrl = ''
    workspaceForm.publicAuditAuthorization = false
    workspaceForm.trainingConsent = false
    formStatus.value = 'success'
    await loadOverview()
  } catch (error: unknown) {
    formStatus.value = 'error'
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || '工作區無法儲存。'
  }
}

async function revokeConsent(workspaceId: number) {
  if (!window.confirm('要撤回此工作區的訓練同意嗎？既有去識別候選資料將不再用於未來模型工作。')) return
  try {
    await $fetch(`/api/audit/workspaces/${workspaceId}/revoke-consent`, { method: 'POST' })
    await loadOverview()
  } catch (error: unknown) {
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || '訓練同意無法撤回。'
  }
}

async function recordManualObservations() {
  manualStatus.value = 'saving'
  try {
    const observations = Object.entries(signalValues).filter(([, value]) => value !== null).map(([key, value]) => ({ key, value, evidenceNote: '' }))
    const result = await $fetch<{ auditRunId: number, assessments: Array<{ journeyStage: string, priorityRank: number, score: number, assessmentStatus: string, summary: string }> }>('/api/audit/manual-observations', { method: 'POST', body: { workspaceId: manualForm.workspaceId, targetUrl: manualForm.targetUrl, authorizationConfirmed: manualForm.authorizationConfirmed, observations } })
    lastAudit.value = result
    reviewForm.correctedPrimaryStage = result.assessments[0]?.journeyStage || 'discovery'
    manualStatus.value = 'success'
  } catch (error: unknown) {
    manualStatus.value = 'error'
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || '人工觀察紀錄無法儲存。'
  }
}

async function submitReview() {
  if (!lastAudit.value) return
  reviewStatus.value = 'saving'
  try {
    await $fetch('/api/audit/reviews', { method: 'POST', body: { auditRunId: lastAudit.value.auditRunId, ...reviewForm } })
    reviewStatus.value = 'success'
    await loadOverview()
  } catch (error: unknown) {
    reviewStatus.value = 'error'
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || '策略師審核無法儲存。'
  }
}

async function runSimilarityPilot() {
  pilotStatus.value = 'running'
  pilotMessage.value = ''
  try {
    const result = await $fetch<{ message: string }>('/api/audit/similarity-pilot', { method: 'POST', body: { maxCandidates: 3 } })
    pilotStatus.value = 'success'
    pilotMessage.value = result.message
  } catch (error: unknown) {
    pilotStatus.value = 'error'
    pilotMessage.value = (error as { statusMessage?: string }).statusMessage || '相似度試行無法執行。'
  }
}

async function createPublicSource() {
  sourceStatus.value = 'saving'
  try {
    await $fetch('/api/intelligence/sources', { method: 'POST', body: { ...sourceForm, robotsUrl: sourceForm.robotsUrl || null, termsUrl: sourceForm.termsUrl || null, licenceReference: sourceForm.licenceReference || null, language: sourceForm.language || null, region: sourceForm.region || null, policyEvidence: { ownerRecordedAt: new Date().toISOString(), sourceCardIntent: 'public-intelligence' }, reviewNote: sourceForm.reviewNote || null } })
    sourceForm.sourceUrl = ''; sourceForm.sourceName = ''; sourceForm.language = ''; sourceForm.region = ''; sourceForm.robotsUrl = ''; sourceForm.termsUrl = ''; sourceForm.licenceReference = ''; sourceForm.reviewNote = ''
    sourceStatus.value = 'success'
    await loadPublicSources()
  } catch (error: unknown) {
    sourceStatus.value = 'error'
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || '來源卡無法儲存。'
  }
}

async function approvePublicSource(sourceId: number, requestedUse: 'research_only' | 'evaluation_candidate' | 'training_candidate' = 'research_only') {
  try {
    await $fetch(`/api/intelligence/sources/${sourceId}/approve`, { method: 'POST', body: { requestedUse, reviewNote: 'Owner reviewed source policy and intended use.' } })
    await loadPublicSources()
  } catch (error: unknown) { errorMessage.value = (error as { statusMessage?: string }).statusMessage || '此來源無法核准用於指定用途。' }
}

async function createPublicArtifact() {
  artifactStatus.value = 'saving'
  try {
    const fieldData = buildArtifactFieldData()
    const sourceSpanHash = await sha256(artifactForm.sourceSpanText)
    await $fetch('/api/intelligence/artifacts', { method: 'POST', body: { sourceId: artifactForm.sourceId, sourceUrl: artifactForm.sourceUrl, artifactType: artifactForm.artifactType, artifactText: artifactForm.sourceSpanText, sourceLocator: artifactForm.sourceLocator, sourceSpanHash, fieldData, language: artifactForm.language || null, extractionMethod: 'human_annotation', requestedUse: artifactForm.requestedUse } })
    artifactForm.sourceUrl = ''; artifactForm.sourceLocator = ''; artifactForm.sourceSpanText = ''; artifactForm.language = ''
    artifactStatus.value = 'success'
  } catch (error: unknown) {
    artifactStatus.value = 'error'
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || '公開情報產物無法儲存。'
  }
}

function eligibleIngestionSources() {
  return publicSources.value.filter(item => item.reviewStatus === 'approved' && item.robotsStatus === 'reviewed_allow' && ['allows_research', 'allows_evaluation', 'allows_training'].includes(item.termsStatus) && item.copyrightRisk === 'low' && item.piiStatus === 'none_detected' && !item.removedAt)
}
function syncIngestionSourceSelection() {
  const eligible = eligibleIngestionSources()
  if (eligible.length === 1 && ingestionForm.sourceId === 0) ingestionForm.sourceId = eligible[0]!.id
  if (!eligible.some(source => source.id === ingestionForm.sourceId)) ingestionForm.sourceId = eligible.length === 1 ? eligible[0]!.id : 0
}
async function loadPublicSources() {
  publicSources.value = await $fetch<PublicSource[]>('/api/intelligence/sources', { query: { search: sourceFilters.search || undefined, reviewStatus: sourceFilters.reviewStatus || undefined, allowedUse: sourceFilters.allowedUse || undefined, includeRemoved: sourceFilters.includeRemoved ? 'true' : undefined } })
  syncIngestionSourceSelection()
}

function startSourceReview(source: PublicSource) {
  activeSourceReview.value = source
  sourceReviewForm.requestedUse = source.allowedUse === 'blocked' ? 'research_only' : source.allowedUse as 'research_only' | 'evaluation_candidate' | 'training_candidate'
  sourceReviewForm.robotsStatus = source.robotsStatus as typeof sourceReviewForm.robotsStatus
  sourceReviewForm.termsStatus = source.termsStatus as typeof sourceReviewForm.termsStatus
  sourceReviewForm.copyrightRisk = source.copyrightRisk as typeof sourceReviewForm.copyrightRisk
  sourceReviewForm.piiStatus = source.piiStatus as typeof sourceReviewForm.piiStatus
  sourceReviewForm.reviewNote = ''
}

async function submitSourceReview() {
  if (!activeSourceReview.value) return
  sourceReviewStatus.value = 'saving'
  try {
    await $fetch(`/api/intelligence/sources/${activeSourceReview.value.id}/review`, { method: 'POST', body: { ...sourceReviewForm, robotsUrl: sourceReviewForm.robotsUrl || null, termsUrl: sourceReviewForm.termsUrl || null, licenceReference: sourceReviewForm.licenceReference || null, retentionUntil: null, policyEvidence: { ownerReviewedAt: new Date().toISOString(), review: 'manual' }, reviewNote: sourceReviewForm.reviewNote || null } })
    sourceReviewStatus.value = 'success'
    await loadPublicSources()
  } catch (error: unknown) { sourceReviewStatus.value = 'error'; errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The source policy could not be re-reviewed.' }
}

async function removePublicSource(source: PublicSource) {
  if (!window.confirm(`Disable ${source.sourceName || source.domain} and revoke every linked artifact from future dataset use?`)) return
  try { await $fetch(`/api/intelligence/sources/${source.id}/remove`, { method: 'POST', body: { reviewNote: 'Owner requested source removal.' } }); await loadPublicSources() } catch (error: unknown) { errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The source could not be disabled.' }
}

async function showSourceHistory(sourceId: number) {
  try { sourceHistory.value = await $fetch<SourceHistory[]>(`/api/intelligence/sources/${sourceId}/history`) } catch (error: unknown) { errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The source history could not be loaded.' }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function buildArtifactFieldData() {
  const language = artifactForm.language || 'und'
  if (artifactForm.artifactType === 'page_manifest') return { pageType: artifactFeatures.pageType, hierarchyDepth: artifactFeatures.hierarchyDepth, language, market: artifactFeatures.market || null }
  if (artifactForm.artifactType === 'structural_features') return { signals: { primaryCta: artifactFeatures.primaryCta, serviceRouting: artifactFeatures.serviceRouting, expertContact: artifactFeatures.expertContact, insights: artifactFeatures.insights, trustSignals: artifactFeatures.trustSignals, priceOrEstimator: artifactFeatures.priceOrEstimator, faqOrGuidedTopics: artifactFeatures.faqOrGuidedTopics }, primaryJourneyStage: artifactFeatures.primaryJourneyStage, navigationDepth: artifactFeatures.navigationDepth, serviceRoutes: artifactFeatures.serviceRoutes }
  if (artifactForm.artifactType === 'topic_map') return { topics: artifactFeatures.topics.split(',').map(item => item.trim()).filter(Boolean), searchIntents: [artifactFeatures.searchIntent], primaryTopic: artifactFeatures.primaryTopic }
  if (artifactForm.artifactType === 'entity_map') return { entities: [{ name: artifactFeatures.entityName, type: artifactFeatures.entityType, relationship: artifactFeatures.entityRelationship }] }
  if (artifactForm.artifactType === 'semantic_features') return { semanticSummary: artifactFeatures.semanticSummary, embeddingModel: artifactFeatures.embeddingModel || null }
  if (artifactForm.artifactType === 'technical_seo') return { hasH1: artifactFeatures.hasH1, canonicalPresent: artifactFeatures.canonicalPresent, indexability: artifactFeatures.indexability, schemaTypes: artifactFeatures.schemaTypes.split(',').map(item => item.trim()).filter(Boolean), internalLinkCount: artifactFeatures.internalLinkCount, languageSignal: artifactForm.language || null }
  if (artifactForm.artifactType === 'derived_excerpt') return { excerptPurpose: artifactFeatures.excerptPurpose, wordCount: artifactForm.sourceSpanText.trim().split(/\s+/).filter(Boolean).length }
  return { annotationKind: artifactFeatures.annotationKind, observation: artifactFeatures.observation, reviewerConfidence: artifactFeatures.reviewerConfidence }
}

function csvValues(value: string) { return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))] }

async function createSeoGeoAnnotation() {
  seoGeoStatus.value = 'saving'
  try {
    const sourceSpanHash = await sha256(seoGeoForm.evidenceSpanText)
    const fieldData = { annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: seoGeoForm.primaryJourneyStage, journeyStages: [...new Set([seoGeoForm.primaryJourneyStage, ...csvValues(seoGeoForm.journeyStages)])], searchIntents: csvValues(seoGeoForm.searchIntents), contentTypes: csvValues(seoGeoForm.contentTypes), audienceRoles: csvValues(seoGeoForm.audienceRoles), topicClusters: csvValues(seoGeoForm.topicClusters), entitySignals: [{ name: seoGeoForm.entityName, type: seoGeoForm.entityType, relationship: seoGeoForm.entityRelationship }], geoSignals: csvValues(seoGeoForm.geoSignals), citationReadiness: csvValues(seoGeoForm.citationReadiness), technicalSeoSignals: csvValues(seoGeoForm.technicalSeoSignals), frictionSignals: csvValues(seoGeoForm.frictionSignals), actionPriority: seoGeoForm.actionPriority, annotationRationale: seoGeoForm.annotationRationale, reviewerConfidence: seoGeoForm.reviewerConfidence }
    await $fetch('/api/intelligence/artifacts', { method: 'POST', body: { sourceId: seoGeoForm.sourceId, sourceUrl: seoGeoForm.sourceUrl, artifactType: 'human_annotation', artifactText: seoGeoForm.evidenceSpanText, sourceLocator: seoGeoForm.sourceLocator, sourceSpanHash, fieldData, language: seoGeoForm.language || null, extractionMethod: 'human_annotation', requestedUse: 'training_candidate' } })
    seoGeoForm.sourceUrl = ''; seoGeoForm.sourceLocator = ''; seoGeoForm.evidenceSpanText = ''; seoGeoForm.topicClusters = ''; seoGeoForm.entityName = ''; seoGeoForm.entityRelationship = ''; seoGeoForm.annotationRationale = ''
    seoGeoStatus.value = 'success'
    await loadPublicArtifacts()
  } catch (error: unknown) { seoGeoStatus.value = 'error'; errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'SEO／GEO 多維人工標註無法儲存。' }
}

async function loadPublicArtifacts() {
  publicArtifacts.value = await $fetch<PublicArtifact[]>('/api/intelligence/artifacts')
}

async function loadPublicDatasets() {
  publicDatasets.value = await $fetch<PublicDataset[]>('/api/intelligence/datasets')
}

async function loadIngestionJobs() {
  ingestionJobs.value = await $fetch<IngestionJob[]>('/api/intelligence/ingestion-jobs')
}

async function loadPublicInferences() {
  publicInferences.value = await $fetch<PublicInference[]>('/api/intelligence/inferences')
}

async function createIngestionJob() {
  ingestionStatus.value = 'saving'
  mlMessage.value = ''
  try {
    const result = await $fetch<{ message: string }>('/api/intelligence/ingestion-jobs', { method: 'POST', body: { ...ingestionForm } })
    ingestionStatus.value = 'success'
    mlMessage.value = result.message
    ingestionForm.requestedUrl = ''
    await Promise.all([loadIngestionJobs(), loadPublicArtifacts()])
  } catch (error: unknown) {
    ingestionStatus.value = 'error'
    mlMessage.value = (error as { statusMessage?: string }).statusMessage || '已核准文件無法處理；請檢查來源政策、robots 與公開 URL。'
  }
}

async function runFrictionBaseline(ingestionJobId: number) {
  analysisStatus.value = 'saving'
  mlMessage.value = ''
  try {
    const result = await $fetch<{ status: string }>('/api/intelligence/inferences', { method: 'POST', body: { action: 'run_friction_baseline', ingestionJobId } })
    analysisStatus.value = 'success'
    mlMessage.value = `基準結果已記錄為「${displayLabel(result.status)}」。仍需要策略師人工審核。`
    await loadPublicInferences()
  } catch (error: unknown) { analysisStatus.value = 'error'; mlMessage.value = (error as { statusMessage?: string }).statusMessage || '無法執行基準分析。' }
}

async function runBgeSimilarity() {
  analysisStatus.value = 'saving'
  mlMessage.value = ''
  try {
    const result = await $fetch<{ status: string }>('/api/intelligence/inferences', { method: 'POST', body: { action: 'run_bge_similarity', ingestionJobIds: bgeJobIds.value } })
    analysisStatus.value = 'success'
    mlMessage.value = `BGE-M3 相似度結果已記錄為「${displayLabel(result.status)}」。相似度不是成效預測。`
    await loadPublicInferences()
  } catch (error: unknown) { analysisStatus.value = 'error'; mlMessage.value = (error as { statusMessage?: string }).statusMessage || '無法執行 BGE-M3 相似度分析。' }
}

async function requestPredictionReadiness() {
  analysisStatus.value = 'saving'
  mlMessage.value = ''
  try {
    const result = await $fetch<{ message: string }>('/api/intelligence/inferences', { method: 'POST', body: { action: 'request_supervised_prediction' } })
    analysisStatus.value = 'success'
    mlMessage.value = result.message
  } catch (error: unknown) { analysisStatus.value = 'error'; mlMessage.value = (error as { statusMessage?: string }).statusMessage || '無法檢查預測就緒度。' }
}

async function reviewArtifactQuality(artifactId: number, qualityStatus: 'passed' | 'needs_revision' | 'rejected') {
  if (artifactQualityStatus.value === 'saving') return
  artifactQualityStatus.value = 'saving'
  artifactQualityMessage.value = ''
  try {
    await $fetch(`/api/intelligence/artifacts/${artifactId}/quality`, { method: 'POST', body: { qualityStatus, qualityNote: '擁有者品質審核。' } })
    await loadPublicArtifacts()
    artifactQualityStatus.value = 'success'
    artifactQualityMessage.value = `產物 #${artifactId} 已儲存為「${displayLabel(qualityStatus)}」。`
  } catch (error: unknown) {
    artifactQualityStatus.value = 'error'
    errorMessage.value = requestFailureMessage(error, '無法儲存產物品質審核。')
    artifactQualityMessage.value = errorMessage.value
  }
}

async function createDatasetManifest() {
  datasetStatus.value = 'saving'
  try {
    await $fetch('/api/intelligence/datasets', { method: 'POST', body: { ...datasetForm, labelTaxonomyVersion: datasetForm.labelTaxonomyVersion || null, splitVersion: datasetForm.splitVersion || null, reviewNote: datasetForm.reviewNote || null } })
    datasetStatus.value = 'success'
    datasetForm.artifactIds = []
    await loadPublicDatasets()
  } catch (error: unknown) { datasetStatus.value = 'error'; errorMessage.value = (error as { statusMessage?: string }).statusMessage || '無法建立資料集清單。' }
}

async function approvePublicDataset(datasetId: number) {
  datasetApprovalStatus.value = 'saving'
  try {
    await $fetch(`/api/intelligence/datasets/${datasetId}/approve`, { method: 'POST', body: { reviewNote: datasetApprovalNotes[datasetId] || '' } })
    datasetApprovalStatus.value = 'success'
    await loadPublicDatasets()
  } catch (error: unknown) { datasetApprovalStatus.value = 'error'; errorMessage.value = (error as { statusMessage?: string }).statusMessage || '資料集 manifest 無法核准。' }
}

onMounted(loadOverview)
</script>

<template>
  <section class="audit-lab" aria-labelledby="audit-title">
    <div class="audit-lab-head">
      <p class="eyebrow">私有／旅程洞察</p>
      <h1 id="audit-title">稽核路徑。<br><em>治理證據。</em></h1>
      <p>此私有作業空間僅用於已授權公開頁面的結構、策略師審核與去識別模型就緒度；不會推論私有轉換成果。</p>
    </div>

    <div v-if="state === 'loading'" class="audit-state" aria-live="polite">正在載入私有稽核實驗室…</div>
    <div v-else-if="state === 'signin'" class="audit-state audit-auth">
      <p class="eyebrow">需要 owner 工作階段</p>
      <h2>此系統僅在私有登入後開放。</h2>
      <p>稽核證據、審核決策與未來訓練候選資料都不是公開網站內容。</p>
      <button class="audit-button" type="button" @click="startAuditSignIn">登入稽核實驗室 <span aria-hidden="true">↗</span></button>
    </div>
    <div v-else-if="state === 'error'" class="audit-state audit-error" role="alert">{{ errorMessage }}</div>

    <template v-else-if="overview">
      <section class="audit-summary" aria-label="ML readiness summary">
        <div><span>已核准多維標註</span><strong>{{ overview.readiness.approvedHumanAnnotations }}</strong><small>僅計入已通過來源、PII、品質與去重檢查的 SEO／GEO 人工標註。</small></div>
        <div><span>資料集 manifest</span><strong>{{ displayLabel(overview.readiness.manifestAdmission.status) }}</strong><small>尚未建立或核准的資料集不會進入遠端訓練。</small></div>
        <div><span>遠端訓練門檻</span><strong>{{ overview.readiness.approvedHumanAnnotations }}／{{ overview.readiness.manifestAdmission.minimumCandidates }}</strong><small>五個旅程階段各至少 {{ overview.readiness.manifestAdmission.minimumPerStage }} 筆，並需建立、核准不可變 manifest。</small></div>
      </section>

      <section class="audit-grid">
        <div class="audit-panel audit-panel-wide">
          <p class="eyebrow">01／授權工作區</p>
          <h2>先設定公開使用邊界，不直接開始爬取。</h2>
          <p class="audit-panel-copy">工作區會記錄你獲授權審核的目標。儲存此記錄<strong>不會啟動爬蟲</strong>；它會建立日後人工審核觀察所需的同意與範圍邊界。</p>
          <form class="audit-workspace-form" @submit.prevent="createWorkspace">
            <label><span>工作區名稱</span><input v-model.trim="workspaceForm.displayName" required maxlength="160" autocomplete="off"></label>
            <label><span>公開目標 URL</span><input v-model.trim="workspaceForm.targetUrl" required type="url" placeholder="https://example.com" inputmode="url"></label>
            <label><span>審核語言</span><select v-model="workspaceForm.language"><option value="zh-hant">繁體中文</option><option value="en">英文</option></select></label>
            <label class="audit-check"><input v-model="workspaceForm.publicAuditAuthorization" type="checkbox" required><span>我確認已獲授權，並會在所述範圍內審核此公開網站。</span></label>
            <label class="audit-check"><input v-model="workspaceForm.trainingConsent" type="checkbox"><span>我明確允許日後僅將經人工核准且已去識別的特徵紀錄納入模型評估；我可隨時撤回同意。</span></label>
            <button class="audit-button" :disabled="formStatus === 'saving'" type="submit">{{ formStatus === 'saving' ? '正在儲存邊界…' : '建立私有工作區' }} <span aria-hidden="true">↗</span></button>
            <p v-if="formStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">工作區已儲存，尚未發出外部請求或開始抓取。</p>
            <p v-else-if="formStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p>
          </form>
        </div>
        <div class="audit-panel">
          <p class="eyebrow">模型邊界</p>
          <h2>BGE-M3 受閘門控管。</h2>
          <dl class="audit-definition-list">
            <div><dt>Model</dt><dd>{{ overview.readiness.bgeM3.model }}</dd></div>
            <div><dt>憑證</dt><dd>{{ overview.readiness.bgeM3.status === 'token_not_configured' ? '尚未設定：需要僅限伺服器端的私密設定。' : '已於伺服器端設定。' }}</dd></div>
            <div><dt>輸入</dt><dd>僅使用已去識別且取得同意的特徵彙總。</dd></div>
            <div><dt>輸出</dt><dd>相似度排序僅供策略人員審核，絕不構成自動決策。</dd></div>
          </dl>
          <button class="audit-button" :disabled="overview.readiness.bgeM3.status !== 'pilot_ready' || pilotStatus === 'running'" type="button" @click="runSimilarityPilot">{{ pilotStatus === 'running' ? '正在排序特徵…' : '執行相似度試行分析' }} <span aria-hidden="true">↗</span></button>
          <p v-if="pilotMessage" class="audit-feedback" :class="pilotStatus === 'error' ? 'audit-failure' : 'audit-success'" aria-live="polite">{{ pilotMessage }}</p>
        </div>
      </section>

      <section class="audit-panel audit-workspaces" aria-labelledby="workspace-list-title">
        <p class="eyebrow">02／私有工作區登錄</p>
        <h2 id="workspace-list-title">{{ overview.workspaces.length ? '已授權邊界' : '尚未授權任何工作區。' }}</h2>
        <div v-if="overview.workspaces.length" class="audit-table-wrap"><table><thead><tr><th>工作區</th><th>目標</th><th>語言</th><th>訓練同意</th><th>狀態</th></tr></thead><tbody><tr v-for="workspace in overview.workspaces" :key="workspace.id"><td>{{ workspace.displayName }}</td><td>{{ workspace.targetDomain }}</td><td>{{ workspace.language === 'zh-hant' ? '繁體中文' : '英文' }}</td><td>{{ workspace.consentRevokedAt ? '已撤回' : workspace.trainingConsent ? '已明確同意' : '尚未同意' }}</td><td><button v-if="workspace.trainingConsent && !workspace.consentRevokedAt" class="audit-revoke" type="button" @click="revokeConsent(workspace.id)">撤回訓練同意</button><span v-else>範圍已儲存・未抓取</span></td></tr></tbody></table></div>
      </section>

      <section v-if="overview.workspaces.length" class="audit-grid audit-manual" aria-labelledby="manual-audit-title">
        <div class="audit-panel audit-panel-wide">
          <p class="eyebrow">03／人工結構稽核</p>
          <h2 id="manual-audit-title">記錄最小且有用的證據。</h2>
          <p class="audit-panel-copy">此表單只記錄策略人員觀察到的公開頁面結構訊號（是／否），不會索取頁面副本、分析資料、客戶資料或執行即時爬取。</p>
          <form class="audit-workspace-form" @submit.prevent="recordManualObservations">
            <label><span>已授權工作區</span><select v-model.number="manualForm.workspaceId" required><option :value="0" disabled>選擇工作區</option><option v-for="workspace in overview.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.displayName }} · {{ workspace.targetDomain }}</option></select></label>
            <label><span>已審核公開網址</span><input v-model.trim="manualForm.targetUrl" required type="url" placeholder="https://authorized-target.example/page" inputmode="url"></label>
            <div class="audit-signal-grid"><label v-for="(label, key) in signalLabels" :key="key"><span>{{ label }}</span><select v-model="signalValues[key]"><option :value="null">未記錄</option><option :value="true">已觀察</option><option :value="false">未觀察</option></select></label></div>
            <label class="audit-check"><input v-model="manualForm.authorizationConfirmed" type="checkbox" required><span>我確認這是經授權、人工審核的公開頁面觀察，並非私有成效宣稱。</span></label>
            <button class="audit-button" :disabled="manualStatus === 'saving'" type="submit">{{ manualStatus === 'saving' ? '正在分類訊號…' : '建立可審核評估' }} <span aria-hidden="true">↗</span></button>
            <p v-if="manualStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p>
          </form>
        </div>
        <div class="audit-panel"><p class="eyebrow">證據邊界</p><h2>任何公開訊號都不能證明轉換。</h2><p class="audit-panel-copy">基準分析可標示缺少的結構並排序審核需求；若沒有另行授權的第一方證據，轉換階段一律不足。</p></div>
      </section>

      <section v-if="lastAudit" class="audit-grid audit-assessment" aria-labelledby="assessment-title">
        <div class="audit-panel audit-panel-wide"><p class="eyebrow">04／規則基準輸出</p><h2 id="assessment-title">每一筆結論都等待策略師審核。</h2><ol class="assessment-list"><li v-for="assessment in lastAudit.assessments" :key="assessment.journeyStage"><span>{{ String(assessment.priorityRank).padStart(2, '0') }}</span><div><strong>{{ displayLabel(assessment.journeyStage) }}</strong><p>{{ assessment.summary }}</p></div><em>{{ displayLabel(assessment.assessmentStatus) }} · {{ assessment.score }}</em></li></ol></div>
        <div class="audit-panel"><p class="eyebrow">人工審核</p><h2>確認、修訂或拒絕。</h2><form class="audit-workspace-form" @submit.prevent="submitReview"><label><span>決定</span><select v-model="reviewForm.decision"><option value="confirmed">已確認</option><option value="amended">已修訂</option><option value="rejected">已拒絕</option></select></label><label><span>主要摩擦階段</span><select v-model="reviewForm.correctedPrimaryStage"><option v-for="stage in ['discovery','understanding','response','progression','conversion']" :key="stage" :value="stage">{{ displayLabel(stage) }}</option></select></label><label><span>策略師理由</span><textarea v-model.trim="reviewForm.reviewNote" required maxlength="3000"></textarea></label><label><span>品質檢查</span><select v-model="reviewForm.qualityCheckStatus"><option value="passed">品質通過</option><option value="needs_revision">需要修訂</option><option value="rejected">已拒絕</option></select></label><label class="audit-check"><input v-model="reviewForm.approvedForTraining" type="checkbox"><span>僅在已取得同意且通過所有品質檢查時，核准去識別特徵候選資料。</span></label><button class="audit-button" :disabled="reviewStatus === 'saving'" type="submit">{{ reviewStatus === 'saving' ? '正在儲存審核…' : '儲存人工審核' }} <span aria-hidden="true">↗</span></button><p v-if="reviewStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">審核已儲存，已依同意與品質閘門評估訓練資格。</p><p v-else-if="reviewStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div>
      </section>

      <section class="audit-panel audit-research" aria-labelledby="research-title">
        <p class="eyebrow">05／公開研究登錄</p>
        <h2 id="research-title">結構備註，不是訓練資料。</h2>
        <p class="audit-panel-copy">這些是人工研究的公開結構標記，仍待策略師確認；它們不會進入原始頁面保存、模型輸入或轉換成效宣稱。</p>
        <div class="research-case-grid"><article v-for="item in overview.researchCases" :key="item.id"><p>{{ item.market }} / {{ item.category }}</p><h3><a :href="item.sourceUrl" target="_blank" rel="noreferrer">{{ item.sourceName }} <span aria-hidden="true">↗</span></a></h3><dl><div v-for="(value, signal) in item.signals" :key="signal"><dt>{{ String(signal).replaceAll(/([A-Z])/g, ' $1') }}</dt><dd>{{ value ? '已觀察到' : '未觀察到' }}</dd></div></dl><small>{{ item.researchNote }}</small><strong>{{ item.restrictions.join(' · ') }}</strong></article></div>
      </section>

      <section class="audit-grid audit-public-intelligence" aria-labelledby="source-card-title">
        <div class="audit-panel audit-panel-wide"><p class="eyebrow">06／公開情報來源卡</p><h2 id="source-card-title">使用公開價值，保留來源脈絡。</h2><p class="audit-panel-copy">一次記錄來源、條款、robots 審核、風險與預定用途。待處理的來源卡不能接收產物；核准只定義可允許的研究、評估或訓練上限，不代表來源表現的宣稱。</p><form class="audit-workspace-form" @submit.prevent="createPublicSource"><label><span>來源名稱</span><input v-model.trim="sourceForm.sourceName" required maxlength="300"></label><label><span>公開來源 URL</span><input v-model.trim="sourceForm.sourceUrl" required type="url" placeholder="https://public-source.example"></label><div class="audit-signal-grid"><label><span>來源類型</span><select v-model="sourceForm.sourceType"><option value="website">網站</option><option value="api">API</option><option value="dataset">資料集</option><option value="publication">出版品</option><option value="document">文件</option></select></label><label><span>發現方式</span><select v-model="sourceForm.discoveryMethod"><option value="owner_research">Owner 研究</option><option value="public_search">公開搜尋</option><option value="api_catalogue">API 目錄</option><option value="licensed_import">授權匯入</option></select></label><label><span>robots 審核</span><select v-model="sourceForm.robotsStatus"><option value="unreviewed">未審核</option><option value="reviewed_allow">已審核：公開路徑</option><option value="reviewed_restrict">已審核：有限制</option><option value="unavailable">無法取得</option><option value="not_applicable">不適用</option></select></label><label><span>條款／授權審核</span><select v-model="sourceForm.termsStatus"><option value="unreviewed">未審核</option><option value="allows_research">允許研究</option><option value="allows_evaluation">允許評估</option><option value="allows_training">允許訓練</option><option value="prohibits_automation">禁止自動化</option><option value="prohibits_training">禁止訓練</option><option value="unknown">未知</option></select></label><label><span>著作權／使用風險</span><select v-model="sourceForm.copyrightRisk"><option value="unreviewed">未審核</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="blocked">已阻擋</option></select></label><label><span>PII 審核</span><select v-model="sourceForm.piiStatus"><option value="unreviewed">未審核</option><option value="none_detected">未偵測到</option><option value="possible">可能存在</option><option value="restricted">受限制</option></select></label></div><div class="audit-signal-grid"><label><span>robots URL</span><input v-model.trim="sourceForm.robotsUrl" type="url" placeholder="https://source.example/robots.txt"></label><label><span>條款／授權 URL</span><input v-model.trim="sourceForm.termsUrl" type="url" placeholder="https://source.example/terms"></label><label><span>授權參考</span><input v-model.trim="sourceForm.licenceReference" maxlength="500"></label></div><label><span>政策依據／審核者備註</span><textarea v-model.trim="sourceForm.reviewNote" maxlength="3000" placeholder="記錄此來源可使用的理由、限制，或仍待審核的事項。"></textarea></label><button class="audit-button" :disabled="sourceStatus === 'saving'" type="submit">{{ sourceStatus === 'saving' ? '正在儲存來源卡…' : '儲存來源卡' }} <span aria-hidden="true">↗</span></button><p v-if="sourceStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">來源卡已儲存。新增產物前，請先審核並核准可允許的用途。</p><p v-else-if="sourceStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div><div class="audit-panel"><p class="eyebrow">使用閘門</p><h2>先研究，再證明下一步用途。</h2><p class="audit-panel-copy">公開來源可支援主題地圖、實體、服務語意、資訊架構、技術 SEO 與策略註記等研究。每一個來源與產物都會固定其精確允許用途。</p></div></section>

      <section v-if="publicSources.length || sourceFilters.includeRemoved" class="audit-panel audit-workspaces" aria-labelledby="public-source-list-title">
        <p class="eyebrow">07／來源登錄</p><h2 id="public-source-list-title">受政策控管的公開來源</h2>
        <form class="audit-source-filters" @submit.prevent="loadPublicSources"><input v-model.trim="sourceFilters.search" type="search" placeholder="搜尋來源或網域"><select v-model="sourceFilters.reviewStatus"><option value="">所有審核狀態</option><option value="pending">待處理</option><option value="approved">已核准</option><option value="needs_policy_review">需要政策審核</option><option value="removed">已停用</option></select><select v-model="sourceFilters.allowedUse"><option value="">所有用途層級</option><option value="research_only">僅限研究</option><option value="evaluation_candidate">評估候選</option><option value="training_candidate">訓練候選</option><option value="blocked">已阻擋</option></select><label class="audit-check"><input v-model="sourceFilters.includeRemoved" type="checkbox"><span>顯示已停用項目</span></label><button class="audit-revoke" type="submit">篩選</button></form>
        <div v-if="publicSources.length" class="audit-table-wrap"><table><thead><tr><th>來源</th><th>政策</th><th>允許用途</th><th>審核</th><th>操作</th></tr></thead><tbody><tr v-for="source in publicSources" :key="source.id"><td><strong>{{ source.sourceName || source.domain }}</strong><br><small>{{ source.domain }}</small></td><td>robots：{{ displayLabel(source.robotsStatus) }}<br>條款：{{ displayLabel(source.termsStatus) }}<br>風險：{{ displayLabel(source.copyrightRisk) }}／{{ displayLabel(source.piiStatus) }}</td><td>{{ displayLabel(source.allowedUse) }}</td><td>{{ displayLabel(source.reviewStatus) }}</td><td class="audit-action-stack"><button v-if="source.reviewStatus !== 'approved' && !source.removedAt" class="audit-revoke audit-approve" type="button" @click="approvePublicSource(source.id)">核准研究用途</button><button v-if="!source.removedAt" class="audit-revoke" type="button" @click="startSourceReview(source)">重新審核</button><button class="audit-revoke" type="button" @click="showSourceHistory(source.id)">歷程</button><button v-if="!source.removedAt" class="audit-revoke audit-danger" type="button" @click="removePublicSource(source)">停用</button></td></tr></tbody></table></div><p v-else class="audit-panel-copy">沒有符合目前篩選條件的來源。</p>
        <form v-if="activeSourceReview" class="audit-workspace-form audit-source-review" @submit.prevent="submitSourceReview"><p class="eyebrow">重新審核／{{ activeSourceReview.sourceName || activeSourceReview.domain }}</p><div class="audit-signal-grid"><label><span>robots 審核</span><select v-model="sourceReviewForm.robotsStatus"><option value="unreviewed">未審核</option><option value="reviewed_allow">已審核：允許公開路徑</option><option value="reviewed_restrict">已審核：有限制</option><option value="unavailable">無法取得</option><option value="not_applicable">不適用</option></select></label><label><span>條款狀態</span><select v-model="sourceReviewForm.termsStatus"><option value="unreviewed">未審核</option><option value="allows_research">允許研究</option><option value="allows_evaluation">允許評估</option><option value="allows_training">允許訓練</option><option value="prohibits_automation">禁止自動化</option><option value="prohibits_training">禁止訓練</option><option value="unknown">未知</option></select></label><label><span>著作權風險</span><select v-model="sourceReviewForm.copyrightRisk"><option value="unreviewed">未審核</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="blocked">已阻擋</option></select></label><label><span>PII 審核</span><select v-model="sourceReviewForm.piiStatus"><option value="unreviewed">未審核</option><option value="none_detected">未偵測到</option><option value="possible">可能存在</option><option value="restricted">受限制</option></select></label><label><span>申請用途</span><select v-model="sourceReviewForm.requestedUse"><option value="research_only">僅限研究</option><option value="evaluation_candidate">評估候選</option><option value="training_candidate">訓練候選</option><option value="blocked">已阻擋</option></select></label></div><label><span>robots URL</span><input v-model.trim="sourceReviewForm.robotsUrl" type="url" placeholder="https://source.example/robots.txt"></label><label><span>條款／授權 URL</span><input v-model.trim="sourceReviewForm.termsUrl" type="url" placeholder="https://source.example/terms"></label><label><span>授權參考</span><input v-model.trim="sourceReviewForm.licenceReference" maxlength="500"></label><label><span>審核備註</span><textarea v-model.trim="sourceReviewForm.reviewNote" maxlength="3000" required></textarea></label><button class="audit-button" :disabled="sourceReviewStatus === 'saving'" type="submit">{{ sourceReviewStatus === 'saving' ? '正在儲存政策審核…' : '儲存重新審核' }} <span aria-hidden="true">↗</span></button></form>
        <ol v-if="sourceHistory.length" class="audit-history"><li v-for="entry in sourceHistory" :key="entry.id"><strong>{{ displayLabel(entry.action) }}</strong> · {{ displayLabel(entry.previousAllowedUse) }} → {{ displayLabel(entry.nextAllowedUse) }} · {{ displayLabel(entry.nextReviewStatus) }}<small>{{ entry.reviewNote || '沒有審核備註。' }} · {{ new Date(entry.createdAt).toLocaleString('zh-TW') }}</small></li></ol>
      </section>

      <section v-if="publicSources.some(source => source.reviewStatus === 'approved' && !source.removedAt)" class="audit-grid audit-public-artifact" aria-labelledby="artifact-title"><div class="audit-panel audit-panel-wide"><p class="eyebrow">08／高價值公開產物</p><h2 id="artifact-title">保存使來源可用的結構化資訊。</h2><p class="audit-panel-copy">每項產物都包含型別化特徵契約、來源定位器，以及由已審核文字範圍生成的 SHA-256 雜湊。請勿貼入帳戶資料、私密資訊或未審核的大量頁面副本。</p><form class="audit-workspace-form" @submit.prevent="createPublicArtifact"><label><span>已核准來源</span><select v-model.number="artifactForm.sourceId" required><option :value="0" disabled>選擇已核准來源</option><option v-for="source in publicSources.filter(item => item.reviewStatus === 'approved' && !item.removedAt)" :key="source.id" :value="source.id">{{ source.sourceName || source.domain }} · {{ source.allowedUse }}</option></select></label><label><span>此產物的來源 URL</span><input v-model.trim="artifactForm.sourceUrl" required type="url" placeholder="https://public-source.example/page"></label><label><span>來源定位器／選擇器</span><input v-model.trim="artifactForm.sourceLocator" required maxlength="1024" placeholder="main > section:nth-of-type(2) h2"></label><label><span>已審核來源範圍</span><textarea v-model.trim="artifactForm.sourceSpanText" required maxlength="20000" placeholder="支撐此產物的精確、有界文字或觀察範圍。"></textarea></label><div class="audit-signal-grid"><label><span>產物類型</span><select v-model="artifactForm.artifactType"><option value="page_manifest">頁面清單</option><option value="structural_features">結構特徵</option><option value="topic_map">主題地圖</option><option value="entity_map">實體地圖</option><option value="semantic_features">語意特徵</option><option value="technical_seo">技術 SEO</option><option value="derived_excerpt">衍生摘錄</option><option value="human_annotation">人工註記</option></select></label><label><span>申請用途</span><select v-model="artifactForm.requestedUse"><option value="research_only">僅限研究</option><option value="evaluation_candidate">評估候選</option><option value="training_candidate">訓練候選</option></select></label><label><span>語言</span><input v-model.trim="artifactForm.language" maxlength="24" placeholder="en"></label></div><template v-if="artifactForm.artifactType === 'page_manifest'"><div class="audit-signal-grid"><label><span>頁面類型</span><select v-model="artifactFeatures.pageType"><option v-for="item in ['home','service','insight','case','contact','pricing','faq','other']" :key="item" :value="item">{{ displayLabel(item) }}</option></select></label><label><span>階層深度</span><input v-model.number="artifactFeatures.hierarchyDepth" type="number" min="0" max="12"></label><label><span>市場</span><input v-model.trim="artifactFeatures.market" maxlength="80"></label></div></template><template v-else-if="artifactForm.artifactType === 'structural_features'"><div class="audit-signal-grid"><label v-for="label in ['primaryCta','serviceRouting','expertContact','insights','trustSignals','priceOrEstimator','faqOrGuidedTopics']" :key="label" class="audit-check"><input v-model="artifactFeatures[label as keyof typeof artifactFeatures]" type="checkbox"><span>{{ label }}</span></label><label><span>主要旅程階段</span><select v-model="artifactFeatures.primaryJourneyStage"><option v-for="stage in ['discovery','understanding','response','progression','conversion']" :key="stage" :value="stage">{{ displayLabel(stage) }}</option></select></label><label><span>導覽深度</span><input v-model.number="artifactFeatures.navigationDepth" type="number" min="0" max="12"></label><label><span>服務路徑數</span><input v-model.number="artifactFeatures.serviceRoutes" type="number" min="0" max="100"></label></div></template><template v-else-if="artifactForm.artifactType === 'topic_map'"><label><span>主題（以逗號分隔）</span><input v-model.trim="artifactFeatures.topics" required></label><label><span>主要主題</span><input v-model.trim="artifactFeatures.primaryTopic" required></label><label><span>意圖</span><select v-model="artifactFeatures.searchIntent"><option v-for="intent in ['informational','commercial','transactional','navigational']" :key="intent" :value="intent">{{ displayLabel(intent) }}</option></select></label></template><template v-else-if="artifactForm.artifactType === 'entity_map'"><div class="audit-signal-grid"><label><span>實體名稱</span><input v-model.trim="artifactFeatures.entityName" required></label><label><span>實體類型</span><select v-model="artifactFeatures.entityType"><option v-for="kind in ['organisation','person','service','industry','location','product','concept']" :key="kind" :value="kind">{{ displayLabel(kind) }}</option></select></label><label><span>關係</span><input v-model.trim="artifactFeatures.entityRelationship" required></label></div></template><template v-else-if="artifactForm.artifactType === 'semantic_features'"><label><span>語意摘要</span><textarea v-model.trim="artifactFeatures.semanticSummary" required minlength="40" maxlength="3000"></textarea></label><label><span>嵌入模型（選填）</span><input v-model.trim="artifactFeatures.embeddingModel" maxlength="120"></label></template><template v-else-if="artifactForm.artifactType === 'technical_seo'"><div class="audit-signal-grid"><label class="audit-check"><input v-model="artifactFeatures.hasH1" type="checkbox"><span>具有 H1</span></label><label class="audit-check"><input v-model="artifactFeatures.canonicalPresent" type="checkbox"><span>已有 Canonical</span></label><label><span>索引狀態</span><select v-model="artifactFeatures.indexability"><option value="indexable">可索引</option><option value="noindex">禁止索引</option><option value="unknown">未知</option></select></label><label><span>Schema 類型（以逗號分隔）</span><input v-model.trim="artifactFeatures.schemaTypes"></label><label><span>內部連結數</span><input v-model.number="artifactFeatures.internalLinkCount" type="number" min="0" max="10000"></label></div></template><template v-else-if="artifactForm.artifactType === 'derived_excerpt'"><label><span>摘錄用途</span><select v-model="artifactFeatures.excerptPurpose"><option v-for="kind in ['positioning','service_definition','cta_pattern','faq_answer','technical_signal','other']" :key="kind" :value="kind">{{ displayLabel(kind) }}</option></select></label></template><template v-else-if="artifactForm.artifactType === 'human_annotation'"><label><span>註記類型</span><select v-model="artifactFeatures.annotationKind"><option v-for="kind in ['strategy_interpretation','taxonomy_label','quality_note','policy_note']" :key="kind" :value="kind">{{ displayLabel(kind) }}</option></select></label><label><span>觀察</span><textarea v-model.trim="artifactFeatures.observation" required minlength="8" maxlength="3000"></textarea></label><label><span>審核者信心（1–5）</span><input v-model.number="artifactFeatures.reviewerConfidence" type="number" min="1" max="5"></label></template><button class="audit-button" :disabled="artifactStatus === 'saving'" type="submit">{{ artifactStatus === 'saving' ? '正在儲存產物…' : '儲存版本化產物' }} <span aria-hidden="true">↗</span></button><p v-if="artifactStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">產物已儲存，並附有來源定位器、範圍雜湊與政策快照。</p><p v-else-if="artifactStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div><div class="audit-panel"><p class="eyebrow">特徵契約</p><h2>不只是否。</h2><p class="audit-panel-copy">此契約可擴充：頁面清單、結構訊號、主題與實體地圖、語意摘要、技術 SEO、摘錄與人工解讀，都具有型別、版本，並可經由來源脈絡撤回。</p></div></section>

      <section v-if="publicSources.some(source => source.reviewStatus === 'approved' && source.allowedUse === 'training_candidate' && source.piiStatus === 'none_detected' && !source.removedAt)" class="audit-panel audit-workspaces" aria-labelledby="seo-geo-label-title"><p class="eyebrow">09／SEO／GEO 多維人工標註</p><h2 id="seo-geo-label-title">以可解釋的多維欄位建立每一筆訓練證據。</h2><p class="audit-panel-copy">這不是 y／n 標記。每筆資料均須由人員根據精確、有限的公開證據填入旅程、意圖、受眾、內容、主題、實體、地域、可引用性、技術 SEO、摩擦與行動優先度。提交後仍須品質審核與 manifest 核准。</p><form class="audit-workspace-form" @submit.prevent="createSeoGeoAnnotation"><label><span>可訓練已核准來源</span><select v-model.number="seoGeoForm.sourceId" required><option :value="0" disabled>選擇條款、PII 與訓練用途均已核准的來源</option><option v-for="source in publicSources.filter(item => item.reviewStatus === 'approved' && item.allowedUse === 'training_candidate' && item.piiStatus === 'none_detected' && !item.removedAt)" :key="source.id" :value="source.id">{{ source.sourceName || source.domain }}</option></select></label><label><span>公開頁面 URL</span><input v-model.trim="seoGeoForm.sourceUrl" required type="url" placeholder="https://approved-source.example/page"></label><label><span>來源定位器</span><input v-model.trim="seoGeoForm.sourceLocator" required maxlength="1024" placeholder="main > article > section:nth-of-type(2)"></label><label><span>去識別且有界的證據範圍</span><textarea v-model.trim="seoGeoForm.evidenceSpanText" required maxlength="20000" placeholder="只貼入支撐標註所需的公開、去識別、有限範圍內容。"></textarea></label><div class="audit-signal-grid"><label><span>主要旅程階段</span><select v-model="seoGeoForm.primaryJourneyStage"><option v-for="stage in ['discovery','understanding','response','progression','conversion']" :key="stage" :value="stage">{{ displayLabel(stage) }}</option></select></label><label><span>旅程階段（逗號分隔）</span><input v-model.trim="seoGeoForm.journeyStages" required></label><label><span>搜尋意圖（逗號分隔）</span><input v-model.trim="seoGeoForm.searchIntents" required placeholder="informational, commercial"></label><label><span>內容型態（逗號分隔）</span><input v-model.trim="seoGeoForm.contentTypes" required placeholder="service, faq"></label><label><span>受眾角色（逗號分隔）</span><input v-model.trim="seoGeoForm.audienceRoles" required placeholder="buyer, researcher"></label><label><span>地域訊號（逗號分隔）</span><input v-model.trim="seoGeoForm.geoSignals" required placeholder="global, multilingual"></label></div><div class="audit-signal-grid"><label><span>主題群集（逗號分隔）</span><input v-model.trim="seoGeoForm.topicClusters" required></label><label><span>實體名稱</span><input v-model.trim="seoGeoForm.entityName" required></label><label><span>實體類型</span><select v-model="seoGeoForm.entityType"><option v-for="item in ['organisation','service','product','industry','location','concept']" :key="item" :value="item">{{ displayLabel(item) }}</option></select></label><label><span>實體關係</span><input v-model.trim="seoGeoForm.entityRelationship" required></label><label><span>行動優先度</span><select v-model="seoGeoForm.actionPriority"><option v-for="item in ['critical','high','medium','low','monitor']" :key="item" :value="item">{{ item }}</option></select></label><label><span>標註信心度（1–5）</span><input v-model.number="seoGeoForm.reviewerConfidence" required type="number" min="1" max="5"></label></div><label><span>可引用性訊號（逗號分隔）</span><input v-model.trim="seoGeoForm.citationReadiness" required placeholder="first_party_expertise, structured_data"></label><label><span>技術 SEO 訊號（逗號分隔）</span><input v-model.trim="seoGeoForm.technicalSeoSignals" required placeholder="title_present, h1_present"></label><label><span>摩擦訊號（逗號分隔）</span><input v-model.trim="seoGeoForm.frictionSignals" required placeholder="weak_cta"></label><label><span>人工標註理由</span><textarea v-model.trim="seoGeoForm.annotationRationale" required minlength="16" maxlength="2000"></textarea></label><button class="audit-button" :disabled="seoGeoStatus === 'saving'" type="submit">{{ seoGeoStatus === 'saving' ? '正在固定多維標註…' : '儲存多維人工標註' }} <span aria-hidden="true">↗</span></button><p v-if="seoGeoStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">多維標註已儲存，待品質審核與 manifest 納管。</p><p v-else-if="seoGeoStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></section>

      <section v-if="publicArtifacts.length" class="audit-panel audit-workspaces" aria-labelledby="artifact-quality-title"><p class="eyebrow">10／產物品質閘門</p><h2 id="artifact-quality-title">任何資料集使用前，先審核產物。</h2><div class="audit-table-wrap"><table><thead><tr><th>產物</th><th>追溯</th><th>政策</th><th>品質</th><th>操作</th></tr></thead><tbody><tr v-for="artifact in publicArtifacts" :key="artifact.id"><td><strong>{{ displayLabel(artifact.artifactType) }}</strong><br><small>{{ artifact.sourceName || artifact.sourceUrl }}</small></td><td><small>{{ artifact.sourceLocator }}</small><br><code>{{ artifact.sourceSpanHash?.slice(0, 12) }}…</code></td><td>{{ displayLabel(artifact.useSnapshot) }}</td><td>{{ artifact.qualityStatus.replaceAll('_', ' ') }}</td><td><button v-if="artifact.qualityStatus !== 'passed'" class="audit-revoke audit-approve" :disabled="artifactQualityStatus === 'saving'" type="button" @click="reviewArtifactQuality(artifact.id, 'passed')">{{ artifactQualityStatus === 'saving' ? '正在儲存…' : '通過品質審核' }}</button><button v-if="artifact.qualityStatus === 'pending'" class="audit-revoke" :disabled="artifactQualityStatus === 'saving'" type="button" @click="reviewArtifactQuality(artifact.id, 'needs_revision')">需要修訂</button><span v-else-if="artifact.qualityStatus === 'passed'">可納入清單</span></td></tr></tbody></table></div><p v-if="artifactQualityStatus !== 'idle'" class="audit-feedback" :class="artifactQualityStatus === 'error' ? 'audit-failure' : 'audit-success'" :role="artifactQualityStatus === 'error' ? 'alert' : undefined" aria-live="polite">{{ artifactQualityStatus === 'saving' ? '正在儲存產物品質審核…' : artifactQualityMessage }}</p></section>

      <section v-if="publicArtifacts.some(artifact => artifact.qualityStatus === 'passed')" class="audit-grid audit-dataset-builder" aria-labelledby="dataset-builder-title"><div class="audit-panel audit-panel-wide"><p class="eyebrow">10／資料集清單</p><h2 id="dataset-builder-title">在學習前固定精確資料。</h2><p class="audit-panel-copy">清單會參照來源與產物雜湊、政策等級、特徵契約、分類法與切分版本。它是可審核的候選集合，不代表監督式模型已完成訓練。</p><form class="audit-workspace-form" @submit.prevent="createDatasetManifest"><div class="audit-signal-grid"><label><span>資料集名稱</span><input v-model.trim="datasetForm.datasetName" required maxlength="160"></label><label><span>版本</span><input v-model.trim="datasetForm.datasetVersion" required maxlength="80"></label><label><span>預定用途</span><select v-model="datasetForm.intendedUse"><option value="research">研究</option><option value="evaluation">評估</option><option value="training">訓練候選</option></select></label><label><span>特徵契約</span><input v-model.trim="datasetForm.featureContractVersion" required maxlength="80"></label><label><span>分類法版本</span><input v-model.trim="datasetForm.labelTaxonomyVersion" maxlength="80"></label><label><span>切分版本</span><input v-model.trim="datasetForm.splitVersion" maxlength="80"></label></div><label><span>清單審核備註</span><textarea v-model.trim="datasetForm.reviewNote" maxlength="3000"></textarea></label><fieldset class="audit-artifact-picker"><legend>選取已審核產物</legend><label v-for="artifact in publicArtifacts.filter(item => item.qualityStatus === 'passed')" :key="artifact.id" class="audit-check"><input v-model="datasetForm.artifactIds" type="checkbox" :value="artifact.id"><span><strong>{{ displayLabel(artifact.artifactType) }}</strong> · {{ artifact.sourceName || artifact.sourceUrl }} · {{ artifact.useSnapshot }}</span></label></fieldset><button class="audit-button" :disabled="datasetStatus === 'saving' || !datasetForm.artifactIds.length" type="submit">{{ datasetStatus === 'saving' ? '正在固定清單…' : '建立資料集清單' }} <span aria-hidden="true">↗</span></button><p v-if="datasetStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">清單已建立，可供審核，但不是已訓練模型。</p><p v-else-if="datasetStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div><div class="audit-panel"><p class="eyebrow">目前清單</p><h2>{{ publicDatasets.length ? '版本化資料脈絡' : '尚無清單。' }}</h2><ul v-if="publicDatasets.length" class="audit-history"><li v-for="dataset in publicDatasets" :key="dataset.id"><strong>{{ dataset.datasetName }} / {{ dataset.datasetVersion }}</strong><small>{{ displayLabel(dataset.intendedUse) }} · {{ displayLabel(dataset.status) }}<br><code>{{ dataset.manifestHash.slice(0, 16) }}…</code></small></li></ul><p v-else class="audit-panel-copy">審核者選取通過品質審核且符合所需用途等級的產物後，才會出現第一份清單。</p></div></section>

      <section v-if="publicDatasets.length" class="audit-panel audit-workspaces" aria-labelledby="manifest-approval-title"><p class="eyebrow">12／訓練 manifest 核准</p><h2 id="manifest-approval-title">只有已核准的 100 筆公開資料集能交接訓練。</h2><p class="audit-panel-copy">核准會重新驗證資料集用途、分類法版本、至少 100 筆去重的成員、每旅程階段至少 10 筆、來源訓練權利、品質與 PII 閘門。未通過任一條件，Hugging Face 工作不會被提交。</p><div class="audit-table-wrap"><table><thead><tr><th>資料集</th><th>資料與分類法</th><th>狀態</th><th>owner 審核</th></tr></thead><tbody><tr v-for="dataset in publicDatasets" :key="dataset.id"><td><strong>{{ dataset.datasetName }} / {{ dataset.datasetVersion }}</strong><br><small><code>{{ dataset.manifestHash.slice(0, 16) }}…</code></small></td><td>{{ dataset.artifactCount }} 筆 · {{ dataset.labelTaxonomyVersion || '未指定' }}<br><small>{{ displayLabel(dataset.intendedUse) }}</small></td><td>{{ displayLabel(dataset.status) }}</td><td><template v-if="dataset.status === 'ready_for_review'"><textarea v-model.trim="datasetApprovalNotes[dataset.id]" minlength="16" maxlength="3000" placeholder="至少 16 字的核准理由、來源／授權與標籤分布覆核摘要"></textarea><button class="audit-revoke audit-approve" :disabled="datasetApprovalStatus === 'saving' || (datasetApprovalNotes[dataset.id] || '').trim().length < 16" type="button" @click="approvePublicDataset(dataset.id)">{{ datasetApprovalStatus === 'saving' ? '正在重新驗證…' : '核准訓練 manifest' }}</button></template><small v-else-if="dataset.status === 'approved'">已於 {{ dataset.approvedAt ? new Date(dataset.approvedAt).toLocaleString('zh-TW') : '—' }} 核准，可在 ML Workbench 選取。</small><small v-else>尚未達到可審核狀態。</small></td></tr></tbody></table></div><p v-if="datasetApprovalStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></section>

      <section v-if="publicSources.some(source => source.reviewStatus === 'approved' && !source.removedAt)" class="audit-grid audit-public-intelligence" aria-labelledby="ingestion-title"><div class="audit-panel audit-panel-wide"><p class="eyebrow">13／受控公開資料收集</p><h2 id="ingestion-title">在已核准網域內收集有限頁面。<br><em>只保留可審核訊號。</em></h2><p class="audit-panel-copy">每次收集僅限同一個已核准來源網域，最多 10 頁、發現深度最多 2 層，且不允許外部連結或子網域。只有來源卡的 robots 已核准、條款允許、著作權風險低且未發現已知 PII 時才會執行。處理器不保存原始 HTML 或清洗後正文；發現可能 PII 的頁面一律跳過，不建立訓練產物。</p><form class="audit-workspace-form" @submit.prevent="createIngestionJob"><label><span>已核准來源</span><select v-model.number="ingestionForm.sourceId" required><option :value="0" disabled>選擇通過政策的來源</option><option v-for="source in eligibleIngestionSources()" :key="source.id" :value="source.id">{{ source.sourceName || source.domain }} · {{ source.allowedUse }}</option></select></label><label><span>起始公開文件 URL</span><input v-model.trim="ingestionForm.requestedUrl" required type="url" placeholder="https://developers.google.com/search/docs"></label><div class="audit-signal-grid"><label><span>收集模式</span><select v-model="ingestionForm.mode"><option value="site">同網域受控多頁收集</option><option value="document">單一文件</option></select></label><label><span>最多頁數</span><select v-model.number="ingestionForm.maxPages"><option v-for="count in [1, 3, 5, 10]" :key="count" :value="count">{{ count }} 頁</option></select></label><label><span>最大發現深度</span><select v-model.number="ingestionForm.maxDepth"><option :value="0">僅起始頁</option><option :value="1">1 層</option><option :value="2">2 層</option></select></label></div><button class="audit-button" :disabled="ingestionStatus === 'saving' || !ingestionForm.sourceId" type="submit">{{ ingestionStatus === 'saving' ? '正在執行受控收集…' : '開始受控公開資料收集' }} <span aria-hidden="true">↗</span></button><p v-if="ingestionStatus === 'success' && mlMessage" class="audit-feedback audit-success" aria-live="polite">{{ mlMessage }}</p><p v-else-if="ingestionStatus === 'error' && mlMessage" class="audit-feedback audit-failure" role="alert">{{ mlMessage }}</p></form></div><div class="audit-panel"><p class="eyebrow">硬性邊界</p><h2>擴大頁數，不擴大權限。</h2><p class="audit-panel-copy">系統仍不追隨外部連結或子網域、不保存原始 HTML、不擷取表單、不把公開存取視為授權，且每次請求都會再次檢查來源政策、網域、robots、條款、PII 與去重紀錄。</p></div></section>

      <section v-if="ingestionJobs.length" class="audit-panel audit-workspaces" aria-labelledby="ingestion-ledger-title"><p class="eyebrow">12／擷取台帳</p><h2 id="ingestion-ledger-title">每次擷取都留下可審核的軌跡。</h2><div class="audit-table-wrap"><table><thead><tr><th>文件</th><th>處理</th><th>PII／保存</th><th>衍生產物</th><th>分析</th></tr></thead><tbody><tr v-for="job in ingestionJobs" :key="job.id"><td><strong>{{ job.sourceName || `來源 #${job.sourceId}` }}</strong><br><small>{{ job.requestedUrl }}</small></td><td>{{ displayLabel(job.status) }}<br><small>{{ job.httpStatus || job.errorCode || '—' }}</small></td><td>{{ displayLabel(job.piiOutcome) }}<br><small>{{ job.cleanedCharacterCount ? `${job.cleanedCharacterCount} 個清理後字元（未保存）` : '未保存頁面文字' }}</small></td><td>{{ job.primaryArtifactId ? `產物 #${job.primaryArtifactId}` : '未建立產物' }}</td><td><button v-if="job.status === 'completed' && job.primaryArtifactId" class="audit-revoke audit-approve" :disabled="analysisStatus === 'saving'" type="button" @click="runFrictionBaseline(job.id)">執行摩擦基準分析</button><label v-if="job.status === 'completed' && job.primaryArtifactId" class="audit-check"><input v-model="bgeJobIds" type="checkbox" :value="job.id"><span>與 BGE-M3 比較</span></label></td></tr></tbody></table></div><div class="audit-action-stack"><button class="audit-button" :disabled="analysisStatus === 'saving' || bgeJobIds.length < 2 || bgeJobIds.length > 3" type="button" @click="runBgeSimilarity">執行 BGE-M3 特徵相似度分析 ({{ bgeJobIds.length }}/3) <span aria-hidden="true">↗</span></button><button class="audit-revoke" :disabled="analysisStatus === 'saving'" type="button" @click="requestPredictionReadiness">檢查監督式預測就緒度</button><p v-if="mlMessage" class="audit-feedback" :class="analysisStatus === 'error' || ingestionStatus === 'error' ? 'audit-failure' : 'audit-success'" aria-live="polite">{{ mlMessage }}</p></div></section>

      <section v-if="publicInferences.length" class="audit-panel audit-workspaces" aria-labelledby="inference-ledger-title"><p class="eyebrow">13／分析與預測台帳</p><h2 id="inference-ledger-title">模型協助審核，不代替決策。</h2><div class="audit-table-wrap"><table><thead><tr><th>分析</th><th>模型</th><th>來源</th><th>狀態</th><th>邊界</th></tr></thead><tbody><tr v-for="inference in publicInferences" :key="inference.id"><td>{{ displayLabel(inference.analysisKind) }}<br><small>工作 #{{ inference.ingestionJobId || '—' }}</small></td><td>{{ inference.modelFamily }}<br><small>{{ inference.modelVersion }}</small></td><td>{{ inference.sourceName || `來源 #${inference.sourceId}` }}</td><td>{{ displayLabel(inference.status) }}</td><td>{{ inference.requiresHumanReview ? '需要人工審核' : '—' }}</td></tr></tbody></table></div></section>
    </template>
  </section>
</template>
