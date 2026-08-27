import { fingerprint } from './canonical'
import { DEVELOPMENT_GATE, GEO_OUTCOME_FEATURE_CATALOG_VERSION, GEO_OUTCOME_HARD_NEGATIVE_POLICY_VERSION, GEO_OUTCOME_LABEL_CONTRACT_VERSION, GEO_OUTCOME_SCHEMA_VERSION, GEO_OUTCOME_SPLIT_POLICY_VERSION, MAX_OBSERVATIONS, SHADOW_GATE } from './constants'
import { deriveFeatureVector } from './feature-catalog'
import { canBePrimaryCitationTruth, isHardNegativeCandidate, isCitationSelectionLabel } from './observation-contract'
import { assertDisjointComplete, splitDatasetMembers, splitFingerprint } from './split-policy'
import type { DatasetManifest, DatasetMember, DatasetReadiness, OutcomeObservation, SplitAssignment } from './types'

function queryGroupKey(observation: OutcomeObservation): string { return fingerprint({ runIdentity: observation.runIdentity, normalizedQueryHash: observation.normalizedQueryHash, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, region: observation.region, observationWindow: observation.observationWindow }) }
function identityKey(observation: OutcomeObservation): string { return fingerprint({ ownerUserId: observation.ownerUserId, runIdentity: observation.runIdentity, normalizedQueryHash: observation.normalizedQueryHash, candidatePageIdentityHash: observation.candidatePageIdentityHash, engine: observation.engine, model: observation.model, modelVersion: observation.modelVersion, interface: observation.interface, locale: observation.locale, observationWindow: observation.observationWindow }) }
function countBy(values: readonly string[]): Record<string, number> { return values.reduce<Record<string, number>>((acc, value) => { acc[value] = (acc[value] || 0) + 1; return acc }, {}) }
function splitRows(split: SplitAssignment | null, name: keyof SplitAssignment): number { return split ? split[name].length : 0 }
function setAssignments(members: DatasetMember[], split: SplitAssignment | null): DatasetMember[] { if (!split) return members; const assignment = new Map<string, DatasetMember['splitAssignment']>(); for (const [name, rows] of Object.entries(split)) for (const row of rows) assignment.set(row, name as DatasetMember['splitAssignment']); return members.map(member => ({ ...member, splitAssignment: assignment.get(member.observationFingerprint) })) }

export function getDatasetReadiness(input: { candidates: number, queryGroups: number, websites: number, engines: number, positives: number, hardNegatives: number, observationSpanDays: number | null }): DatasetReadiness {
  const missing: string[] = []
  if (input.candidates < DEVELOPMENT_GATE.minCandidates) missing.push(`至少需要 ${DEVELOPMENT_GATE.minCandidates} 個合法 outcome candidates，目前 ${input.candidates}`)
  if (input.queryGroups < DEVELOPMENT_GATE.minQueryGroups) missing.push(`至少需要 ${DEVELOPMENT_GATE.minQueryGroups} 個 query groups，目前 ${input.queryGroups}`)
  if (input.websites < DEVELOPMENT_GATE.minWebsites) missing.push(`至少需要 ${DEVELOPMENT_GATE.minWebsites} 個 websites，目前 ${input.websites}`)
  if (input.engines < DEVELOPMENT_GATE.minEngines) missing.push(`至少需要 ${DEVELOPMENT_GATE.minEngines} 個 engines/interfaces，目前 ${input.engines}`)
  if (input.positives < DEVELOPMENT_GATE.minPositives) missing.push(`至少需要 ${DEVELOPMENT_GATE.minPositives} 個 positives，目前 ${input.positives}`)
  if (input.hardNegatives < DEVELOPMENT_GATE.minHardNegatives) missing.push(`至少需要 ${DEVELOPMENT_GATE.minHardNegatives} 個 verified hard negatives，目前 ${input.hardNegatives}`)
  if (input.observationSpanDays === null || input.observationSpanDays < DEVELOPMENT_GATE.minObservationSpanDays) missing.push(`observation span 至少 ${DEVELOPMENT_GATE.minObservationSpanDays} 天，目前 ${input.observationSpanDays === null ? '不可計算' : `${input.observationSpanDays} 天`}`)
  return { ready: missing.length === 0, status: missing.length === 0 ? 'ready' : 'insufficient_data', missing }
}
export function getShadowReadiness(input: { candidates: number, queryGroups: number, websites: number, engines: number, positives: number, hardNegatives: number, observationSpanDays: number | null, temporalHoldoutCount: number, hasPrimaryEvidence: boolean }): DatasetReadiness {
  const missing: string[] = []
  if (input.candidates < SHADOW_GATE.minCandidates) missing.push(`Shadow 至少需要 ${SHADOW_GATE.minCandidates} 個合法 outcome candidates，目前 ${input.candidates}`)
  if (input.queryGroups < SHADOW_GATE.minQueryGroups) missing.push(`Shadow 至少需要 ${SHADOW_GATE.minQueryGroups} 個 query groups，目前 ${input.queryGroups}`)
  if (input.websites < SHADOW_GATE.minWebsites) missing.push(`Shadow 至少需要 ${SHADOW_GATE.minWebsites} 個 websites，目前 ${input.websites}`)
  if (input.engines < SHADOW_GATE.minEngines) missing.push(`Shadow 至少需要 ${SHADOW_GATE.minEngines} 個 engines/interfaces，目前 ${input.engines}`)
  if (input.positives < SHADOW_GATE.minPositives) missing.push(`Shadow 至少需要 ${SHADOW_GATE.minPositives} 個 positives，目前 ${input.positives}`)
  if (input.hardNegatives < SHADOW_GATE.minHardNegatives) missing.push(`Shadow 至少需要 ${SHADOW_GATE.minHardNegatives} 個 verified hard negatives，目前 ${input.hardNegatives}`)
  if (input.observationSpanDays === null || input.observationSpanDays < SHADOW_GATE.minObservationSpanDays) missing.push(`Shadow observation span 至少 ${SHADOW_GATE.minObservationSpanDays} 天，目前 ${input.observationSpanDays === null ? '不可計算' : `${input.observationSpanDays} 天`}`)
  if (input.temporalHoldoutCount === 0) missing.push('Shadow 必須有 temporal holdout。')
  if (!input.hasPrimaryEvidence) missing.push('Shadow 必須有 manual_verified_primary 或 consumer_surface_observed evidence。')
  return { ready: missing.length === 0, status: missing.length === 0 ? 'ready' : 'insufficient_data', missing }
}

export interface DatasetBuildResult { manifest: DatasetManifest, members: DatasetMember[], split: SplitAssignment | null }

export function buildCitationSelectionDataset(observations: readonly OutcomeObservation[], ownerUserId: number): DatasetBuildResult {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error('ownerUserId must be server-derived.')
  if (observations.length > MAX_OBSERVATIONS) throw new Error('Too many observations.')
  if (observations.some(observation => observation.ownerUserId !== ownerUserId)) throw new Error('Owner isolation failed.')
  const seenIdentity = new Set<string>()
  for (const observation of observations) { const identity = identityKey(observation); if (seenIdentity.has(identity)) throw new Error('Duplicate candidate identity.'); seenIdentity.add(identity) }
  const eligible = observations.filter(observation => isCitationSelectionLabel(observation) && canBePrimaryCitationTruth(observation))
  const positives = eligible.filter(observation => observation.citationStatus === 'cited')
  const membersByFingerprint = new Map<string, DatasetMember>()
  for (const positive of positives) {
    const hardNegatives = eligible.filter(item => isHardNegativeCandidate(item, positive))
    if (!hardNegatives.length) continue
    const positiveMember: DatasetMember = { observationFingerprint: positive.observationFingerprint, websiteIdentityHash: positive.websiteIdentityHash, normalizedQueryHash: positive.normalizedQueryHash, runIdentity: positive.runIdentity, queryGroupKey: queryGroupKey(positive), label: 1, hardNegative: false, consentStatus: positive.consentStatus, piiStatus: positive.piiStatus, reviewFingerprint: positive.reviewFingerprint, featureVector: deriveFeatureVector(positive), observation: positive }
    membersByFingerprint.set(positive.observationFingerprint, positiveMember)
    for (const candidate of hardNegatives) if (!membersByFingerprint.has(candidate.observationFingerprint)) membersByFingerprint.set(candidate.observationFingerprint, { observationFingerprint: candidate.observationFingerprint, websiteIdentityHash: candidate.websiteIdentityHash, normalizedQueryHash: candidate.normalizedQueryHash, runIdentity: candidate.runIdentity, queryGroupKey: queryGroupKey(candidate), label: 0, hardNegative: true, consentStatus: candidate.consentStatus, piiStatus: candidate.piiStatus, reviewFingerprint: candidate.reviewFingerprint, featureVector: deriveFeatureVector(candidate), observation: candidate })
  }
  let members = [...membersByFingerprint.values()].sort((a, b) => a.observationFingerprint < b.observationFingerprint ? -1 : a.observationFingerprint > b.observationFingerprint ? 1 : 0)
  const timestamps = members.map(member => new Date(member.observation.runTimestamp).getTime()).filter(Number.isFinite)
  const observationStart = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null; const observationEnd = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null; const spanDays = observationStart && observationEnd ? Math.floor((new Date(observationEnd).getTime() - new Date(observationStart).getTime()) / 86_400_000) : null
  const splitReadiness = getDatasetReadiness({ candidates: members.length, queryGroups: new Set(members.map(member => member.queryGroupKey)).size, websites: new Set(members.map(member => member.websiteIdentityHash)).size, engines: new Set(members.map(member => `${member.observation.engine}:${member.observation.interface}`)).size, positives: members.filter(member => member.label === 1).length, hardNegatives: members.filter(member => member.hardNegative).length, observationSpanDays: spanDays })
  let split: SplitAssignment | null = null; let splitFailure: string | null = null
  try { split = splitDatasetMembers(members) } catch (error) { splitFailure = error instanceof Error ? error.message : 'gate_blocked: split failed.' }
  members = setAssignments(members, split)
  if (split) assertDisjointComplete(split, members)
  const missing = [...splitReadiness.missing]; if (splitFailure) missing.push(splitFailure)
  const readiness: DatasetReadiness = { ready: splitReadiness.ready && !splitFailure, status: splitReadiness.ready && !splitFailure ? 'ready' : splitFailure ? 'gate_blocked' : 'insufficient_data', missing }
  const splitLists = split || { train: [], validation: [], test: [], temporalHoldout: [], siteHoldout: [], queryHoldout: [] }
  const sourcePayload = { schemaVersion: GEO_OUTCOME_SCHEMA_VERSION, taskType: 'citation_selection' as const, featureCatalogVersion: GEO_OUTCOME_FEATURE_CATALOG_VERSION, labelContractVersion: GEO_OUTCOME_LABEL_CONTRACT_VERSION, hardNegativePolicyVersion: GEO_OUTCOME_HARD_NEGATIVE_POLICY_VERSION, sourceObservationFingerprints: members.map(member => member.observationFingerprint).sort(), sourceBasisCounts: countBy(members.map(member => member.observation.labelBasis)), engineCounts: countBy(members.map(member => `${member.observation.engine}:${member.observation.interface}`)), localeCounts: countBy(members.map(member => member.observation.locale)), websiteCount: new Set(members.map(member => member.websiteIdentityHash)).size, queryGroupCount: new Set(members.map(member => member.queryGroupKey)).size, positiveCount: members.filter(member => member.label === 1).length, hardNegativeCount: members.filter(member => member.hardNegative).length, observationStart, observationEnd, splitPolicyVersion: GEO_OUTCOME_SPLIT_POLICY_VERSION, trainFingerprints: splitLists.train, validationFingerprints: splitLists.validation, testFingerprints: splitLists.test, siteHoldoutFingerprints: splitLists.siteHoldout, queryHoldoutFingerprints: splitLists.queryHoldout, temporalHoldoutFingerprints: splitLists.temporalHoldout, trainRowCount: splitRows(split, 'train'), validationRowCount: splitRows(split, 'validation'), testRowCount: splitRows(split, 'test'), siteHoldoutRowCount: splitRows(split, 'siteHoldout'), queryHoldoutRowCount: splitRows(split, 'queryHoldout'), temporalHoldoutRowCount: splitRows(split, 'temporalHoldout'), limitations: ['citation-selection labels require verified consumer-surface or owner-reviewed evidence.', 'unobserved pages are not negative examples.', 'provider API, GSC, GA4, and heuristic labels are not primary citation truth.', 'a passing development gate does not imply production readiness.', ...missing] }
  const manifestFingerprint = fingerprint(sourcePayload); const manifest: DatasetManifest = { manifestId: `geo-dataset-${manifestFingerprint.slice(0, 20)}`, ...sourcePayload, manifestFingerprint, readiness, status: readiness.ready ? 'ready_for_review' : 'gate_blocked', ownerUserId, createdAt: new Date(0).toISOString() }
  return { manifest, members, split }
}

export function buildStructuralAuxiliaryManifest(input: { ownerUserId: number, exampleFingerprints: string[], approvedCount: number, featureCatalogVersion?: string }): DatasetManifest {
  const featureCatalog = input.featureCatalogVersion || GEO_OUTCOME_FEATURE_CATALOG_VERSION; const source = { schemaVersion: GEO_OUTCOME_SCHEMA_VERSION, taskType: 'structural_readiness_auxiliary' as const, featureCatalogVersion: featureCatalog, labelContractVersion: GEO_OUTCOME_LABEL_CONTRACT_VERSION, hardNegativePolicyVersion: 'not_applicable_structural_auxiliary', sourceObservationFingerprints: [...input.exampleFingerprints].sort(), sourceBasisCounts: { heuristic_auxiliary_only: input.approvedCount }, engineCounts: {}, localeCounts: {}, websiteCount: 0, queryGroupCount: 0, positiveCount: 0, hardNegativeCount: 0, observationStart: null, observationEnd: null, splitPolicyVersion: 'not_applicable_structural_auxiliary', trainFingerprints: [], validationFingerprints: [], testFingerprints: [], siteHoldoutFingerprints: [], queryHoldoutFingerprints: [], temporalHoldoutFingerprints: [], trainRowCount: 0, validationRowCount: 0, testRowCount: 0, siteHoldoutRowCount: 0, queryHoldoutRowCount: 0, temporalHoldoutRowCount: 0, limitations: ['This auxiliary dataset uses manually approved structural examples and heuristic labels only.', 'It must not be described as real AI citation outcome data.'] }
  const manifestFingerprint = fingerprint(source); const readiness: DatasetReadiness = input.approvedCount > 0 ? { ready: true, status: 'ready', missing: [] } : { ready: false, status: 'insufficient_data', missing: ['No approved structural examples are available.'] }
  return { manifestId: `geo-structural-${manifestFingerprint.slice(0, 20)}`, ...source, manifestFingerprint, readiness, status: readiness.ready ? 'ready_for_review' : 'gate_blocked', ownerUserId: input.ownerUserId, createdAt: new Date(0).toISOString() }
}
