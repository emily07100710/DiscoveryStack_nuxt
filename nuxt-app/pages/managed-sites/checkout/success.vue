<script setup lang="ts">
type CheckoutStatusFetch = <T = unknown>(path: `/api/managed-sites/${string}`, options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; credentials?: 'omit' | 'same-origin'; headers?: Record<string, string> }) => Promise<T>
// Preserve the original Nuxt fetch and local response DTOs.
const fetchCheckoutStatus = $fetch as unknown as CheckoutStatusFetch
import { computed, onMounted, onUnmounted, ref } from 'vue'

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type FunnelStorage = { sessionId: number; sessionToken: string }
type Fulfilment = { moduleKey: string; status: string; customerVisibleStatus: string; mode: string; ownerActionRequired: boolean }
type CheckoutStatus = {
  status: string
  order: null | { status: string }
  release: null | { status: string; previewUrl: string | null; liveUrl?: string | null }
  fulfilments: Fulfilment[]
  attention?: string | null
  checkoutUrl: string | null
}

const STORAGE_KEY = 'discoverystack.managed-site-funnel'
const status = ref<CheckoutStatus | null>(null)
const available = ref(false)
const checking = ref(false)
const timedOut = ref(false)
const customerAccessReady = ref(false)
const customerAccessError = ref('')
const claimingAccess = ref(false)
let activeSession: FunnelStorage | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let attempts = 0

const orderStatusText = computed(() => {
  const value = status.value?.order?.status
  if (value === 'payment_verified') return '已確認付款'
  if (value === 'payment_pending' || value === 'pending' || value === 'unpaid') return '款項確認中'
  if (value === 'refunded') return '已退款'
  if (value === 'disputed') return '付款爭議處理中'
  if (value === 'cancelled') return '已取消'
  if (value === 'expired') return '付款連結已過期'
  return value || '尚未取得訂單狀態'
})

const releaseStatusText = computed(() => {
  const value = status.value?.release?.status
  if (value === 'live_verified' || value === 'geo_active' || value === 'active') return '網站已上線'
  if (value === 'payment_verified') return '付款已確認，正在準備網域與網站'
  if (value === 'provisioning' || value === 'deployment_pending' || value === 'health_checking') return '網站建置中'
  if (value === 'failed' || value === 'blocked') return '網站建置需要進一步確認'
  return value ? '網站建置處理中' : '尚未開始建置'
})

function shouldPoll(): boolean {
  return ['payment_pending', 'pending', 'unpaid'].includes(status.value?.order?.status || '')
    || status.value?.order?.status === 'payment_verified' && ['payment_verified', 'provisioning', 'deployment_pending', 'retry_wait'].includes(status.value?.release?.status || '')
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

function storedSession(): FunnelStorage | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '')
    if (Number.isSafeInteger(parsed?.sessionId) && parsed.sessionId > 0 && typeof parsed.sessionToken === 'string' && parsed.sessionToken) return parsed
  } catch {
    // A cleared or malformed browser store is an expected post-checkout case.
  }
  return null
}

async function loadStatus(session: FunnelStorage): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    const result = await fetchCheckoutStatus<CheckoutStatus>(`/api/managed-sites/funnel/sessions/${session.sessionId}/status`, {
      method: 'GET',
      credentials: 'omit',
      headers: { 'x-managed-site-funnel-token': session.sessionToken },
    })
    status.value = result
    available.value = true
    activeSession = session
    if (result.order?.status === 'payment_verified' && !customerAccessReady.value) await claimCustomerAccess()
    clearSettledFunnelToken(session)
    if (!shouldPoll()) stopPolling()
  } catch {
    available.value = false
    stopPolling()
  } finally {
    checking.value = false
  }
}

function clearSettledFunnelToken(session: FunnelStorage) {
  if (!status.value) return
  if (['payment_verified', 'refunded', 'disputed'].includes(status.value.order?.status || '') && (status.value.order?.status !== 'payment_verified' || customerAccessReady.value)) {
      try {
        const stored = storedSession()
        if (stored?.sessionId === session.sessionId && stored.sessionToken === session.sessionToken) {
          localStorage.removeItem(STORAGE_KEY)
        }
      } catch {
        // Browser storage may be unavailable even though the status response is valid.
      }
    }
}

async function claimCustomerAccess(): Promise<void> {
  if (!activeSession || claimingAccess.value || status.value?.order?.status !== 'payment_verified') return
  claimingAccess.value = true
  customerAccessError.value = ''
  try {
    const result = await fetchCheckoutStatus<{ granted: boolean }>(`/api/managed-sites/funnel/sessions/${activeSession.sessionId}/customer-access`, {
      method: 'POST', credentials: 'same-origin', body: {},
      headers: { 'x-managed-site-funnel-token': activeSession.sessionToken },
    })
    customerAccessReady.value = result.granted === true
    if (!customerAccessReady.value) throw new Error('access unavailable')
    clearSettledFunnelToken(activeSession)
  } catch {
    customerAccessError.value = '付款已確認，但管理入口暫時無法開啟。請在此頁重試或聯絡客服。'
  } finally {
    claimingAccess.value = false
  }
}

async function pollStatus(session: FunnelStorage): Promise<void> {
  if (checking.value) return
  if (attempts >= (status.value?.order?.status === 'payment_verified' ? 120 : 20)) {
    timedOut.value = true
    stopPolling()
    return
  }
  attempts += 1
  await loadStatus(session)
}

async function pollCustomerStatus(): Promise<void> {
  if (checking.value) return
  if (attempts >= 120) { timedOut.value = true; stopPolling(); return }
  attempts += 1
  checking.value = true
  try {
    const result = await fetchCheckoutStatus<{ launch: CheckoutStatus | null }>('/api/managed-sites/customer/session', { credentials: 'same-origin' })
    customerAccessReady.value = true
    if (result.launch) { status.value = result.launch; available.value = true }
    if (!shouldPoll()) stopPolling()
  } catch { stopPolling() } finally { checking.value = false }
}

onMounted(() => {
  const session = storedSession()
  if (!session) {
    void (async () => {
      await pollCustomerStatus()
      if (shouldPoll()) pollTimer = setInterval(() => { void pollCustomerStatus() }, 3_000)
    })()
    return
  }
  void (async () => {
    await pollStatus(session)
    if (!shouldPoll()) return
    pollTimer = setInterval(() => {
      if (!shouldPoll()) return stopPolling()
      void pollStatus(session)
    }, 3_000)
  })()
})

onUnmounted(stopPolling)
</script>

<template>
  <main class="checkout" aria-labelledby="checkout-title">
    <section class="card">
      <p class="eyebrow">網站訂購流程</p>
      <h1 id="checkout-title">{{ status?.order?.status === 'payment_verified' ? '已確認付款' : '付款與建站進度' }}</h1>

      <template v-if="available && status">
        <p class="lede">我們已收到你從付款頁面返回的訊息，以下是目前由系統確認到的進度。</p>
        <dl class="status-list">
          <div><dt>訂單狀態</dt><dd>{{ orderStatusText }}</dd></div>
          <div><dt>建置狀態</dt><dd>{{ releaseStatusText }}</dd></div>
        </dl>
        <p v-if="status.attention" class="notice" role="alert">{{ status.attention }}</p>
        <p v-if="status.release?.liveUrl" class="preview"><a :href="status.release.liveUrl" rel="noopener noreferrer">查看已上線網站</a></p>
        <p v-else-if="status.release?.previewUrl" class="preview"><a :href="status.release.previewUrl" rel="noopener noreferrer">查看網站預覽</a></p>

        <section v-if="status.fulfilments.length" class="fulfilments" aria-labelledby="fulfilments-title">
          <h2 id="fulfilments-title">功能開通進度</h2>
          <ul>
            <li v-for="item in status.fulfilments" :key="item.moduleKey">
              <strong>{{ item.moduleKey }}</strong>
              <span>{{ item.customerVisibleStatus || item.status }}</span>
            </li>
          </ul>
        </section>
        <p v-if="timedOut" class="notice">系統仍在確認進度，請稍後至管理入口查看；若尚未開通入口，請聯絡客服。</p>
      </template>

      <p v-else class="lede">此頁尚未取得付款結果。若你已開通管理入口，可在下方查看網站狀態。</p>
      <p v-if="customerAccessError" class="notice" role="alert">{{ customerAccessError }} <button type="button" :disabled="claimingAccess" @click="claimCustomerAccess">重試開通入口</button></p>
      <NuxtLink v-if="customerAccessReady" class="button" to="/customer/managed-sites">管理我的網站</NuxtLink>
      <NuxtLink class="button" to="/customer/managed-sites/start">回到網站訂購流程</NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.checkout { display: grid; min-height: 100vh; place-items: center; padding: 1.25rem 1rem; background: #f7f5ef; color: #1b2236; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.card { display: grid; width: min(100%, 38rem); gap: 1.15rem; padding: 1.5rem; border: 1px solid #e7e2d8; border-radius: .9rem; background: white; box-shadow: 0 1rem 2.5rem rgba(45, 51, 72, .06); }
.eyebrow { margin: 0; color: #4d5dad; font: 700 .72rem/1.2 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; }
h1, h2 { margin: 0; font-family: Georgia, serif; }
h1 { font-size: clamp(2rem, 10vw, 3.2rem); line-height: 1.02; }
h2 { font-size: 1.25rem; }
.lede, .notice { margin: 0; color: #5e6575; line-height: 1.65; }
.status-list { display: grid; gap: .7rem; margin: 0; }
.status-list div { display: flex; justify-content: space-between; gap: 1rem; padding-bottom: .7rem; border-bottom: 1px solid #e7e2d8; }
dt { color: #5e6575; } dd { margin: 0; font-weight: 750; text-align: right; }
.preview a { color: #35488d; font-weight: 750; }
.fulfilments { display: grid; gap: .7rem; padding: 1rem; border: 1px solid #e7e2d8; border-radius: .7rem; background: #fbfaf7; }
.fulfilments ul { display: grid; gap: .65rem; padding: 0; margin: 0; list-style: none; }
.fulfilments li { display: flex; justify-content: space-between; gap: 1rem; }
.fulfilments span { color: #5e6575; text-align: right; }
.notice { padding: .8rem; border-radius: .55rem; background: #f0f1f8; color: #384268; }
.button { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; border-radius: .6rem; padding: .8rem 1.1rem; background: #4d5dad; color: white; font-weight: 800; text-decoration: none; }
@media (min-width: 48rem) { .checkout { padding: 3rem 2rem; } .card { padding: 2rem; } }
</style>
