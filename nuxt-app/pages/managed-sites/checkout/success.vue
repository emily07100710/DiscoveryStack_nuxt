<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type FunnelStorage = { sessionId: number; sessionToken: string }
type Fulfilment = { moduleKey: string; status: string; customerVisibleStatus: string; mode: string; ownerActionRequired: boolean }
type CheckoutStatus = {
  status: string
  order: null | { status: string }
  release: null | { status: string; previewUrl: string | null }
  fulfilments: Fulfilment[]
  checkoutUrl: string | null
}

const STORAGE_KEY = 'discoverystack.managed-site-funnel'
const status = ref<CheckoutStatus | null>(null)
const available = ref(false)
const checking = ref(false)
const timedOut = ref(false)
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
  if (value === 'payment_verified') return '付款已確認，準備建置中'
  if (value === 'provisioning' || value === 'deployment_pending' || value === 'health_checking') return '網站建置中'
  if (value === 'failed' || value === 'blocked') return '網站建置需要進一步確認'
  return value ? '網站建置處理中' : '尚未開始建置'
})

function shouldPoll(): boolean {
  return ['payment_pending', 'pending', 'unpaid'].includes(status.value?.order?.status || '')
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
    const result = await $fetch<CheckoutStatus>(`/api/managed-sites/funnel/sessions/${session.sessionId}/status`, {
      method: 'GET',
      credentials: 'omit',
      headers: { 'x-managed-site-funnel-token': session.sessionToken },
    })
    status.value = result
    available.value = true
    if (!shouldPoll()) stopPolling()
  } catch {
    available.value = false
    stopPolling()
  } finally {
    checking.value = false
  }
}

async function pollStatus(session: FunnelStorage): Promise<void> {
  if (checking.value) return
  if (attempts >= 20) {
    timedOut.value = true
    stopPolling()
    return
  }
  attempts += 1
  await loadStatus(session)
}

onMounted(() => {
  const session = storedSession()
  if (!session) return
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
      <h1 id="checkout-title">付款完成</h1>

      <template v-if="available && status">
        <p class="lede">我們已收到你從付款頁面返回的訊息，以下是目前由系統確認到的進度。</p>
        <dl class="status-list">
          <div><dt>訂單狀態</dt><dd>{{ orderStatusText }}</dd></div>
          <div><dt>建置狀態</dt><dd>{{ releaseStatusText }}</dd></div>
        </dl>
        <p v-if="status.release?.previewUrl" class="preview"><a :href="status.release.previewUrl" rel="noopener noreferrer">{{ status.release.previewUrl }}</a></p>

        <section v-if="status.fulfilments.length" class="fulfilments" aria-labelledby="fulfilments-title">
          <h2 id="fulfilments-title">功能開通進度</h2>
          <ul>
            <li v-for="item in status.fulfilments" :key="item.moduleKey">
              <strong>{{ item.moduleKey }}</strong>
              <span>{{ item.customerVisibleStatus || item.status }}</span>
            </li>
          </ul>
        </section>
        <p v-if="timedOut" class="notice">款項確認中，我們會用 email 通知你</p>
      </template>

      <p v-else class="lede">付款完成，我們會用 email 與你聯絡後續進度</p>
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
