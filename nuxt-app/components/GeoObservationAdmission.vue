<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { AdmissionCandidateSetSummary, AdmissionObservationSummary, AdmissionSelectedSource, AdmissionSourceSummary, AdmissionWorkspace } from '../server/geo-outcome-model/admission-types'

type CandidateRow = { rowId: string, candidateUrl: string, contentHash: string, publicationReceiptFingerprint: string }
type ConfirmationDraft = { reason: string, confirmed: boolean }
type GovernanceAction = 'verify_evidence' | 'approve_consent' | 'approve_pii' | 'revoke'
type ExistingCandidateMatch = { sourceRecordId: number, candidateUrl: string, candidatePageIdentityHash: string, candidateSetFingerprint: string, epoch: number }
type RequestOptions = { method?: 'POST', query?: { cursor?: string, sourceRecordId?: number }, body?: Record<string, unknown> }
type AdmissionRequest = (path: string, options?: RequestOptions) => Promise<unknown>

const emit = defineEmits<{ changed: [] }>()
const requestAdmission = $fetch as unknown as AdmissionRequest
const workspace = ref<AdmissionWorkspace | null>(null)
const selectedId = ref('')
const pageState = ref<'loading' | 'ready' | 'empty' | 'unauthorized' | 'invalid' | 'not-found' | 'conflict' | 'unavailable'>('loading')
const pageError = ref('')
const sourceLoading = ref(false)
const nextPageLoading = ref(false)
const actionBusy = ref('')
const actionMessage = ref('')
const actionError = ref('')
const requestGeneration = ref(0)
const sourceSelectionEpoch = ref(0)
let nextRowId = 1
const candidateRows = ref<CandidateRow[]>([newCandidateRow()])
const candidateReason = ref('')
const candidateSeenConfirmed = ref(false)
const existingCandidateUrl = ref('')
const existingCandidateMatch = ref<ExistingCandidateMatch | null>(null)
const existingCandidateBusy = ref(false)
const existingCandidateMessage = ref('')
const governanceDrafts = reactive<Record<string, ConfirmationDraft>>({})
const setRevokeDrafts = reactive<Record<string, ConfirmationDraft>>({})
const approvedCandidateUrls = ref<Array<{ sourceRecordId: number, candidateUrl: string, candidateSetFingerprint: string }>>([])
const idempotencyKeys = new Map<string, string>()

const selectedSource = computed<AdmissionSelectedSource | null>(() => workspace.value?.selectedSource ?? null)
const citedCandidates = computed(() => selectedSource.value?.citations.filter(item => !item.observation) ?? [])
const observations = computed<AdmissionObservationSummary[]>(() => {
  const found = new Map<string, AdmissionObservationSummary>()
  for (const item of selectedSource.value?.citations ?? []) if (item.observation) found.set(item.observation.observationFingerprint, item.observation)
  for (const item of selectedSource.value?.candidateAuthorities ?? []) if (item.observation) found.set(item.observation.observationFingerprint, item.observation)
  return [...found.values()]
})
function hasCurrentCandidateSet(fingerprint: string): boolean {
  return Boolean(selectedSource.value?.candidateSets.some(item => item.candidateSetFingerprint === fingerprint && item.decision === 'approve')
    && !selectedSource.value?.candidateSets.some(item => item.candidateSetFingerprint === fingerprint && item.decision === 'revoke')
    && selectedSource.value?.candidateAuthorities.some(item => item.candidateSetFingerprint === fingerprint))
}
function hasCurrentCandidateAuthority(candidatePageIdentityHash: string): boolean {
  return selectedSource.value?.candidateAuthorities.some(item => item.candidatePageIdentityHash === candidatePageIdentityHash) ?? false
}
const approvedLocalForSource = computed(() => approvedCandidateUrls.value.filter(item => item.sourceRecordId === selectedSource.value?.sourceRecordId && hasCurrentCandidateSet(item.candidateSetFingerprint)))
const sourceOptions = computed(() => workspace.value?.sources ?? [])
const canReviewCandidateSet = computed(() => Boolean(selectedSource.value?.eligible && candidateSeenConfirmed.value && candidateReason.value.trim() && validCandidateRows(candidateRows.value)))

function newCandidateRow(): CandidateRow {
  return { rowId: `candidate-${nextRowId++}`, candidateUrl: '', contentHash: '', publicationReceiptFingerprint: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isObservation(value: unknown): value is AdmissionObservationSummary {
  return isRecord(value)
    && isHash(value.observationFingerprint) && isHash(value.candidatePageIdentityHash) && isHash(value.contentHash)
    && (value.citationStatus === 'cited' || value.citationStatus === 'not_cited' || value.citationStatus === 'unknown')
    && (value.citationPosition === null || (Number.isSafeInteger(value.citationPosition) && Number(value.citationPosition) > 0))
    && ['verified', 'unverified', 'stale', 'ambiguous', 'revoked'].includes(String(value.verificationStatus))
    && ['approved', 'revoked', 'unknown'].includes(String(value.consentStatus))
    && ['clean', 'contains_pii', 'unknown'].includes(String(value.piiStatus))
    && ['exact_publication_draft', 'unknown_external'].includes(String(value.featureOrigin))
    && Number.isSafeInteger(value.missingFeatureCount) && Number(value.missingFeatureCount) >= 0 && Number(value.missingFeatureCount) <= 256
}

function isSourceSummary(value: unknown): value is AdmissionSourceSummary {
  return isRecord(value) && isPositiveId(value.sourceRecordId)
    && typeof value.provider === 'string' && value.provider.length <= 120
    && typeof value.model === 'string' && value.model.length <= 160
    && typeof value.locale === 'string' && value.locale.length <= 40
    && typeof value.observedAt === 'string' && value.observedAt.length <= 40
    && isHash(value.responseHash)
    && Number.isSafeInteger(value.citationCount) && Number(value.citationCount) >= 0 && Number(value.citationCount) <= 100
    && typeof value.eligible === 'boolean'
    && Array.isArray(value.reasonCodes) && value.reasonCodes.length <= 32 && value.reasonCodes.every(code => typeof code === 'string' && code.length <= 100)
}

function isCandidateSet(value: unknown): value is AdmissionCandidateSetSummary {
  return isRecord(value) && typeof value.decisionId === 'string' && value.decisionId.length > 0 && value.decisionId.length <= 128
    && isHash(value.candidateSetFingerprint) && (value.decision === 'approve' || value.decision === 'revoke')
    && Number.isSafeInteger(value.memberCount) && Number(value.memberCount) >= 0 && Number(value.memberCount) <= 100
    && typeof value.createdAt === 'string' && value.createdAt.length <= 40
}

function isSelectedSource(value: unknown, expectedSourceRecordId?: number): value is AdmissionSelectedSource {
  if (!isRecord(value) || !isSourceSummary(value) || typeof value.intakeEnabled !== 'boolean') return false
  const source = value as Record<string, unknown>
  if (expectedSourceRecordId !== undefined && source.sourceRecordId !== expectedSourceRecordId) return false
  if (!Array.isArray(source.citations) || source.citations.length > 100 || !Array.isArray(source.candidateSets) || source.candidateSets.length > 100 || !Array.isArray(source.candidateAuthorities) || source.candidateAuthorities.length > 100) return false
  const citations: unknown[] = source.citations
  const candidateSets: unknown[] = source.candidateSets
  const candidateAuthorities: unknown[] = source.candidateAuthorities
  return citations.every((item: unknown) => isRecord(item)
    && typeof item.candidateUrl === 'string' && item.candidateUrl.length > 0 && item.candidateUrl.length <= 2048
    && isHash(item.candidatePageIdentityHash)
    && Number.isSafeInteger(item.citationPosition) && Number(item.citationPosition) > 0
    && (item.observation === null || isObservation(item.observation)))
    && candidateSets.every(isCandidateSet)
    && candidateAuthorities.every((item: unknown) => isRecord(item)
      && isHash(item.candidatePageIdentityHash) && isHash(item.canonicalPageHash) && isHash(item.websiteIdentityHash)
      && isHash(item.candidateSetFingerprint)
      && ['manual_owner_attested_v1', 'discovery_stack_publication_receipt_v1'].includes(String(item.authorityBasis))
      && (item.citationStatus === 'cited' || item.citationStatus === 'not_cited')
      && (item.observation === null || isObservation(item.observation)))
}

function isWorkspace(value: unknown): value is AdmissionWorkspace {
  return isRecord(value) && Array.isArray(value.sources) && value.sources.length <= 25 && value.sources.every(isSourceSummary)
    && (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length <= 64))
    && (value.selectedSource === null || isSelectedSource(value.selectedSource))
}

function cleanCandidateUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null
  } catch { return null }
}

function validCandidateRows(rows: readonly CandidateRow[]): boolean {
  if (rows.length < 1 || rows.length > 100) return false
  const urls = new Set<string>()
  for (const row of rows) {
    const url = cleanCandidateUrl(row.candidateUrl)
    if (!url || !isHash(row.contentHash.trim())) return false
    if (row.publicationReceiptFingerprint.trim() && !isHash(row.publicationReceiptFingerprint.trim())) return false
    if (urls.has(url)) return false
    urls.add(url)
  }
  return true
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null
  if (Number.isInteger(error.statusCode)) return Number(error.statusCode)
  if (isRecord(error.response) && Number.isInteger(error.response.status)) return Number(error.response.status)
  return null
}

function statusState(error: unknown): typeof pageState.value {
  const status = errorStatus(error)
  return status === 401 ? 'unauthorized' : status === 422 ? 'invalid' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'unavailable'
}

function staticActionError(error: unknown): string {
  const status = errorStatus(error)
  return status === 401 ? '需要 owner session；沒有寫入觀測或治理決定。'
    : status === 409 ? '資料已變更或請求識別衝突；請重新讀取並依目前狀態重新審查。'
      : status === 422 ? '輸入或證據不符合規則；沒有寫入。'
        : status === 404 ? '來源或觀測已不存在；請重新讀取。'
          : '服務暫不可用；請保留相同輸入重試，沒有以假資料替代。'
}

function requestKey(payload: Record<string, unknown>, scope: string): string {
  const identity = JSON.stringify([scope, payload])
  const current = idempotencyKeys.get(identity)
  if (current) return current
  const generator = globalThis.crypto?.randomUUID
  if (!generator) throw new Error('request-key-unavailable')
  const key = generator.call(globalThis.crypto)
  idempotencyKeys.set(identity, key)
  return key
}

function forgetRequestKey(payload: Record<string, unknown>, scope: string) {
  idempotencyKeys.delete(JSON.stringify([scope, payload]))
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

function isCandidateSetReceipt(value: unknown, decision: 'approve' | 'revoke', fingerprint: string, memberCount: number): boolean {
  return isRecord(value)
    && typeof value.decisionId === 'string' && /^geo-candidate-review-[a-f0-9]{20}$/u.test(value.decisionId)
    && value.decision === decision && value.candidateSetFingerprint === fingerprint
    && Number.isSafeInteger(value.memberCount) && value.memberCount === memberCount
    && isHash(value.decisionFingerprint) && isCanonicalIso(value.createdAt)
}

function resetForSourceChange() {
  requestGeneration.value += 1
  sourceSelectionEpoch.value += 1
  sourceLoading.value = false
  candidateRows.value = [newCandidateRow()]
  candidateReason.value = ''
  candidateSeenConfirmed.value = false
  existingCandidateUrl.value = ''
  existingCandidateMatch.value = null
  existingCandidateBusy.value = false
  existingCandidateMessage.value = ''
  for (const key of Object.keys(governanceDrafts)) delete governanceDrafts[key]
  for (const key of Object.keys(setRevokeDrafts)) delete setRevokeDrafts[key]
  approvedCandidateUrls.value = approvedCandidateUrls.value.filter(item => item.sourceRecordId === Number(selectedId.value))
  actionMessage.value = ''
  actionError.value = ''
}

watch(selectedId, (id) => {
  resetForSourceChange()
  const sourceRecordId = Number(id)
  if (id && isPositiveId(sourceRecordId)) void loadWorkspace(undefined, sourceRecordId)
  else if (workspace.value) workspace.value = { ...workspace.value, selectedSource: null }
})

async function loadWorkspace(cursor?: string, sourceRecordId?: number) {
  const generation = ++requestGeneration.value
  if (sourceRecordId) {
    sourceLoading.value = true
    if (workspace.value) workspace.value = { ...workspace.value, selectedSource: null }
  } else if (!cursor) {
    pageState.value = 'loading'
    pageError.value = ''
  } else nextPageLoading.value = true
  try {
    const query = { ...(cursor ? { cursor } : {}), ...(sourceRecordId ? { sourceRecordId } : {}) }
    const reply = await requestAdmission('/api/geo-outcome-model/admission/workspace', { query })
    if (generation !== requestGeneration.value) return
    if (!isRecord(reply) || reply.status !== 'success' || !isWorkspace(reply.workspace)
      || (sourceRecordId !== undefined && (!reply.workspace.selectedSource || !isSelectedSource(reply.workspace.selectedSource, sourceRecordId)))) {
      if (sourceRecordId) actionError.value = '來源資料無法安全讀取；請重新載入，未套用假資料。'
      else pageState.value = 'unavailable'
      return
    }
    const next = reply.workspace
    if (cursor && workspace.value) workspace.value = { ...next, sources: [...workspace.value.sources, ...next.sources], selectedSource: workspace.value.selectedSource }
    else if (sourceRecordId && workspace.value) workspace.value = { ...workspace.value, selectedSource: next.selectedSource }
    else workspace.value = next
    if (!sourceRecordId) pageState.value = workspace.value.sources.length ? 'ready' : 'empty'
  } catch (error) {
    if (generation !== requestGeneration.value) return
    if (sourceRecordId && workspace.value) { workspace.value = { ...workspace.value, selectedSource: null }; actionError.value = staticActionError(error) }
    else { pageState.value = statusState(error); pageError.value = staticActionError(error) }
  } finally {
    if (generation === requestGeneration.value) {
      sourceLoading.value = false
      nextPageLoading.value = false
    }
  }
}

function selectSource(value: string) { selectedId.value = value }
function loadNextPage() {
  const cursor = workspace.value?.nextCursor
  if (cursor && !nextPageLoading.value) void loadWorkspace(cursor)
}

function draftFor(key: string, target: Record<string, ConfirmationDraft>): ConfirmationDraft {
  if (!target[key]) target[key] = { reason: '', confirmed: false }
  return target[key]!
}

function governanceDraft(fingerprint: string, action: GovernanceAction) { return draftFor(`${fingerprint}:${action}`, governanceDrafts) }
function candidateSetRevokeDraft(fingerprint: string) { return draftFor(fingerprint, setRevokeDrafts) }
function governanceAllowed(observation: AdmissionObservationSummary, action: GovernanceAction): boolean {
  if (observation.verificationStatus === 'revoked') return false
  if (action === 'verify_evidence') return observation.verificationStatus !== 'verified'
  if (action === 'approve_consent') return observation.consentStatus === 'unknown'
  if (action === 'approve_pii') return observation.piiStatus === 'unknown'
  return true
}
function candidateSetAlreadyRevoked(item: AdmissionCandidateSetSummary): boolean {
  return selectedSource.value?.candidateSets.some(decision => decision.decision === 'revoke' && decision.candidateSetFingerprint === item.candidateSetFingerprint) ?? false
}

function isVerificationStatus(value: unknown): boolean {
  return ['verified', 'unverified', 'stale', 'ambiguous', 'revoked'].includes(String(value))
}

function isGovernanceReply(value: unknown, observation: AdmissionObservationSummary, action: GovernanceAction, sourceRecordId: number, reason: string): boolean {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.observation) || !isRecord(value.verificationDecision)) return false
  const projected = value.observation
  const decision = value.verificationDecision
  const factType = action === 'verify_evidence' ? 'evidence_verification' : action === 'approve_consent' ? 'consent_review' : action === 'approve_pii' ? 'pii_review' : 'revocation'
  if (projected.observationFingerprint !== observation.observationFingerprint
    || !isVerificationStatus(projected.verificationStatus)
    || !['unknown', 'approved', 'revoked'].includes(String(projected.consentStatus))
    || !['unknown', 'clean', 'contains_pii'].includes(String(projected.piiStatus))
    || decision.observationFingerprint !== observation.observationFingerprint
    || !isPositiveId(decision.ownerUserId) || decision.ownerUserId !== decision.reviewerUserId
    || !isVerificationStatus(decision.previousVerificationStatus) || !isVerificationStatus(decision.newVerificationStatus)
    || decision.newVerificationStatus !== projected.verificationStatus
    || decision.factType !== factType || decision.factStatus !== (action === 'revoke' ? 'revoked' : 'approved')
    || decision.reason !== reason || !isHash(decision.decisionFingerprint)
    || typeof decision.decisionId !== 'string' || !/^geo-governance-[a-f0-9]{20}$/u.test(decision.decisionId)
    || !isCanonicalIso(decision.createdAt)
    || decision.consentStatus !== projected.consentStatus || decision.piiStatus !== projected.piiStatus) return false
  if (action === 'approve_consent' && projected.consentStatus !== 'approved') return false
  if (action === 'approve_pii' && projected.piiStatus !== 'clean') return false
  if (action === 'revoke' && (projected.verificationStatus !== 'revoked' || projected.consentStatus !== 'revoked' || projected.piiStatus !== 'unknown')) return false
  if (action !== 'verify_evidence') return value.evidenceBinding === null && decision.evidenceLocatorHash === null
  if (!isHash(decision.evidenceLocatorHash) || !isRecord(value.evidenceBinding)) return false
  const binding = value.evidenceBinding
  return isPositiveId(binding.ownerUserId) && binding.ownerUserId === decision.ownerUserId
    && binding.observationFingerprint === observation.observationFingerprint
    && binding.evidenceLocatorHash === decision.evidenceLocatorHash
    && binding.purpose === 'geo_outcome_verification' && binding.sourceKind === 'llm_visibility_observation'
    && binding.sourceRecordId === sourceRecordId
    && isPositiveId(binding.sourceProjectId) && isPositiveId(binding.sourceQueryId) && isPositiveId(binding.sourceRunId) && isPositiveId(binding.candidateAuthorityId)
    && binding.sourceResponseHash === selectedSource.value?.responseHash
    && isHash(binding.sourceCitationSetFingerprint) && isHash(binding.candidateAuthorityFingerprint)
    && isHash(binding.candidateSetFingerprint) && isHash(binding.canonicalCandidateUrlHash)
    && isHash(binding.evidenceBindingFingerprint)
    && (binding.serverDerivedCitationStatus === 'cited' || binding.serverDerivedCitationStatus === 'not_cited')
    && binding.serverDerivedCitationStatus === observation.citationStatus
    && (binding.serverDerivedCitationPosition === null || (Number.isSafeInteger(binding.serverDerivedCitationPosition) && Number(binding.serverDerivedCitationPosition) > 0))
    && binding.serverDerivedCitationPosition === observation.citationPosition
    && binding.sourceObservedAt === selectedSource.value?.observedAt && isCanonicalIso(binding.sourceObservedAt)
    && isCanonicalIso(binding.createdAt)
    && selectedSource.value?.candidateAuthorities.some(authority => authority.candidatePageIdentityHash === observation.candidatePageIdentityHash
      && authority.candidateSetFingerprint === binding.candidateSetFingerprint
      && authority.observation?.observationFingerprint === observation.observationFingerprint) === true
    && hasCurrentCandidateSet(binding.candidateSetFingerprint)
}

function addCandidateRow() { if (candidateRows.value.length < 100) candidateRows.value.push(newCandidateRow()) }
function removeCandidateRow(rowId: string) { if (candidateRows.value.length > 1) candidateRows.value = candidateRows.value.filter(row => row.rowId !== rowId) }

async function refreshSelectedSource() {
  const sourceRecordId = Number(selectedId.value)
  if (isPositiveId(sourceRecordId)) await loadWorkspace(undefined, sourceRecordId)
}

async function postAction(path: string, payload: Record<string, unknown>, successMessage: string, validateReply: (reply: unknown) => boolean = reply => isRecord(reply) && reply.status === 'success'): Promise<boolean> {
  const key = `${path}:${JSON.stringify(payload)}`
  if (actionBusy.value) return false
  const sourceAtStart = Number(selectedId.value)
  const epochAtStart = sourceSelectionEpoch.value
  const idempotencyKey = requestKey(payload, path)
  actionBusy.value = key
  actionMessage.value = ''
  actionError.value = ''
  try {
    const reply = await requestAdmission(path, { method: 'POST', body: { ...payload, idempotencyKey } })
    if (!validateReply(reply)) throw new Error('invalid-admission-response')
    forgetRequestKey(payload, path)
    emit('changed')
    const stillCurrent = Number(selectedId.value) === sourceAtStart && sourceSelectionEpoch.value === epochAtStart
    if (stillCurrent) {
      actionMessage.value = successMessage
      await refreshSelectedSource()
    }
    return stillCurrent
  } catch (error) {
    if (Number(selectedId.value) === sourceAtStart && sourceSelectionEpoch.value === epochAtStart) actionError.value = staticActionError(error)
    return false
  } finally {
    actionBusy.value = ''
  }
}

function submitCandidateSet() {
  const sourceRecordId = selectedSource.value?.sourceRecordId
  if (!sourceRecordId || !canReviewCandidateSet.value) return
  const candidates = candidateRows.value.map(row => ({
    candidateUrl: cleanCandidateUrl(row.candidateUrl)!,
    contentHash: row.contentHash.trim(),
    ...(row.publicationReceiptFingerprint.trim() ? { publicationReceiptFingerprint: row.publicationReceiptFingerprint.trim() } : {}),
  }))
  const payload = { sourceRecordId, decision: 'approve', reason: candidateReason.value.trim(), candidates }
  const attestedUrls = candidates.map(row => row.candidateUrl)
  const epochAtStart = sourceSelectionEpoch.value
  let approvedFingerprint = ''
  void postAction('/api/geo-outcome-model/candidate-sets/review', payload, '候選集審查已記錄；不是訓練核准。', reply => {
    if (!isRecord(reply) || !isHash(reply.candidateSetFingerprint) || !isCandidateSetReceipt(reply, 'approve', reply.candidateSetFingerprint, candidates.length)) return false
    approvedFingerprint = reply.candidateSetFingerprint
    return true
  }).then(succeeded => {
      if (succeeded && Number(selectedId.value) === sourceRecordId && sourceSelectionEpoch.value === epochAtStart) {
        approvedCandidateUrls.value = [...approvedCandidateUrls.value.filter(item => item.sourceRecordId !== sourceRecordId), ...attestedUrls.map(candidateUrl => ({ sourceRecordId, candidateUrl, candidateSetFingerprint: approvedFingerprint }))]
        candidateRows.value = [newCandidateRow()]
        candidateReason.value = ''
        candidateSeenConfirmed.value = false
      }
    })
}

async function checkExistingCandidate() {
  const sourceRecordId = selectedSource.value?.sourceRecordId
  const canonicalUrl = cleanCandidateUrl(existingCandidateUrl.value)
  const epochAtStart = sourceSelectionEpoch.value
  existingCandidateMatch.value = null
  existingCandidateMessage.value = ''
  if (!sourceRecordId || !selectedSource.value?.intakeEnabled || !canonicalUrl || existingCandidateBusy.value) return
  const subtle = globalThis.crypto?.subtle
  if (!subtle || typeof subtle.digest !== 'function' || typeof TextEncoder === 'undefined') {
    existingCandidateMessage.value = '此瀏覽器無法安全核對既有 authority；沒有送出寫入。'
    return
  }
  existingCandidateBusy.value = true
  try {
    const canonicalIdentity = JSON.stringify({ canonicalCandidateUrl: canonicalUrl })
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalIdentity))
    const candidatePageIdentityHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    if (Number(selectedId.value) !== sourceRecordId || sourceSelectionEpoch.value !== epochAtStart
      || cleanCandidateUrl(existingCandidateUrl.value) !== canonicalUrl) return
    const authority = selectedSource.value?.candidateAuthorities.find(item => item.candidatePageIdentityHash === candidatePageIdentityHash
      && item.citationStatus === 'not_cited' && item.observation === null && hasCurrentCandidateSet(item.candidateSetFingerprint))
    if (!authority) {
      existingCandidateMessage.value = '找不到符合此 URL 的目前有效未引用核准 authority；沒有新增候選 authority，也沒有送出寫入。'
      return
    }
    existingCandidateMatch.value = {
      sourceRecordId, candidateUrl: canonicalUrl, candidatePageIdentityHash,
      candidateSetFingerprint: authority.candidateSetFingerprint, epoch: epochAtStart,
    }
    existingCandidateMessage.value = '已和目前核准的未引用 authority 精確比對；這不會建立新 authority，server 仍會重新驗證。'
  } catch {
    if (Number(selectedId.value) === sourceRecordId && sourceSelectionEpoch.value === epochAtStart) {
      existingCandidateMessage.value = '無法安全核對既有 authority；沒有送出寫入。'
    }
  } finally {
    if (Number(selectedId.value) === sourceRecordId && sourceSelectionEpoch.value === epochAtStart) existingCandidateBusy.value = false
  }
}

function revokeCandidateSet(item: AdmissionCandidateSetSummary) {
  const sourceRecordId = selectedSource.value?.sourceRecordId
  const draft = candidateSetRevokeDraft(item.candidateSetFingerprint)
  if (!sourceRecordId || item.decision !== 'approve' || !draft.confirmed || !draft.reason.trim()) return
  void postAction('/api/geo-outcome-model/candidate-sets/review', {
    sourceRecordId,
    decision: 'revoke',
    reason: draft.reason.trim(),
    candidateSetFingerprint: item.candidateSetFingerprint,
  }, '候選集 authority 已提交撤銷；請依重新讀取確認目前狀態。', reply => isCandidateSetReceipt(reply, 'revoke', item.candidateSetFingerprint, 0))
}

async function intakeCandidate(candidateUrl: string, expectedCandidateSetFingerprint?: string, existingMatch?: ExistingCandidateMatch) {
  const sourceRecordId = selectedSource.value?.sourceRecordId
  if (!sourceRecordId || !selectedSource.value?.intakeEnabled || !cleanCandidateUrl(candidateUrl) || actionBusy.value) return
  const canonicalUrl = cleanCandidateUrl(candidateUrl)!
  const citation = selectedSource.value.citations.find(item => item.candidateUrl === canonicalUrl && !item.observation)
  const citedAuthorityIsCurrent = Boolean(citation && hasCurrentCandidateAuthority(citation.candidatePageIdentityHash))
  const localApprovedAuthorityIsCurrent = Boolean(expectedCandidateSetFingerprint
    && hasCurrentCandidateSet(expectedCandidateSetFingerprint)
    && approvedLocalForSource.value.some(item => item.candidateUrl === canonicalUrl && item.candidateSetFingerprint === expectedCandidateSetFingerprint))
  const existingAuthorityIsCurrent = Boolean(existingMatch && existingMatch.sourceRecordId === sourceRecordId
    && existingMatch.candidateUrl === canonicalUrl && existingMatch.epoch === sourceSelectionEpoch.value
    && existingMatch.candidateSetFingerprint === expectedCandidateSetFingerprint
    && selectedSource.value.candidateAuthorities.some(item => item.candidatePageIdentityHash === existingMatch.candidatePageIdentityHash
      && item.candidateSetFingerprint === existingMatch.candidateSetFingerprint && item.citationStatus === 'not_cited'
      && item.observation === null && hasCurrentCandidateSet(item.candidateSetFingerprint)))
  if (!citedAuthorityIsCurrent && !localApprovedAuthorityIsCurrent && !existingAuthorityIsCurrent) return
  const sourceAtStart = sourceRecordId
  const epochAtStart = sourceSelectionEpoch.value
  const payload = { sourceRecordId, candidateUrl: canonicalUrl }
  const key = '/api/geo-outcome-model/admission/intake'
  const idempotencyKey = requestKey(payload, key)
  actionBusy.value = `${key}:${JSON.stringify(payload)}`
  actionMessage.value = ''
  actionError.value = ''
  try {
    const reply = await requestAdmission(key, { method: 'POST', body: { ...payload, idempotencyKey } })
    if (!isRecord(reply) || reply.status !== 'success' || !isRecord(reply.observation)
      || !isObservation(reply.observation) || reply.observation.sourceRecordId !== sourceRecordId || reply.observation.verificationStatus !== 'unverified'
      || reply.observation.consentStatus !== 'unknown' || reply.observation.piiStatus !== 'unknown'
      || reply.observation.governanceIndependent !== true || reply.observation.trainingAdmission !== false
      || reply.observation.productionActivation !== false || typeof reply.observation.replayed !== 'boolean') throw new Error('invalid-intake-response')
    forgetRequestKey(payload, key)
    emit('changed')
    if (Number(selectedId.value) === sourceAtStart && sourceSelectionEpoch.value === epochAtStart) {
      actionMessage.value = reply.observation.replayed
        ? '已重播原始 intake receipt；它不是目前治理狀態或核准，以下狀態以重新讀取的 workspace 為準。'
        : 'Intake receipt 已確認；不代表 evidence、consent、PII 或訓練核准，以下狀態以重新讀取的 workspace 為準。'
      approvedCandidateUrls.value = approvedCandidateUrls.value.filter(item => !(item.sourceRecordId === sourceRecordId && item.candidateUrl === payload.candidateUrl))
      if (existingCandidateMatch.value?.candidateUrl === payload.candidateUrl) {
        existingCandidateMatch.value = null
        existingCandidateUrl.value = ''
      }
      await refreshSelectedSource()
    }
  } catch (error) {
    if (Number(selectedId.value) === sourceAtStart && sourceSelectionEpoch.value === epochAtStart) actionError.value = staticActionError(error)
  } finally { actionBusy.value = '' }
}

function submitGovernance(observation: AdmissionObservationSummary, action: GovernanceAction) {
  const draft = governanceDraft(observation.observationFingerprint, action)
  const sourceRecordId = selectedSource.value?.sourceRecordId
  if (!sourceRecordId || !draft.confirmed || !draft.reason.trim() || actionBusy.value) return
  const submittedReason = draft.reason.trim()
  const payload = {
    action,
    reason: submittedReason,
    ...(action === 'verify_evidence' ? { sourceRecordId } : {}),
  }
  void postAction(`/api/geo-outcome-model/observations/${observation.observationFingerprint}/verify`, payload, '治理決定已記錄；請依重新讀取後的獨立狀態確認。', reply => isGovernanceReply(reply, observation, action, sourceRecordId, submittedReason))
}

const observationActions: readonly { action: GovernanceAction, label: string, description: string }[] = [
  { action: 'verify_evidence', label: '核對 primary evidence', description: '只可綁定目前選取的 LLM Visibility source record。' },
  { action: 'approve_consent', label: '獨立核准 consent', description: '這是與 evidence、PII 分開的 owner 決定。' },
  { action: 'approve_pii', label: '獨立核准 PII 檢查', description: '這是與 evidence、consent 分開的 owner 決定。' },
  { action: 'revoke', label: '終止撤回此 observation', description: '撤回為 terminal；不能用此操作重開。' },
]

onMounted(() => { void loadWorkspace() })
</script>

<template>
  <section class="admission" aria-labelledby="admission-title">
    <header class="hero">
      <div><p class="eyebrow">OWNER-ONLY · REAL OBSERVATION ADMISSION</p><h2 id="admission-title">真實觀測登錄與獨立審查</h2><p>這不是 Colab、正式模型或訓練入口。只有先在 LLM Visibility 人工審查的實際 consumer snapshot，才可作為 source；provider API 結果不等於消費者引用真值。</p></div>
      <span class="badge">READ · GOVERN · NO AUTO-TRAIN</span>
    </header>

    <p v-if="pageState === 'loading'" class="state" role="status">正在唯讀載入 owner sources…</p>
    <p v-else-if="pageState === 'unauthorized'" class="state blocked" role="alert">需要有效的 owner session；未讀取或寫入觀測。</p>
    <p v-else-if="pageState === 'invalid'" class="state blocked" role="alert">workspace 請求無效；請重新載入。</p>
    <p v-else-if="pageState === 'not-found'" class="state blocked" role="alert">指定來源不存在或不屬於目前 owner。</p>
    <p v-else-if="pageState === 'conflict'" class="state blocked" role="alert">來源資料或版本已變動；請重新讀取後再審查。</p>
    <p v-else-if="pageState === 'unavailable'" class="state blocked" role="alert">workspace 目前無法安全載入；{{ pageError || '沒有用假資料替代。' }}</p>
    <p v-else-if="pageState === 'empty'" class="state empty">尚無可選的已審查 consumer snapshot；這裡不會建立模擬來源。</p>

    <template v-if="workspace && (pageState === 'ready' || pageState === 'empty')">
      <div class="source-picker">
        <label>人工審查過的 LLM Visibility source
          <select :value="selectedId" aria-label="選擇已審查來源" @change="selectSource(($event.target as HTMLSelectElement).value)">
            <option value="">選擇來源</option>
            <option v-for="source in sourceOptions" :key="source.sourceRecordId" :value="String(source.sourceRecordId)">#{{ source.sourceRecordId }} · {{ source.provider }}/{{ source.model }} · {{ source.locale }} · {{ source.observedAt }}</option>
          </select>
        </label>
        <button type="button" :disabled="nextPageLoading || !workspace.nextCursor" @click="loadNextPage">{{ nextPageLoading ? '讀取中…' : workspace.nextCursor ? '載入更多來源' : '沒有更多來源' }}</button>
      </div>

      <p v-if="workspace.sources.length" class="privacy">僅顯示有界 source metadata；不載入 prompt、raw response 或 evidence locator。</p>
      <p v-if="sourceLoading" class="state" role="status">正在讀取所選來源的候選 authority 與治理摘要…</p>
      <p v-if="actionMessage" class="notice" role="status">{{ actionMessage }}</p>
      <p v-if="actionError" class="state blocked" role="alert">{{ actionError }}</p>

      <template v-if="selectedSource">
        <article class="source-card">
          <div class="source-heading"><div><p class="eyebrow">SOURCE RECORD #{{ selectedSource.sourceRecordId }}</p><h3>{{ selectedSource.provider }} / {{ selectedSource.model }}</h3><p>{{ selectedSource.locale }} · {{ selectedSource.observedAt }} · response {{ selectedSource.responseHash }}</p></div><span :class="selectedSource.eligible ? 'badge badge--ready' : 'badge badge--blocked'">{{ selectedSource.eligible ? 'eligible for owner review' : 'blocked source' }}</span></div>
          <p v-if="selectedSource.reasonCodes.length" class="limitation">{{ selectedSource.reasonCodes.join(' · ') }}</p>
          <p>引用數：{{ selectedSource.citations.length }} · authority rows：{{ selectedSource.candidateAuthorities.length }} · candidate-set decisions：{{ selectedSource.candidateSets.length }}</p>
          <p class="privacy">所有 intake 都重新由 server 綁定 owner、source run、candidate identity、hash 與 citation label；重播回應不保證 authority 目前仍有效。</p>
        </article>

        <article class="panel">
          <h3>已登錄的 candidate authority（只顯示 hash metadata）</h3>
          <p v-if="!selectedSource.candidateAuthorities.length" class="empty">沒有持久化 candidate authority；不從 hash 反推 URL。</p>
          <ul v-else class="candidate-list"><li v-for="authority in selectedSource.candidateAuthorities" :key="authority.candidatePageIdentityHash" class="authority-row"><strong>{{ authority.citationStatus === 'cited' ? '已引用' : '未引用但有明確 authority' }} · {{ authority.authorityBasis }}</strong><small>candidate identity · {{ authority.candidatePageIdentityHash }}</small><small>canonical page hash · {{ authority.canonicalPageHash }}</small><small>website identity · {{ authority.websiteIdentityHash }}</small><small>candidate set · {{ authority.candidateSetFingerprint }}</small><small v-if="authority.observation">{{ authority.observation.verificationStatus }} · consent {{ authority.observation.consentStatus }} · PII {{ authority.observation.piiStatus }} · feature {{ authority.observation.featureOrigin }} · missing {{ authority.observation.missingFeatureCount }}</small></li></ul>
        </article>

        <article class="panel">
          <h3>可見候選與引用狀態</h3>
          <p v-if="!selectedSource.citations.length" class="empty">source 沒有可顯示的 citation URL；不從 hash 反推 URL。</p>
          <ul v-else class="candidate-list"><li v-for="candidate in selectedSource.citations" :key="candidate.candidatePageIdentityHash" class="candidate-row"><div><strong>Citation #{{ candidate.citationPosition }}</strong><span class="url">{{ candidate.candidateUrl }}</span><small>page identity {{ candidate.candidatePageIdentityHash }}</small><small v-if="candidate.observation">{{ candidate.observation.verificationStatus }} · consent {{ candidate.observation.consentStatus }} · PII {{ candidate.observation.piiStatus }} · features {{ candidate.observation.featureOrigin }} · missing {{ candidate.observation.missingFeatureCount }}</small></div><button v-if="!candidate.observation && selectedSource.intakeEnabled && hasCurrentCandidateAuthority(candidate.candidatePageIdentityHash)" type="button" :disabled="Boolean(actionBusy)" @click="intakeCandidate(candidate.candidateUrl)">建立待審 observation</button></li></ul>
          <p v-if="!selectedSource.intakeEnabled" class="limitation">此 source 不符合 intake prerequisites；保持唯讀，不會建立 observation。</p>
        </article>

        <article class="panel candidate-set-panel">
          <h3>人工記錄同次觀測中實際可見且確認已檢索的候選集</h3>
          <p>只提交同次 source run 中實際可見且確認已檢索的公開頁面之確切 snapshot SHA-256 或 publication receipt fingerprint。不可由引用 URL 推造 content hash；此項只記錄 candidate-set authority，不核准 evidence、consent、PII 或訓練。</p>
          <div v-for="row in candidateRows" :key="row.rowId" class="candidate-input-row">
            <label>候選 URL<input v-model.trim="row.candidateUrl" type="url" autocomplete="off" placeholder="https://…"></label>
            <label>實際頁面 snapshot SHA-256<input v-model.trim="row.contentHash" inputmode="text" maxlength="64" autocomplete="off" placeholder="64 位 lowercase hex"></label>
            <label>精確 publication receipt fingerprint（選填）<input v-model.trim="row.publicationReceiptFingerprint" inputmode="text" maxlength="64" autocomplete="off" placeholder="64 位 lowercase hex"></label>
            <button type="button" class="secondary" :disabled="candidateRows.length <= 1 || Boolean(actionBusy)" @click="removeCandidateRow(row.rowId)">移除此列</button>
          </div>
          <div class="actions"><button type="button" class="secondary" :disabled="candidateRows.length >= 100 || Boolean(actionBusy)" @click="addCandidateRow">新增候選列</button></div>
          <label>Owner 審查理由<textarea v-model.trim="candidateReason" rows="2" maxlength="500" placeholder="記錄核對依據，不貼 prompt／response／個資"></textarea></label>
          <label class="confirm"><input v-model="candidateSeenConfirmed" type="checkbox">我確認這些 URL 是同一 source run 中實際可見且確認已檢索到的候選，且所填 hash／receipt 是精確證據；未引用不代表 negative。</label>
          <button type="button" :disabled="Boolean(actionBusy) || !canReviewCandidateSet" @click="submitCandidateSet">{{ actionBusy.includes('candidate-sets/review') ? '正在提交…' : '提交人工 candidate-set review' }}</button>
        </article>

        <article class="panel">
          <h3>登錄既有核准的未引用候選</h3>
          <p>重新開啟後可輸入已核准候選 URL；瀏覽器只以 Web Crypto 將正規化 URL 對照目前 server 提供的 identity hash，不從 hash 還原 URL，也不使用本機持久儲存。僅目前仍有效、尚無 observation 的核准 authority 可登錄；server 會再次驗證。</p>
          <label>已核准候選 URL<input v-model.trim="existingCandidateUrl" type="url" autocomplete="off" placeholder="https://…" @input="existingCandidateMatch = null; existingCandidateMessage = ''"></label>
          <button type="button" :disabled="Boolean(actionBusy) || existingCandidateBusy || !selectedSource.intakeEnabled" @click="checkExistingCandidate">{{ existingCandidateBusy ? '安全核對中…' : '核對目前既有 authority' }}</button>
          <p v-if="existingCandidateMessage" :class="existingCandidateMatch ? 'notice' : 'limitation'" role="status">{{ existingCandidateMessage }}</p>
          <button v-if="existingCandidateMatch" type="button" :disabled="Boolean(actionBusy) || !selectedSource.intakeEnabled" @click="intakeCandidate(existingCandidateMatch.candidateUrl, existingCandidateMatch.candidateSetFingerprint, existingCandidateMatch)">建立待審 observation</button>
        </article>

        <article v-if="approvedLocalForSource.length" class="panel">
          <h3>本次人工核准 candidate-set 的待登錄頁面</h3>
          <p>仍須逐筆 intake；server 會重新驗證 current approved authority 並由 server derive 引用標籤。</p>
          <ul class="candidate-list"><li v-for="item in approvedLocalForSource" :key="`${item.candidateSetFingerprint}:${item.candidateUrl}`" class="candidate-row"><span class="url">{{ item.candidateUrl }}</span><button type="button" :disabled="Boolean(actionBusy) || !selectedSource.intakeEnabled" @click="intakeCandidate(item.candidateUrl, item.candidateSetFingerprint)">建立待審 observation</button></li></ul>
        </article>

        <article class="panel">
          <h3>已登錄候選集與撤回</h3>
          <p v-if="!selectedSource.candidateSets.length" class="empty">尚無 candidate-set review decision。</p>
          <div v-for="item in selectedSource.candidateSets" :key="`${item.decisionId}:${item.candidateSetFingerprint}`" class="set-row"><div><strong>{{ item.decision === 'approve' ? '已核准 authority' : '已撤銷 authority' }}</strong><small>{{ item.memberCount }} candidates · {{ item.createdAt }} · {{ item.candidateSetFingerprint }}</small></div><template v-if="item.decision === 'approve' && !candidateSetAlreadyRevoked(item)"><label>撤銷理由<textarea v-model.trim="candidateSetRevokeDraft(item.candidateSetFingerprint).reason" rows="2" maxlength="500"></textarea></label><label class="confirm"><input v-model="candidateSetRevokeDraft(item.candidateSetFingerprint).confirmed" type="checkbox">我確認要撤銷這組精確 candidate-set authority；只影響此 set，不撤銷 observation。</label><button class="danger" type="button" :disabled="Boolean(actionBusy) || !candidateSetRevokeDraft(item.candidateSetFingerprint).confirmed || !candidateSetRevokeDraft(item.candidateSetFingerprint).reason.trim()" @click="revokeCandidateSet(item)">撤銷此 candidate set</button></template></div>
        </article>

        <article class="panel governance-panel">
          <h3>逐筆 observation 治理</h3>
          <p>Evidence、consent、PII、revoke 是互相獨立的 append-only 決定。Unknown feature 維持 unknown；UI 不提供或提交 feature JSON。</p>
          <p v-if="!observations.length" class="empty">此 source 尚無 observation；只顯示 evidence/candidate authority，不補造紀錄。</p>
          <article v-for="observation in observations" :key="observation.observationFingerprint" class="observation-card">
            <div class="observation-heading"><div><strong>{{ observation.citationStatus === 'cited' ? '已引用候選' : '未引用的已登錄候選' }}</strong><small>{{ observation.observationFingerprint }}</small></div><span class="badge">{{ observation.verificationStatus }}</span></div>
            <dl class="observation-facts"><div><dt>Consent</dt><dd>{{ observation.consentStatus }}</dd></div><div><dt>PII review</dt><dd>{{ observation.piiStatus }}</dd></div><div><dt>Feature origin</dt><dd>{{ observation.featureOrigin === 'exact_publication_draft' ? '精確發布稿特徵' : 'unknown_external' }}</dd></div><div><dt>Missing feature count</dt><dd>{{ observation.missingFeatureCount }}</dd></div></dl>
            <p v-if="observation.featureOrigin === 'unknown_external' || observation.missingFeatureCount > 0" class="limitation">特徵缺失／來源未知會保留為 unknown；不得在此貼入或推測特徵。</p>
            <div class="governance-actions"><section v-for="item in observationActions" :key="item.action" class="governance-action"><strong>{{ item.label }}</strong><small>{{ item.description }}</small><label>此項決定的理由<textarea v-model.trim="governanceDraft(observation.observationFingerprint, item.action).reason" rows="2" maxlength="500"></textarea></label><label class="confirm"><input v-model="governanceDraft(observation.observationFingerprint, item.action).confirmed" type="checkbox">我已獨立核對並確認只提交此項 {{ item.action }} 決定。</label><button :class="item.action === 'revoke' ? 'danger' : 'secondary'" type="button" :disabled="Boolean(actionBusy) || !governanceAllowed(observation, item.action) || !governanceDraft(observation.observationFingerprint, item.action).confirmed || !governanceDraft(observation.observationFingerprint, item.action).reason.trim()" @click="submitGovernance(observation, item.action)">{{ actionBusy.includes(observation.observationFingerprint) ? '正在提交…' : item.label }}</button></section></div>
          </article>
        </article>
      </template>
      <p v-else-if="selectedId && !sourceLoading && pageState === 'ready'" class="state empty">所選來源尚未載入；不混用前一筆 source 的資料。</p>
    </template>
  </section>
</template>

<style scoped>
.admission{max-width:1240px;margin:1rem auto;padding:1.25rem;border:1px solid #d7e1ef;border-radius:16px;background:#fff;color:#172033}.hero{display:flex;justify-content:space-between;gap:1.25rem;align-items:start;padding:1rem 1.15rem;border-radius:12px;background:linear-gradient(130deg,#f3f7ff,#fbfcfe)}.hero h2{margin:.2rem 0;font-size:clamp(1.35rem,3vw,1.8rem)}.hero p{max-width:760px;line-height:1.65}.eyebrow{font-size:.72rem;font-weight:800;letter-spacing:.1em;color:#52627a}.badge{display:inline-flex;align-items:center;white-space:nowrap;padding:.35rem .55rem;border-radius:999px;background:#edf2fb;color:#284b86;font-size:.72rem;font-weight:800}.badge--ready{background:#e7f6ee;color:#126342}.badge--blocked{background:#fff1dc;color:#754600}.source-picker{display:grid;grid-template-columns:minmax(12rem,1fr) auto;gap:.7rem;align-items:end;margin:1rem 0}.source-picker label,.panel label{display:grid;gap:.3rem;font-size:.86rem;font-weight:700}.source-picker select,input,textarea{box-sizing:border-box;width:100%;padding:.55rem;border:1px solid #b9c5d7;border-radius:7px;background:#fff;font:inherit;font-weight:400}.source-picker button,.panel button{border:0;border-radius:8px;padding:.62rem .85rem;background:#213f7a;color:#fff;font:inherit;cursor:pointer}.source-picker button:disabled,.panel button:disabled{opacity:.55;cursor:not-allowed}.privacy,.panel>p,.source-card p{font-size:.86rem;color:#52627a;line-height:1.55}.panel,.source-card,.state{margin:.9rem 0;padding:1rem;border:1px solid #dbe3ef;border-radius:12px;background:#fff}.source-card{background:#f9fbfe}.source-heading,.observation-heading{display:flex;justify-content:space-between;gap:.8rem;align-items:start}.source-heading h3,.panel h3{margin:.25rem 0}.source-heading p{overflow-wrap:anywhere}.state{background:#f2f6fb}.blocked,.limitation{color:#87500b;background:#fff6e8}.empty{color:#65738a}.notice{padding:.65rem;border-radius:8px;background:#eaf7ef;color:#146b48}.candidate-list{display:grid;gap:.7rem;padding:0;list-style:none}.candidate-row,.set-row{display:flex;justify-content:space-between;align-items:start;gap:.8rem;padding:.75rem;border:1px solid #e1e7ef;border-radius:9px}.candidate-row>div{min-width:0}.candidate-row small,.set-row small,.observation-heading small,.governance-action small{display:block;color:#66748b}.url{display:block;overflow-wrap:anywhere;margin:.2rem 0}.candidate-input-row{display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:.6rem;align-items:end;margin:.7rem 0;padding:.7rem;border:1px solid #e4eaf2;border-radius:9px}.candidate-input-row input{min-width:0}.actions,.button-row{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0}.panel button.secondary{background:#e8eef8;color:#203d72}.panel button.danger{background:#9a3440;color:white}.confirm{display:flex!important;grid-template-columns:auto 1fr!important;align-items:start;gap:.55rem!important;margin:.65rem 0;font-weight:600!important;line-height:1.45}.confirm input{width:auto;margin:.2rem 0 0}.source-card .limitation,.panel .limitation{padding:.55rem;border-radius:7px}.set-row{display:grid;grid-template-columns:1fr minmax(15rem,2fr);margin:.65rem 0}.set-row>div:first-child{min-width:0;overflow-wrap:anywhere}.set-row>template{display:contents}.set-row label,.set-row button{grid-column:2}.observation-card{margin:.8rem 0;padding:.8rem;border:1px solid #dce4ef;border-radius:10px;background:#fbfcff}.observation-heading small{overflow-wrap:anywhere}.observation-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.4rem}.observation-facts div{padding:.45rem;border-radius:7px;background:#f1f5fa}.observation-facts dt{font-size:.72rem;color:#5a6880}.observation-facts dd{margin:.2rem 0 0;overflow-wrap:anywhere}.governance-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:.6rem}.governance-action{display:grid;gap:.45rem;padding:.7rem;border:1px solid #e0e7f1;border-radius:8px;background:#fff}.governance-action textarea,.panel textarea{resize:vertical}.governance-action button{justify-self:start}.panel ul{padding-left:1.15rem}.panel li{overflow-wrap:anywhere}.panel .candidate-row{padding:.7rem}.panel .candidate-row>button{align-self:center}@media(max-width:720px){.admission{padding:.8rem}.hero,.source-heading,.candidate-row{display:grid}.hero{padding:.9rem}.source-picker{grid-template-columns:1fr}.candidate-input-row,.set-row{grid-template-columns:1fr}.set-row label,.set-row button{grid-column:1}.source-heading{justify-content:start}}
</style>
