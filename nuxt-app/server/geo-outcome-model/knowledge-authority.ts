import { canonicalJson, fingerprint } from './canonical'
import type { DatasetDecision, DatasetDecisionSummary, DatasetManifest, GeoOutcomeRepositoryPort } from './types'
import type { DatasetKnowledgeApprovalReference, DatasetKnowledgeAuthority, DatasetKnowledgeAuthoritySummary, DatasetKnowledgeHead, DatasetKnowledgeMode, DatasetKnowledgeState } from './knowledge-authority-types'

const HASH = /^[a-f0-9]{64}$/u
const STATE_KEYS = ['ownerUserId', 'manifestId', 'manifestFingerprint', 'nativeDatasetId', 'heads']
const HEAD_KEYS = ['subjectKind', 'subjectId', 'operation', 'sequenceNumber', 'bindingFingerprint', 'revisionNumber', 'revisionContentHash', 'revisionFingerprint', 'currentRevisionFingerprint']
const fail = (code: string): never => { throw new DatasetKnowledgeAuthorityError(code) }
export class DatasetKnowledgeAuthorityError extends Error {
  constructor(readonly code: string) { super(`Dataset Knowledge authority rejected: ${code}.`); this.name = 'DatasetKnowledgeAuthorityError' }
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function id(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 }
function hash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value) }
function businessId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u0020\u007f]/u.test(value) }
function headOrder(left: DatasetKnowledgeHead, right: DatasetKnowledgeHead): number { return left.subjectKind.localeCompare(right.subjectKind, 'en') || left.subjectId - right.subjectId }
function normalizedState(raw: unknown): DatasetKnowledgeState {
  if (!record(raw) || !exactKeys(raw, STATE_KEYS) || !id(raw.ownerUserId) || !id(raw.nativeDatasetId) || !businessId(raw.manifestId) || !hash(raw.manifestFingerprint) || !Array.isArray(raw.heads) || raw.heads.length > 2_000) return fail('corrupt_dependency_state')
  const seen = new Set<string>()
  for (const head of raw.heads) {
    if (!record(head) || !exactKeys(head, HEAD_KEYS) || !['entity', 'claim', 'source'].includes(String(head.subjectKind)) || !id(head.subjectId) || !['bind', 'revoke'].includes(String(head.operation)) || !id(head.sequenceNumber) || !id(head.revisionNumber) || !hash(head.bindingFingerprint) || !hash(head.revisionContentHash) || !hash(head.revisionFingerprint) || head.currentRevisionFingerprint !== null && !hash(head.currentRevisionFingerprint) || head.operation === 'revoke' && head.currentRevisionFingerprint !== null) return fail('corrupt_dependency_state')
    const key = `${head.subjectKind}:${head.subjectId}`
    if (seen.has(key)) return fail('duplicate_dependency_head')
    seen.add(key)
  }
  return { ownerUserId: raw.ownerUserId, manifestId: raw.manifestId, manifestFingerprint: raw.manifestFingerprint, nativeDatasetId: raw.nativeDatasetId, heads: structuredClone(raw.heads as DatasetKnowledgeHead[]).sort(headOrder) }
}
export function buildDatasetKnowledgeAuthority(state: DatasetKnowledgeState, mode: DatasetKnowledgeMode): DatasetKnowledgeAuthority {
  if (mode !== 'declared_none_v1' && mode !== 'pinned_v1') return fail('explicit_dependency_declaration_required')
  const current = normalizedState(state)
  const active = current.heads.filter(head => head.operation === 'bind')
  if (mode === 'declared_none_v1' && active.length) return fail('active_dependencies_require_pinned_declaration')
  if (mode === 'pinned_v1' && !active.length) return fail('pinned_declaration_requires_active_dependencies')
  if (active.some(head => head.currentRevisionFingerprint !== head.revisionFingerprint)) return fail('knowledge_revision_stale')
  const body = { schemaVersion: 'geo-dataset-knowledge-authority-v1' as const, ...current, mode }
  return { ...body, authorityFingerprint: fingerprint(body) }
}
export function assertValidDatasetKnowledgeAuthority(raw: unknown): asserts raw is DatasetKnowledgeAuthority {
  if (!record(raw) || !exactKeys(raw, [...STATE_KEYS, 'schemaVersion', 'mode', 'authorityFingerprint']) || raw.schemaVersion !== 'geo-dataset-knowledge-authority-v1' || !hash(raw.authorityFingerprint)) return fail('corrupt_dependency_approval')
  const rebuilt = buildDatasetKnowledgeAuthority({ ownerUserId: raw.ownerUserId, manifestId: raw.manifestId, manifestFingerprint: raw.manifestFingerprint, nativeDatasetId: raw.nativeDatasetId, heads: raw.heads } as DatasetKnowledgeState, raw.mode as DatasetKnowledgeMode)
  if (rebuilt.authorityFingerprint !== raw.authorityFingerprint || canonicalJson(rebuilt) !== canonicalJson(raw)) return fail('corrupt_dependency_approval')
}
export function assertValidApprovalReference(raw: unknown): asserts raw is DatasetKnowledgeApprovalReference {
  if (!record(raw) || !exactKeys(raw, ['datasetDecisionId', 'knowledgeAuthorityFingerprint']) || !businessId(raw.datasetDecisionId) || !hash(raw.knowledgeAuthorityFingerprint)) return fail('dependency_approval_reference_required')
}
export function referencesEqual(left: DatasetKnowledgeApprovalReference, right: DatasetKnowledgeApprovalReference): boolean {
  return left.datasetDecisionId === right.datasetDecisionId && left.knowledgeAuthorityFingerprint === right.knowledgeAuthorityFingerprint
}
export function approvalReference(value: { datasetDecisionId?: string, knowledgeAuthorityFingerprint?: string }): DatasetKnowledgeApprovalReference {
  const reference = { datasetDecisionId: value.datasetDecisionId, knowledgeAuthorityFingerprint: value.knowledgeAuthorityFingerprint }
  assertValidApprovalReference(reference)
  return reference
}
export function summarizeDatasetDecision(decision: DatasetDecision): DatasetDecisionSummary {
  let knowledgeAuthority: DatasetDecisionSummary['knowledgeAuthority'] = null
  if (decision.knowledgeAuthority) {
    assertValidDatasetKnowledgeAuthority(decision.knowledgeAuthority)
    knowledgeAuthority = { mode: decision.knowledgeAuthority.mode, authorityFingerprint: decision.knowledgeAuthority.authorityFingerprint, activePinCount: decision.knowledgeAuthority.heads.filter(head => head.operation === 'bind').length }
  }
  // Whitelist the HTTP receipt instead of spreading private persisted envelopes.
  return { decisionId: decision.decisionId, ownerUserId: decision.ownerUserId, manifestId: decision.manifestId, previousStatus: decision.previousStatus, newStatus: decision.newStatus, reviewerUserId: decision.reviewerUserId, reason: decision.reason, manifestFingerprint: decision.manifestFingerprint, createdAt: decision.createdAt, knowledgeAuthority }
}
export async function assertDatasetKnowledgeAuthorityCurrent(ownerUserId: number, dataset: DatasetManifest, repository: GeoOutcomeRepositoryPort, expectedReference?: DatasetKnowledgeApprovalReference, lock = false): Promise<{ decision: DatasetDecision, reference: DatasetKnowledgeApprovalReference }> {
  if (!id(ownerUserId) || dataset.ownerUserId !== ownerUserId || dataset.status !== 'approved') return fail('dataset_not_approved')
  // Acquire the native/subject locks before reading an approval snapshot on write paths.
  const state = await repository.readDatasetKnowledgeState(ownerUserId, dataset.manifestId, lock)
  const currentDataset = await repository.getDataset(ownerUserId, dataset.manifestId)
  if (!currentDataset || currentDataset.ownerUserId !== ownerUserId || currentDataset.status !== 'approved' || currentDataset.manifestFingerprint !== dataset.manifestFingerprint || state.ownerUserId !== ownerUserId || state.manifestId !== dataset.manifestId || state.manifestFingerprint !== dataset.manifestFingerprint) return fail('dataset_not_approved')
  const decisions = await repository.listDatasetDecisions(ownerUserId)
  const decision = decisions.filter(item => item.ownerUserId === ownerUserId && item.manifestId === dataset.manifestId && item.manifestFingerprint === dataset.manifestFingerprint).at(-1)
  if (!decision || decision.newStatus !== 'approved' || decision.reviewerUserId !== ownerUserId || !decision.knowledgeAuthority) return fail('explicit_dependency_approval_required')
  assertValidDatasetKnowledgeAuthority(decision.knowledgeAuthority)
  const authority = decision.knowledgeAuthority
  if (authority.ownerUserId !== ownerUserId || authority.manifestId !== dataset.manifestId || authority.manifestFingerprint !== dataset.manifestFingerprint) return fail('dependency_approval_scope_mismatch')
  const current = buildDatasetKnowledgeAuthority(state, authority.mode)
  if (current.authorityFingerprint !== authority.authorityFingerprint) return fail('dependency_approval_stale')
  const reference = { datasetDecisionId: decision.decisionId, knowledgeAuthorityFingerprint: authority.authorityFingerprint }
  if (expectedReference) { assertValidApprovalReference(expectedReference); if (!referencesEqual(reference, expectedReference)) return fail('dependency_approval_changed') }
  return { decision, reference }
}
export async function summarizeDatasetKnowledgeAuthority(ownerUserId: number, dataset: DatasetManifest, repository: GeoOutcomeRepositoryPort): Promise<DatasetKnowledgeAuthoritySummary> {
  let activePinCount = 0
  let mode: DatasetKnowledgeMode | null = null
  let authorityFingerprint: string | null = null
  try {
    const state = await repository.readDatasetKnowledgeState(ownerUserId, dataset.manifestId)
    activePinCount = normalizedState(state).heads.filter(head => head.operation === 'bind').length
    const decision = (await repository.listDatasetDecisions(ownerUserId)).filter(item => item.ownerUserId === ownerUserId && item.manifestId === dataset.manifestId && item.manifestFingerprint === dataset.manifestFingerprint).at(-1)
    if (!decision?.knowledgeAuthority) return { status: 'not_declared', mode, authorityFingerprint, activePinCount, reasonCodes: ['explicit_dependency_approval_required'] }
    assertValidDatasetKnowledgeAuthority(decision.knowledgeAuthority)
    mode = decision.knowledgeAuthority.mode; authorityFingerprint = decision.knowledgeAuthority.authorityFingerprint
    await assertDatasetKnowledgeAuthorityCurrent(ownerUserId, dataset, repository)
    return { status: 'current', mode, authorityFingerprint, activePinCount, reasonCodes: [] }
  } catch (error) {
    return { status: error instanceof DatasetKnowledgeAuthorityError ? 'stale' : 'unavailable', mode, authorityFingerprint, activePinCount, reasonCodes: [error instanceof DatasetKnowledgeAuthorityError ? error.code : 'knowledge_authority_unavailable'] }
  }
}
