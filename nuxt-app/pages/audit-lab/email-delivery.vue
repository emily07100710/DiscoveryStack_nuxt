<script setup lang="ts">
import type { Ref } from 'vue'

definePageMeta({ layout: 'owner' })
useHead({ title: '郵件寄送紀錄｜DiscoveryStack', meta: [{ name: 'robots', content: 'noindex,nofollow,noarchive' }] })
type EmailItem = { id: string; purpose: string; status: string; createdAt: string; updatedAt: string; nextAttemptAt: string; expiresAt: string; attemptCount: number; lastErrorCode: string | null }
type Workspace = { items: EmailItem[]; limit: number; prePurchaseChallengesExcluded: boolean; configurationReady: boolean; executionEnabled: boolean; inboxDeliveryVerified: false }
type Reader = <T>(path: string, options: { server: false }) => Promise<{ data: Ref<T | undefined>; error: Ref<{ statusCode?: number } | undefined>; pending: Ref<boolean>; refresh: () => Promise<void> }>
const read = useFetch as unknown as Reader
const { data, error, pending, refresh } = await read<Workspace>('/api/managed-sites/email-outbox', { server: false })
const items = computed(() => data.value?.items || [])
const count = (statuses: string[]) => items.value.filter(item => statuses.includes(item.status)).length
const purposes: Record<string, string> = { inbox_verification: '信箱驗證', customer_reaccess: '重新登入', member_invitation: '成員邀請', contact_form_forward: '表單通知', workspace_ready: '網站交付通知' }
const statuses: Record<string, string> = { queued: '等待寄送', processing: '處理中', reconcile_pending: '補登送出紀錄', accepted: '供應商已接受', cancelled: '已取消', manual_required: '需要人工處理' }
const reasons: Record<string, string> = { outbox_disabled: '自動寄送未開啟', outbox_unconfigured: '設定需重新確認', authority_stale: '授權或收件對象已變動', outbox_expired: '連結或郵件已過期', outbox_collision: '寄送識別不一致', outbox_busy: '等待佇列處理', provider_unavailable: '寄信服務暫時不可用', retry_window_expired: '安全重試期限已過', attempt_limit: '已達重試上限', outbox_storage_unavailable: '資料庫暫時不可用', invalid_input: '郵件資料需人工確認' }
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
</script>

<template>
  <section class="email-workspace">
    <header class="email-header">
      <div><p class="eyebrow">TRANSACTIONAL EMAIL</p><h1>郵件寄送紀錄</h1><p>查看邀請、登入與表單通知的處理狀態。這裡不會顯示信箱、驗證碼或登入連結。</p></div>
      <button type="button" :disabled="pending" @click="refresh()">{{ pending ? '更新中…' : '更新紀錄' }}</button>
    </header>
    <aside class="boundary">「供應商已接受」代表寄信服務接受了請求，尚不代表客戶實際收到郵件。這個頁面只供查看，重新載入不會觸發寄信。</aside>
    <OwnerAsyncState :loading="pending" :error="error ? '郵件紀錄暫時無法載入，請確認登入狀態、資料庫更新與郵件設定。' : ''" @retry="refresh()">
      <div class="settings" aria-label="寄送設定狀態">
        <p>郵件設定：<strong>{{ data?.configurationReady ? '設定已填妥，仍需驗收' : '尚未完整設定' }}</strong></p>
        <p>自動寄送：<strong>{{ data?.executionEnabled ? '已開啟' : '關閉中' }}</strong></p>
        <NuxtLink to="/audit-lab/managed-sites">查看開通與供應商設定 →</NuxtLink>
      </div>
      <div class="summary" aria-label="最近紀錄摘要">
        <article><span>待處理</span><strong>{{ count(['queued', 'processing', 'reconcile_pending']) }}</strong></article>
        <article><span>供應商已接受</span><strong>{{ count(['accepted']) }}</strong><small>未驗證實際收信</small></article>
        <article><span>需要人工確認</span><strong>{{ count(['manual_required']) }}</strong></article>
        <article><span>已取消</span><strong>{{ count(['cancelled']) }}</strong></article>
      </div>
      <p class="scope">摘要限最近 {{ data?.limit || 50 }} 筆屬於你的專案與登入通知；不是全平台總數。尚未歸屬專案的購買前信箱驗證紀錄不在此列表。</p>
      <p v-if="!items.length" class="empty">目前沒有郵件紀錄。佇列為空不代表寄件服務已驗收。</p>
      <div v-else class="table-wrap">
        <table>
          <caption>最近郵件處理紀錄（台北時間）</caption>
          <thead><tr><th scope="col">用途</th><th scope="col">狀態</th><th scope="col">處理次數</th><th scope="col">建立時間</th><th scope="col">下一次處理／到期</th><th scope="col">需注意事項</th></tr></thead>
          <tbody><tr v-for="item in items" :key="item.id"><td>{{ purposes[item.purpose] || '系統通知' }}</td><td><span class="status" :class="`status--${item.status}`">{{ statuses[item.status] || '需確認' }}</span></td><td>{{ item.attemptCount }}</td><td>{{ date(item.createdAt) }}</td><td><span v-if="['queued', 'reconcile_pending'].includes(item.status)">{{ date(item.nextAttemptAt) }}<br></span><small>到期 {{ date(item.expiresAt) }}</small></td><td>{{ item.lastErrorCode ? reasons[item.lastErrorCode] || '需人工確認' : '—' }}</td></tr></tbody>
        </table>
      </div>
    </OwnerAsyncState>
  </section>
</template>

<style scoped>
.email-workspace{max-width:1280px;margin:0 auto;padding:clamp(1.25rem,4vw,3rem)}.email-header{display:flex;justify-content:space-between;align-items:center;gap:1.5rem;margin-bottom:1.5rem}.eyebrow{font-size:.7rem;letter-spacing:.14em;font-weight:800;color:#596d87;margin:0 0 .6rem}h1{font-size:clamp(1.7rem,3vw,2.3rem);margin:0 0 .75rem}.email-header p:not(.eyebrow){line-height:1.7;color:#596d87;margin:0}.email-header button{flex-shrink:0;border:1px solid #c3ceda;border-radius:10px;padding:.65rem 1rem;font:inherit;font-size:.8rem;font-weight:700;background:#fff;color:#17253d;cursor:pointer}.email-header button:disabled{opacity:.6;cursor:wait}.email-header button:focus-visible{outline:3px solid #83b4e6;outline-offset:3px}.boundary{background:#e8eef7;border:1px solid #c5d4e7;border-radius:12px;padding:1rem 1.2rem;color:#344b67;font-size:.84rem;line-height:1.7;margin-bottom:1.5rem}.settings{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;align-items:center;font-size:.82rem}.settings p{margin:.4rem 0}.settings a{color:#334f80}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin:1.25rem 0}.summary article{display:flex;flex-direction:column;gap:.6rem;padding:1.1rem 1.3rem;background:#fff;border:1px solid #d8e0e9;border-radius:14px}.summary span,.summary small,.scope{color:#596d87;font-size:.78rem}.summary strong{font-size:1.8rem}.scope{line-height:1.7;margin:0 0 1.25rem}.empty{padding:2rem;border:1px dashed #b6c5d3;border-radius:12px;background:#fff;text-align:center;color:#596d87}.table-wrap{overflow-x:auto;background:#fff;border:1px solid #d8e0e9;border-radius:14px}table{border-collapse:collapse;width:100%;min-width:790px;font-size:.82rem}caption{text-align:left;padding:1rem;font-weight:700}th,td{padding:1rem;text-align:left;border-top:1px solid #e1e6ed;line-height:1.65}th{color:#596d87;background:#f8fafc;font-weight:700}.status{display:inline-flex;padding:.2rem .6rem;border-radius:6px;background:#eef2f7;white-space:nowrap}.status--accepted{background:#e7f1e9;color:#326745}.status--manual_required{background:#fff0dd;color:#885b1c}.status--cancelled{color:#637184}td small{color:#637184}@media(max-width:760px){.email-header{align-items:flex-start;flex-direction:column;gap:1rem}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary article{padding:1rem}.table-wrap{border-radius:10px}}
</style>
