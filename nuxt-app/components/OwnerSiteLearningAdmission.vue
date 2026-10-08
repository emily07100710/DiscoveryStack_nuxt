<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

type SiteLearningAuthorization = { id: number; fingerprint: string; consentVersion: string; expiresAt: string }
type SiteLearningGrant = { state: 'active'; fingerprint: string; authorizationId: number }
type SiteLearningEntry = { entryId: number; targetRowId: number; clientId: number; label: string; confirmationFingerprint: string; grant: SiteLearningGrant | null; authorizations: SiteLearningAuthorization[] }
type SiteLearningOutcome = { id: number; entryId: number; targetRowId: number | null; assessmentFingerprint: string; grantFingerprint: string | null; state: 'pending' | 'approved' | 'rejected' | 'blocked' }
type SiteLearningWorkspace = { entries: SiteLearningEntry[]; outcomes: SiteLearningOutcome[]; release: { state: 'not_generated' | 'generated'; status: string; eligibleCandidateCount: number; blockedOutcomeCount: number; modelTrainingAllowed: false; citationTrainingEligible: false; limitations: string[] } }
type OptInRequest = { entryId: number; targetRowId: number; confirmationFingerprint: string; authorizationId: number; authorizationFingerprint: string }
type RevokeRequest = { entryId: number; targetRowId: number; grantFingerprint: string }
type ReviewRequest = { id: number; entryId: number; targetRowId: number; assessmentFingerprint: string; grantFingerprint: string; decision: 'approve' | 'reject' }

const props = withDefaults(defineProps<{ workspace: unknown; releaseResult?: unknown; busy?: boolean; error?: string }>(), { busy: false, error: '' })
const emit = defineEmits<{ refresh: []; optIn: [value: OptInRequest]; revoke: [value: RevokeRequest]; review: [value: ReviewRequest]; buildRelease: [] }>()
const hashPattern = /^[a-f0-9]{64}$/u
const entryKeys = ['entryId', 'targetRowId', 'clientId', 'label', 'confirmationFingerprint', 'grant', 'authorizations'] as const
const authorizationKeys = ['id', 'fingerprint', 'consentVersion', 'expiresAt'] as const
const grantKeys = ['state', 'fingerprint', 'authorizationId'] as const
const outcomeKeys = ['id', 'entryId', 'targetRowId', 'assessmentFingerprint', 'grantFingerprint', 'state'] as const
const workspaceKeys = ['entries', 'outcomes', 'release'] as const
const releaseKeys = ['state', 'status', 'eligibleCandidateCount', 'blockedOutcomeCount', 'modelTrainingAllowed', 'citationTrainingEligible', 'limitations'] as const

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null
    const output: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      output[key] = descriptor.value
    }
    return output
  } catch { return null }
}
function positiveId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
function validateAuthorization(value: unknown): SiteLearningAuthorization | null {
  const row = exactRecord(value, authorizationKeys)
  if (!row || !positiveId(row.id) || typeof row.fingerprint !== 'string' || !hashPattern.test(row.fingerprint)
    || typeof row.consentVersion !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/u.test(row.consentVersion) || !timestamp(row.expiresAt)) return null
  return { id: row.id, fingerprint: row.fingerprint, consentVersion: row.consentVersion, expiresAt: row.expiresAt }
}
function validateGrant(value: unknown): SiteLearningGrant | null | false {
  if (value === null) return null
  const row = exactRecord(value, grantKeys)
  if (!row || row.state !== 'active' || typeof row.fingerprint !== 'string' || !hashPattern.test(row.fingerprint) || !positiveId(row.authorizationId)) return false
  return { state: 'active', fingerprint: row.fingerprint, authorizationId: row.authorizationId }
}
function validateEntry(value: unknown): SiteLearningEntry | null {
  const row = exactRecord(value, entryKeys)
  if (!row || !positiveId(row.entryId) || !positiveId(row.targetRowId) || !positiveId(row.clientId)
    || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 160
    || typeof row.confirmationFingerprint !== 'string' || !hashPattern.test(row.confirmationFingerprint)
    || !Array.isArray(row.authorizations) || row.authorizations.length > 100) return null
  const grant = validateGrant(row.grant)
  const authorizations = row.authorizations.map(validateAuthorization)
  // A persisted grant remains revocable even after its source authorization is no longer present in the current projection.
  if (grant === false || authorizations.some(value => !value)) return null
  return { entryId: row.entryId, targetRowId: row.targetRowId, clientId: row.clientId, label: row.label, confirmationFingerprint: row.confirmationFingerprint, grant, authorizations: authorizations as SiteLearningAuthorization[] }
}
function validateOutcome(value: unknown): SiteLearningOutcome | null {
  const row = exactRecord(value, outcomeKeys)
  if (!row || !positiveId(row.id) || !positiveId(row.entryId)
    || typeof row.assessmentFingerprint !== 'string' || !hashPattern.test(row.assessmentFingerprint)
    || typeof row.state !== 'string' || !(['pending', 'approved', 'rejected', 'blocked'] as const).includes(row.state as SiteLearningOutcome['state'])) return null
  const blocked = row.state === 'blocked'
  if ((!blocked && !positiveId(row.targetRowId)) || (blocked && row.targetRowId !== null && !positiveId(row.targetRowId))
    || (!blocked && (typeof row.grantFingerprint !== 'string' || !hashPattern.test(row.grantFingerprint)))
    || (blocked && row.grantFingerprint !== null && (typeof row.grantFingerprint !== 'string' || !hashPattern.test(row.grantFingerprint)))) return null
  return { id: row.id, entryId: row.entryId, targetRowId: row.targetRowId as number | null, assessmentFingerprint: row.assessmentFingerprint, grantFingerprint: row.grantFingerprint as string | null, state: row.state as SiteLearningOutcome['state'] }
}
function validateWorkspace(value: unknown): SiteLearningWorkspace | null {
  const row = exactRecord(value, workspaceKeys)
  if (!row || !Array.isArray(row.entries) || row.entries.length > 500 || !Array.isArray(row.outcomes) || row.outcomes.length > 500) return null
  const release = exactRecord(row.release, releaseKeys)
  if (!release || !['not_generated', 'generated'].includes(String(release.state)) || typeof release.status !== 'string'
    || !positiveOrZero(release.eligibleCandidateCount) || !positiveOrZero(release.blockedOutcomeCount)
    || release.modelTrainingAllowed !== false || release.citationTrainingEligible !== false
    || !Array.isArray(release.limitations) || release.limitations.length > 40 || release.limitations.some(item => typeof item !== 'string' || item.length > 160)) return null
  const entries = row.entries.map(validateEntry), outcomes = row.outcomes.map(validateOutcome)
  if (entries.some(item => !item) || outcomes.some(item => !item)) return null
  return { entries: entries as SiteLearningEntry[], outcomes: outcomes as SiteLearningOutcome[], release: { state: release.state as 'not_generated' | 'generated', status: release.status, eligibleCandidateCount: release.eligibleCandidateCount as number, blockedOutcomeCount: release.blockedOutcomeCount as number, modelTrainingAllowed: false, citationTrainingEligible: false, limitations: release.limitations as string[] } }
}
function positiveOrZero(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }

function validateReleaseResult(value: unknown): { status: string; manifest: Record<string, unknown>; eligibleCandidateCount: number; blockedOutcomeCount: number; limitations: string[]; datasetDigest: string; releaseFingerprint: string; candidateResults: Array<{ candidateStatus: string; candidateFingerprint: string | null; reasonCodes: string[] }> } | null {
  const keys = ['status', 'manifest', 'candidateResults', 'eligibleCandidateCount', 'blockedOutcomeCount', 'datasetDigest', 'releaseFingerprint', 'modelTrainingAllowed', 'citationTrainingEligible', 'limitations']
  const row = exactRecord(value, keys)
  const manifestKeys = ['status', 'eligibleCandidateCount', 'trainCandidateFingerprints', 'validationCandidateFingerprints', 'testCandidateFingerprints', 'candidateFingerprints', 'sourceCombinationCount', 'contentTypeCounts', 'languageCounts', 'policyVersion', 'engineVersion', 'reasonCodes', 'limitations', 'manifestFingerprint']
  const manifest = row && exactRecord(row.manifest, manifestKeys)
  const validHashList = (value: unknown) => Array.isArray(value) && value.length <= 500 && value.every(item => typeof item === 'string' && hashPattern.test(item))
  const validCounts = (value: unknown) => {
    try {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const keys = Reflect.ownKeys(value)
      if (keys.length > 80 || keys.some(key => typeof key !== 'string')) return false
      const record = exactRecord(value, keys as string[])
      return Boolean(record && Object.values(record).every(item => positiveOrZero(item)))
    } catch { return false }
  }
  if (!row || typeof row.status !== 'string' || row.status.length > 80 || !manifest || !Array.isArray(row.candidateResults) || row.candidateResults.length > 500
    || !positiveOrZero(row.eligibleCandidateCount) || !positiveOrZero(row.blockedOutcomeCount)
    || typeof row.datasetDigest !== 'string' || !hashPattern.test(row.datasetDigest) || typeof row.releaseFingerprint !== 'string' || !hashPattern.test(row.releaseFingerprint)
    || row.modelTrainingAllowed !== false || row.citationTrainingEligible !== false
    || !Array.isArray(row.limitations) || row.limitations.length > 40 || row.limitations.some(item => typeof item !== 'string' || item.length > 160)
    || typeof manifest.status !== 'string' || !positiveOrZero(manifest.eligibleCandidateCount)
    || !validHashList(manifest.trainCandidateFingerprints) || !validHashList(manifest.validationCandidateFingerprints) || !validHashList(manifest.testCandidateFingerprints) || !validHashList(manifest.candidateFingerprints)
    || !positiveOrZero(manifest.sourceCombinationCount) || !validCounts(manifest.contentTypeCounts) || !validCounts(manifest.languageCounts)
    || typeof manifest.policyVersion !== 'string' || manifest.policyVersion.length > 80 || typeof manifest.engineVersion !== 'string' || manifest.engineVersion.length > 80
    || !Array.isArray(manifest.reasonCodes) || manifest.reasonCodes.length > 80 || manifest.reasonCodes.some(code => typeof code !== 'string' || code.length > 160)
    || !Array.isArray(manifest.limitations) || manifest.limitations.length > 80 || manifest.limitations.some(item => typeof item !== 'string' || item.length > 200)
    || typeof manifest.manifestFingerprint !== 'string' || !hashPattern.test(manifest.manifestFingerprint)) return null
  const candidateResults: Array<{ candidateStatus: string; candidateFingerprint: string | null; reasonCodes: string[] }> = []
  for (const item of row.candidateResults) {
    const candidate = exactRecord(item, ['candidateStatus', 'candidateFingerprint', 'reasonCodes'])
    if (!candidate || typeof candidate.candidateStatus !== 'string' || (candidate.candidateFingerprint !== null && (typeof candidate.candidateFingerprint !== 'string' || !hashPattern.test(candidate.candidateFingerprint)))
      || !Array.isArray(candidate.reasonCodes) || candidate.reasonCodes.length > 40 || candidate.reasonCodes.some(code => typeof code !== 'string' || code.length > 160)) return null
    candidateResults.push({ candidateStatus: candidate.candidateStatus, candidateFingerprint: candidate.candidateFingerprint as string | null, reasonCodes: candidate.reasonCodes as string[] })
  }
  return { status: row.status, manifest, eligibleCandidateCount: row.eligibleCandidateCount as number, blockedOutcomeCount: row.blockedOutcomeCount as number, limitations: row.limitations as string[], datasetDigest: row.datasetDigest, releaseFingerprint: row.releaseFingerprint, candidateResults }
}

const workspace = computed(() => validateWorkspace(props.workspace))
const releaseResult = computed(() => validateReleaseResult(props.releaseResult))
const selectedAuthorizationIds = reactive<Record<string, number | ''>>({})
const evidenceAttested = reactive<Record<string, boolean>>({})
const scopeConfirmed = reactive<Record<string, boolean>>({})
const confirmationOpened = reactive<Record<string, boolean>>({})
const piiReviewed = reactive<Record<string, boolean>>({})
const limitationsUnderstood = reactive<Record<string, boolean>>({})
const revokeConfirmation = reactive<Record<string, boolean>>({})
const releasePromptOpen = ref(false)
const workspaceInvalid = computed(() => !workspace.value)
const outcomeLabels: Record<SiteLearningOutcome['state'], string> = { pending: '待 owner 審查', approved: '已准入（僅此資料版本）', rejected: '已排除', blocked: '目前阻擋' }
const entryIdentity = (entry: SiteLearningEntry) => `${entry.entryId}:${entry.targetRowId}`
function matchingAuthorization(entry: SiteLearningEntry): SiteLearningAuthorization | null {
  const id = selectedAuthorizationIds[entryIdentity(entry)]
  return entry.authorizations.find(item => item.id === id) || null
}
function changeAuthorization(entry: SiteLearningEntry, event: Event) {
  const key = entryIdentity(entry)
  const selected = Number((event.target as HTMLSelectElement).value)
  selectedAuthorizationIds[key] = entry.authorizations.some(item => item.id === selected) ? selected : ''
  evidenceAttested[key] = false
  scopeConfirmed[key] = false
  confirmationOpened[key] = false
}
function currentEntry(entryId: number, targetRowId: number): SiteLearningEntry | undefined { return workspace.value?.entries.find(item => item.entryId === entryId && item.targetRowId === targetRowId) }
function outcomeStateText(outcome: SiteLearningOutcome) { return outcomeLabels[outcome.state] }
function dateLabel(value: string) { return new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeZone: 'Asia/Taipei' }).format(new Date(value)) }
watch(() => workspace.value?.entries.map(entry => `${entryIdentity(entry)}:${entry.confirmationFingerprint}:${entry.grant?.fingerprint || ''}:${entry.authorizations.map(item => `${item.id}:${item.fingerprint}`).join(',')}`).join('|'), () => {
  for (const entry of workspace.value?.entries || []) {
    const key = entryIdentity(entry)
    const selected = entry.authorizations.find(item => item.id === selectedAuthorizationIds[key])
    if (!selected) selectedAuthorizationIds[key] = entry.authorizations[0]?.id || ''
    evidenceAttested[key] = false
    scopeConfirmed[key] = false
    confirmationOpened[key] = false
  }
}, { immediate: true })
watch(() => workspace.value?.outcomes.map(outcome => `${outcome.id}:${outcome.assessmentFingerprint}:${outcome.grantFingerprint}:${outcome.state}`).join('|'), () => {
  for (const outcome of workspace.value?.outcomes || []) {
    piiReviewed[String(outcome.id)] = false
    limitationsUnderstood[String(outcome.id)] = false
  }
}, { immediate: true })

function beginOptIn(entry: SiteLearningEntry) { confirmationOpened[entryIdentity(entry)] = true }
function cancelOptIn(entry: SiteLearningEntry) {
  const key = entryIdentity(entry)
  confirmationOpened[key] = false
  evidenceAttested[key] = false
  scopeConfirmed[key] = false
}
function confirmOptIn(entry: SiteLearningEntry) {
  const authorization = matchingAuthorization(entry)
  const key = entryIdentity(entry)
  if (!authorization || !evidenceAttested[key] || !scopeConfirmed[key]) return
  emit('optIn', { entryId: entry.entryId, targetRowId: entry.targetRowId, confirmationFingerprint: entry.confirmationFingerprint, authorizationId: authorization.id, authorizationFingerprint: authorization.fingerprint })
}
function beginRevoke(entry: SiteLearningEntry) { revokeConfirmation[entryIdentity(entry)] = true }
function cancelRevoke(entry: SiteLearningEntry) { revokeConfirmation[entryIdentity(entry)] = false }
function submitRevoke(entry: SiteLearningEntry) {
  if (entry.grant && revokeConfirmation[entryIdentity(entry)]) {
    emit('revoke', { entryId: entry.entryId, targetRowId: entry.targetRowId, grantFingerprint: entry.grant.fingerprint })
    revokeConfirmation[entryIdentity(entry)] = false
  }
}
function submitReview(outcome: SiteLearningOutcome, decision: 'approve' | 'reject') {
  const key = String(outcome.id)
  if (outcome.state !== 'pending' || outcome.targetRowId === null || outcome.grantFingerprint === null || !piiReviewed[key] || !limitationsUnderstood[key]) return
  emit('review', { id: outcome.id, entryId: outcome.entryId, targetRowId: outcome.targetRowId, assessmentFingerprint: outcome.assessmentFingerprint, grantFingerprint: outcome.grantFingerprint, decision })
}
function beginRelease() { releasePromptOpen.value = true }
function cancelRelease() { releasePromptOpen.value = false }
function confirmRelease() { releasePromptOpen.value = false; emit('buildRelease') }
</script>

<template>
  <section id="site-learning-admission" class="site-learning" aria-labelledby="site-learning-title">
    <div class="section-head">
      <div><p class="eyebrow">網站成效資料准入</p><h2 id="site-learning-title">先核對授權，再審查每份成效資料</h2></div>
      <button class="secondary-button" type="button" :disabled="busy" @click="emit('refresh')">重新讀取准入狀態</button>
    </div>
    <p class="lead">這是獨立的網站成效學習流程；不會改變內容發布狀態，也不會自動收數、訓練或部署模型。每份准入只綁定明確客戶用途授權與已核驗的網站發布版本。</p>
    <p class="consent-boundary"><strong>重要：</strong>「擁有人申明已有客戶模型用途同意證明，不是代客戶同意。」請確認留存的客戶同意證明明確涵蓋模型改進用途、網站範圍、版本及保存期限；LINE 發文同意、發布核准或網站公開均不等於模型用途同意。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="workspaceInvalid" class="empty">目前無法確認網站成效資料准入狀態；未顯示確認、撤銷、審查或釋出操作。</div>
    <template v-else>
      <section class="subsection" aria-labelledby="site-learning-grants-title">
        <h3 id="site-learning-grants-title">一、網站版本與客戶用途授權</h3>
        <p class="muted">僅伺服器核對的歷史發布版本可申請准入。來源授權失效或網站核驗不可用時，不可新增准入；已存在的授權仍可撤銷。</p>
        <div v-if="!workspace!.entries.length" class="empty">目前沒有符合條件的已核驗網站版本。</div>
        <article v-for="entry in workspace!.entries" :key="entryIdentity(entry)" class="entry-card">
          <div class="entry-top"><strong>{{ entry.label }}</strong><span>{{ entry.grant ? '已建立接入授權' : entry.authorizations.length ? '尚未接入' : '目前沒有有效客戶授權' }}</span></div>
          <p class="muted">這是特定網站與已核驗發布版本的資料治理狀態，不代表網站目前仍公開或已經收集成效資料。</p>
          <div v-if="entry.grant" class="grant-row">
            <strong>成效資料接入授權有效紀錄</strong>
            <span>綁定授權版本：{{ entry.authorizations.find(item => item.id === entry.grant!.authorizationId)?.consentVersion || '目前授權版本不可用' }}</span>
            <span>此紀錄不代表目前來源、網站或同意仍有效；每次收數仍須重新核驗。</span>
            <button v-if="!revokeConfirmation[entryIdentity(entry)]" class="danger-button" type="button" :disabled="busy" @click="beginRevoke(entry)">撤銷此網站版本的成效資料授權</button>
            <div v-else class="confirm-box" role="group" aria-label="確認撤銷網站成效資料授權"><p>撤銷會阻止後續收數與資料准入；歷史治理紀錄會保留。是否繼續？</p><div class="button-row"><button class="danger-button" type="button" :disabled="busy" @click="submitRevoke(entry)">明確撤銷此授權</button><button class="secondary-button" type="button" :disabled="busy" @click="cancelRevoke(entry)">取消</button></div></div>
          </div>
          <div v-else-if="entry.authorizations.length" class="opt-in-form">
            <label>客戶模型用途授權<select :value="selectedAuthorizationIds[entryIdentity(entry)]" :disabled="busy" @change="changeAuthorization(entry, $event)"><option v-for="authorization in entry.authorizations" :key="`${authorization.id}:${authorization.fingerprint}`" :value="authorization.id">同意版本 {{ authorization.consentVersion }} · 到期 {{ dateLabel(authorization.expiresAt) }}</option></select></label>
            <button v-if="!confirmationOpened[entryIdentity(entry)]" class="primary-button" type="button" :disabled="busy || !matchingAuthorization(entry)" @click="beginOptIn(entry)">確認此網站版本接入成效資料</button>
            <div v-else class="confirm-box" role="group" aria-label="確認成效資料授權範圍">
              <label class="check"><input :checked="evidenceAttested[entryIdentity(entry)] === true" type="checkbox" @change="evidenceAttested[entryIdentity(entry)] = ($event.target as HTMLInputElement).checked">我（owner）已查驗有可核對的客戶模型用途同意證明；這是對證明存在的申明，不是代客戶同意。</label>
              <label class="check"><input :checked="scopeConfirmed[entryIdentity(entry)] === true" type="checkbox" @change="scopeConfirmed[entryIdentity(entry)] = ($event.target as HTMLInputElement).checked">我已確認所選同意涵蓋此網站、此發布版本、模型改進用途與保存期限。</label>
              <div class="button-row"><button class="primary-button" type="button" :disabled="busy || !evidenceAttested[entryIdentity(entry)] || !scopeConfirmed[entryIdentity(entry)]" @click="confirmOptIn(entry)">保存此版本接入授權</button><button class="secondary-button" type="button" :disabled="busy" @click="cancelOptIn(entry)">取消</button></div>
            </div>
          </div>
          <div v-else class="blocked-note">沒有符合此網站的有效客戶模型用途授權，因此不提供接入確認。</div>
          <details class="advanced"><summary>檢視此筆核對指紋</summary><dl><div><dt>網站發布核對指紋</dt><dd>{{ entry.confirmationFingerprint }}</dd></div><div v-if="entry.grant"><dt>接入授權指紋</dt><dd>{{ entry.grant.fingerprint }}</dd></div></dl></details>
        </article>
      </section>

      <section class="subsection" aria-labelledby="site-learning-outcomes-title">
        <h3 id="site-learning-outcomes-title">二、逐筆成效資料審查</h3>
        <p class="muted">每筆核准只涵蓋顯示的 assessment 與客戶授權指紋；新增、改動、撤銷或過期都需重新審查。核准不會開始訓練。</p>
        <div v-if="!workspace!.outcomes.length" class="empty">目前沒有可審查的網站成效資料候選。</div>
        <article v-for="outcome in workspace!.outcomes" :key="outcome.id" class="outcome-card">
          <div class="entry-top"><strong>{{ workspace!.entries.find(entry => entry.entryId === outcome.entryId && entry.targetRowId === outcome.targetRowId)?.label || '網站成效項目' }}</strong><span>{{ outcomeStateText(outcome) }}</span></div>
          <p class="muted">審查狀態不等於模型品質、因果效果或已訓練。核准前請確認來源權利、去識別化與觀察限制。</p>
          <p v-if="outcome.state === 'blocked' && (outcome.targetRowId === null || outcome.grantFingerprint === null)" class="blocked-note">這筆舊資料缺少網站目標或准入證明指紋；保留為受阻紀錄，不提供審查操作。</p>
          <div v-if="outcome.state === 'pending'" class="review-form">
            <label class="check"><input :checked="piiReviewed[String(outcome.id)] === true" type="checkbox" @change="piiReviewed[String(outcome.id)] = ($event.target as HTMLInputElement).checked">我已逐筆檢查個資與去識別化，不以雜湊代表匿名。</label>
            <label class="check"><input :checked="limitationsUnderstood[String(outcome.id)] === true" type="checkbox" @change="limitationsUnderstood[String(outcome.id)] = ($event.target as HTMLInputElement).checked">我理解這是觀察資料，不代表因果或已驗證商業成效。</label>
            <div class="button-row"><button class="primary-button" type="button" :disabled="busy || !piiReviewed[String(outcome.id)] || !limitationsUnderstood[String(outcome.id)]" @click="submitReview(outcome, 'approve')">核准這份資料准入候選</button><button class="danger-button" type="button" :disabled="busy || !piiReviewed[String(outcome.id)] || !limitationsUnderstood[String(outcome.id)]" @click="submitReview(outcome, 'reject')">排除此筆候選</button></div>
          </div>
          <details class="advanced"><summary>檢視審查指紋</summary><dl><div><dt>成效評估指紋</dt><dd>{{ outcome.assessmentFingerprint }}</dd></div><div><dt>客戶授權指紋</dt><dd>{{ outcome.grantFingerprint || '缺少授權指紋' }}</dd></div></dl></details>
        </article>
      </section>

      <section class="subsection release-section" aria-labelledby="site-learning-release-title">
        <h3 id="site-learning-release-title">三、明確建立最新成效資料釋出</h3>
        <p class="muted">只有你按下按鈕才重新核對網站、目前授權與已審查資料。釋出只產生去識別化資料集候選／manifest 摘要，不會訓練或部署模型，也不會進入引用模型資料集。</p>
        <div class="release-facts"><span>目前狀態：<strong>{{ workspace!.release.status }}</strong></span><span>符合候選：<strong>{{ workspace!.release.eligibleCandidateCount }}</strong></span><span>受阻候選：<strong>{{ workspace!.release.blockedOutcomeCount }}</strong></span></div>
        <ul v-if="workspace!.release.limitations.length" class="reasons"><li v-for="(reason, index) in workspace!.release.limitations" :key="`${reason}-${index}`">{{ reason }}</li></ul>
        <p class="blocked-note">模型訓練權限：未授予。引用模型准入：不適用。</p>
        <button v-if="!releasePromptOpen" class="primary-button" type="button" :disabled="busy" @click="beginRelease">重新核對並建立最新成效資料釋出</button>
        <div v-else class="confirm-box" role="group" aria-label="確認建立成效資料釋出"><p>此操作會立即重新核對目前網站與客戶授權並建立本次資料候選快照；它不是訓練或部署。是否繼續？</p><div class="button-row"><button class="primary-button" type="button" :disabled="busy" @click="confirmRelease">明確建立本次釋出</button><button class="secondary-button" type="button" :disabled="busy" @click="cancelRelease">取消</button></div></div>
        <div v-if="releaseResult" class="release-result" aria-live="polite"><strong>本次重新核對結果：{{ releaseResult.status }}</strong><span>符合候選 {{ releaseResult.eligibleCandidateCount }}；受阻候選 {{ releaseResult.blockedOutcomeCount }}。</span><ul><template v-for="candidate in releaseResult.candidateResults"><li v-for="(reason, index) in candidate.reasonCodes" :key="`${candidate.candidateFingerprint}-${index}`">{{ reason }}</li></template></ul><span>訓練與正式部署均未執行。</span><details class="advanced"><summary>檢視本次資料指紋</summary><dl><div><dt>Dataset digest</dt><dd>{{ releaseResult.datasetDigest }}</dd></div><div><dt>Release fingerprint</dt><dd>{{ releaseResult.releaseFingerprint }}</dd></div></dl></details></div>
        <p v-if="props.releaseResult && !releaseResult" class="blocked-note" role="alert">本次釋出回應不完整或格式未知；不顯示候選數量或成功狀態。</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.site-learning{display:grid;gap:1rem;margin:2rem 0;padding:clamp(1rem,2vw,1.5rem);border:1px solid #cbd8d0;border-radius:14px;background:#f5f8f4;color:#21362c}.section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem}.eyebrow{margin:0 0 .4rem;color:#547264;font-size:.72rem;font-weight:900;letter-spacing:.1em}.section-head h2{margin:0;font-size:clamp(1.35rem,3vw,1.8rem)}.lead,.muted{color:#54645b;line-height:1.6}.lead{margin:0}.muted{margin:.35rem 0;font-size:.83rem}.consent-boundary{margin:0;padding:.85rem 1rem;border-left:4px solid #a7793d;background:#fff8ea;color:#594529;font-size:.88rem;line-height:1.55}.subsection{display:grid;gap:.7rem;padding-top:1.1rem;border-top:1px solid #d6e1d8}.subsection h3{margin:0;font-size:1.1rem}.entry-card,.outcome-card{display:grid;gap:.55rem;min-width:0;padding:1rem;border:1px solid #d7e1d8;border-radius:10px;background:#fff}.entry-top{display:flex;justify-content:space-between;gap:.8rem;align-items:flex-start}.entry-top span{font-size:.75rem;font-weight:800;color:#53685a}.opt-in-form,.grant-row,.review-form,.confirm-box,.release-result{display:grid;gap:.6rem;padding:.8rem;background:#f5f8f5;border:1px solid #e0e8e0;border-radius:8px}.opt-in-form>label{display:grid;gap:.35rem;color:#43584a;font-size:.8rem;font-weight:800}.opt-in-form select{max-width:100%;padding:.6rem;border:1px solid #aabbb0;border-radius:6px;background:#fff;color:inherit;font:inherit}.check{display:flex;align-items:flex-start;gap:.55rem;color:#3f5145;font-size:.82rem;line-height:1.5}.check input{flex:0 0 auto;margin-top:.2rem}.button-row{display:flex;flex-wrap:wrap;gap:.55rem}.primary-button,.secondary-button,.danger-button{width:max-content;max-width:100%;border:1px solid #91a89a;border-radius:7px;padding:.55rem .8rem;background:#fff;color:#274537;font:inherit;font-size:.8rem;font-weight:800;cursor:pointer}.primary-button{background:#28543e;border-color:#28543e;color:#fff}.danger-button{border-color:#c78c83;color:#8a4036}.primary-button:disabled,.secondary-button:disabled,.danger-button:disabled{opacity:.55;cursor:not-allowed}.blocked-note,.empty{padding:.75rem .9rem;border:1px dashed #b9c6bc;background:#fff;color:#5c675f;font-size:.83rem;line-height:1.5}.advanced{padding-top:.5rem;border-top:1px solid #e2e8e2}.advanced summary{width:max-content;max-width:100%;cursor:pointer;color:#4d6e5c;font-size:.76rem;font-weight:800}.advanced dl{display:grid;gap:.4rem;margin:.7rem 0 0}.advanced dl div{display:grid;grid-template-columns:11rem minmax(0,1fr);gap:.6rem;font-size:.72rem}.advanced dt{color:#647268}.advanced dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.release-facts{display:flex;flex-wrap:wrap;gap:.5rem}.release-facts span{padding:.55rem .7rem;border:1px solid #d6e1d8;background:#fff;color:#59685e;font-size:.8rem}.release-facts strong{color:#274c37}.reasons,.release-result ul{margin:.25rem 0;padding-left:1.25rem;color:#58665c;font-size:.8rem;line-height:1.5}.error{margin:0;color:#8b302c;font-size:.85rem;font-weight:700}.release-result strong,.release-result span{font-size:.82rem;line-height:1.5}.release-result strong{color:#30543d}@media(max-width:620px){.section-head,.entry-top{display:grid;align-items:start}.section-head>.secondary-button{width:max-content}.site-learning{margin:1.25rem 0;padding:1rem}.advanced dl div{grid-template-columns:1fr;gap:.2rem}}
.site-learning,.subsection,.opt-in-form,.grant-row,.review-form,.confirm-box,.release-result{min-width:0;grid-template-columns:minmax(0,1fr)}
.section-head{flex-wrap:wrap}.section-head>div,.entry-top>*{min-width:0}.entry-top{flex-wrap:wrap}.entry-top strong{overflow-wrap:anywhere}
.opt-in-form>label{min-width:0}.opt-in-form select{width:100%;min-width:0;box-sizing:border-box}.confirm-box,.check,.blocked-note,.reasons{overflow-wrap:anywhere}
</style>
