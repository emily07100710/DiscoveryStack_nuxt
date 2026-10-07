<script setup lang="ts">
import { nextTick, type Ref } from 'vue'
import { createEmailManualReviewClient, type EmailManualReviewClientCommand } from '../../utils/emailManualReviewClient'

definePageMeta({ layout: 'owner' })
useHead({ title: '郵件寄送紀錄｜DiscoveryStack', meta: [{ name: 'robots', content: 'noindex,nofollow,noarchive' }] })
type EmailItem = { id: string; purpose: string; status: string; createdAt: string; updatedAt: string; nextAttemptAt: string; expiresAt: string; attemptCount: number; lastErrorCode: string | null; providerState: string; providerEventCount: number; providerLastEventAt: string | null; providerReportedDeliveredAt: string | null; providerAttentionRequired: boolean; inboxDeliveryVerified: false; manualReviewStatus: 'not_required' | 'disabled' | 'open' | 'closed_no_resend'; manualReviewVersion: string | null; manualReviewReason: EmailManualReviewClientCommand['reason'] | null; manualReviewClosedAt: string | null }
type Workspace = { items: EmailItem[]; limit: number; prePurchaseChallengesExcluded: boolean; configurationReady: boolean; executionEnabled: boolean; providerEventsConfigured: boolean; providerEventsEnabled: boolean; manualReviewEnabled: boolean; inboxDeliveryVerified: false }
type Reader = <T>(path: string, options: { server: false }) => Promise<{ data: Ref<T | undefined>; error: Ref<{ statusCode?: number } | undefined>; pending: Ref<boolean>; refresh: () => Promise<void> }>
const read = useFetch as unknown as Reader
const { data, error, pending, refresh } = await read<Workspace>('/api/managed-sites/email-outbox', { server: false })
const items = computed(() => data.value?.items || [])
const count = (statuses: string[]) => items.value.filter(item => statuses.includes(item.status)).length
const purposes: Record<string, string> = { inbox_verification: '信箱驗證', customer_reaccess: '重新登入', member_invitation: '成員邀請', contact_form_forward: '表單通知', workspace_ready: '網站交付通知' }
const statuses: Record<string, string> = { queued: '等待寄送', processing: '處理中', reconcile_pending: '補登送出紀錄', accepted: '供應商已接受', cancelled: '已取消', manual_required: '需要人工處理' }
const providerStates: Record<string, string> = { unknown: '尚無可歸屬的回報', sent: '已嘗試寄送', delivery_delayed: '寄送延遲', delivered_to_server: '已送達收件伺服器', failed: '寄送失敗', suppressed: '供應商已抑制寄送', bounced: '已退信', complained: '收件方回報垃圾郵件' }
const reasons: Record<string, string> = { outbox_disabled: '自動寄送未開啟', outbox_unconfigured: '設定需重新確認', authority_stale: '授權或收件對象已變動', outbox_expired: '連結或郵件已過期', outbox_collision: '寄送識別不一致', outbox_busy: '等待佇列處理', provider_unavailable: '寄信服務暫時不可用', retry_window_expired: '安全重試期限已過', attempt_limit: '已達重試上限', outbox_storage_unavailable: '資料庫暫時不可用', invalid_input: '郵件資料需人工確認' }
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
const reviewReasons: Record<EmailManualReviewClientCommand['reason'], string> = { reviewed_no_resend: '已完成調查，保留原紀錄且不重寄', handled_outside_platform: '已由其他管道處理（擁有人回報，未獨立驗證）' }
const reviewDraft = ref<{ itemId: string; expectedVersion: string; reason: EmailManualReviewClientCommand['reason']; confirmNoResend: boolean } | null>(null)
const reviewPanel = ref<HTMLFormElement | null>(null)
const reviewTarget = computed(() => items.value.find(item => item.id === reviewDraft.value?.itemId))
const reviewCurrent = computed(() => !!reviewDraft.value && data.value?.manualReviewEnabled === true && reviewTarget.value?.manualReviewStatus === 'open' && reviewTarget.value.manualReviewVersion === reviewDraft.value.expectedVersion)
const reviewing = ref(false)
const reviewMessage = ref('')
const reviewError = ref('')
type ReviewWriter = (path: '/api/managed-sites/email-outbox/manual-resolution', options: { method: 'POST'; credentials: 'same-origin'; body: EmailManualReviewClientCommand }) => Promise<unknown>
// Bound this one command explicitly instead of instantiating Nitro's entire route union.
// The browser-safe client still validates the unknown response before claiming success.
const writeManualReview = $fetch as unknown as ReviewWriter
const reviewClient = createEmailManualReviewClient({
  createRequestId: () => globalThis.crypto.randomUUID(),
  request: command => writeManualReview('/api/managed-sites/email-outbox/manual-resolution', { method: 'POST', credentials: 'same-origin', body: command }),
})
async function openReview(item: EmailItem) {
  if (pending.value || reviewing.value || error.value || !data.value?.manualReviewEnabled || item.manualReviewStatus !== 'open' || !item.manualReviewVersion) return
  reviewDraft.value = { itemId: item.id, expectedVersion: item.manualReviewVersion, reason: 'reviewed_no_resend', confirmNoResend: false }
  reviewMessage.value = ''; reviewError.value = ''
  await nextTick()
  const panel = reviewPanel.value
  if (!panel || reviewDraft.value?.itemId !== item.id) return
  // Bring the inserted form into view without animating or starting any request.
  panel.scrollIntoView({ block: 'center' })
  panel.focus({ preventScroll: true })
}
function cancelReview() {
  if (!reviewing.value) reviewDraft.value = null
}
async function submitReview() {
  if (!reviewDraft.value || !reviewCurrent.value || !reviewDraft.value.confirmNoResend || pending.value || reviewing.value || error.value) return
  reviewing.value = true; reviewMessage.value = ''; reviewError.value = ''
  try {
    await reviewClient.close({ ...reviewDraft.value })
    reviewDraft.value = null
    reviewMessage.value = '人工調查已結案。原寄送狀態與供應商回報保留，沒有重新寄信，也不代表實際收信。'
    try { await refresh() } catch { /* The confirmed write is independent of the read-only refresh. */ }
    if (error.value) reviewMessage.value += ' 最新列表暫時無法讀取，請稍後更新紀錄。'
  } catch (cause) {
    const failure = cause as { statusCode?: number; response?: { status?: number } }
    const status = failure?.statusCode || failure?.response?.status
    reviewError.value = status === 409 ? '紀錄已變動或已結案，請更新紀錄確認；不要重寄。'
      : status === 401 || status === 403 ? '登入或後台權限已變動，請重新登入後確認紀錄。'
      : status === 404 ? '這筆紀錄目前不可處理，請更新紀錄。'
      : '結案結果尚未確認。請用同一份內容再試一次，或更新紀錄確認；這裡不會重新寄信。'
  } finally { reviewing.value = false }
}
</script>

<template>
  <section class="email-workspace">
    <header class="email-header">
      <div><p class="eyebrow">TRANSACTIONAL EMAIL</p><h1>郵件寄送紀錄</h1><p>查看邀請、登入與表單通知的處理狀態。這裡不會顯示信箱、驗證碼或登入連結。</p></div>
      <button type="button" :disabled="pending || reviewing" @click="refresh()">{{ pending ? '更新中…' : '更新紀錄' }}</button>
    </header>
    <aside class="boundary">「供應商已接受」代表寄信服務接受了請求，尚不代表客戶實際收到郵件。「已送達收件伺服器」是供應商的送達回報，不保證信箱入件或已讀。更新紀錄只會讀取資料，不會觸發寄信。人工調查結案只留下處理紀錄，不會重新寄信；退信或投訴不會被後來的送達回報清除。</aside>
    <p v-if="reviewMessage" class="review-message" role="status" aria-live="polite">{{ reviewMessage }}</p>
    <p v-if="reviewError" class="review-error" role="alert">{{ reviewError }}</p>
    <OwnerAsyncState :loading="pending" :error="error ? '郵件紀錄暫時無法載入，請確認登入狀態、資料庫更新與郵件設定。' : ''" @retry="refresh()">
      <div class="settings" aria-label="寄送設定狀態">
        <p>郵件設定：<strong>{{ data?.configurationReady ? '設定已填妥，仍需驗收' : '尚未完整設定' }}</strong></p>
        <p>自動寄送：<strong>{{ data?.executionEnabled ? '已開啟' : '關閉中' }}</strong></p>
        <p>送達／退信回報：<strong>{{ data?.providerEventsEnabled && data?.providerEventsConfigured ? '已開啟，仍需真實驗收' : data?.providerEventsEnabled ? '設定不完整，未接收' : '關閉中' }}</strong></p>
        <p>人工調查結案：<strong>{{ data?.manualReviewEnabled ? '已開啟，只記錄、不重寄' : '關閉中' }}</strong></p>
        <NuxtLink to="/audit-lab/managed-sites">查看開通與供應商設定 →</NuxtLink>
      </div>
      <div class="summary" aria-label="最近紀錄摘要">
        <article><span>待處理</span><strong>{{ count(['queued', 'processing', 'reconcile_pending']) }}</strong></article>
        <article><span>供應商已接受</span><strong>{{ count(['accepted']) }}</strong><small>未驗證實際收信</small></article>
        <article><span>尚待人工確認</span><strong>{{ items.filter(item => item.status === 'manual_required' && item.manualReviewStatus !== 'closed_no_resend').length }}</strong><small v-if="items.some(item => item.manualReviewStatus === 'closed_no_resend')">已調查結案 {{ items.filter(item => item.manualReviewStatus === 'closed_no_resend').length }} 筆；未重寄</small></article>
        <article><span>已取消</span><strong>{{ count(['cancelled']) }}</strong></article>
      </div>
      <p class="scope">摘要限最近 {{ data?.limit || 50 }} 筆屬於你的專案與登入通知；不是全平台總數。尚未歸屬專案的購買前信箱驗證紀錄不在此列表。</p>
      <form v-if="reviewDraft" ref="reviewPanel" class="review-panel" tabindex="-1" aria-labelledby="email-review-heading" @submit.prevent="submitReview()">
        <h2 id="email-review-heading">人工調查結案，不重寄</h2>
        <p>用途：{{ purposes[reviewTarget?.purpose || ''] || '系統通知' }} · 原因：{{ reasons[reviewTarget?.lastErrorCode || ''] || '需人工確認' }} · 到期：{{ date(reviewTarget?.expiresAt || null) }}</p>
        <p>供應商回報：{{ providerStates[reviewTarget?.providerState || ''] || providerStates.unknown }}。請先核對既有回報與其他處理管道；此操作不會恢復原連結、補登寄送成功或確認收信。</p>
        <p v-if="!reviewCurrent" class="review-error">這筆紀錄或功能設定已變動，請取消並更新紀錄後再確認。</p>
        <label class="review-field" for="email-review-reason">結案分類
          <select id="email-review-reason" v-model="reviewDraft.reason" :disabled="reviewing || !reviewCurrent"><option v-for="(label, value) in reviewReasons" :key="value" :value="value">{{ label }}</option></select>
        </label>
        <label class="review-confirm"><input v-model="reviewDraft.confirmNoResend" type="checkbox" :disabled="reviewing || !reviewCurrent">我已完成核對，了解結案只記錄人工處理，不會重寄，也不能證明郵件已送達或已讀。</label>
        <div class="review-actions"><button type="submit" :disabled="reviewing || pending || !reviewCurrent || !reviewDraft.confirmNoResend">{{ reviewing ? '儲存中…' : '確認結案，不重寄' }}</button><button type="button" :disabled="reviewing" @click="cancelReview()">取消</button></div>
      </form>
      <p v-if="!items.length" class="empty">目前沒有郵件紀錄。佇列為空不代表寄件服務已驗收。</p>
      <div v-else class="table-wrap">
        <table>
          <caption>最近郵件處理紀錄（台北時間）</caption>
          <thead><tr><th scope="col">用途</th><th scope="col">佇列狀態</th><th scope="col">供應商回報</th><th scope="col">處理次數</th><th scope="col">建立時間</th><th scope="col">下一次處理／到期</th><th scope="col">需注意事項</th><th scope="col">人工調查</th></tr></thead>
          <tbody><tr v-for="item in items" :key="item.id"><td>{{ purposes[item.purpose] || '系統通知' }}</td><td><span class="status" :class="`status--${item.status}`">{{ statuses[item.status] || '需確認' }}</span></td><td><span class="status" :class="{ 'status--attention': item.providerAttentionRequired }">{{ providerStates[item.providerState] || providerStates.unknown }}</span><br><small>{{ item.providerEventCount || 0 }} 筆回報<span v-if="item.providerLastEventAt"> · {{ date(item.providerLastEventAt) }}</span></small><br v-if="item.providerReportedDeliveredAt"><small v-if="item.providerReportedDeliveredAt">伺服器送達回報 {{ date(item.providerReportedDeliveredAt) }}</small></td><td>{{ item.attemptCount }}</td><td>{{ date(item.createdAt) }}</td><td><span v-if="['queued', 'reconcile_pending'].includes(item.status)">{{ date(item.nextAttemptAt) }}<br></span><small>到期 {{ date(item.expiresAt) }}</small></td><td>{{ item.lastErrorCode ? reasons[item.lastErrorCode] || '需人工確認' : item.providerAttentionRequired ? '請核對供應商回報；這裡不會重新寄信' : '—' }}</td><td><template v-if="item.manualReviewStatus === 'closed_no_resend'"><span class="status">調查已結案，未重寄</span><br><small>{{ item.manualReviewReason ? reviewReasons[item.manualReviewReason] : '原寄送結果不變' }}<br>{{ date(item.manualReviewClosedAt) }}</small></template><button v-else-if="data?.manualReviewEnabled && item.manualReviewStatus === 'open'" type="button" class="review-open" :disabled="pending || reviewing" @click="openReview(item)">核對並結案</button><small v-else>{{ item.status === 'manual_required' ? '結案功能未開通；不會重寄' : '—' }}</small></td></tr></tbody>
        </table>
      </div>
    </OwnerAsyncState>
  </section>
</template>

<style scoped>
.review-panel{margin:1.5rem 0;padding:1.3rem;background:#fff;border:1px solid #c5d4e7;border-radius:14px;line-height:1.7}.review-panel h2{font-size:1.15rem;margin:0 0 .7rem}.review-panel p{font-size:.84rem;color:#344b67}.review-field{display:flex;flex-direction:column;gap:.4rem;font-size:.84rem;font-weight:700}.review-field select{max-width:100%;width:100%;padding:.65rem;border:1px solid #c3ceda;border-radius:8px;font:inherit;background:#fff}.review-confirm{display:flex;align-items:flex-start;gap:.65rem;font-size:.84rem;margin:1rem 0}.review-confirm input{margin-top:.4rem;flex-shrink:0}.review-actions{display:flex;flex-wrap:wrap;gap:.7rem}.review-actions button,.review-open{padding:.6rem .85rem;border:1px solid #c3ceda;border-radius:8px;background:#fff;font:inherit;font-size:.8rem;color:#17253d;cursor:pointer}.review-actions button[type=submit]{background:#17253d;color:#fff}.review-actions button:disabled,.review-open:disabled{opacity:.5;cursor:not-allowed}.review-panel :focus-visible,.review-open:focus-visible{outline:3px solid #83b4e6;outline-offset:3px}.review-message,.review-error{padding:.9rem 1rem;border-radius:10px;font-size:.84rem;line-height:1.7;overflow-wrap:anywhere}.review-message{background:#e7f1e9;color:#326745}.review-error{background:#fff0dd;color:#885b1c}
.status--attention{background:#fff0dd;color:#885b1c}
.email-workspace{max-width:1280px;margin:0 auto;padding:clamp(1.25rem,4vw,3rem)}.email-header{display:flex;justify-content:space-between;align-items:center;gap:1.5rem;margin-bottom:1.5rem}.eyebrow{font-size:.7rem;letter-spacing:.14em;font-weight:800;color:#596d87;margin:0 0 .6rem}h1{font-size:clamp(1.7rem,3vw,2.3rem);margin:0 0 .75rem}.email-header p:not(.eyebrow){line-height:1.7;color:#596d87;margin:0}.email-header button{flex-shrink:0;border:1px solid #c3ceda;border-radius:10px;padding:.65rem 1rem;font:inherit;font-size:.8rem;font-weight:700;background:#fff;color:#17253d;cursor:pointer}.email-header button:disabled{opacity:.6;cursor:wait}.email-header button:focus-visible{outline:3px solid #83b4e6;outline-offset:3px}.boundary{background:#e8eef7;border:1px solid #c5d4e7;border-radius:12px;padding:1rem 1.2rem;color:#344b67;font-size:.84rem;line-height:1.7;margin-bottom:1.5rem}.settings{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;align-items:center;font-size:.82rem}.settings p{margin:.4rem 0}.settings a{color:#334f80}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin:1.25rem 0}.summary article{display:flex;flex-direction:column;gap:.6rem;padding:1.1rem 1.3rem;background:#fff;border:1px solid #d8e0e9;border-radius:14px}.summary span,.summary small,.scope{color:#596d87;font-size:.78rem}.summary strong{font-size:1.8rem}.scope{line-height:1.7;margin:0 0 1.25rem}.empty{padding:2rem;border:1px dashed #b6c5d3;border-radius:12px;background:#fff;text-align:center;color:#596d87}.table-wrap{overflow-x:auto;background:#fff;border:1px solid #d8e0e9;border-radius:14px}table{border-collapse:collapse;width:100%;min-width:790px;font-size:.82rem}caption{text-align:left;padding:1rem;font-weight:700}th,td{padding:1rem;text-align:left;border-top:1px solid #e1e6ed;line-height:1.65}th{color:#596d87;background:#f8fafc;font-weight:700}.status{display:inline-flex;padding:.2rem .6rem;border-radius:6px;background:#eef2f7;white-space:nowrap}.status--accepted{background:#e7f1e9;color:#326745}.status--manual_required{background:#fff0dd;color:#885b1c}.status--cancelled{color:#637184}td small{color:#637184}@media(max-width:760px){.email-header{align-items:flex-start;flex-direction:column;gap:1rem}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary article{padding:1rem}.table-wrap{border-radius:10px}}
</style>
