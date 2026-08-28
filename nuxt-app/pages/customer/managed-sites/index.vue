<script setup lang="ts">
import { onMounted, ref } from 'vue'

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const loading = ref(true)
const errorMessage = ref('')
const projection = ref<any>(null)
const moduleWorkspace = ref<any>(null)
const assistantQuestion = ref('')
const assistantResult = ref<any>(null)
const assistantLoading = ref(false)

async function loadCustomerSite() {
  loading.value = true
  errorMessage.value = ''
  try {
    projection.value = await $fetch('/api/managed-sites/customer/session')
    try { moduleWorkspace.value = await $fetch('/api/managed-sites/customer/modules') } catch { moduleWorkspace.value = null }
  } catch (error: any) {
    projection.value = null
    errorMessage.value = error?.data?.message || '此客戶入口需要有效的邀請工作階段。'
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
  try { assistantResult.value = await $fetch('/api/managed-sites/customer/assistant', { method: 'POST', body: { question: assistantQuestion.value } }) }
  catch (error: any) { assistantResult.value = { status: 'blocked', answer: null, limitation: error?.data?.message || '目前無法使用助手。' } }
  finally { assistantLoading.value = false }
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
      <button v-if="projection" type="button" class="button" @click="exportData">匯出我的資料</button>
      <NuxtLink v-if="projection && ['owner', 'administrator', 'editor'].includes(projection.membership.role)" class="button button--editor" to="/customer/managed-sites/editor">開啟網站編輯器</NuxtLink>
    </header>

    <p v-if="loading" class="state" role="status">正在載入專案資料…</p>
    <p v-else-if="errorMessage" class="state state--error" role="alert">{{ errorMessage }}</p>
    <section v-else-if="projection" class="managed-site-portal__grid">
      <article class="card card--wide">
        <p class="card__label">PROJECT</p>
        <h2>{{ projection.project.canonicalClientIdentity }}</h2>
        <dl>
          <div><dt>網站</dt><dd>{{ projection.project.canonicalWebsiteIdentity }}</dd></div>
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
.assistant-form { display: grid; gap: .7rem; margin-top: 1rem; }
.assistant-form textarea { width: 100%; border: 1px solid #e7e2d8; border-radius: .55rem; padding: .8rem; resize: vertical; }
.assistant-form .button { justify-self: start; }
.assistant-result { margin-top: 1rem; padding: .8rem; border-radius: .55rem; background: #edf6ef; color: #236241; }
.assistant-result--blocked { background: #fff4e5; color: #875215; }
.assistant-result p { margin: .35rem 0 0; line-height: 1.6; }
@media (max-width: 42rem) { .managed-site-portal { padding: 2rem 1rem; } .managed-site-portal__header { display: block; } .button { margin-top: 1rem; } .managed-site-portal__grid { grid-template-columns: 1fr; } .card--wide { grid-column: auto; } dl { grid-template-columns: 1fr; } .module-list { grid-template-columns: 1fr; } }
</style>
