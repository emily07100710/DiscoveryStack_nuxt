<script setup lang="ts">
import { onMounted, ref } from 'vue'

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const loading = ref(true)
const errorMessage = ref('')
const projection = ref<any>(null)

async function loadCustomerSite() {
  loading.value = true
  errorMessage.value = ''
  try {
    projection.value = await $fetch('/api/managed-sites/customer/session')
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
@media (max-width: 42rem) { .managed-site-portal { padding: 2rem 1rem; } .managed-site-portal__header { display: block; } .button { margin-top: 1rem; } .managed-site-portal__grid { grid-template-columns: 1fr; } .card--wide { grid-column: auto; } dl { grid-template-columns: 1fr; } }
</style>
