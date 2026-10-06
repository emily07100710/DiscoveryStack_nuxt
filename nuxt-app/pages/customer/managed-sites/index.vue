<script setup lang="ts">
type CustomerPortalFetch = <T = unknown>(path: '/api/managed-sites/customer/session' | '/api/managed-sites/customer/modules' | '/api/managed-sites/customer/content-admin' | '/api/managed-sites/customer/visibility' | '/api/system-factory/customer/status' | '/api/managed-sites/customer/assistant' | '/api/managed-sites/customer/logout', options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }) => Promise<T>
// Preserve the same Nuxt requests, session checks and customer response DTOs.
const fetchCustomerPortal = $fetch as unknown as CustomerPortalFetch

import { computed, onMounted, ref } from 'vue'

type ContentProgress = {
  entries: Array<{ id: number; title?: string | null; topic?: string | null; status: string; plannedLocalDate: string }>
  readiness: { schedulerEnabled: boolean; generationExecutorAvailable: boolean }
  siteReadiness: { hasContentCalendar: boolean; hasExecutablePublicationTarget: boolean; hasCurrentOwnerPolicy: boolean; customerApprovalRequired: boolean }
}
type VisibilityReport = { status: 'ready' | 'insufficient_data'; domain: string; trackedQueries: number; observedQueries: number; sampleCount: number; brandMentionRate: number | null; citationRate: number | null; exactCitationRate: number | null; observations: Array<{ query: string; provider: string; observedAt: string | Date; brandMentioned: boolean; citationUrls: string[] }>; limitations: string[] } | { status: 'not_configured'; message: string }

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const loading = ref(true)
const errorMessage = ref('')
const requiresReaccess = ref(false)
const projection = ref<any>(null)
const moduleWorkspace = ref<any>(null)
const contentProgress = ref<ContentProgress | null>(null)
const visibilityReport = ref<VisibilityReport | null>(null)
const contentProgressNote = ref('')
const visibilityNote = ref('')
const systemStatus = ref<any>(null)
const assistantQuestion = ref('')
const assistantResult = ref<any>(null)
const assistantLoading = ref(false)
const signingOut = ref(false)
const recentContent = computed(() => [...(contentProgress.value?.entries || [])].sort((a, b) => b.plannedLocalDate.localeCompare(a.plannedLocalDate)).slice(0, 5))
const percentage = (value: number | null | undefined) => typeof value === 'number' ? `${Math.round(value * 100)}%` : '資料不足'
const displayDate = (value: string | Date) => new Intl.DateTimeFormat('zh-Hant-TW', { dateStyle: 'medium' }).format(new Date(value))
const contentStatus = (status: string) => ({ planned: '已排程', draft: '草稿中', ready_to_publish: '待確認／發布', delivered: '已發布', blocked: '暫停處理', failed: '需要處理' } as Record<string, string>)[status] || status
const sectionLoadNote = (error: any) => [403, 409, 422].includes(error?.statusCode || error?.status || error?.response?.status) ? '目前方案或網站設定尚未啟用此功能。' : '暫時無法載入，請稍後重新整理。'

async function loadCustomerSite() {
  loading.value = true
  errorMessage.value = ''
  requiresReaccess.value = false
  try {
    projection.value = await fetchCustomerPortal('/api/managed-sites/customer/session')
    try { moduleWorkspace.value = await fetchCustomerPortal('/api/managed-sites/customer/modules') } catch { moduleWorkspace.value = null }
    try { contentProgress.value = await fetchCustomerPortal<ContentProgress>('/api/managed-sites/customer/content-admin'); contentProgressNote.value = '' } catch (error) { contentProgress.value = null; contentProgressNote.value = sectionLoadNote(error) }
    try { visibilityReport.value = await fetchCustomerPortal<VisibilityReport>('/api/managed-sites/customer/visibility'); visibilityNote.value = '' } catch (error) { visibilityReport.value = null; visibilityNote.value = sectionLoadNote(error) }
    try { systemStatus.value = await fetchCustomerPortal('/api/system-factory/customer/status') } catch { systemStatus.value = null }
  } catch (error: any) {
    projection.value = null
    requiresReaccess.value = (error?.statusCode || error?.status || error?.response?.status) === 401
    errorMessage.value = requiresReaccess.value ? '登入已到期，請重新登入網站後台。' : error?.data?.message || '此客戶入口需要有效的邀請工作階段。'
  } finally {
    loading.value = false
  }
}

async function exportData() {
  window.location.href = '/api/managed-sites/customer/export'
}

async function askAssistant() {
  if (!assistantQuestion.value.trim() || assistantLoading.value) return
  assistantLoading.value = true
  assistantResult.value = null
  try { assistantResult.value = await fetchCustomerPortal('/api/managed-sites/customer/assistant', { method: 'POST', body: { question: assistantQuestion.value } }) }
  catch (error: any) { assistantResult.value = { status: 'blocked', answer: null, limitation: error?.data?.message || '目前無法使用助手。' } }
  finally { assistantLoading.value = false }
}

async function signOut() {
  if (signingOut.value) return
  signingOut.value = true
  try {
    await fetchCustomerPortal('/api/managed-sites/customer/logout', { method: 'POST' })
    window.location.assign('/managed-site-access')
  } catch {
    errorMessage.value = '目前無法安全登出，請稍後再試。'
    signingOut.value = false
  }
}

onMounted(loadCustomerSite)
</script>

<template>
  <main class="managed-site-portal" aria-labelledby="managed-site-title">
    <header class="managed-site-portal__header">
      <div>
        <p class="eyebrow">CUSTOMER PORTAL / MANAGED SITE</p>
        <h1 id="managed-site-title">你的 Managed Site</h1>
        <p class="lede">這裡只顯示你所屬網站專案的內容、版本、素材與訂閱狀態。平台原始碼與其他客戶資料不在此入口提供。</p>
      </div>
      <button v-if="projection?.capabilities.customerDataExport" type="button" class="button" @click="exportData">匯出我的資料</button>
      <NuxtLink v-if="projection?.capabilities.customerDataExport" class="button button--editor" to="/customer/managed-sites/inbox">網站詢問</NuxtLink>
      <NuxtLink v-if="projection && ['owner', 'administrator', 'editor'].includes(projection.membership.role)" class="button button--editor" to="/customer/managed-sites/editor">開啟網站編輯器</NuxtLink>
      <NuxtLink v-if="projection && ['owner', 'administrator', 'editor'].includes(projection.membership.role)" class="button button--editor" to="/customer/managed-sites/design-care">免費美術調整</NuxtLink>
      <button v-if="projection" type="button" class="button button--editor" :disabled="signingOut" @click="signOut">{{ signingOut ? '登出中…' : '登出' }}</button>
      <a v-else-if="!loading" class="button button--editor" href="/managed-site-access">重新登入</a>
    </header>

    <p v-if="loading" class="state" role="status">正在載入專案資料…</p>
    <p v-else-if="errorMessage" class="state state--error" role="alert">{{ errorMessage }} <a v-if="requiresReaccess" href="/managed-site-access">重新登入網站後台</a></p>
    <section v-else-if="projection" class="managed-site-portal__grid">
      <article class="card card--wide">
        <p class="card__label">PROJECT</p>
        <h2>{{ projection.project.canonicalClientIdentity }}</h2>
        <p v-if="projection.launch?.attention" class="state state--error" role="alert">{{ projection.launch.attention }}</p>
        <p v-else-if="projection.launch?.order?.status === 'payment_verified' && !projection.launch?.release?.liveUrl" class="muted">付款已確認。正式網站與網域仍在準備中，完成驗證後才會顯示上線連結。</p>
        <dl>
          <div><dt>網站</dt><dd><a v-if="projection.launch?.release?.liveUrl" :href="projection.launch.release.liveUrl" rel="noopener noreferrer">查看已上線網站</a><span v-else>{{ projection.project.canonicalWebsiteIdentity }}</span></dd></div>
          <div><dt>類型</dt><dd>{{ projection.project.siteType }}</dd></div>
          <div><dt>狀態</dt><dd>{{ projection.project.status }}</dd></div>
          <div><dt>我的角色</dt><dd>{{ projection.membership.role }}</dd></div>
        </dl>
      </article>
      <article class="card">
        <p class="card__label">SUBSCRIPTION</p>
        <h2>{{ projection.subscription?.status || '尚未建立' }}</h2>
        <p>{{ projection.subscription?.planKey || '付款與方案確認後顯示。' }}</p>
      </article>
      <article class="card">
        <p class="card__label">CRM / ERP SYSTEM</p>
        <h2>{{ systemStatus?.system?.tenant?.state || (systemStatus?.available ? systemStatus?.system?.status : '尚未加購') }}</h2>
        <p v-if="systemStatus?.system?.tenant?.adminLaunchAvailable">系統已通過 receipt-based health；進階管理入口仍由角色與 server session 控制。</p>
        <p v-else>尚無可用的 verified health + active tenant，不顯示管理入口。</p>
      </article>
      <article class="card">
        <p class="card__label">ACCESS BOUNDARY</p>
        <h2>受控代管</h2>
        <p>網域屬於客戶；平台負責部署、維護與 GEO 營運。原始碼不提供下載。</p>
      </article>
      <article v-if="moduleWorkspace" class="card card--wide">
        <p class="card__label">MODULES & GEO OPERATIONS</p>
        <h2>模組與持續營運</h2>
        <p class="muted">{{ moduleWorkspace.canonicalContentOperations.message }}</p>
        <div class="module-list"><div v-for="module in moduleWorkspace.modules" :key="module.moduleKey"><strong>{{ module.moduleKey }}</strong><span>{{ module.status }} · {{ module.externalCalls ? '外部執行' : '尚未外部執行' }}</span></div></div>
      </article>
      <article class="card card--wide" aria-labelledby="customer-content-title">
        <p class="card__label">CONTENT OPERATIONS</p><h2 id="customer-content-title">文章與發布進度</h2>
        <p v-if="!contentProgress" class="muted">{{ contentProgressNote || '尚無內容營運資料。' }}</p>
        <template v-else>
          <p class="muted">以下是這個網站的內容流程條件；單一條件完成不代表文章已自動產生或發布。</p>
          <div class="operation-status"><span>內容日曆 <strong>{{ contentProgress.siteReadiness.hasContentCalendar ? '已建立' : '尚未建立' }}</strong></span><span>排程服務 <strong>{{ contentProgress.readiness.schedulerEnabled ? '已啟用' : '尚未啟用' }}</strong></span><span>AI 產稿設定 <strong>{{ contentProgress.readiness.generationExecutorAvailable ? '已設定' : '尚未設定' }}</strong></span><span>此站發布通道 <strong>{{ contentProgress.siteReadiness.hasExecutablePublicationTarget ? '已設定' : '尚未設定' }}</strong></span><span>此站營運授權 <strong>{{ contentProgress.siteReadiness.hasCurrentOwnerPolicy ? '有效' : '尚未完成' }}</strong></span><span>發文前確認 <strong>{{ contentProgress.siteReadiness.customerApprovalRequired ? '需要客戶確認' : '依方案規則' }}</strong></span></div>
          <p v-if="!recentContent.length" class="muted">目前沒有排程中的文章；設定內容方案與發布目標後，進度會顯示在這裡。</p>
          <ul v-else class="report-list"><li v-for="entry in recentContent" :key="entry.id"><div><strong>{{ entry.title || entry.topic || '待命名內容' }}</strong><small>預定 {{ entry.plannedLocalDate }}</small></div><span>{{ contentStatus(entry.status) }}</span></li></ul>
        </template>
      </article>
      <article class="card card--wide" aria-labelledby="customer-visibility-title">
        <p class="card__label">AI CITATION REPORT</p><h2 id="customer-visibility-title">AI 如何提到你的品牌</h2>
        <p v-if="!visibilityReport" class="muted">{{ visibilityNote || '尚無引用觀測資料。' }}</p>
        <p v-else-if="visibilityReport.status === 'not_configured'" class="muted">{{ visibilityReport.message }}</p>
        <template v-else>
          <p class="muted">{{ visibilityReport.domain }} · 最近 30 天已核准的人工觀測；資料不足時不推算成效。</p>
          <div class="report-metrics"><div><small>追蹤問題</small><strong>{{ visibilityReport.trackedQueries }}</strong></div><div><small>核實樣本</small><strong>{{ visibilityReport.sampleCount }}</strong></div><div><small>品牌提及率</small><strong>{{ percentage(visibilityReport.brandMentionRate) }}</strong></div><div><small>網站引用率</small><strong>{{ percentage(visibilityReport.exactCitationRate) }}</strong></div></div>
          <p v-if="!visibilityReport.observations.length" class="muted">目前沒有可顯示的核實觀測。建立並核准觀測後，問題、平台與引用網址會出現在這裡。</p>
          <ul v-else class="report-list"><li v-for="(observation, index) in visibilityReport.observations" :key="`${observation.provider}-${observation.observedAt}-${index}`"><div><strong>{{ observation.query }}</strong><small>{{ observation.provider }} · {{ displayDate(observation.observedAt) }}</small><a v-for="url in observation.citationUrls" :key="url" :href="url" target="_blank" rel="noopener noreferrer">查看引用頁面 ↗</a></div><span>{{ observation.citationUrls.length ? '引用網站' : observation.brandMentioned ? '提到品牌' : '未提及' }}</span></li></ul>
          <p class="report-limitation">{{ visibilityReport.limitations[0] }}</p>
        </template>
      </article>
      <article class="card card--wide">
        <p class="card__label">BOUNDED AI ASSISTANT</p>
        <h2>問問你的網站助手</h2>
        <p class="muted">助手只會使用已授權且可引用的專案內容；若 provider 尚未連線，會明確回報尚未啟用，不會編造答案。</p>
        <form class="assistant-form" @submit.prevent="askAssistant"><textarea v-model="assistantQuestion" rows="3" maxlength="2000" placeholder="例如：目前網站有哪些版本？"></textarea><button class="button" type="submit" :disabled="assistantLoading">{{ assistantLoading ? '處理中…' : '詢問' }}</button></form>
        <div v-if="assistantResult" class="assistant-result" :class="{ 'assistant-result--blocked': assistantResult.status !== 'answered' }"><strong>{{ assistantResult.status === 'answered' ? '助手回覆' : '尚未啟用' }}</strong><p>{{ assistantResult.answer || assistantResult.limitation }}</p></div>
      </article>
      <article class="card card--wide">
        <p class="card__label">VERSIONS</p>
        <p v-if="!projection.versions.length" class="muted">目前尚未建立網站版本。</p>
        <ul v-else class="version-list">
          <li v-for="version in projection.versions" :key="version.id"><strong>v{{ version.version }}</strong><span>{{ version.lifecycleStatus }} · {{ version.createdByAuthority }}</span></li>
        </ul>
      </article>
    </section>
  </main>
</template>

<style scoped>
.managed-site-portal { min-height: 100vh; padding: 4rem clamp(1rem, 5vw, 5rem); background: #f7f5ef; color: #1b2236; }
.managed-site-portal__header { max-width: 72rem; margin: 0 auto 2.5rem; display: flex; justify-content: space-between; gap: 2rem; align-items: flex-end; }
.eyebrow, .card__label { margin: 0 0 .7rem; color: #4d5dad; font: 700 .72rem/1.2 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; }
h1 { margin: 0; font: 900 clamp(2.2rem, 6vw, 4.6rem)/1.02 Georgia, serif; }
h2 { margin: 0 0 .6rem; font: 700 1.35rem/1.15 Georgia, serif; }
.lede { max-width: 52rem; color: #5e6575; line-height: 1.7; }
.button { border: 0; border-radius: .6rem; padding: .8rem 1.1rem; background: #4d5dad; color: white; cursor: pointer; font-weight: 700; }
.button--editor { display: inline-flex; text-decoration: none; background: #17233b; }
.state { max-width: 72rem; margin: 0 auto; padding: 1rem; border-radius: .7rem; background: white; }
.state--error { color: #8a2b24; border: 1px solid #edb3ab; }
.managed-site-portal__grid { max-width: 72rem; margin: 0 auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.card { padding: 1.3rem; background: white; border: 1px solid #e7e2d8; border-radius: .8rem; box-shadow: 0 1rem 2.5rem rgba(45, 51, 72, .06); }
.card--wide { grid-column: span 2; }
dl { margin: 1.2rem 0 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .9rem; }
dt { color: #777d8b; font-size: .78rem; } dd { margin: .25rem 0 0; overflow-wrap: anywhere; }
.muted { color: #777d8b; }
.version-list { list-style: none; padding: 0; margin: 0; display: grid; gap: .55rem; }
.version-list li { display: flex; justify-content: space-between; gap: 1rem; padding: .7rem 0; border-bottom: 1px solid #eeeae2; }
.version-list span { color: #777d8b; }
.module-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .55rem; margin-top: 1rem; }
.module-list div { display: grid; gap: .2rem; padding: .7rem; border: 1px solid #eeeae2; border-radius: .55rem; }
.module-list strong { font-size: .75rem; }
.module-list span { color: #777d8b; font-size: .68rem; }
.operation-status, .report-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .6rem; margin: 1rem 0; }
.operation-status span, .report-metrics div { display: grid; gap: .35rem; padding: .85rem; border: 1px solid #e7e2d8; border-radius: .55rem; background: #f7f5ef; font-size: .75rem; }
.operation-status strong { color: #17233b; }
.report-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.report-metrics small { color: #777d8b; }
.report-metrics strong { color: #17233b; font-size: 1.3rem; }
.report-list { list-style: none; margin: 1rem 0 0; padding: 0; }
.report-list li { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; padding: .8rem 0; border-top: 1px solid #e7e2d8; }
.report-list li > div { display: grid; gap: .25rem; min-width: 0; }
.report-list li strong { overflow-wrap: anywhere; }
.report-list li small, .report-list li > span { color: #777d8b; font-size: .72rem; }
.report-list li > span { flex: 0 0 auto; }
.report-list a { color: #17233b; font-size: .72rem; overflow-wrap: anywhere; }
.report-limitation { margin: 1rem 0 0; color: #777d8b; font-size: .72rem; line-height: 1.6; }
.assistant-form { display: grid; gap: .7rem; margin-top: 1rem; }
.assistant-form textarea { width: 100%; border: 1px solid #e7e2d8; border-radius: .55rem; padding: .8rem; resize: vertical; }
.assistant-form .button { justify-self: start; }
.assistant-result { margin-top: 1rem; padding: .8rem; border-radius: .55rem; background: #edf6ef; color: #236241; }
.assistant-result--blocked { background: #fff4e5; color: #875215; }
.assistant-result p { margin: .35rem 0 0; line-height: 1.6; }
@media (max-width: 42rem) { .managed-site-portal { padding: 2rem 1rem; } .managed-site-portal__header { display: block; } .button { margin-top: 1rem; } .managed-site-portal__grid { grid-template-columns: 1fr; } .card--wide { grid-column: auto; } dl { grid-template-columns: 1fr; } .module-list, .operation-status, .report-metrics { grid-template-columns: 1fr; } }
</style>
