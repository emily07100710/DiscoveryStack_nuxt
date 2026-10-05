<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { gsap } from 'gsap'
import { initPremiumServiceAccordion } from '../lib/premium-motion'

type ServiceRow = {
  title: string
  detail: string
  status?: '規劃中' | '人工設定' | '個別評估'
}

type ServiceGroup = {
  id: string
  number: string
  label: string
  title: string
  description: string
  rows: ServiceRow[]
}

const serviceGroups: ServiceGroup[] = [
  {
    id: 'preview',
    number: '01',
    label: 'PREVIEW',
    title: '本次先看見',
    description: '先把品牌方向，變成可以親手看的畫面。',
    rows: [
      { title: '桌機與手機的網站預覽', detail: '切換桌機、平板與手機，看看版面在不同裝置上的呈現。這一步是 RWD 概念預覽。' },
      { title: '服務、商品與頁面結構', detail: '依網站方向查看首頁、服務、品牌內容或商品的配置，先確認訪客怎麼理解你。' },
      { title: 'SEO／GEO 內容結構', detail: '預覽清楚的標題、內容層次與問答方向；正式的搜尋設定與內容依方案建置。' },
      { title: '聯絡與預約示範', detail: '親手點選聯絡或預約入口。示範不會送出資料，也不會建立真實預約。' },
    ],
  },
  {
    id: 'build',
    number: '02',
    label: 'BUILD',
    title: '正式建置包含',
    description: '確認方案後，把方向做成可營運的網站。',
    rows: [
      { title: '網站版面與內容管理', detail: '依確認的頁面與功能範圍建置正式網站，並安排日常內容管理方式。' },
      { title: '網域、DNS 與 SSL 設定', detail: '確認網域所有權與必要授權後，依方案安排網址、安全連線與相關設定。網域與第三方費用另行確認。' },
      { title: '部署與上線安排', detail: '依確認方案完成部署與上線檢查。這次預覽不會購買網域、部署或啟用正式服務。' },
    ],
  },
  {
    id: 'extensions',
    number: '03',
    label: 'EXTEND',
    title: '延伸需求・先評估',
    description: '可提出需求；規劃中的項目目前尚未開放。',
    rows: [
      { title: 'LINE 訊息串接', status: '規劃中', detail: 'LINE 串接尚未開放正式啟用。可先提出聯絡與訊息需求，後續開通仍需帳號授權與功能確認。' },
      { title: 'Google 預約與行程', status: '規劃中', detail: '預約與行程串接尚未開放正式啟用。可先說明預約流程；後續需確認 Google 帳號與權限。' },
      { title: 'Stripe 收款／Shopify 電商', status: '人工設定', detail: '目前需人工設定。先確認平台帳號、適用方案與授權，再評估設定範圍；第三方審核及費用另行確認。' },
      { title: '台灣金流與電子發票', status: '規劃中', detail: '台灣金流與電子發票串接尚未開放正式啟用。可先提出收款、開票與使用平台需求。' },
      { title: '物流與 ERP 串接', status: '規劃中', detail: '物流與 ERP 串接尚未開放正式啟用。可先提供使用的平台與配送流程，作為後續規劃依據。' },
      { title: 'CRM、會員與 PWA', status: '個別評估', detail: '先評估客戶管理、會員權限或可加入主畫面的 PWA 網站需求，確認可用範圍、平台條件與報價後再安排。' },
    ],
  },
]

const platformExamples = [
  { name: 'LINE', asset: '/platforms/line.png', className: 'line' },
  { name: 'Google Calendar', asset: '/platforms/google-calendar.svg', className: 'calendar' },
  { name: 'Stripe', asset: '/platforms/stripe.svg', className: 'stripe' },
]

const overview = ref<HTMLElement | null>(null)
let disposeMotion: (() => void) | undefined
let reducedPreference: MediaQueryList | undefined

function syncServiceMotion() {
  disposeMotion?.()
  disposeMotion = undefined
  if (!overview.value || reducedPreference?.matches || document.documentElement.dataset.motionPaused === 'true' || typeof ResizeObserver === 'undefined') return
  disposeMotion = initPremiumServiceAccordion(overview.value, gsap)
}

onMounted(() => {
  reducedPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  syncServiceMotion()
  reducedPreference?.addEventListener?.('change', syncServiceMotion)
  document.addEventListener('discoverystack:motion-change', syncServiceMotion)
})

onBeforeUnmount(() => {
  disposeMotion?.()
  reducedPreference?.removeEventListener?.('change', syncServiceMotion)
  if (typeof document !== 'undefined') document.removeEventListener('discoverystack:motion-change', syncServiceMotion)
})
</script>

<template>
  <section ref="overview" id="builder-services" class="builder-service-overview" aria-labelledby="builder-service-overview-title">
    <header class="service-overview-heading">
      <div>
        <p class="service-overview-kicker">THE WEBSITE, AND WHAT COMES WITH IT</p>
        <h2 id="builder-service-overview-title">從預覽，到你的正式網站。</h2>
      </div>
      <p class="service-overview-intro">先看見方向，再確認建置與開通範圍。<br>點開項目，看看每一步包含什麼。</p>
    </header>

    <div class="service-overview-columns">
      <article v-for="group in serviceGroups" :key="group.id" class="service-overview-group" :class="`service-group-${group.id}`" :aria-labelledby="`builder-services-${group.id}`">
        <div class="service-group-index" aria-hidden="true"><span>{{ group.number }}</span><span>{{ group.label }}</span></div>
        <h3 :id="`builder-services-${group.id}`">{{ group.title }}</h3>
        <p class="service-group-description">{{ group.description }}</p>

        <div v-if="group.id === 'extensions'" class="service-platform-examples" aria-label="延伸需求的平台範例">
          <span v-for="platform in platformExamples" :key="platform.name" class="service-platform-mark" :class="`service-platform-${platform.className}`">
            <img :src="platform.asset" :alt="platform.name" :width="platform.className === 'line' ? 40 : 24" :height="platform.className === 'line' ? 40 : 24" loading="lazy" decoding="async">
          </span>
          <span class="service-platform-label">可提出需求</span>
        </div>

        <div class="service-overview-rows">
          <details v-for="row in group.rows" :key="row.title" class="service-overview-row" data-service>
            <summary><span class="service-row-title">{{ row.title }}</span><span v-if="row.status" class="service-row-status">{{ row.status }}</span><span class="service-row-indicator" aria-hidden="true"></span></summary>
            <div class="premium-service-detail service-overview-detail"><p>{{ row.detail }}</p></div>
          </details>
        </div>
      </article>
    </div>

    <footer class="service-overview-note">
      <span class="service-overview-status"><i aria-hidden="true"></i>目前為互動預覽</span>
      <p>正式建置依確認方案安排；延伸需求依上列狀態評估。</p>
    </footer>
  </section>
</template>

<style scoped>
.builder-service-overview {
  --service-ink: var(--studio-paper, var(--premium-paper, #eee9df));
  --service-accent: var(--studio-khaki, var(--premium-khaki, #b7a88f));
  max-width: 88rem;
  margin: 0 auto clamp(3rem, 6vw, 5rem);
  padding-block: clamp(1.8rem, 3vw, 2.8rem) 1rem;
  border-top: 1px solid rgba(183, 168, 143, .25);
  border-bottom: 1px solid rgba(183, 168, 143, .18);
  color: var(--service-ink);
  font-family: var(--font-body, 'Noto Sans TC', sans-serif);
}

.builder-service-overview *,
.builder-service-overview *::before,
.builder-service-overview *::after { box-sizing: border-box; }
.builder-service-overview p,
.builder-service-overview h2,
.builder-service-overview h3 { margin: 0; }
.service-overview-heading { display: flex; align-items: end; justify-content: space-between; gap: 2rem; margin-bottom: 2.5rem; }
.service-overview-kicker { color: var(--service-accent); font: .55rem/1.6 var(--font-mono, ui-monospace, monospace); letter-spacing: .1em; }
.service-overview-heading h2 { margin-top: .8rem; font: 400 clamp(1.35rem, 2.3vw, 2.1rem)/1.5 var(--font-display, 'Noto Serif TC', serif); letter-spacing: -.035em; text-wrap: balance; }
.service-overview-intro { color: rgba(238, 233, 223, .68); font-size: .72rem; line-height: 1.9; }
.service-overview-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: clamp(1.8rem, 3vw, 3rem); }
.service-overview-group { min-width: 0; }
.service-overview-group + .service-overview-group { border-left: 1px solid rgba(183, 168, 143, .14); padding-left: clamp(1.8rem, 3vw, 3rem); }
.service-group-index { display: flex; align-items: center; justify-content: space-between; gap: 1rem; color: var(--service-accent); font: .5rem/1.6 var(--font-mono, ui-monospace, monospace); letter-spacing: .1em; }
.service-group-index > span:first-child { font-size: .63rem; letter-spacing: 0; }
.service-overview-group h3 { margin-top: .8rem; font: 400 clamp(1rem, 1.4vw, 1.35rem)/1.6 var(--font-display, 'Noto Serif TC', serif); letter-spacing: -.025em; }
.service-group-description { margin-top: .65rem !important; color: rgba(238, 233, 223, .63); font-size: .68rem; line-height: 1.85; }
.service-overview-rows { margin-top: 1.4rem; }
.service-overview-row { border-top: 1px solid rgba(183, 168, 143, .16); }
.service-overview-row:last-child { border-bottom: 1px solid rgba(183, 168, 143, .16); }
.service-overview-row summary { display: flex; align-items: center; justify-content: space-between; gap: .85rem; min-height: 3rem; padding: .75rem 0; color: var(--service-ink); list-style: none; cursor: pointer; font-size: .73rem; line-height: 1.7; }
.service-overview-row summary::-webkit-details-marker { display: none; }
.service-overview-row summary::marker { content: ''; }
.service-overview-row summary:focus-visible { outline: 1px solid var(--service-accent); outline-offset: 4px; }
.service-row-title { flex: 1; min-width: 0; }
.service-row-status { flex: 0 0 auto; padding: .18rem .35rem; border: 1px solid rgba(183, 168, 143, .3); color: var(--service-accent); font-size: .5rem; line-height: 1.5; white-space: nowrap; }
.service-row-indicator { position: relative; flex: 0 0 .65rem; width: .65rem; height: .65rem; color: var(--service-accent); }
.service-row-indicator::before,
.service-row-indicator::after { content: ''; position: absolute; background: currentColor; }
.service-row-indicator::before { top: calc(50% - .5px); left: 0; width: 100%; height: 1px; }
.service-row-indicator::after { top: 0; left: calc(50% - .5px); width: 1px; height: 100%; transition: transform .2s ease; }
.service-overview-row[open] summary:not([aria-expanded=false]) .service-row-indicator::after,
.service-overview-row summary[aria-expanded=true] .service-row-indicator::after { transform: scaleY(0); }
.service-overview-detail { display: block; grid-template-columns: none; padding: 0; margin: 0; border: 0; }
.service-overview-detail > p { padding: 0 1.3rem 1rem 0; color: rgba(238, 233, 223, .68); font-size: .68rem; line-height: 1.95; overflow-wrap: anywhere; }
.service-platform-examples { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem; min-height: 40px; margin-top: 1rem; }
.service-platform-mark { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; background: #f5f1e9; }
.service-platform-mark img { display: block; width: 24px; height: 24px; object-fit: contain; }
.service-platform-line { width: 40px; height: 40px; background: transparent; }
.service-platform-line img { width: 40px; height: 40px; }
.service-platform-label { margin-left: .2rem; color: rgba(238, 233, 223, .54); font-size: .58rem; line-height: 1.6; }
.service-overview-note { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .8rem 2rem; margin-top: 1.8rem; padding-top: 1rem; }
.service-overview-status { display: inline-flex; align-items: center; gap: .55rem; color: var(--service-accent); font-size: .6rem; line-height: 1.7; white-space: nowrap; }
.service-overview-status i { width: .27rem; height: .27rem; background: var(--service-accent); border-radius: 50%; }
.service-overview-note p { max-width: 35rem; color: rgba(238, 233, 223, .53); font-size: .58rem; line-height: 1.8; }

@media (max-width: 64rem) {
  .service-overview-heading { align-items: start; flex-direction: column; gap: .9rem; margin-bottom: 2rem; }
  .service-overview-columns { gap: 1.4rem; }
  .service-overview-group + .service-overview-group { padding-left: 1.4rem; }
  .service-overview-row summary { font-size: .7rem; }
}

@media (max-width: 48rem) {
  .builder-service-overview { margin-bottom: 3rem; padding-block: 1.8rem 1rem; }
  .service-overview-columns { grid-template-columns: minmax(0, 1fr); gap: 2rem; }
  .service-overview-group + .service-overview-group { padding: 1.6rem 0 0; border-left: 0; border-top: 1px solid rgba(183, 168, 143, .25); }
  .service-overview-kicker { font-size: .48rem; letter-spacing: .07em; }
  .service-overview-heading h2 { font-size: clamp(1.3rem, 5.5vw, 1.8rem); }
  .service-overview-intro { font-size: .7rem; }
  .service-overview-group h3 { font-size: 1.2rem; }
  .service-group-description { font-size: .73rem; }
  .service-overview-rows { margin-top: 1.1rem; }
  .service-overview-row summary { min-height: 3.2rem; font-size: .8rem; }
  .service-overview-detail > p { font-size: .74rem; }
  .service-overview-note { align-items: start; flex-direction: column; gap: .6rem; margin-top: 1.5rem; }
  .service-overview-note p { font-size: .62rem; }
}

@media (prefers-reduced-motion: reduce) {
  .service-row-indicator::after { transition: none; }
}
</style>
