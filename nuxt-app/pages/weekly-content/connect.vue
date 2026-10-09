<script setup lang="ts">
import type { WeeklyLiffContext, WeeklyLiffCompany } from '../../server/weekly-content/liff-service'
type PublicConfig = { enabled: false } | { enabled: true; liffId: string; origin: string; connectPath: string; scopes: readonly string[] }
type LiffSdk = { init(options: { liffId: string }): Promise<void>; isLoggedIn(): boolean; login(options: { redirectUri: string }): void; getIDToken(): string | null; getContext(): { scope?: string[] } | null }
type ConnectFetch = <T>(path: string, options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }) => Promise<T>
const connectFetch = $fetch as unknown as ConnectFetch
const state = ref<'loading' | 'login' | 'ready' | 'disabled' | 'error' | 'success'>('loading')
const invitation = ref(''), consent = ref(false), message = ref(''), busy = ref(false)
const context = ref<WeeklyLiffContext | null>(null), connectedCompany = ref<WeeklyLiffCompany | null>(null)
let sdk: LiffSdk | undefined, config: Extract<PublicConfig, { enabled: true }> | undefined, examinedInvitation = ''
useHead({ title: '連結公司與 LINE｜DS搜尋王', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }, { name: 'referrer', content: 'no-referrer' }] })
function clearConfirmation() { context.value = null; consent.value = false; examinedInvitation = '' }
function cleanHistory() { window.history.replaceState(null, '', '/weekly-content/connect') }
function publicMessage(cause: unknown) {
  const status = cause && typeof cause === 'object' && 'statusCode' in cause ? Number(cause.statusCode) : 0
  return status === 401 ? 'LINE 登入已失效，請重新開啟此頁。' : status === 409 ? '邀約或公司資料已改變，請重新貼上邀約碼核對。' : status === 404 || status === 422 ? '邀約碼無效或已過期，請向服務人員索取新碼。' : '目前無法完成連結，請稍後重試或聯絡服務人員。'
}
async function loadSdk(): Promise<LiffSdk> {
  const loaded = () => (window as unknown as { liff?: LiffSdk }).liff
  if (loaded()) return loaded()!
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    const timer = window.setTimeout(() => { script.remove(); reject(new Error('sdk unavailable')) }, 10000)
    script.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js'; script.async = true; script.charset = 'utf-8'; script.referrerPolicy = 'no-referrer'
    script.onload = () => { window.clearTimeout(timer); resolve() }; script.onerror = () => { window.clearTimeout(timer); script.remove(); reject(new Error('sdk unavailable')) }
    document.head.appendChild(script)
  })
  if (!loaded()) throw new Error('sdk unavailable')
  return loaded()!
}
function idToken() { const value = sdk?.getIDToken(); if (!value) throw new Error('login required'); return value }
function login() { if (sdk && config) sdk.login({ redirectUri: `${config.origin}/weekly-content/connect` }) }
async function showOwnCompanies() {
  context.value = await connectFetch<WeeklyLiffContext>('/api/weekly-content/connect/context', { method: 'POST', body: { idToken: idToken() } })
}
async function examine() {
  if (busy.value || state.value !== 'ready') return
  message.value = ''; clearConfirmation()
  const raw = invitation.value.trim()
  if (!/^wli_[A-Za-z0-9_-]{32}$/.test(raw)) { message.value = '請貼上服務人員提供的完整邀約碼。'; return }
  busy.value = true
  try { const result = await connectFetch<WeeklyLiffContext>('/api/weekly-content/connect/context', { method: 'POST', body: { idToken: idToken(), invitationToken: raw } }); context.value = result; examinedInvitation = raw }
  catch (cause) { message.value = publicMessage(cause) } finally { busy.value = false }
}
async function confirm() {
  if (busy.value || !consent.value || context.value?.mode !== 'invitation' || !examinedInvitation) return
  busy.value = true; message.value = ''
  try {
    const result = await connectFetch<{ purpose: 'identity_binding'; status: 'bound' | 'replayed'; company: WeeklyLiffCompany }>('/api/weekly-content/connect/confirm', { method: 'POST', body: { idToken: idToken(), invitationToken: examinedInvitation, confirmationToken: context.value.confirmationToken, consent: true } })
    connectedCompany.value = result.company; invitation.value = ''; clearConfirmation(); state.value = 'success'
  } catch (cause) { message.value = publicMessage(cause); clearConfirmation() } finally { busy.value = false }
}
onMounted(async () => {
  try {
    // Invite codes are entered only after init. LINE's own OAuth URL is consumed by its SDK, then removed.
    const result = await connectFetch<PublicConfig>('/api/weekly-content/connect/config')
    if (!result.enabled) { cleanHistory(); state.value = 'disabled'; return }
    if (window.location.origin !== result.origin || result.connectPath !== '/weekly-content/connect') throw new Error('origin not configured')
    // LIFF consumes OAuth and liff.state before we touch the URL. A workbench
    // lives below this configured endpoint, so it can share the same LIFF app.
    const originalLiffState = new URL(window.location.href).searchParams.get('liff.state')
    config = result; sdk = await loadSdk(); await sdk.init({ liffId: result.liffId })
    if (window.location.pathname.startsWith('/weekly-content/connect/workbench')) return
    if (originalLiffState && originalLiffState.length <= 512) {
      const next = new URL(originalLiffState, window.location.origin)
      const workspaceId = next.searchParams.get('workspaceId') || ''
      if (next.origin === result.origin && next.pathname === '/workbench' && /^aw_[A-Za-z0-9_-]{32}$/.test(workspaceId)) {
        window.location.replace(`${result.origin}/weekly-content/connect/workbench?workspaceId=${encodeURIComponent(workspaceId)}`)
        return
      }
    }
    cleanHistory()
    if (!sdk.isLoggedIn()) { state.value = 'login'; return }
    const scopes = sdk.getContext()?.scope || []
    if (!scopes.includes('openid') || scopes.some(scope => scope !== 'openid')) throw new Error('scope not configured')
    await showOwnCompanies(); state.value = 'ready'
  } catch (cause) { cleanHistory(); message.value = publicMessage(cause); state.value = 'error' }
})
onBeforeUnmount(() => { invitation.value = ''; examinedInvitation = ''; context.value = null; sdk = undefined })
</script>

<template>
  <main class="connect-page">
    <section class="connect-card">
      <div class="brand"><img src="/brand/ds-searchking-line-avatar-premium-v1.png" alt="DS搜尋王" width="64" height="64"><span>DS搜尋王</span></div>
      <h1>連結公司與 LINE</h1>
      <p class="intro">這一步只確認公司與 LINE 身分，不會啟用每週寫稿或授權發文。文章服務另行啟用後，仍需要你逐篇看稿並同意原稿，文章才會發到公司的網站。</p>
      <aside class="data-notice" aria-labelledby="line-data-notice-title">
        <h2 id="line-data-notice-title">LINE 資料與你的選擇</h2>
        <p>我們會使用你的 LINE 識別碼確認受邀公司與網站，並保存綁定關係。若之後啟用文章服務，也會傳送文章送審通知及保存你的審稿決定。</p>
        <p>連結公司與同意接收通知，不代表同意任何一篇文章發佈；每篇仍需你另行同意。</p>
        <p>如需解除綁定或停止通知，可透過服務窗口提出要求，核對身分後由服務人員處理。</p>
        <p><a href="https://discoverystack-web.onrender.com/zh-hant/privacy" target="_blank" rel="noopener noreferrer">隱私與資料使用說明</a> · <a href="https://discoverystack-web.onrender.com/zh-hant#fit" target="_blank" rel="noopener noreferrer">聯絡服務窗口</a></p>
      </aside>
      <p v-if="state === 'loading'" role="status">正在確認 LINE 登入…</p>
      <template v-else-if="state === 'login'"><p>先用 LINE 登入，再貼上服務人員提供的邀約碼。</p><button @click="login">用 LINE 登入</button></template>
      <p v-else-if="state === 'disabled'">客戶連結尚未開放，請聯絡服務人員。</p>
      <template v-else-if="state === 'ready'">
        <div v-if="context?.mode === 'bindings' && context.companies.length" class="company-list"><h2>你已連結的公司</h2><article v-for="(company, index) in context.companies" :key="index"><strong>{{ company.displayName }}</strong><p>{{ company.canonicalSiteOrigin }}</p></article></div>
        <p>要連結新公司，請向服務人員索取邀約碼。這裡不提供客戶名單或自行選公司。</p>
        <form @submit.prevent="examine"><label for="invite">公司邀約碼</label><input id="invite" v-model="invitation" autocomplete="off" autocapitalize="off" :spellcheck="false" maxlength="36" placeholder="貼上 wli_ 開頭的邀約碼" :disabled="busy" @input="clearConfirmation"><button :disabled="busy">核對公司</button></form>
        <div v-if="context?.mode === 'invitation'" class="company-confirm"><h2>請確認要連結的公司</h2><strong>{{ context.company.displayName }}</strong><p>{{ context.company.canonicalSiteOrigin }}</p><label class="consent"><input v-model="consent" type="checkbox" :disabled="busy">我確認這是我的公司，同意連結目前 LINE 帳號。文章服務另行啟用後，可透過此 LINE 接收送審通知。</label><p>連結身分不代表啟用文章服務，也不代表同意任何一篇文章發佈。</p><button :disabled="!consent || busy" @click="confirm">確認連結這家公司</button></div>
      </template>
      <template v-else-if="state === 'success'"><h2>已連結 {{ connectedCompany?.displayName }}</h2><p>這一步只完成身分連結，不會啟用每週寫稿或授權任何文章發佈。文章服務與費用範圍由服務人員另外確認。</p><p>請加入「DS搜尋王」官方帳號並保持可接收訊息。文章服務啟用且原稿完成後，才會送到 LINE，仍需要你逐篇同意原稿才會發佈。</p><p>{{ connectedCompany?.canonicalSiteOrigin }}</p></template>
      <p v-if="message" class="notice" role="alert">{{ message }}</p>
    </section>
  </main>
</template>

<style scoped>
.connect-page{min-height:100vh;background:#EEE9DF;color:#171A32;display:flex;justify-content:center;padding:48px 20px}.connect-card{width:100%;max-width:560px;padding:32px;background:#F7F4ED;border:1px solid #B9A477;border-radius:18px}.brand{display:flex;align-items:center;gap:14px;color:#171A32;font-weight:700;letter-spacing:.04em}.brand img{border-radius:16px}h1{font-size:28px;line-height:1.3}h2{font-size:19px}.intro,p{line-height:1.8}form{display:grid;gap:12px;margin-top:24px}input:not([type=checkbox]){padding:12px;border:1px solid #B9A477;border-radius:8px;width:100%;box-sizing:border-box}button{background:#171A32;color:#EEE9DF;border:0;padding:12px 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:default}.company-list article,.company-confirm{background:#EEE9DF;border:1px solid #B9A477;padding:18px;border-radius:12px;margin:20px 0}.company-confirm p,.company-list p{overflow-wrap:anywhere}.consent{display:flex;gap:10px;line-height:1.7;margin:20px 0}.consent input{accent-color:#171A32}.notice{color:#864337}
.data-notice{margin:20px 0;padding-top:16px;border-top:1px solid #B9A477}.data-notice h2{font-size:17px}.data-notice p{font-size:14px}.data-notice a{color:#171A32;text-decoration-color:#B9A477;text-underline-offset:3px}
</style>
