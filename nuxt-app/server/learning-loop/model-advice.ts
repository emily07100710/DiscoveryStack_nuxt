import { z } from 'zod'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../content-operations/repository'
import { fingerprint } from '../geo-outcome-model/canonical'
import { getProductionGeoOutcomeRepository, predict, resolveApprovedFallbackForArtifact } from '../geo-outcome-model/service'
import { canBePrimaryCitationTruth } from '../geo-outcome-model/observation-contract'
import { verifyArtifactHash } from '../geo-outcome-model/release-gate'
import { isFallbackOnlyArtifact } from '../geo-outcome-model/artifact'
import { approvalReference, assertDatasetKnowledgeAuthorityCurrent } from '../geo-outcome-model/knowledge-authority'
import type { ContentFeatureInput, GeoOutcomeRepositoryPort } from '../geo-outcome-model/types'
import { contentFingerprint } from '../seo-geo-core/riskGate'
import { DrizzleLearningLoopRepository } from './repository'
import { learningError, resolveLearningAuthority } from './authority'
import type { LearningLoopRepository } from './types'

const schema = z.object({ entryId: z.number().int().positive(), artifactId: z.string().regex(/^geo-model-[a-f0-9]{20,64}$/) }).strict()
export type DraftAdviceDependencies = { operations?: ContentOperationsRepository; learning?: LearningLoopRepository; models?: GeoOutcomeRepositoryPort; now?: Date | (() => Date) }
const draftIdentity = (lineage: NonNullable<Awaited<ReturnType<ContentOperationsRepository['resolveWorkspaceEntry']>>>) => fingerprint({ entryId: lineage.entry.id, ownerUserId: lineage.entry.ownerUserId, clientId: lineage.client.id, origin: lineage.client.canonicalSiteOrigin, draftId: lineage.draft?.id, draftVersion: lineage.draft?.version, contentHash: lineage.entry.contentHash, evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash, contentType: lineage.entry.contentType, language: lineage.entry.language, opportunityKey: lineage.deliverable.opportunityKey })

/** Evaluate a server-read exact draft. Scores never replace quality review or customer approval. */
export async function getDraftLearningAdvice(ownerUserId: number, value: unknown, deps: DraftAdviceDependencies = {}) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) learningError('INVALID_DRAFT_ADVICE_INPUT', '請選擇草稿和已通過影子驗證的模型。', 422)
  const readNow = () => typeof deps.now === 'function' ? deps.now() : deps.now || new Date()
  const operations = deps.operations || createContentOperationsRepository(), learning = deps.learning || new DrizzleLearningLoopRepository(), models = deps.models || getProductionGeoOutcomeRepository(), now = readNow()
  const lineage = await operations.resolveWorkspaceEntry(ownerUserId, parsed.data.entryId)
  if (!lineage || lineage.client.ownerUserId !== ownerUserId || lineage.entry.ownerUserId !== ownerUserId || !lineage.draft || typeof lineage.draft.title !== 'string' || typeof lineage.draft.body !== 'string' || lineage.draft.contentHash !== lineage.entry.contentHash || contentFingerprint(lineage.draft.title, lineage.draft.body) !== lineage.draft.contentHash) learningError('EXACT_DRAFT_REQUIRED')
  const exactDraftIdentity = draftIdentity(lineage)
  let grantedScope: { id: number; authorizationFingerprint: string; sourceFingerprint: string } | null = null
  for (const grant of (await learning.listAuthorizations(ownerUserId)).filter(row => row.clientId === lineage.client.id)) {
    const current = resolveLearningAuthority(await learning.getScope(ownerUserId, grant.id), { ownerUserId, clientId: grant.clientId, sourceId: grant.sourceId }, now)
    if (current) { grantedScope = { id: grant.id, authorizationFingerprint: grant.authorizationFingerprint, sourceFingerprint: current.sourceFingerprint }; break }
  }
  if (!grantedScope) learningError('CURRENT_LEARNING_CONSENT_REQUIRED')
  const artifact = await models.getArtifact(ownerUserId, parsed.data.artifactId)
  if (!artifact || isFallbackOnlyArtifact(artifact) || artifact.status !== 'approved_for_shadow' || artifact.taskType !== 'citation_selection' || !verifyArtifactHash(artifact)) learningError('OWNER_SHADOW_MODEL_REQUIRED')
  const dataset = (await models.listDatasets(ownerUserId)).find(row => row.manifestFingerprint === artifact.datasetManifestFingerprint)
  const decision = (await models.listDatasetDecisions(ownerUserId)).filter(row => row.manifestFingerprint === dataset?.manifestFingerprint && row.manifestId === dataset?.manifestId).at(-1)
  const members = dataset ? await models.getDatasetMembers(ownerUserId, dataset.manifestId) : []
  if (!dataset || dataset.status !== 'approved' || decision?.newStatus !== 'approved' || !members.length || members.some(row => !canBePrimaryCitationTruth(row.observation))) learningError('CURRENT_MODEL_LINEAGE_REQUIRED')
  let modelKnowledgeReference
  try { modelKnowledgeReference = (await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, models, approvalReference(artifact))).reference } catch { learningError('CURRENT_MODEL_LINEAGE_REQUIRED') }
  // Use an actually represented engine/interface context; missing page features stay missing.
  const context = members[0]!.observation, draft = lineage.draft, body = draft.body as string
  const headings = [...body.matchAll(/^#{1,6}\s+/gm)].map(match => match[0].trim().length)
  const features: ContentFeatureInput = {
    contentType: lineage.entry.contentType === 'article' || lineage.entry.contentType === 'faq' ? lineage.entry.contentType : 'other',
    locale: lineage.entry.language, pageAgeBucket: 'unknown', contentLengthBucket: body.length < 500 ? 'xs' : body.length < 2000 ? 's' : body.length < 6000 ? 'm' : body.length < 12000 ? 'l' : 'xl',
    headingHierarchy: !headings.length ? 'none' : new Set(headings).size > 1 ? 'structured' : 'flat', directAnswerPresence: 'unknown', faqStructure: 'unknown', structuredDataPresence: 'unknown', citationMarkerCount: Math.min(1000, [...body.matchAll(/\[cite:[^\]]+\]/g)].length), approvedAuthoritySourceCount: null, evidenceUtilizationRatio: null, entityCoverage: null,
    selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'unknown', indexabilityFlag: 'unknown', internalLinkDepthBucket: 'unknown', contentFreshnessBucket: 'unknown', queryPageLexicalOverlap: null, topicClusterEqual: 'unknown', verifiedPublicationAgeDays: null, priorObservationCount: null,
  }
  const timestamp = now.toISOString(), runIdentity = `draft-advice:${fingerprint({ entryId: lineage.entry.id, draftId: draft.id, contentHash: draft.contentHash }).slice(0, 24)}`
  const input = { schemaVersion: 'geo-outcome-observation-v1', projectId: null, clientId: null, websiteIdentityHash: fingerprint(lineage.client.canonicalSiteOrigin), queryIdentityHash: fingerprint(lineage.deliverable.opportunityKey), normalizedQueryHash: fingerprint(lineage.deliverable.opportunityKey), candidatePageIdentityHash: fingerprint({ entryId: lineage.entry.id, contentHash: draft.contentHash }), canonicalPageHash: fingerprint({ entryId: lineage.entry.id }), contentHash: draft.contentHash, evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash, publicationReceiptFingerprint: null,
    engine: context.engine, model: context.model, modelVersion: context.modelVersion, interface: context.interface, locale: lineage.entry.language, region: context.region, runIdentity, runTimestamp: timestamp, observationWindow: { start: timestamp, end: timestamp }, observableStatus: 'not_observable', retrievalStatus: 'unknown', citationStatus: 'unknown', citationPosition: null, mentionStatus: 'unknown', recommendationStatus: 'unknown', labelBasis: 'heuristic_auxiliary_only', verificationStatus: 'unverified', evidenceLocatorHashes: [], appliedRuleHashes: [], contentFeatureVector: features }
  let prediction: Awaited<ReturnType<typeof predict>>
  try { prediction = await predict(ownerUserId, artifact.artifactId, input, models) }
  catch { learningError('ADVICE_LINEAGE_CHANGED', '模型、回退基準或資料授權已變動，請更新後重新核對。') }
  // A revocation or draft edit while scoring prevents even an advisory from being accepted as current.
  const fresh = await operations.resolveWorkspaceEntry(ownerUserId, lineage.entry.id)
  const freshArtifact = await models.getArtifact(ownerUserId, artifact.artifactId)
  const freshDataset = await models.getDataset(ownerUserId, dataset.manifestId)
  const freshDecision = (await models.listDatasetDecisions(ownerUserId)).filter(row => row.manifestFingerprint === dataset.manifestFingerprint && row.manifestId === dataset.manifestId).at(-1)
  const freshMembers = await models.getDatasetMembers(ownerUserId, dataset.manifestId)
  const freshGrant = await learning.getScope(ownerUserId, grantedScope.id)
  const freshAuthority = freshGrant ? resolveLearningAuthority(freshGrant, { ownerUserId, clientId: lineage.client.id, sourceId: freshGrant.authorization.sourceId }, readNow()) : null
  if (!fresh || draftIdentity(fresh) !== exactDraftIdentity || fresh.draft?.id !== draft.id || fresh.draft.contentHash !== draft.contentHash || fresh.entry.contentHash !== draft.contentHash || typeof fresh.draft.title !== 'string' || typeof fresh.draft.body !== 'string' || contentFingerprint(fresh.draft.title, fresh.draft.body) !== draft.contentHash || freshArtifact?.artifactHash !== prediction.modelArtifactHash || freshArtifact.status !== 'approved_for_shadow' || !verifyArtifactHash(freshArtifact) || freshGrant?.authorization.authorizationFingerprint !== grantedScope.authorizationFingerprint || freshAuthority?.sourceFingerprint !== grantedScope.sourceFingerprint || freshDataset?.status !== 'approved' || freshDataset.manifestFingerprint !== dataset.manifestFingerprint || freshDecision?.newStatus !== 'approved' || fingerprint(freshMembers) !== fingerprint(members) || freshMembers.some(row => !canBePrimaryCitationTruth(row.observation))) learningError('ADVICE_LINEAGE_CHANGED')
  try { await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, freshDataset, models, modelKnowledgeReference) } catch { learningError('ADVICE_LINEAGE_CHANGED') }
  if (!await resolveApprovedFallbackForArtifact(ownerUserId, freshArtifact, models)) learningError('ADVICE_LINEAGE_CHANGED', '回退模型的核准或資料授權已變動，請更新後重新核對。')
  const advice = { contractVersion: 'exact-draft-model-advice-v1', entryId: lineage.entry.id, draftId: draft.id, draftVersion: draft.version, contentHash: draft.contentHash, modelArtifactHash: prediction.modelArtifactHash, datasetManifestHash: prediction.datasetManifestHash, experimentalScore: prediction.experimentalScore, representedContext: { engine: context.engine, interface: context.interface }, featureContributions: prediction.featureContributions.filter(row => !row.missing && !prediction.missingFeatureList.includes(row.key)).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 8), missingFeatureList: prediction.missingFeatureList, predictionIsVerifiedOutcome: false as const, publicationAuthorization: false as const, productionModelActivation: false as const, limitations: [...prediction.limitations, 'single_draft_advisory_not_a_market_ranking', 'unknown_features_not_inferred', 'does_not_edit_or_publish_content', 'exact_customer_approval_remains_required'] }
  return { ...advice, adviceFingerprint: fingerprint(advice) }
}
