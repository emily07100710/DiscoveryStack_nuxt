import { createError } from 'h3'
import { and, eq } from 'drizzle-orm'
import { analysePublicHomepage } from '../utils/publicSiteAnalysis'
import { requireAuditDatabase } from '../audit/repository'
import { seoGeoProductionPlans } from '../database/schema'
import { optimiseGeoDocument, referenceRulesAdapter } from '../geo/optimise'
import type { GeoDocumentInput, GeoRewriteAdapter } from '../geo/contracts'
import type { ContentDraftGenerationInput, EvidenceRef } from './contracts'
import { createDeterministicDiagnosis } from './diagnosis'
import { contentFingerprint, evaluateContentRisk } from './riskGate'
import { createDeterministicScaffoldGenerator, buildOptimizationDocument, type ContentDraftGenerator } from './contentGenerator'
import { resolveProductionRuntimeProviders } from './productionProviders'
import {
  createCanonicalProductionBrief,
  createContentJob,
  createStrategyRecommendations,
  createContentBrief,
  createProductionPlan,
  findOwnerBriefForDeliverable,
  getProductionPlanBundle,
  getOwnerContentBrief,
  getOwnerContentJob,
  resolveApprovedEvidenceSnapshot,
  resolveProductionContext,
  recalculateProductionPlanStatus,
  prepareProductionPlanGeneration,
  saveContentCandidate,
  saveDiagnosis,
  saveRiskGate,
  transitionContentJob,
  updateProductionDeliverable,
} from './repository'
import { resolveCanonicalGeoRules } from '../geo/rules'

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
}

function canonicalSource(context: { title: string, language: 'en' | 'zh-hant', evidenceContext: string, diagnosisContext: string, strategyContext: string, goals: string[], constraints: string[] }): GeoDocumentInput {
  return {
    title: context.title,
    content: context.evidenceContext || 'No approved evidence text is available.',
    language: context.language,
    approvedEvidenceContext: context.evidenceContext,
    approvedDiagnosisContext: context.diagnosisContext,
    approvedStrategyContext: context.strategyContext,
    approvedBriefGoals: context.goals,
    approvedBriefConstraints: context.constraints,
  }
}

function draftInput(context: Awaited<ReturnType<typeof resolveProductionContext>>): ContentDraftGenerationInput {
  return {
    contentType: context.opportunity.deliverableType,
    title: context.opportunity.title,
    audience: context.opportunity.audience,
    language: context.plan.language,
    goals: context.opportunity.goals,
    constraints: context.opportunity.constraints,
    diagnosisFindings: Array.isArray((context.diagnosisResult as { findings?: unknown }).findings) ? (context.diagnosisResult as { findings: ContentDraftGenerationInput['diagnosisFindings'] }).findings : [],
    strategyRules: context.rules.map(rule => ({ id: rule.id, title: rule.title, instruction: rule.instruction, rationale: rule.rationale, priority: rule.priority })),
    evidenceMaterials: context.evidenceSnapshot.materials,
  }
}

function draftSource(context: Awaited<ReturnType<typeof resolveProductionContext>>, body?: string): GeoDocumentInput {
  const input = draftInput(context)
  return canonicalSource({
    title: input.title,
    language: input.language,
    evidenceContext: body ? `${context.evidenceSnapshot.context}\n\nBase draft to optimize:\n${body}` : context.evidenceSnapshot.context,
    diagnosisContext: JSON.stringify(input.diagnosisFindings).slice(0, 12000),
    strategyContext: JSON.stringify(input.strategyRules).slice(0, 16000),
    goals: input.goals,
    constraints: input.constraints,
  })
}

function sourceModeFor(provenance: Record<string, unknown>, provider: string): 'provider_candidate' | 'reference_fallback' | 'manual' {
  if (provenance.generationMode === 'deterministic_scaffold' || provider === 'reference-rules-v1' || provider === 'discoverystack-deterministic-scaffold') return 'reference_fallback'
  return 'provider_candidate'
}

function withEvidenceMaterialGate(result: ReturnType<typeof evaluateContentRisk>, materials: Array<{ reviewedText: string }>) {
  if (materials.some(material => material.reviewedText.trim())) return result
  return {
    ...result,
    status: 'blocked' as const,
    findings: [...result.findings, { id: 'missing_reviewed_evidence_text', severity: 'blocking' as const, message: 'Approved artifact 沒有可用 reviewed text；不能把 metadata 當成 base draft 內容。', evidenceRequired: true }],
  }
}

export async function runOwnerPublicDiagnosis(input: { ownerUserId: number, homepageUrl: string, sourceId?: number, auditRunId?: number }) {
  const analysis = await analysePublicHomepage(input.homepageUrl)
  const approvedEvidence = input.sourceId ? await resolveApprovedEvidenceSnapshot(input.ownerUserId, [{ sourceId: input.sourceId, reason: 'Owner supplied source for diagnosis' }], 'diagnosis', { requireArtifact: false }) : { refs: [], context: '', hash: '', materials: [] }
  const diagnosis = createDeterministicDiagnosis(analysis, input.sourceId, approvedEvidence.refs)
  const stored = await saveDiagnosis({ ownerUserId: input.ownerUserId, sourceId: input.sourceId, auditRunId: input.auditRunId, diagnosis })
  const strategy = diagnosis.engine === 'deterministic-diagnosis-v1' && diagnosis.findings.length
    ? await createStrategyRecommendations({ ownerUserId: input.ownerUserId, diagnosisId: stored.id })
    : { recommendations: [] }
  return { diagnosisId: stored.id, diagnosis, strategyRecommendations: strategy.recommendations, analysis: { finalUrl: analysis.finalUrl, snapshotFingerprint: analysis.snapshotFingerprint, analysisVersion: analysis.analysisVersion } }
}

export type ProductionRuntimeDependencies = {
  baseDraftGenerator?: ContentDraftGenerator
  optimizationAdapter?: GeoRewriteAdapter
}

async function runOwnerProductionDeliverableInternal(input: { ownerUserId: number, context: Awaited<ReturnType<typeof resolveProductionContext>>, job: Awaited<ReturnType<typeof getOwnerContentJob>>, dependencies?: ProductionRuntimeDependencies }) {
  const { context, job } = input
  if (job.operation !== 'content_draft') throw createError({ statusCode: 422, statusMessage: 'Production job must use the content_draft operation.' })
  if (job.status === 'candidate_ready' || job.status === 'needs_human_review' || job.status === 'approved' || job.status === 'blocked') return { job, replayed: true }
  if (job.status !== 'queued') throw createError({ statusCode: 409, statusMessage: `Content job is not executable from status ${job.status}.` })
  await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'processing' })
  const brief = context.brief || await createCanonicalProductionBrief(input.ownerUserId, context)
  const inputForDraft = draftInput(context)
  const source = draftSource(context)
  const runtimeProviders = resolveProductionRuntimeProviders(job.providerMode)
  const baseGenerator = input.dependencies?.baseDraftGenerator || runtimeProviders.baseDraftGenerator
  try {
    const baseResult = await baseGenerator.generate(inputForDraft)
    const baseRisk = withEvidenceMaterialGate(evaluateContentRisk({ source, candidateTitle: baseResult.title, candidateBody: baseResult.body, evidenceCount: context.evidenceSnapshot.refs.length }), context.evidenceSnapshot.materials)
    const baseDraft = await saveContentCandidate({
      jobId: job.id,
      title: baseResult.title,
      body: baseResult.body,
      contentHash: contentFingerprint(baseResult.title, baseResult.body),
      sourceMode: sourceModeFor({ ...baseResult.provenance, generationMode: baseResult.mode }, baseResult.provider),
      provenance: { ...baseResult.provenance, stage: 'base_draft', generationMode: baseResult.mode, generator: baseGenerator.id, generatorVersion: baseGenerator.version, runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? null, evidenceSnapshotHash: context.evidenceSnapshot.hash, selectedRuleIds: context.rules.map(rule => rule.id), briefId: brief.id },
      evidenceRefs: context.evidenceSnapshot.refs,
      safetyStatus: baseRisk.status === 'blocked' ? 'blocked' : baseRisk.status === 'needs_human_review' ? 'needs_review' : 'passed',
      safetyNotes: [...baseResult.limitations, 'Base draft is an evidence-bound draft and is not a publishable result.'],
    })
    await saveRiskGate({ draftId: baseDraft.id, result: baseRisk, evidenceSnapshotHash: context.evidenceSnapshot.hash })
    if (baseRisk.status === 'blocked') {
      await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'blocked', providerProvenance: { stage: 'base_draft', generator: baseGenerator.id, generationMode: baseResult.mode, runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? null } })
      await updateProductionDeliverable(input.ownerUserId, context.deliverable.id, { status: 'blocked', briefId: brief.id, jobId: job.id })
      return { job: { ...job, status: 'blocked' as const }, baseDraft, riskGate: baseRisk, replayed: false }
    }

    const selectedRules = resolveCanonicalGeoRules(context.rules.map(rule => rule.id))
    const optimizationDocument = buildOptimizationDocument({ title: baseResult.title, body: baseResult.body, language: inputForDraft.language, goals: inputForDraft.goals, constraints: inputForDraft.constraints, diagnosisFindings: inputForDraft.diagnosisFindings, strategyRules: inputForDraft.strategyRules, evidenceMaterials: inputForDraft.evidenceMaterials })
    const optimizationResult = await optimiseGeoDocument(optimizationDocument, input.dependencies?.optimizationAdapter || runtimeProviders.optimizationAdapter, selectedRules)
    const candidate = optimizationResult.candidate
    const optimizedRisk = withEvidenceMaterialGate(evaluateContentRisk({ source, candidateTitle: candidate.optimizedTitle, candidateBody: candidate.optimizedContent, evidenceCount: context.evidenceSnapshot.refs.length }), context.evidenceSnapshot.materials)
    const optimizedDraft = await saveContentCandidate({
      jobId: job.id,
      title: candidate.optimizedTitle,
      body: candidate.optimizedContent,
      contentHash: contentFingerprint(candidate.optimizedTitle, candidate.optimizedContent),
      sourceMode: candidate.provider === 'reference-rules-v1' ? 'reference_fallback' : 'provider_candidate',
      provenance: { provider: candidate.provider, providerVersion: candidate.providerVersion, providerProvenance: candidate.provenance, runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? candidate.provenance.fallbackReason ?? null, stage: 'optimized', generationMode: 'selected_rule_optimization', parentDraftId: baseDraft.id, parentBaseDraftHash: baseDraft.contentHash, rulesetVersion: optimizationResult.rulesetVersion, selectedRuleIds: selectedRules.map(rule => rule.id), appliedRuleIds: candidate.appliedRuleIds, evidenceSnapshotHash: context.evidenceSnapshot.hash, briefId: brief.id },
      evidenceRefs: context.evidenceSnapshot.refs,
      safetyStatus: optimizedRisk.status === 'blocked' ? 'blocked' : optimizedRisk.status === 'needs_human_review' ? 'needs_review' : 'passed',
      safetyNotes: [...candidate.safetyNotes, optimizationResult.interpretationLimit, 'Optimization is a selected-rule AutoGEO-compatible pass; it is not a ranking or conversion prediction.'],
    })
    const optimizedRiskGate = await saveRiskGate({ draftId: optimizedDraft.id, result: optimizedRisk, evidenceSnapshotHash: context.evidenceSnapshot.hash })
    const finalStatus = optimizedRisk.status === 'blocked' ? 'blocked' : 'needs_human_review'
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: finalStatus, providerProvenance: { stage: 'optimized', provider: candidate.provider, providerVersion: candidate.providerVersion, selectedRuleIds: selectedRules.map(rule => rule.id), appliedRuleIds: candidate.appliedRuleIds, baseDraftId: baseDraft.id, optimizedDraftId: optimizedDraft.id, execution: candidate.provenance.execution || 'selected-rule-optimization', fallbackReason: runtimeProviders.fallbackReason ?? candidate.provenance.fallbackReason ?? null } })
    await updateProductionDeliverable(input.ownerUserId, context.deliverable.id, { status: finalStatus === 'blocked' ? 'blocked' : 'needs_human_review', briefId: brief.id, jobId: job.id })
    return { job: { ...job, status: finalStatus },       baseDraft: { id: baseDraft.id, version: baseDraft.version, sourceMode: baseDraft.sourceMode, contentHash: baseDraft.contentHash },
      draft: { id: optimizedDraft.id, version: optimizedDraft.version, sourceMode: optimizedDraft.sourceMode, contentHash: optimizedDraft.contentHash },
      result: optimizationResult, riskGate: optimizedRiskGate, riskGateDecision: optimizedRisk.status, replayed: false }
  } catch (error) {
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'failed', errorCode: 'production_generation_failed', errorSummary: error instanceof Error ? error.message.slice(0, 500) : 'Unknown production generation error', providerProvenance: { stage: 'failed', runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? null } })
    await updateProductionDeliverable(input.ownerUserId, context.deliverable.id, { status: 'blocked', briefId: brief.id, jobId: job.id })
    throw error
  }
}

export async function runOwnerProductionDeliverable(input: { ownerUserId: number, planId: number, deliverableId: number, dependencies?: ProductionRuntimeDependencies }) {
  const context = await resolveProductionContext({ ownerUserId: input.ownerUserId, planId: input.planId, deliverableId: input.deliverableId, includeArtifacts: true })
  if (context.plan.ownerUserId !== input.ownerUserId || context.deliverable.ownerUserId !== input.ownerUserId || context.deliverable.planId !== input.planId || context.deliverable.id !== input.deliverableId) throw createError({ statusCode: 404, statusMessage: 'Production deliverable lineage was not found.' })
  if (['blocked', 'archived', 'cancelled'].includes(context.plan.status) || ['blocked', 'exported'].includes(context.deliverable.status)) throw createError({ statusCode: 422, statusMessage: 'Production deliverable is not executable in its current state.' })
  const brief = context.brief || await createCanonicalProductionBrief(input.ownerUserId, context)
  const runtimeProviders = resolveProductionRuntimeProviders()
  const job = context.job || await createContentJob({ ownerUserId: input.ownerUserId, briefId: brief.id, operation: 'content_draft', providerMode: runtimeProviders.mode, idempotencyKey: `orchestrator:plan:${input.planId}:deliverable:${input.deliverableId}`.slice(0, 128), productionPlanId: input.planId, strategyRecommendationId: context.strategy.id, productionDeliverableId: input.deliverableId })
  const result = await runOwnerProductionDeliverableInternal({ ownerUserId: input.ownerUserId, context: { ...context, brief, job }, job, dependencies: input.dependencies })
  const optimizedDraft = 'draft' in result && result.draft ? result.draft : null
  const riskGate = 'riskGate' in result && result.riskGate ? result.riskGate : null
  return { ...result, planId: input.planId, deliverableId: input.deliverableId, briefId: brief.id, jobId: result.job.id, optimizedDraftId: optimizedDraft?.id || null, contentHash: optimizedDraft && typeof optimizedDraft.contentHash === 'string' ? optimizedDraft.contentHash : null, riskGateId: riskGate && 'id' in riskGate && typeof riskGate.id === 'number' ? riskGate.id : null, riskGateDecision: riskGate && typeof riskGate.status === 'string' ? riskGate.status : null, resultingStatus: result.job.status }

}

/** Standalone owner request. Governed Production Plans use runOwnerProductionPlan below. */
export async function runOwnerAutoGeoContentJob(input: { ownerUserId: number, briefId: number, document: GeoDocumentInput, idempotencyKey: string, jobId?: number }) {
  const brief = await getOwnerContentBrief(input.ownerUserId, input.briefId)
  if (brief.status !== 'ready_for_generation') throw createError({ statusCode: 422, statusMessage: 'Content Brief is not ready for generation.' })
  if (brief.language !== input.document.language) throw createError({ statusCode: 422, statusMessage: 'Document language must match the approved Content Brief.' })
  const approvedEvidence = await resolveApprovedEvidenceSnapshot(input.ownerUserId, (Array.isArray(brief.evidenceRefs) ? brief.evidenceRefs : []) as EvidenceRef[], 'content_draft', { requireArtifact: true })
  if (approvedEvidence.hash !== brief.evidenceSnapshotHash) throw createError({ statusCode: 409, statusMessage: 'Content Brief evidence snapshot is stale; create a new Brief before generating.' })
  const requestedRuntime = resolveProductionRuntimeProviders()
  const job = input.jobId ? await getOwnerContentJob(input.ownerUserId, input.jobId) : await createContentJob({ ownerUserId: input.ownerUserId, briefId: brief.id, operation: 'content_draft', providerMode: requestedRuntime.mode, idempotencyKey: input.idempotencyKey, productionPlanId: brief.productionPlanId ?? undefined, strategyRecommendationId: brief.strategyRecommendationId ?? undefined, productionDeliverableId: brief.productionDeliverableId ?? undefined })
  if (job.briefId !== brief.id || job.operation !== 'content_draft') throw createError({ statusCode: 422, statusMessage: 'Job must belong to this Brief and use the content_draft operation.' })
  if (input.jobId && job.idempotencyKey !== input.idempotencyKey) throw createError({ statusCode: 409, statusMessage: 'The supplied idempotency key does not match this content job.' })
  if (brief.productionPlanId && brief.productionDeliverableId) {
    const context = await resolveProductionContext({ ownerUserId: input.ownerUserId, planId: brief.productionPlanId, deliverableId: brief.productionDeliverableId, includeArtifacts: true })
    return runOwnerProductionDeliverableInternal({ ownerUserId: input.ownerUserId, context: { ...context, brief, job }, job })
  }
  if (job.status === 'candidate_ready' || job.status === 'needs_human_review' || job.status === 'approved' || job.status === 'blocked') return { job, replayed: true }
  await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'processing' })
  try {
    const source = { ...input.document, approvedEvidenceContext: approvedEvidence.context, approvedBriefGoals: arrayOfStrings(brief.goals), approvedBriefConstraints: arrayOfStrings(brief.constraints) }
    const runtimeProviders = resolveProductionRuntimeProviders(job.providerMode)
    const result = await optimiseGeoDocument(source, runtimeProviders.optimizationAdapter)
    const candidate = result.candidate
    const riskGate = evaluateContentRisk({ source: result.original, candidateTitle: candidate.optimizedTitle, candidateBody: candidate.optimizedContent, evidenceCount: approvedEvidence.refs.length })
    const draft = await saveContentCandidate({ jobId: job.id, title: candidate.optimizedTitle, body: candidate.optimizedContent, contentHash: contentFingerprint(candidate.optimizedTitle, candidate.optimizedContent), sourceMode: candidate.provider === 'reference-rules-v1' ? 'reference_fallback' : 'provider_candidate', provenance: { ...candidate.provenance, stage: 'optimized', generationMode: 'standalone-optimization', rulesetVersion: result.rulesetVersion, runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? candidate.provenance.fallbackReason ?? null }, evidenceRefs: approvedEvidence.refs, safetyStatus: riskGate.status === 'blocked' ? 'blocked' : riskGate.status === 'needs_human_review' ? 'needs_review' : 'passed', safetyNotes: [...candidate.safetyNotes, result.interpretationLimit] })
    await saveRiskGate({ draftId: draft.id, result: riskGate, evidenceSnapshotHash: approvedEvidence.hash })
    const finalStatus = riskGate.status === 'blocked' ? 'blocked' : 'needs_human_review'
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: finalStatus, providerProvenance: { stage: 'standalone-optimization', provider: candidate.provider, appliedRuleIds: candidate.appliedRuleIds, runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? candidate.provenance.fallbackReason ?? null } })
    return { job: { ...job, status: finalStatus }, draft: { id: draft.id, version: draft.version, sourceMode: draft.sourceMode }, result, riskGate, replayed: false }
  } catch (error) {
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'failed', errorCode: 'candidate_generation_failed', errorSummary: error instanceof Error ? error.message.slice(0, 500) : 'Unknown candidate generation error' })
    throw error
  }
}

export async function runOwnerProductionPlan(input: { ownerUserId: number, planId: number, dependencies?: ProductionRuntimeDependencies }) {
  const current = await getProductionPlanBundle(input.ownerUserId, input.planId)
  if (current.plan.status === 'completed' || current.plan.status === 'blocked') return { ...current, generated: [], replayed: true }
  const prepared = await prepareProductionPlanGeneration(input.ownerUserId, input.planId)
  const generated: Array<{ deliverableId: number, jobId: number, status: string, baseDraftId?: number, draftId?: number }> = []
  for (const item of prepared.prepared) {
    try {
      const context = await resolveProductionContext({ ownerUserId: input.ownerUserId, planId: input.planId, deliverableId: item.deliverableId, includeArtifacts: true })
      const brief = context.brief || await createCanonicalProductionBrief(input.ownerUserId, context)
      const job = context.job || await getOwnerContentJob(input.ownerUserId, item.jobId)
      const result = await runOwnerProductionDeliverableInternal({ ownerUserId: input.ownerUserId, context: { ...context, brief, job }, job, dependencies: input.dependencies })
      generated.push({ deliverableId: item.deliverableId, jobId: item.jobId, status: result.job.status, baseDraftId: 'baseDraft' in result ? result.baseDraft?.id : undefined, draftId: 'draft' in result ? result.draft?.id : undefined })
    } catch {
      generated.push({ deliverableId: item.deliverableId, jobId: item.jobId, status: 'blocked' })
    }
  }
  await recalculateProductionPlanStatus(input.ownerUserId, input.planId)
  return { ...await getProductionPlanBundle(input.ownerUserId, input.planId), generated, replayed: false }
}
