<script setup lang="ts">
type Readiness = {
  contracts: { feature: string, taxonomy: string, label: string }
  stageCoverage: Record<string, number>
  consentedCandidates: number
  bgeM3: { model: string, status: string, similarityOnly: boolean, maxCandidatesPerRun: number }
  supervisedLearning: { status: string, minimumCandidates: number, minimumPerStage: number, requiresHumanReview: boolean }
}
type Overview = { owner: { name: string, role: string }, workspaces: Array<{ id: number, displayName: string, targetDomain: string, language: string, publicAuditAuthorization: boolean, trainingConsent: boolean, consentRevokedAt: string | null }>, readiness: Readiness, researchCases: Array<{ id: string, market: string, category: string, sourceName: string, sourceUrl: string, signals: Record<string, boolean>, researchNote: string, status: string, restrictions: readonly string[] }> }
type PublicSource = { id: number, sourceName: string | null, sourceUrl: string, domain: string | null, sourceType: string, allowedUse: string, reviewStatus: string, robotsStatus: string, termsStatus: string, copyrightRisk: string, piiStatus: string, lastReviewedAt: string | null, retentionUntil: string | null, removedAt: string | null }
type SourceHistory = { id: number, action: string, previousAllowedUse: string | null, nextAllowedUse: string, previousReviewStatus: string | null, nextReviewStatus: string, reviewNote: string | null, createdAt: string }
type PublicArtifact = { id: number, sourceId: number, sourceName: string | null, sourceUrl: string, artifactType: string, useSnapshot: string, qualityStatus: string, sourceLocator: string | null, sourceSpanHash: string | null, capturedAt: string }
type PublicDataset = { id: number, datasetName: string, datasetVersion: string, intendedUse: string, status: string, featureContractVersion: string, labelTaxonomyVersion: string | null, splitVersion: string | null, manifestHash: string, createdAt: string, approvedAt: string | null }
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
const signalLabels: Record<string, string> = { 'seo.title_present': 'SEO title is present', 'content.h1_present': 'Primary H1 is present', 'content.service_language': 'Clear service language is present', 'content.faq_present': 'FAQ or guided topics are present', 'journey.contact_route': 'Human contact route is present', 'journey.booking_route': 'Booking route is present', 'journey.cta_present': 'Primary CTA is present' }
const signalValues = reactive<Record<string, boolean | null>>(Object.fromEntries(Object.keys(signalLabels).map(key => [key, null])))
const lastAudit = ref<{ auditRunId: number, assessments: Array<{ journeyStage: string, priorityRank: number, score: number, assessmentStatus: string, summary: string }> } | null>(null)
const reviewForm = reactive({ decision: 'confirmed' as 'confirmed' | 'amended' | 'rejected', correctedPrimaryStage: 'discovery', reviewNote: '', qualityCheckStatus: 'passed' as 'pending' | 'passed' | 'needs_revision' | 'rejected', approvedForTraining: false })
const pilotMessage = ref('')
const publicSources = ref<PublicSource[]>([])
const sourceStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const artifactStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const sourceForm = reactive({ sourceType: 'website' as 'website' | 'api' | 'dataset' | 'publication' | 'document', sourceUrl: '', sourceName: '', language: '', region: '', discoveryMethod: 'owner_research' as 'owner_research' | 'public_search' | 'api_catalogue' | 'licensed_import', robotsStatus: 'unreviewed' as 'unreviewed' | 'reviewed_allow' | 'reviewed_restrict' | 'unavailable' | 'not_applicable', robotsUrl: '', termsStatus: 'unreviewed' as 'unreviewed' | 'allows_research' | 'allows_evaluation' | 'allows_training' | 'prohibits_automation' | 'prohibits_training' | 'unknown', termsUrl: '', licenceReference: '', copyrightRisk: 'unreviewed' as 'unreviewed' | 'low' | 'medium' | 'high' | 'blocked', piiStatus: 'unreviewed' as 'unreviewed' | 'none_detected' | 'possible' | 'restricted', reviewNote: '' })
const sourceFilters = reactive({ search: '', reviewStatus: '', allowedUse: '', includeRemoved: false })
const activeSourceReview = ref<PublicSource | null>(null)
const sourceReviewStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const sourceHistory = ref<SourceHistory[]>([])
const sourceReviewForm = reactive({ requestedUse: 'research_only' as 'research_only' | 'evaluation_candidate' | 'training_candidate' | 'blocked', robotsStatus: 'unreviewed' as 'unreviewed' | 'reviewed_allow' | 'reviewed_restrict' | 'unavailable' | 'not_applicable', robotsUrl: '', termsStatus: 'unreviewed' as 'unreviewed' | 'allows_research' | 'allows_evaluation' | 'allows_training' | 'prohibits_automation' | 'prohibits_training' | 'unknown', termsUrl: '', licenceReference: '', copyrightRisk: 'unreviewed' as 'unreviewed' | 'low' | 'medium' | 'high' | 'blocked', piiStatus: 'unreviewed' as 'unreviewed' | 'none_detected' | 'possible' | 'restricted', reviewNote: '' })
const artifactForm = reactive({ sourceId: 0, sourceUrl: '', artifactType: 'structural_features' as 'page_manifest' | 'structural_features' | 'topic_map' | 'entity_map' | 'semantic_features' | 'technical_seo' | 'derived_excerpt' | 'human_annotation', sourceLocator: '', sourceSpanText: '', language: '', requestedUse: 'research_only' as 'research_only' | 'evaluation_candidate' | 'training_candidate' })
const artifactFeatures = reactive({ pageType: 'service' as 'home' | 'service' | 'insight' | 'case' | 'contact' | 'pricing' | 'faq' | 'other', hierarchyDepth: 0, market: '', navigationDepth: 0, serviceRoutes: 0, primaryJourneyStage: 'understanding' as 'discovery' | 'understanding' | 'response' | 'progression' | 'conversion', primaryCta: false, serviceRouting: false, expertContact: false, insights: false, trustSignals: false, priceOrEstimator: false, faqOrGuidedTopics: false, topics: '', primaryTopic: '', searchIntent: 'informational' as 'informational' | 'commercial' | 'transactional' | 'navigational', entityName: '', entityType: 'organisation' as 'organisation' | 'person' | 'service' | 'industry' | 'location' | 'product' | 'concept', entityRelationship: '', semanticSummary: '', embeddingModel: '', hasH1: false, canonicalPresent: false, indexability: 'unknown' as 'indexable' | 'noindex' | 'unknown', schemaTypes: '', internalLinkCount: 0, excerptPurpose: 'positioning' as 'positioning' | 'service_definition' | 'cta_pattern' | 'faq_answer' | 'technical_signal' | 'other', annotationKind: 'strategy_interpretation' as 'strategy_interpretation' | 'taxonomy_label' | 'quality_note' | 'policy_note', observation: '', reviewerConfidence: 3 })
const publicArtifacts = ref<PublicArtifact[]>([])
const publicDatasets = ref<PublicDataset[]>([])
const datasetStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const datasetForm = reactive({ datasetName: 'public-intelligence', datasetVersion: 'v0.1.0', intendedUse: 'research' as 'research' | 'evaluation' | 'training', featureContractVersion: 'public-intelligence-v1', labelTaxonomyVersion: 'journey-friction-v1', splitVersion: 'split-v1', reviewNote: '', artifactIds: [] as number[] })
const ingestionJobs = ref<IngestionJob[]>([])
const publicInferences = ref<PublicInference[]>([])
const ingestionStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const analysisStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const mlMessage = ref('')
const ingestionForm = reactive({ sourceId: 0, requestedUrl: '' })
const bgeJobIds = ref<number[]>([])

definePageMeta({ i18n: false })
useHead({ title: 'Private Audit Lab', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

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
    else { state.value = 'error'; errorMessage.value = 'Audit Lab is unavailable. Check the private service configuration and try again.' }
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
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The workspace could not be saved.'
  }
}

async function revokeConsent(workspaceId: number) {
  if (!window.confirm('Revoke this workspace\'s training consent? Existing de-identified candidates will be excluded from future model work.')) return
  try {
    await $fetch(`/api/audit/workspaces/${workspaceId}/revoke-consent`, { method: 'POST' })
    await loadOverview()
  } catch (error: unknown) {
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'Training consent could not be revoked.'
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
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The manual observation record could not be saved.'
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
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The strategist review could not be saved.'
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
    pilotMessage.value = (error as { statusMessage?: string }).statusMessage || 'The similarity pilot could not run.'
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
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The Source Card could not be saved.'
  }
}

async function approvePublicSource(sourceId: number, requestedUse: 'research_only' | 'evaluation_candidate' | 'training_candidate' = 'research_only') {
  try {
    await $fetch(`/api/intelligence/sources/${sourceId}/approve`, { method: 'POST', body: { requestedUse, reviewNote: 'Owner reviewed source policy and intended use.' } })
    await loadPublicSources()
  } catch (error: unknown) { errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The source could not be approved for that use.' }
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
    errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The public intelligence artifact could not be saved.'
  }
}

async function loadPublicSources() {
  publicSources.value = await $fetch<PublicSource[]>('/api/intelligence/sources', { query: { search: sourceFilters.search || undefined, reviewStatus: sourceFilters.reviewStatus || undefined, allowedUse: sourceFilters.allowedUse || undefined, includeRemoved: sourceFilters.includeRemoved ? 'true' : undefined } })
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
    mlMessage.value = (error as { statusMessage?: string }).statusMessage || 'The approved document could not be processed.'
  }
}

async function runFrictionBaseline(ingestionJobId: number) {
  analysisStatus.value = 'saving'
  mlMessage.value = ''
  try {
    const result = await $fetch<{ status: string }>('/api/intelligence/inferences', { method: 'POST', body: { action: 'run_friction_baseline', ingestionJobId } })
    analysisStatus.value = 'success'
    mlMessage.value = `Baseline result recorded as ${result.status.replaceAll('_', ' ')}. A strategist review is still required.`
    await loadPublicInferences()
  } catch (error: unknown) { analysisStatus.value = 'error'; mlMessage.value = (error as { statusMessage?: string }).statusMessage || 'The baseline could not run.' }
}

async function runBgeSimilarity() {
  analysisStatus.value = 'saving'
  mlMessage.value = ''
  try {
    const result = await $fetch<{ status: string }>('/api/intelligence/inferences', { method: 'POST', body: { action: 'run_bge_similarity', ingestionJobIds: bgeJobIds.value } })
    analysisStatus.value = 'success'
    mlMessage.value = `BGE-M3 similarity recorded as ${result.status.replaceAll('_', ' ')}. Similarity is not a performance prediction.`
    await loadPublicInferences()
  } catch (error: unknown) { analysisStatus.value = 'error'; mlMessage.value = (error as { statusMessage?: string }).statusMessage || 'BGE-M3 similarity could not run.' }
}

async function requestPredictionReadiness() {
  analysisStatus.value = 'saving'
  mlMessage.value = ''
  try {
    const result = await $fetch<{ message: string }>('/api/intelligence/inferences', { method: 'POST', body: { action: 'request_supervised_prediction' } })
    analysisStatus.value = 'success'
    mlMessage.value = result.message
  } catch (error: unknown) { analysisStatus.value = 'error'; mlMessage.value = (error as { statusMessage?: string }).statusMessage || 'Prediction readiness could not be checked.' }
}

async function reviewArtifactQuality(artifactId: number, qualityStatus: 'passed' | 'needs_revision' | 'rejected') {
  try { await $fetch(`/api/intelligence/artifacts/${artifactId}/quality`, { method: 'POST', body: { qualityStatus, qualityNote: 'Owner quality review.' } }); await loadPublicArtifacts() } catch (error: unknown) { errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The artifact quality review could not be saved.' }
}

async function createDatasetManifest() {
  datasetStatus.value = 'saving'
  try {
    await $fetch('/api/intelligence/datasets', { method: 'POST', body: { ...datasetForm, labelTaxonomyVersion: datasetForm.labelTaxonomyVersion || null, splitVersion: datasetForm.splitVersion || null, reviewNote: datasetForm.reviewNote || null } })
    datasetStatus.value = 'success'
    datasetForm.artifactIds = []
    await loadPublicDatasets()
  } catch (error: unknown) { datasetStatus.value = 'error'; errorMessage.value = (error as { statusMessage?: string }).statusMessage || 'The dataset manifest could not be created.' }
}

onMounted(loadOverview)
</script>

<template>
  <section class="audit-lab" aria-labelledby="audit-title">
    <div class="audit-lab-head">
      <p class="eyebrow">Private / Journey intelligence</p>
      <h1 id="audit-title">Audit the route.<br><em>Govern the evidence.</em></h1>
      <p>Private operational space for authorised public-page structure, strategist review and de-identified model readiness. It does not infer private conversion outcomes.</p>
    </div>

    <div v-if="state === 'loading'" class="audit-state" aria-live="polite">Loading the private Audit Lab…</div>
    <div v-else-if="state === 'signin'" class="audit-state audit-auth">
      <p class="eyebrow">Owner session required</p>
      <h2>This system opens only after private sign-in.</h2>
      <p>Audit evidence, review decisions and future training candidates are not public website content.</p>
      <button class="audit-button" type="button" @click="startAuditSignIn">Sign in to Audit Lab <span aria-hidden="true">↗</span></button>
    </div>
    <div v-else-if="state === 'error'" class="audit-state audit-error" role="alert">{{ errorMessage }}</div>

    <template v-else-if="overview">
      <section class="audit-summary" aria-label="ML readiness summary">
        <div><span>Consented candidates</span><strong>{{ overview.readiness.consentedCandidates }}</strong><small>Human-reviewed, de-identified candidates only.</small></div>
        <div><span>BGE-M3 pilot</span><strong>{{ overview.readiness.bgeM3.status.replaceAll('_', ' ') }}</strong><small>{{ overview.readiness.bgeM3.similarityOnly ? 'Similarity ranking only; no trained model claim.' : '' }}</small></div>
        <div><span>Supervised learning</span><strong>{{ overview.readiness.supervisedLearning.status.replaceAll('_', ' ') }}</strong><small>Requires ≥ {{ overview.readiness.supervisedLearning.minimumCandidates }} consented candidates and ≥ {{ overview.readiness.supervisedLearning.minimumPerStage }} per stage.</small></div>
      </section>

      <section class="audit-grid">
        <div class="audit-panel audit-panel-wide">
          <p class="eyebrow">01 / Authorise a workspace</p>
          <h2>Start with the public boundary, not a crawl.</h2>
          <p class="audit-panel-copy">A workspace records a target that you are authorised to review. Saving this record <strong>does not start a crawler</strong>; it creates the consent and scope boundary for later human-reviewed observations.</p>
          <form class="audit-workspace-form" @submit.prevent="createWorkspace">
            <label><span>Workspace name</span><input v-model.trim="workspaceForm.displayName" required maxlength="160" autocomplete="off"></label>
            <label><span>Public target URL</span><input v-model.trim="workspaceForm.targetUrl" required type="url" placeholder="https://example.com" inputmode="url"></label>
            <label><span>Review language</span><select v-model="workspaceForm.language"><option value="zh-hant">繁體中文</option><option value="en">English</option></select></label>
            <label class="audit-check"><input v-model="workspaceForm.publicAuditAuthorization" type="checkbox" required><span>I confirm I am authorised to review this public website within the stated scope.</span></label>
            <label class="audit-check"><input v-model="workspaceForm.trainingConsent" type="checkbox"><span>I explicitly permit only future human-approved, de-identified feature records to be considered for model evaluation. I may revoke consent later.</span></label>
            <button class="audit-button" :disabled="formStatus === 'saving'" type="submit">{{ formStatus === 'saving' ? 'Saving boundary…' : 'Create private workspace' }} <span aria-hidden="true">↗</span></button>
            <p v-if="formStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">Workspace saved. No external request or crawl has started.</p>
            <p v-else-if="formStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p>
          </form>
        </div>
        <div class="audit-panel">
          <p class="eyebrow">Model boundary</p>
          <h2>BGE-M3 is gated.</h2>
          <dl class="audit-definition-list">
            <div><dt>Model</dt><dd>{{ overview.readiness.bgeM3.model }}</dd></div>
            <div><dt>Credential</dt><dd>{{ overview.readiness.bgeM3.status === 'token_not_configured' ? 'Not configured — server-only secret required.' : 'Configured server-side.' }}</dd></div>
            <div><dt>Input</dt><dd>Only de-identified, consented feature aggregates.</dd></div>
            <div><dt>Output</dt><dd>Similarity ranking for strategist review; never an automated decision.</dd></div>
          </dl>
          <button class="audit-button" :disabled="overview.readiness.bgeM3.status !== 'pilot_ready' || pilotStatus === 'running'" type="button" @click="runSimilarityPilot">{{ pilotStatus === 'running' ? 'Ranking features…' : 'Run similarity pilot' }} <span aria-hidden="true">↗</span></button>
          <p v-if="pilotMessage" class="audit-feedback" :class="pilotStatus === 'error' ? 'audit-failure' : 'audit-success'" aria-live="polite">{{ pilotMessage }}</p>
        </div>
      </section>

      <section class="audit-panel audit-workspaces" aria-labelledby="workspace-list-title">
        <p class="eyebrow">02 / Private workspace register</p>
        <h2 id="workspace-list-title">{{ overview.workspaces.length ? 'Authorised boundaries' : 'No workspace has been authorised yet.' }}</h2>
        <div v-if="overview.workspaces.length" class="audit-table-wrap"><table><thead><tr><th>Workspace</th><th>Target</th><th>Language</th><th>Training consent</th><th>State</th></tr></thead><tbody><tr v-for="workspace in overview.workspaces" :key="workspace.id"><td>{{ workspace.displayName }}</td><td>{{ workspace.targetDomain }}</td><td>{{ workspace.language }}</td><td>{{ workspace.consentRevokedAt ? 'Revoked' : workspace.trainingConsent ? 'Explicit' : 'Not granted' }}</td><td><button v-if="workspace.trainingConsent && !workspace.consentRevokedAt" class="audit-revoke" type="button" @click="revokeConsent(workspace.id)">Revoke training consent</button><span v-else>Scope saved · no crawl</span></td></tr></tbody></table></div>
      </section>

      <section v-if="overview.workspaces.length" class="audit-grid audit-manual" aria-labelledby="manual-audit-title">
        <div class="audit-panel audit-panel-wide">
          <p class="eyebrow">03 / Manual structural audit</p>
          <h2 id="manual-audit-title">Record the smallest useful evidence.</h2>
          <p class="audit-panel-copy">This form records only strategist-observed yes/no public-page structure signals. It does not request page copy, analytics, customer data or a live crawl.</p>
          <form class="audit-workspace-form" @submit.prevent="recordManualObservations">
            <label><span>Authorised workspace</span><select v-model.number="manualForm.workspaceId" required><option :value="0" disabled>Select a workspace</option><option v-for="workspace in overview.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.displayName }} · {{ workspace.targetDomain }}</option></select></label>
            <label><span>Reviewed public URL</span><input v-model.trim="manualForm.targetUrl" required type="url" placeholder="https://authorised-target.example/page" inputmode="url"></label>
            <div class="audit-signal-grid"><label v-for="(label, key) in signalLabels" :key="key"><span>{{ label }}</span><select v-model="signalValues[key]"><option :value="null">Not recorded</option><option :value="true">Observed</option><option :value="false">Not observed</option></select></label></div>
            <label class="audit-check"><input v-model="manualForm.authorizationConfirmed" type="checkbox" required><span>I confirm this is an authorised, human-reviewed public-page observation and not a private performance claim.</span></label>
            <button class="audit-button" :disabled="manualStatus === 'saving'" type="submit">{{ manualStatus === 'saving' ? 'Classifying signals…' : 'Create reviewable assessment' }} <span aria-hidden="true">↗</span></button>
            <p v-if="manualStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p>
          </form>
        </div>
        <div class="audit-panel"><p class="eyebrow">Evidence boundary</p><h2>No public signal proves conversion.</h2><p class="audit-panel-copy">The baseline may flag missing structure and rank the need for review. The conversion stage is always insufficient without separately authorised first-party evidence.</p></div>
      </section>

      <section v-if="lastAudit" class="audit-grid audit-assessment" aria-labelledby="assessment-title">
        <div class="audit-panel audit-panel-wide"><p class="eyebrow">04 / Rule baseline output</p><h2 id="assessment-title">Every line waits for a strategist.</h2><ol class="assessment-list"><li v-for="assessment in lastAudit.assessments" :key="assessment.journeyStage"><span>{{ String(assessment.priorityRank).padStart(2, '0') }}</span><div><strong>{{ assessment.journeyStage }}</strong><p>{{ assessment.summary }}</p></div><em>{{ assessment.assessmentStatus.replaceAll('_', ' ') }} · {{ assessment.score }}</em></li></ol></div>
        <div class="audit-panel"><p class="eyebrow">Human review</p><h2>Confirm, amend or reject.</h2><form class="audit-workspace-form" @submit.prevent="submitReview"><label><span>Decision</span><select v-model="reviewForm.decision"><option value="confirmed">Confirmed</option><option value="amended">Amended</option><option value="rejected">Rejected</option></select></label><label><span>Primary friction stage</span><select v-model="reviewForm.correctedPrimaryStage"><option v-for="stage in ['discovery','understanding','response','progression','conversion']" :key="stage" :value="stage">{{ stage }}</option></select></label><label><span>Strategist rationale</span><textarea v-model.trim="reviewForm.reviewNote" required maxlength="3000"></textarea></label><label><span>Quality check</span><select v-model="reviewForm.qualityCheckStatus"><option value="passed">Passed</option><option value="needs_revision">Needs revision</option><option value="rejected">Rejected</option></select></label><label class="audit-check"><input v-model="reviewForm.approvedForTraining" type="checkbox"><span>Approve a de-identified feature candidate only if consent and all quality checks are satisfied.</span></label><button class="audit-button" :disabled="reviewStatus === 'saving'" type="submit">{{ reviewStatus === 'saving' ? 'Saving review…' : 'Save human review' }} <span aria-hidden="true">↗</span></button><p v-if="reviewStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">Review saved. Training eligibility was evaluated against consent and quality gates.</p><p v-else-if="reviewStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div>
      </section>

      <section class="audit-panel audit-research" aria-labelledby="research-title">
        <p class="eyebrow">05 / Public research register</p>
        <h2 id="research-title">Structure notes, not training data.</h2>
        <p class="audit-panel-copy">These are human-researched public structural markers. They remain pending strategist confirmation and are excluded from raw-page storage, model input and conversion claims.</p>
        <div class="research-case-grid"><article v-for="item in overview.researchCases" :key="item.id"><p>{{ item.market }} / {{ item.category }}</p><h3><a :href="item.sourceUrl" target="_blank" rel="noreferrer">{{ item.sourceName }} <span aria-hidden="true">↗</span></a></h3><dl><div v-for="(value, signal) in item.signals" :key="signal"><dt>{{ String(signal).replaceAll(/([A-Z])/g, ' $1') }}</dt><dd>{{ value ? 'Observed' : 'Not observed' }}</dd></div></dl><small>{{ item.researchNote }}</small><strong>{{ item.restrictions.join(' · ') }}</strong></article></div>
      </section>

      <section class="audit-grid audit-public-intelligence" aria-labelledby="source-card-title">
        <div class="audit-panel audit-panel-wide"><p class="eyebrow">06 / Public intelligence source card</p><h2 id="source-card-title">Use public value. Preserve the lineage.</h2><p class="audit-panel-copy">Record the source, terms, robots review, risk and intended use once. A pending Source Card cannot accept artifacts. Approval establishes the maximum allowed research, evaluation or training use—not a claim about a source’s performance.</p><form class="audit-workspace-form" @submit.prevent="createPublicSource"><label><span>Source name</span><input v-model.trim="sourceForm.sourceName" required maxlength="300"></label><label><span>Public source URL</span><input v-model.trim="sourceForm.sourceUrl" required type="url" placeholder="https://public-source.example"></label><div class="audit-signal-grid"><label><span>Source type</span><select v-model="sourceForm.sourceType"><option value="website">Website</option><option value="api">API</option><option value="dataset">Dataset</option><option value="publication">Publication</option><option value="document">Document</option></select></label><label><span>Discovery</span><select v-model="sourceForm.discoveryMethod"><option value="owner_research">Owner research</option><option value="public_search">Public search</option><option value="api_catalogue">API catalogue</option><option value="licensed_import">Licensed import</option></select></label><label><span>robots review</span><select v-model="sourceForm.robotsStatus"><option value="unreviewed">Unreviewed</option><option value="reviewed_allow">Reviewed: public paths</option><option value="reviewed_restrict">Reviewed: restrictions present</option><option value="unavailable">Unavailable</option><option value="not_applicable">Not applicable</option></select></label><label><span>Terms / licence review</span><select v-model="sourceForm.termsStatus"><option value="unreviewed">Unreviewed</option><option value="allows_research">Allows research</option><option value="allows_evaluation">Allows evaluation</option><option value="allows_training">Allows training</option><option value="prohibits_automation">Prohibits automation</option><option value="prohibits_training">Prohibits training</option><option value="unknown">Unknown</option></select></label><label><span>Copyright / use risk</span><select v-model="sourceForm.copyrightRisk"><option value="unreviewed">Unreviewed</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="blocked">Blocked</option></select></label><label><span>PII review</span><select v-model="sourceForm.piiStatus"><option value="unreviewed">Unreviewed</option><option value="none_detected">None detected</option><option value="possible">Possible</option><option value="restricted">Restricted</option></select></label></div><div class="audit-signal-grid"><label><span>robots URL</span><input v-model.trim="sourceForm.robotsUrl" type="url" placeholder="https://source.example/robots.txt"></label><label><span>Terms / licence URL</span><input v-model.trim="sourceForm.termsUrl" type="url" placeholder="https://source.example/terms"></label><label><span>Licence reference</span><input v-model.trim="sourceForm.licenceReference" maxlength="500"></label></div><label><span>Policy evidence / reviewer note</span><textarea v-model.trim="sourceForm.reviewNote" maxlength="3000" placeholder="Record why this source can be used, its restriction, or what still needs review."></textarea></label><button class="audit-button" :disabled="sourceStatus === 'saving'" type="submit">{{ sourceStatus === 'saving' ? 'Saving source card…' : 'Save source card' }} <span aria-hidden="true">↗</span></button><p v-if="sourceStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">Source Card saved. Review and approve an allowed use before adding artifacts.</p><p v-else-if="sourceStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div><div class="audit-panel"><p class="eyebrow">Use gate</p><h2>Research first. Then prove the next use.</h2><p class="audit-panel-copy">Public sources can support substantial research: topic maps, entities, service semantics, information architecture, technical SEO and strategic annotations. The exact permitted use is frozen on every source and artifact.</p></div></section>

      <section v-if="publicSources.length || sourceFilters.includeRemoved" class="audit-panel audit-workspaces" aria-labelledby="public-source-list-title">
        <p class="eyebrow">07 / Source register</p><h2 id="public-source-list-title">Public sources under policy control</h2>
        <form class="audit-source-filters" @submit.prevent="loadPublicSources"><input v-model.trim="sourceFilters.search" type="search" placeholder="Search source or domain"><select v-model="sourceFilters.reviewStatus"><option value="">All review states</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="needs_policy_review">Needs policy review</option><option value="removed">Removed</option></select><select v-model="sourceFilters.allowedUse"><option value="">All use levels</option><option value="research_only">Research</option><option value="evaluation_candidate">Evaluation</option><option value="training_candidate">Training</option><option value="blocked">Blocked</option></select><label class="audit-check"><input v-model="sourceFilters.includeRemoved" type="checkbox"><span>Show disabled</span></label><button class="audit-revoke" type="submit">Filter</button></form>
        <div v-if="publicSources.length" class="audit-table-wrap"><table><thead><tr><th>Source</th><th>Policy</th><th>Allowed use</th><th>Review</th><th>Actions</th></tr></thead><tbody><tr v-for="source in publicSources" :key="source.id"><td><strong>{{ source.sourceName || source.domain }}</strong><br><small>{{ source.domain }}</small></td><td>robots: {{ source.robotsStatus }}<br>terms: {{ source.termsStatus }}<br>risk: {{ source.copyrightRisk }} / {{ source.piiStatus }}</td><td>{{ source.allowedUse.replaceAll('_', ' ') }}</td><td>{{ source.reviewStatus.replaceAll('_', ' ') }}</td><td class="audit-action-stack"><button v-if="source.reviewStatus !== 'approved' && !source.removedAt" class="audit-revoke audit-approve" type="button" @click="approvePublicSource(source.id)">Approve research</button><button v-if="!source.removedAt" class="audit-revoke" type="button" @click="startSourceReview(source)">Re-review</button><button class="audit-revoke" type="button" @click="showSourceHistory(source.id)">History</button><button v-if="!source.removedAt" class="audit-revoke audit-danger" type="button" @click="removePublicSource(source)">Disable</button></td></tr></tbody></table></div><p v-else class="audit-panel-copy">No sources match the current filter.</p>
        <form v-if="activeSourceReview" class="audit-workspace-form audit-source-review" @submit.prevent="submitSourceReview"><p class="eyebrow">Re-review / {{ activeSourceReview.sourceName || activeSourceReview.domain }}</p><div class="audit-signal-grid"><label><span>robots review</span><select v-model="sourceReviewForm.robotsStatus"><option value="unreviewed">Unreviewed</option><option value="reviewed_allow">Reviewed: public paths</option><option value="reviewed_restrict">Reviewed: restrictions present</option><option value="unavailable">Unavailable</option><option value="not_applicable">Not applicable</option></select></label><label><span>Terms status</span><select v-model="sourceReviewForm.termsStatus"><option value="unreviewed">Unreviewed</option><option value="allows_research">Allows research</option><option value="allows_evaluation">Allows evaluation</option><option value="allows_training">Allows training</option><option value="prohibits_automation">Prohibits automation</option><option value="prohibits_training">Prohibits training</option><option value="unknown">Unknown</option></select></label><label><span>Copyright risk</span><select v-model="sourceReviewForm.copyrightRisk"><option value="unreviewed">Unreviewed</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="blocked">Blocked</option></select></label><label><span>PII review</span><select v-model="sourceReviewForm.piiStatus"><option value="unreviewed">Unreviewed</option><option value="none_detected">None detected</option><option value="possible">Possible</option><option value="restricted">Restricted</option></select></label><label><span>Requested use</span><select v-model="sourceReviewForm.requestedUse"><option value="research_only">Research only</option><option value="evaluation_candidate">Evaluation candidate</option><option value="training_candidate">Training candidate</option><option value="blocked">Blocked</option></select></label></div><label><span>robots URL</span><input v-model.trim="sourceReviewForm.robotsUrl" type="url" placeholder="https://source.example/robots.txt"></label><label><span>Terms / licence URL</span><input v-model.trim="sourceReviewForm.termsUrl" type="url" placeholder="https://source.example/terms"></label><label><span>Licence reference</span><input v-model.trim="sourceReviewForm.licenceReference" maxlength="500"></label><label><span>Reviewer note</span><textarea v-model.trim="sourceReviewForm.reviewNote" maxlength="3000" required></textarea></label><button class="audit-button" :disabled="sourceReviewStatus === 'saving'" type="submit">{{ sourceReviewStatus === 'saving' ? 'Saving policy review…' : 'Save re-review' }} <span aria-hidden="true">↗</span></button></form>
        <ol v-if="sourceHistory.length" class="audit-history"><li v-for="entry in sourceHistory" :key="entry.id"><strong>{{ entry.action }}</strong> · {{ entry.previousAllowedUse || 'none' }} → {{ entry.nextAllowedUse }} · {{ entry.nextReviewStatus }}<small>{{ entry.reviewNote || 'No reviewer note.' }} · {{ new Date(entry.createdAt).toLocaleString() }}</small></li></ol>
      </section>

      <section v-if="publicSources.some(source => source.reviewStatus === 'approved' && !source.removedAt)" class="audit-grid audit-public-artifact" aria-labelledby="artifact-title"><div class="audit-panel audit-panel-wide"><p class="eyebrow">08 / High-value public artifact</p><h2 id="artifact-title">Store what makes the source useful.</h2><p class="audit-panel-copy">Every artifact has a typed feature contract, a source locator and a SHA-256 hash generated from the reviewed span. Do not paste account data, private information or unreviewed bulk page copies.</p><form class="audit-workspace-form" @submit.prevent="createPublicArtifact"><label><span>Approved source</span><select v-model.number="artifactForm.sourceId" required><option :value="0" disabled>Select an approved source</option><option v-for="source in publicSources.filter(item => item.reviewStatus === 'approved' && !item.removedAt)" :key="source.id" :value="source.id">{{ source.sourceName || source.domain }} · {{ source.allowedUse }}</option></select></label><label><span>Source URL for this artifact</span><input v-model.trim="artifactForm.sourceUrl" required type="url" placeholder="https://public-source.example/page"></label><label><span>Source locator / selector</span><input v-model.trim="artifactForm.sourceLocator" required maxlength="1024" placeholder="main > section:nth-of-type(2) h2"></label><label><span>Reviewed source span</span><textarea v-model.trim="artifactForm.sourceSpanText" required maxlength="20000" placeholder="The exact bounded text or observation span that supports this artifact."></textarea></label><div class="audit-signal-grid"><label><span>Artifact type</span><select v-model="artifactForm.artifactType"><option value="page_manifest">Page manifest</option><option value="structural_features">Structural features</option><option value="topic_map">Topic map</option><option value="entity_map">Entity map</option><option value="semantic_features">Semantic features</option><option value="technical_seo">Technical SEO</option><option value="derived_excerpt">Derived excerpt</option><option value="human_annotation">Human annotation</option></select></label><label><span>Requested use</span><select v-model="artifactForm.requestedUse"><option value="research_only">Research only</option><option value="evaluation_candidate">Evaluation candidate</option><option value="training_candidate">Training candidate</option></select></label><label><span>Language</span><input v-model.trim="artifactForm.language" maxlength="24" placeholder="en"></label></div><template v-if="artifactForm.artifactType === 'page_manifest'"><div class="audit-signal-grid"><label><span>Page type</span><select v-model="artifactFeatures.pageType"><option v-for="item in ['home','service','insight','case','contact','pricing','faq','other']" :key="item" :value="item">{{ item }}</option></select></label><label><span>Hierarchy depth</span><input v-model.number="artifactFeatures.hierarchyDepth" type="number" min="0" max="12"></label><label><span>Market</span><input v-model.trim="artifactFeatures.market" maxlength="80"></label></div></template><template v-else-if="artifactForm.artifactType === 'structural_features'"><div class="audit-signal-grid"><label v-for="label in ['primaryCta','serviceRouting','expertContact','insights','trustSignals','priceOrEstimator','faqOrGuidedTopics']" :key="label" class="audit-check"><input v-model="artifactFeatures[label as keyof typeof artifactFeatures]" type="checkbox"><span>{{ label }}</span></label><label><span>Primary journey stage</span><select v-model="artifactFeatures.primaryJourneyStage"><option v-for="stage in ['discovery','understanding','response','progression','conversion']" :key="stage" :value="stage">{{ stage }}</option></select></label><label><span>Navigation depth</span><input v-model.number="artifactFeatures.navigationDepth" type="number" min="0" max="12"></label><label><span>Service routes</span><input v-model.number="artifactFeatures.serviceRoutes" type="number" min="0" max="100"></label></div></template><template v-else-if="artifactForm.artifactType === 'topic_map'"><label><span>Topics (comma-separated)</span><input v-model.trim="artifactFeatures.topics" required></label><label><span>Primary topic</span><input v-model.trim="artifactFeatures.primaryTopic" required></label><label><span>Intent</span><select v-model="artifactFeatures.searchIntent"><option v-for="intent in ['informational','commercial','transactional','navigational']" :key="intent" :value="intent">{{ intent }}</option></select></label></template><template v-else-if="artifactForm.artifactType === 'entity_map'"><div class="audit-signal-grid"><label><span>Entity name</span><input v-model.trim="artifactFeatures.entityName" required></label><label><span>Entity type</span><select v-model="artifactFeatures.entityType"><option v-for="kind in ['organisation','person','service','industry','location','product','concept']" :key="kind" :value="kind">{{ kind }}</option></select></label><label><span>Relationship</span><input v-model.trim="artifactFeatures.entityRelationship" required></label></div></template><template v-else-if="artifactForm.artifactType === 'semantic_features'"><label><span>Semantic summary</span><textarea v-model.trim="artifactFeatures.semanticSummary" required minlength="40" maxlength="3000"></textarea></label><label><span>Embedding model (optional)</span><input v-model.trim="artifactFeatures.embeddingModel" maxlength="120"></label></template><template v-else-if="artifactForm.artifactType === 'technical_seo'"><div class="audit-signal-grid"><label class="audit-check"><input v-model="artifactFeatures.hasH1" type="checkbox"><span>Has H1</span></label><label class="audit-check"><input v-model="artifactFeatures.canonicalPresent" type="checkbox"><span>Canonical present</span></label><label><span>Indexability</span><select v-model="artifactFeatures.indexability"><option value="indexable">Indexable</option><option value="noindex">Noindex</option><option value="unknown">Unknown</option></select></label><label><span>Schema types (comma-separated)</span><input v-model.trim="artifactFeatures.schemaTypes"></label><label><span>Internal links</span><input v-model.number="artifactFeatures.internalLinkCount" type="number" min="0" max="10000"></label></div></template><template v-else-if="artifactForm.artifactType === 'derived_excerpt'"><label><span>Excerpt purpose</span><select v-model="artifactFeatures.excerptPurpose"><option v-for="kind in ['positioning','service_definition','cta_pattern','faq_answer','technical_signal','other']" :key="kind" :value="kind">{{ kind }}</option></select></label></template><template v-else-if="artifactForm.artifactType === 'human_annotation'"><label><span>Annotation kind</span><select v-model="artifactFeatures.annotationKind"><option v-for="kind in ['strategy_interpretation','taxonomy_label','quality_note','policy_note']" :key="kind" :value="kind">{{ kind }}</option></select></label><label><span>Observation</span><textarea v-model.trim="artifactFeatures.observation" required minlength="8" maxlength="3000"></textarea></label><label><span>Reviewer confidence (1–5)</span><input v-model.number="artifactFeatures.reviewerConfidence" type="number" min="1" max="5"></label></template><button class="audit-button" :disabled="artifactStatus === 'saving'" type="submit">{{ artifactStatus === 'saving' ? 'Saving artifact…' : 'Save versioned artifact' }} <span aria-hidden="true">↗</span></button><p v-if="artifactStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">Artifact saved with its source locator, span hash and policy snapshot.</p><p v-else-if="artifactStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div><div class="audit-panel"><p class="eyebrow">Feature contract</p><h2>More than yes / no.</h2><p class="audit-panel-copy">The contract is intentionally expandable: page manifests, structural signals, topic and entity maps, semantic summaries, technical SEO, excerpts and human interpretation are all typed, versioned and reversible through their source lineage.</p></div></section>

      <section v-if="publicArtifacts.length" class="audit-panel audit-workspaces" aria-labelledby="artifact-quality-title"><p class="eyebrow">09 / Artifact quality gate</p><h2 id="artifact-quality-title">Review artifacts before any dataset can see them.</h2><div class="audit-table-wrap"><table><thead><tr><th>Artifact</th><th>Trace</th><th>Policy</th><th>Quality</th><th>Action</th></tr></thead><tbody><tr v-for="artifact in publicArtifacts" :key="artifact.id"><td><strong>{{ artifact.artifactType.replaceAll('_', ' ') }}</strong><br><small>{{ artifact.sourceName || artifact.sourceUrl }}</small></td><td><small>{{ artifact.sourceLocator }}</small><br><code>{{ artifact.sourceSpanHash?.slice(0, 12) }}…</code></td><td>{{ artifact.useSnapshot.replaceAll('_', ' ') }}</td><td>{{ artifact.qualityStatus.replaceAll('_', ' ') }}</td><td><button v-if="artifact.qualityStatus !== 'passed'" class="audit-revoke audit-approve" type="button" @click="reviewArtifactQuality(artifact.id, 'passed')">Pass quality</button><button v-if="artifact.qualityStatus === 'pending'" class="audit-revoke" type="button" @click="reviewArtifactQuality(artifact.id, 'needs_revision')">Needs revision</button><span v-else-if="artifact.qualityStatus === 'passed'">Ready for manifest</span></td></tr></tbody></table></div></section>

      <section v-if="publicArtifacts.some(artifact => artifact.qualityStatus === 'passed')" class="audit-grid audit-dataset-builder" aria-labelledby="dataset-builder-title"><div class="audit-panel audit-panel-wide"><p class="eyebrow">10 / Dataset manifest</p><h2 id="dataset-builder-title">Freeze the exact data before you learn from it.</h2><p class="audit-panel-copy">A manifest references source and artifact hashes, policy level, feature contract, taxonomy and split version. It is a reviewable candidate set—not evidence that a supervised model has been trained.</p><form class="audit-workspace-form" @submit.prevent="createDatasetManifest"><div class="audit-signal-grid"><label><span>Dataset name</span><input v-model.trim="datasetForm.datasetName" required maxlength="160"></label><label><span>Version</span><input v-model.trim="datasetForm.datasetVersion" required maxlength="80"></label><label><span>Intended use</span><select v-model="datasetForm.intendedUse"><option value="research">Research</option><option value="evaluation">Evaluation</option><option value="training">Training candidate</option></select></label><label><span>Feature contract</span><input v-model.trim="datasetForm.featureContractVersion" required maxlength="80"></label><label><span>Taxonomy version</span><input v-model.trim="datasetForm.labelTaxonomyVersion" maxlength="80"></label><label><span>Split version</span><input v-model.trim="datasetForm.splitVersion" maxlength="80"></label></div><label><span>Manifest review note</span><textarea v-model.trim="datasetForm.reviewNote" maxlength="3000"></textarea></label><fieldset class="audit-artifact-picker"><legend>Select reviewed artifacts</legend><label v-for="artifact in publicArtifacts.filter(item => item.qualityStatus === 'passed')" :key="artifact.id" class="audit-check"><input v-model="datasetForm.artifactIds" type="checkbox" :value="artifact.id"><span><strong>{{ artifact.artifactType.replaceAll('_', ' ') }}</strong> · {{ artifact.sourceName || artifact.sourceUrl }} · {{ artifact.useSnapshot }}</span></label></fieldset><button class="audit-button" :disabled="datasetStatus === 'saving' || !datasetForm.artifactIds.length" type="submit">{{ datasetStatus === 'saving' ? 'Freezing manifest…' : 'Create dataset manifest' }} <span aria-hidden="true">↗</span></button><p v-if="datasetStatus === 'success'" class="audit-feedback audit-success" aria-live="polite">Manifest created. It is ready for review, not a trained model.</p><p v-else-if="datasetStatus === 'error'" class="audit-feedback audit-failure" role="alert">{{ errorMessage }}</p></form></div><div class="audit-panel"><p class="eyebrow">Current manifests</p><h2>{{ publicDatasets.length ? 'Versioned data lineage' : 'No manifest yet.' }}</h2><ul v-if="publicDatasets.length" class="audit-history"><li v-for="dataset in publicDatasets" :key="dataset.id"><strong>{{ dataset.datasetName }} / {{ dataset.datasetVersion }}</strong><small>{{ dataset.intendedUse }} · {{ dataset.status }}<br><code>{{ dataset.manifestHash.slice(0, 16) }}…</code></small></li></ul><p v-else class="audit-panel-copy">The first manifest appears only after a reviewer selects quality-passed artifacts that meet the required use level.</p></div></section>

      <section v-if="publicSources.some(source => source.reviewStatus === 'approved' && !source.removedAt)" class="audit-grid audit-public-intelligence" aria-labelledby="ingestion-title"><div class="audit-panel audit-panel-wide"><p class="eyebrow">11 / Approved document ingestion</p><h2 id="ingestion-title">Fetch one policy-cleared document.<br><em>Keep only the useful signal.</em></h2><p class="audit-panel-copy">This is an explicit one-page request, not a site crawl. It runs only when its Source Card has approved robots review, terms permitting acquisition, low copyright risk and no known PII. The processor holds HTML only in memory, then stores hashes and typed structural features. If potential PII is found, it creates no artifact.</p><form class="audit-workspace-form" @submit.prevent="createIngestionJob"><label><span>Approved source</span><select v-model.number="ingestionForm.sourceId" required><option :value="0" disabled>Select a policy-cleared source</option><option v-for="source in publicSources.filter(item => item.reviewStatus === 'approved' && item.robotsStatus === 'reviewed_allow' && ['allows_research','allows_evaluation','allows_training'].includes(item.termsStatus) && item.copyrightRisk === 'low' && item.piiStatus === 'none_detected' && !item.removedAt)" :key="source.id" :value="source.id">{{ source.sourceName || source.domain }} · {{ source.allowedUse }}</option></select></label><label><span>One public document URL</span><input v-model.trim="ingestionForm.requestedUrl" required type="url" placeholder="https://approved-source.example/service"></label><button class="audit-button" :disabled="ingestionStatus === 'saving' || !ingestionForm.sourceId" type="submit">{{ ingestionStatus === 'saving' ? 'Processing bounded document…' : 'Process approved document' }} <span aria-hidden="true">↗</span></button></form></div><div class="audit-panel"><p class="eyebrow">Hard boundary</p><h2>No silent crawling.</h2><p class="audit-panel-copy">The system will not discover links, follow redirects, retain raw HTML, ingest forms, evaluate a business, or treat public access as a licence. Source policy is checked again for every request.</p></div></section>

      <section v-if="ingestionJobs.length" class="audit-panel audit-workspaces" aria-labelledby="ingestion-ledger-title"><p class="eyebrow">12 / Ingestion ledger</p><h2 id="ingestion-ledger-title">Every fetch leaves a reviewable trace.</h2><div class="audit-table-wrap"><table><thead><tr><th>Document</th><th>Processing</th><th>PII / retention</th><th>Derived artifact</th><th>Analysis</th></tr></thead><tbody><tr v-for="job in ingestionJobs" :key="job.id"><td><strong>{{ job.sourceName || `Source #${job.sourceId}` }}</strong><br><small>{{ job.requestedUrl }}</small></td><td>{{ job.status.replaceAll('_', ' ') }}<br><small>{{ job.httpStatus || job.errorCode || '—' }}</small></td><td>{{ job.piiOutcome.replaceAll('_', ' ') }}<br><small>{{ job.cleanedCharacterCount ? `${job.cleanedCharacterCount} cleaned characters (not stored)` : 'No persistent page text' }}</small></td><td>{{ job.primaryArtifactId ? `Artifact #${job.primaryArtifactId}` : 'No artifact created' }}</td><td><button v-if="job.status === 'completed' && job.primaryArtifactId" class="audit-revoke audit-approve" :disabled="analysisStatus === 'saving'" type="button" @click="runFrictionBaseline(job.id)">Run friction baseline</button><label v-if="job.status === 'completed' && job.primaryArtifactId" class="audit-check"><input v-model="bgeJobIds" type="checkbox" :value="job.id"><span>Compare with BGE-M3</span></label></td></tr></tbody></table></div><div class="audit-action-stack"><button class="audit-button" :disabled="analysisStatus === 'saving' || bgeJobIds.length < 2 || bgeJobIds.length > 3" type="button" @click="runBgeSimilarity">Run BGE-M3 feature similarity ({{ bgeJobIds.length }}/3) <span aria-hidden="true">↗</span></button><button class="audit-revoke" :disabled="analysisStatus === 'saving'" type="button" @click="requestPredictionReadiness">Check supervised prediction readiness</button><p v-if="mlMessage" class="audit-feedback" :class="analysisStatus === 'error' || ingestionStatus === 'error' ? 'audit-failure' : 'audit-success'" aria-live="polite">{{ mlMessage }}</p></div></section>

      <section v-if="publicInferences.length" class="audit-panel audit-workspaces" aria-labelledby="inference-ledger-title"><p class="eyebrow">13 / Analysis &amp; prediction ledger</p><h2 id="inference-ledger-title">Models assist review; they do not decide.</h2><div class="audit-table-wrap"><table><thead><tr><th>Analysis</th><th>Model</th><th>Source</th><th>Status</th><th>Boundary</th></tr></thead><tbody><tr v-for="inference in publicInferences" :key="inference.id"><td>{{ inference.analysisKind.replaceAll('_', ' ') }}<br><small>Job #{{ inference.ingestionJobId || '—' }}</small></td><td>{{ inference.modelFamily }}<br><small>{{ inference.modelVersion }}</small></td><td>{{ inference.sourceName || `Source #${inference.sourceId}` }}</td><td>{{ inference.status.replaceAll('_', ' ') }}</td><td>{{ inference.requiresHumanReview ? 'Human review required' : '—' }}</td></tr></tbody></table></div></section>
    </template>
  </section>
</template>
