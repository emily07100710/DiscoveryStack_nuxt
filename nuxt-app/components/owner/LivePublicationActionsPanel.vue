<script setup lang="ts">
import type { getLivePublicationActionWorkspace } from '../../server/learning-loop/live-action-service'

type Workspace = Awaited<ReturnType<typeof getLivePublicationActionWorkspace>>
type ActionItem = Workspace['items'][number]
type Decision = 'approved' | 'rejected'
// The intervention catch-all has dynamic subpaths; avoid expanding the full Nitro route map.
const readApi = $fetch as unknown as <T>(path: string, options: { method: 'GET' }) => Promise<T>
const mutateApi = $fetch as unknown as (path: string, options: { method: 'POST'; body: Record<string, unknown> }) => Promise<unknown>

const endpoint = '/api/interventions/closed-loop/live-actions'
const workspace = ref<Workspace | null>(null)
const loading = ref(true)
const submitting = ref(false)
const safeError = ref('')
const notice = ref('')
const review = reactive({
  actionId: null as number | null,
  evidenceFingerprint: '',
  decision: 'approved' as Decision,
  piiReviewConfirmed: false,
  rightsConfirmed: false,
  observationalOnlyAcknowledged: false,
  reviewReason: '',
})

const selectedItem = computed(() => workspace.value?.items.find(item => item.id === review.actionId) || null)
const reviewReasonLength = computed(() => review.reviewReason.trim().length)
const canSubmitReview = computed(() => {
  const item = selectedItem.value
  return Boolean(!loading.value && !submitting.value && item && item.status === 'observed' && item.reviewStatus === 'pending'
    && item.currentEvidenceValid && item.evidenceFingerprint === review.evidenceFingerprint && !isExpired(item)
    && review.piiReviewConfirmed && review.rightsConfirmed && review.observationalOnlyAcknowledged
    && reviewReasonLength.value >= 10 && reviewReasonLength.value <= 500)
})

function resetReview() {
  review.actionId = null
  review.evidenceFingerprint = ''
  review.decision = 'approved'
  review.piiReviewConfirmed = false
  review.rightsConfirmed = false
  review.observationalOnlyAcknowledged = false
  review.reviewReason = ''
}

function isExpired(item: ActionItem): boolean {
  const expiry = Date.parse(item.expiresAt)
  return !Number.isFinite(expiry) || expiry <= Date.now() || item.status === 'expired'
}

async function refreshWorkspace(preserveNotice = false) {
  resetReview()
  safeError.value = ''
  if (!preserveNotice) notice.value = ''
  workspace.value = null
  loading.value = true
  try {
    workspace.value = await readApi<Workspace>(endpoint, { method: 'GET' })
  } catch (error: unknown) {
    const status = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : 0
    safeError.value = status === 401 || status === 403
      ? '請先登入擁有人工作台，再重新讀取發布操作紀錄。'
      : '發布操作紀錄暫時無法讀取；畫面不會顯示未驗證或過期的審查資料。'
  } finally {
    loading.value = false
  }
}

function startReview(item: ActionItem, decision: Decision) {
  resetReview()
  if (!item.currentEvidenceValid || !item.evidenceFingerprint || isExpired(item) || item.status !== 'observed' || item.reviewStatus !== 'pending') return
  review.actionId = item.id
  review.evidenceFingerprint = item.evidenceFingerprint
  review.decision = decision
}

async function submitReview() {
  const item = selectedItem.value
  if (!item || !canSubmitReview.value) return
  submitting.value = true
  safeError.value = ''
  notice.value = ''
  try {
    await mutateApi(`${endpoint}/review`, {
      method: 'POST',
      body: {
        actionId: item.id,
        evidenceFingerprint: review.evidenceFingerprint,
        decision: review.decision,
        piiReviewConfirmed: true,
        rightsConfirmed: true,
        observationalOnlyAcknowledged: true,
        reviewReason: review.reviewReason.trim(),
      },
    })
    notice.value = '審查已記錄；這不會觸發擷取、發布或模型訓練。'
    await refreshWorkspace(true)
  } catch {
    resetReview()
    safeError.value = '審查未完成。請重新讀取目前證據後再確認；不會顯示原始伺服器回應。'
  } finally {
    submitting.value = false
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    capturing_before: '正在保存發布前基線', before_ready: '發布前基線已保存', dispatch_started: '發布已開始，等待正式收據',
    awaiting_after: '等待正式頁面驗證', capturing_after: '正在驗證正式頁面', observed: '已觀察到符合計畫的頁面',
    blocked: '目前受阻', expired: '證據已到期',
  }
  return labels[status] || '狀態待確認'
}

function reasonLabel(code: string | null): string {
  if (!code) return '目前沒有額外的操作原因。'
  const labels: Record<string, string> = {
    BEFORE_CAPTURE_DEFERRED: '發布前基線尚未安全保存，這筆操作不會被當作已驗證。',
    LIVE_PAGE_NOT_YET_MATCHED: '目前正式頁面尚未符合核准內容；系統會依既有排程有限重試。',
    AFTER_VERIFICATION_DEFERRED: '發布後頁面驗證暫時延後，尚未形成可審查證據。',
    CURRENT_ACTION_AUTHORITY_REQUIRED: '目前授權或發布來源已變動，需重新確認後才可使用。',
    EXACT_BEFORE_AND_RECEIPT_REQUIRED: '尚缺精確的發布前基線或正式發布收據。',
    AFTER_VERIFICATION_WINDOW_EXPIRED: '發布後頁面驗證時限已過，這筆證據不可審查。',
    PROJECTION_NOT_VERIFIED: '頁面語意投影未通過檢查，不能作為審查依據。',
  }
  return labels[code] || '有一項目前狀態需要系統重新確認；原始資料不會在此顯示。'
}

function beforeLabel(state: string | null): string {
  if (state === 'not_found') return '同一 URL 的已知 404（新頁基線）'
  if (state === 'controlled_document') return '已驗證的受控內容頁'
  return '未能建立可用基線'
}

function reviewStatusLabel(status: string): string {
  if (status === 'approved') return '已核准（仍須獨立資料集審查）'
  if (status === 'rejected') return '已拒絕'
  return '等待擁有人獨立審查'
}

onMounted(() => { void refreshWorkspace() })
</script>

<template>
  <section class="live-actions" aria-labelledby="live-actions-title">
    <header class="panel-heading">
      <div>
        <p class="eyebrow">受治理的實際發布操作</p>
        <h2 id="live-actions-title">發布前後證據</h2>
      </div>
      <button type="button" class="button button--secondary" :disabled="loading || submitting" @click="refreshWorkspace()">{{ loading ? '讀取中…' : '重新讀取' }}</button>
    </header>

    <p class="limitation">這是受控 HTML 的語意觀察，不代表瀏覽器可見性、搜尋索引或 AI 引用；結果只供後續獨立審查，不是因果結論或主要引用標籤。此面板不會觸發擷取、發布或訓練。</p>
    <p v-if="safeError" class="notice notice--error" role="alert">{{ safeError }}</p>
    <p v-else-if="notice" class="notice notice--success" role="status">{{ notice }}</p>
    <p v-if="workspace && !workspace.enabled" class="state-note">實際發布資料擷取目前未啟用；功能預設關閉。此畫面只讀取既有紀錄。</p>
    <p v-if="loading" class="empty-state" role="status">正在讀取擁有人專屬的安全摘要…</p>
    <p v-else-if="safeError" class="empty-state">目前無法確認最新狀態，請稍後重新讀取。</p>
    <p v-else-if="workspace && workspace.items.length === 0" class="empty-state">目前沒有實際發布操作紀錄；不會建立示範資料。</p>

    <div v-else-if="workspace" class="action-list">
      <article v-for="item in workspace.items" :key="item.id" class="action-card">
        <div class="action-heading">
          <div><p class="eyebrow">操作 #{{ item.id }}</p><h3>{{ statusLabel(item.status) }}</h3></div>
          <span class="state-chip" :data-state="item.status">{{ item.status === 'expired' || isExpired(item) ? '已到期' : !item.currentEvidenceValid ? '需重新確認' : '目前證據有效' }}</span>
        </div>
        <dl class="facts">
          <div><dt>目前證據</dt><dd>{{ item.currentEvidenceValid ? '有效（指紋已綁定本次審查）' : '尚未確認或已變動' }}</dd></div>
          <div><dt>審查狀態</dt><dd>{{ reviewStatusLabel(item.reviewStatus) }}</dd></div>
          <div><dt>證據期限</dt><dd>{{ item.expiresAt }}</dd></div>
          <div><dt>驗證嘗試</dt><dd>{{ item.attemptCount }} 次<span v-if="item.nextAttemptAt"> · 下次檢查 {{ item.nextAttemptAt }}</span></dd></div>
        </dl>
        <p class="reason">{{ !item.currentEvidenceValid ? '目前證據無法供審查使用；請先重新讀取最新狀態。' : reasonLabel(item.reasonCode) }}</p>

        <dl v-if="item.evidenceSummary && item.currentEvidenceValid && !isExpired(item)" class="evidence">
          <div><dt>發布前</dt><dd>{{ beforeLabel(item.evidenceSummary.liveBeforeState) }} · {{ item.evidenceSummary.beforeCapturedAt }}</dd></div>
          <div><dt>實際發布</dt><dd>{{ item.evidenceSummary.deliveredAt }}</dd></div>
          <div><dt>發布後語意驗證</dt><dd>{{ item.evidenceSummary.afterCapturedAt }}</dd></div>
        </dl>
        <p v-else class="evidence-unavailable">發布前／發布後的有效摘要目前不可用。</p>

        <div v-if="item.evidenceSummary && item.currentEvidenceValid && !isExpired(item)" class="planned-features">
          <h4>預先計畫的發布改動</h4>
          <dl class="feature-grid">
            <div><dt>新頁</dt><dd>{{ item.evidenceSummary.features.newPage ? '是' : '否' }}</dd></div>
            <div><dt>標題有變更</dt><dd>{{ item.evidenceSummary.features.titleChanged ? '是' : '否' }}</dd></div>
            <div><dt>段落新增</dt><dd>{{ item.evidenceSummary.features.paragraphsAdded }}</dd></div>
            <div><dt>段落移除</dt><dd>{{ item.evidenceSummary.features.paragraphsRemoved }}</dd></div>
            <div><dt>段落替換</dt><dd>{{ item.evidenceSummary.features.paragraphsReplaced }}</dd></div>
            <div><dt>未變段落</dt><dd>{{ item.evidenceSummary.features.paragraphsUnmodified }}</dd></div>
          </dl>
          <p>文字長度：{{ item.evidenceSummary.features.beforeTextLength }} → {{ item.evidenceSummary.features.plannedTextLength }}；此為發布前建立的計畫特徵，不是發布後績效。</p>
        </div>

        <p v-if="item.currentEvidenceValid && !isExpired(item) && item.reviewStatus !== 'pending'" class="reviewed-note">{{ reviewStatusLabel(item.reviewStatus) }}；此紀錄不可覆寫。</p>
        <div v-else-if="item.status === 'observed' && item.reviewStatus === 'pending' && item.currentEvidenceValid && !isExpired(item)" class="review-actions">
          <div class="decision-buttons" role="group" :aria-label="`操作 ${item.id} 審查決定`">
            <button type="button" class="button" :aria-pressed="review.actionId === item.id && review.decision === 'approved'" @click="startReview(item, 'approved')">準備核准</button>
            <button type="button" class="button button--secondary" :aria-pressed="review.actionId === item.id && review.decision === 'rejected'" @click="startReview(item, 'rejected')">準備拒絕</button>
          </div>
          <form v-if="review.actionId === item.id" class="review-form" @submit.prevent="submitReview">
            <p>提交前請自行確認三項事項；重新讀取會清除選取與所有確認。</p>
            <label><input v-model="review.piiReviewConfirmed" type="checkbox">我已獨立檢查個資風險，並確認此證據可以進入人工審查。</label>
            <label><input v-model="review.rightsConfirmed" type="checkbox">我已重新確認來源授權、權利與同意仍有效。</label>
            <label><input v-model="review.observationalOnlyAcknowledged" type="checkbox">我理解這是觀察性資料，不是因果結論或主要引用標籤。</label>
            <label class="reason-field">審查理由（10–500 字）<textarea v-model.trim="review.reviewReason" required minlength="10" maxlength="500" rows="3" /></label>
            <small>{{ reviewReasonLength }} / 500 字</small>
            <button type="submit" class="button" :disabled="!canSubmitReview">{{ submitting ? '提交中…' : review.decision === 'approved' ? '記錄核准審查' : '記錄拒絕審查' }}</button>
          </form>
        </div>
        <p v-else-if="item.status === 'expired' || isExpired(item)" class="reviewed-note">證據已到期，不提供審查操作。</p>
        <p v-else class="reviewed-note">只有目前有效、尚未審查且完成發布後驗證的證據可進入人工審查。</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.live-actions{margin:2rem 0;padding:clamp(1rem,2vw,1.5rem);border:1px solid var(--line);background:var(--paper);color:var(--ink)}
.panel-heading,.action-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
.panel-heading h2{margin:.2rem 0 0;font-size:clamp(1.5rem,3vw,2.2rem)}
.eyebrow,.facts dt,.feature-grid dt{font:500 .65rem/1.45 var(--font-mono);color:var(--ink-soft);letter-spacing:.04em}
.limitation,.state-note,.reason,.evidence-unavailable,.reviewed-note{color:var(--ink-mid);font-size:.82rem;line-height:1.7}
.state-note{padding:.7rem 1rem;background:var(--sand)}
.empty-state{padding:1rem;border:1px dashed var(--line);color:var(--ink-mid)}
.action-list{display:grid;gap:1rem}
.action-card{padding:1rem;border:1px solid var(--line);background:#fff}
.action-heading h3{margin:.2rem 0;font-size:1.05rem}
.state-chip{padding:.3rem .6rem;border:1px solid var(--line);border-radius:99px;font-size:.7rem;white-space:nowrap}
.state-chip[data-state='observed']{border-color:#679b76;color:#276137}
.state-chip[data-state='expired'],.state-chip[data-state='blocked']{border-color:#be7474;color:#8a3333}
.facts,.evidence{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem;margin:1rem 0}
.facts div,.evidence div,.feature-grid div{min-width:0;padding:.65rem;border:1px solid var(--line);background:var(--paper)}
.facts dt,.evidence dt{margin-bottom:.25rem}
.facts dd,.evidence dd,.feature-grid dd{margin:0;font-size:.8rem;overflow-wrap:anywhere}
.reason{padding:.65rem .8rem;border-left:3px solid var(--cobalt);background:var(--sand)}
.planned-features{margin-top:1rem}
.planned-features h4{margin:.5rem 0;font-size:.9rem}
.feature-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}
.planned-features>p{font-size:.78rem;color:var(--ink-mid)}
.button{border:1px solid var(--cobalt);background:var(--cobalt);color:#fff;padding:.6rem .8rem;font:inherit;font-size:.78rem;cursor:pointer}
.button--secondary{background:transparent;color:var(--cobalt)}
.button:disabled{opacity:.5;cursor:not-allowed}
.review-actions{margin-top:1rem}
.decision-buttons{display:flex;gap:.5rem}
.decision-buttons button[aria-pressed='true']{outline:3px solid color-mix(in srgb,var(--cobalt) 30%,transparent)}
.review-form{display:grid;gap:.7rem;margin-top:1rem;padding:1rem;border:1px solid var(--line);background:var(--paper)}
.review-form p,.review-form small{margin:0;color:var(--ink-mid);font-size:.75rem;line-height:1.5}
.review-form label{display:flex;align-items:flex-start;gap:.55rem;font-size:.8rem;line-height:1.5}
.review-form input[type='checkbox']{margin-top:.2rem}
.review-form .reason-field{display:grid;gap:.35rem}
.review-form textarea{width:100%;box-sizing:border-box;padding:.65rem;border:1px solid var(--line);background:#fff;color:var(--ink);font:inherit;resize:vertical}
.notice{padding:.75rem 1rem}.notice--error{background:#fff2f2;color:#873434}.notice--success{background:#effaf3;color:#205a38}
@media(max-width:42rem){.panel-heading,.action-heading{align-items:flex-start;flex-direction:column}.facts,.evidence{grid-template-columns:1fr}.feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
