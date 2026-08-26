<script setup lang="ts">
import { computed, ref } from 'vue'

type SiteType = 'one-page' | 'brand-blog' | 'commerce'
type ThemeKey = 'mineral' | 'forest' | 'sunset'
type PlanKey = 'launch' | 'growth' | 'autopilot'

const siteTypes: Array<{ id: SiteType; label: string; note: string }> = [
  { id: 'one-page', label: '一頁式網站', note: '快速說清服務與收集詢問' },
  { id: 'brand-blog', label: '品牌＋部落格', note: '建立內容與長期 GEO 能見度' },
  { id: 'commerce', label: '電商網站', note: '商品、購物流程與成長內容' },
]

const moduleOptions = [
  { id: 'admin', label: '內容後台', tag: '推薦' },
  { id: 'ai', label: 'AI 問答助手', tag: 'AI' },
  { id: 'booking', label: 'Google 預約', tag: 'API' },
  { id: 'payment', label: '線上金流', tag: 'API' },
  { id: 'invoice', label: '電子發票', tag: 'API' },
  { id: 'line', label: 'LINE 導入', tag: 'API' },
  { id: 'member', label: '會員系統', tag: '系統' },
  { id: 'app', label: 'PWA／App', tag: '加購' },
]

const themes: Array<{ id: ThemeKey; label: string; colors: string[] }> = [
  { id: 'mineral', label: '理性清晰', colors: ['#17233b', '#dbe7ed', '#ff7a59'] },
  { id: 'forest', label: '自然信任', colors: ['#173f35', '#e5eee6', '#d6a85f'] },
  { id: 'sunset', label: '溫暖精品', colors: ['#5c2d3b', '#f7e8dc', '#c85e43'] },
]

const plans: Array<{ id: PlanKey; label: string; price: number; description: string }> = [
  { id: 'launch', label: '網站上線', price: 0, description: '完成網站、網域與部署，不含持續 GEO 營運。' },
  { id: 'growth', label: 'GEO 持續成長', price: 12800, description: '12 個月監測、成效儀表板與定期內容改善。' },
  { id: 'autopilot', label: 'GEO 自動營運', price: 28800, description: '監測、文章排程、AI 助手與每月人工品質檢查。' },
]

const brandName = ref('山嶼牙醫診所')
const businessBrief = ref('我們是台北的家庭牙醫，重視安心、透明與兒童友善，希望讓第一次來看牙的人不再緊張。')
const entryMode = ref<'existing' | 'new'>('new')
const existingUrl = ref('https://example-business.tw')
const diagnosisRevealed = ref(false)
const siteType = ref<SiteType>('brand-blog')
const selectedModules = ref<string[]>(['admin', 'ai', 'booking', 'line'])
const theme = ref<ThemeKey>('mineral')
const cadence = ref(15)
const plan = ref<PlanKey>('growth')
const domain = ref('shanyu-dental.tw')
const isGenerating = ref(false)
const generationStep = ref(4)
const showHandoff = ref(false)
const viewport = ref<'desktop' | 'mobile'>('desktop')

const currentTheme = computed(() => themes.find((item) => item.id === theme.value) ?? themes[0])
const currentPlan = computed(() => plans.find((item) => item.id === plan.value) ?? plans[0])
const moduleTotal = computed(() => selectedModules.value.length * 3800)
const siteBasePrice = computed(() => siteType.value === 'commerce' ? 128800 : siteType.value === 'brand-blog' ? 88800 : 58800)
const launchPrice = computed(() => siteBasePrice.value + moduleTotal.value)
const cadencePrice = computed(() => {
  if (plan.value === 'launch') return 0
  const multiplier: Record<number, number> = { 3: 2.1, 7: 1.45, 15: 1, 30: 0.72 }
  return Math.round(currentPlan.value.price * (multiplier[cadence.value] ?? 1))
})
const selectedLabels = computed(() => moduleOptions.filter((item) => selectedModules.value.includes(item.id)).map((item) => item.label))
const previewDescription = computed(() => businessBrief.value.trim() || '把品牌、服務與專業內容整理成容易被搜尋與 AI 理解的網站。')

function toggleModule(id: string) {
  selectedModules.value = selectedModules.value.includes(id)
    ? selectedModules.value.filter((item) => item !== id)
    : [...selectedModules.value, id]
}

function runDiagnosis() {
  diagnosisRevealed.value = true
}

function generatePreview() {
  if (isGenerating.value) return
  isGenerating.value = true
  generationStep.value = 0
  const sequence = [1, 2, 3, 4]
  sequence.forEach((step, index) => {
    window.setTimeout(() => {
      generationStep.value = step
      if (step === 4) isGenerating.value = false
    }, 420 * (index + 1))
  })
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('zh-TW').format(value)
}
</script>

<template>
  <section class="concept-builder" :style="{ '--preview-primary': currentTheme.colors[0], '--preview-paper': currentTheme.colors[1], '--preview-accent': currentTheme.colors[2] }">
    <div class="concept-intro">
      <div>
        <p class="concept-kicker"><span>CONCEPT PREVIEW</span> 不會扣款、不會購買網域</p>
        <h1>說一句話，<br><em>把生意變成會成長的網站。</em></h1>
      </div>
      <p>先看見自己的網站，再決定要不要買。從互動預覽、網域、部署，到 GEO 追蹤、自動內容與 AI 助手，都在同一條路徑完成。</p>
    </div>

    <section class="entry-gateway">
      <header>
        <span>01</span>
        <div><p>START WHERE YOU ARE</p><h2>你現在有網站嗎？</h2><small>不論從診斷還是從零開始，最後都會得到一份可以購買的網站預覽。</small></div>
      </header>
      <div class="entry-tabs">
        <button type="button" :class="{ active: entryMode === 'existing' }" @click="entryMode = 'existing'">
          <b>我已經有網站</b><span>先看問題，再生成改善後版本</span>
        </button>
        <button type="button" :class="{ active: entryMode === 'new' }" @click="entryMode = 'new'">
          <b>我還沒有網站</b><span>直接用自然語言建立新網站</span>
        </button>
      </div>

      <div v-if="entryMode === 'existing'" class="diagnosis-entry">
        <div class="diagnosis-form">
          <label>輸入目前網站網址<input v-model="existingUrl" inputmode="url" placeholder="https://your-company.com"></label>
          <button type="button" @click="runDiagnosis">模擬公開網站診斷 <span>→</span></button>
          <small>概念版不會真的爬取網站；正式版只分析公開頁面並清楚標示資料限制。</small>
        </div>
        <div v-if="diagnosisRevealed" class="diagnosis-comparison">
          <article class="before-card">
            <p>CURRENT PUBLIC SIGNALS</p><h3>目前可觀察的缺口</h3>
            <ul><li><b>答案埋得太深</b><span>重要問題沒有在頁面前段直接回答。</span></li><li><b>品牌實體不清楚</b><span>服務、地區與專業關係缺少一致描述。</span></li><li><b>內容無法持續</b><span>沒有可延伸的主題架構與更新節奏。</span></li></ul>
          </article>
          <div class="comparison-arrow">→</div>
          <article class="after-card">
            <p>GENERATED IMPROVEMENT</p><h3>新網站會直接改善</h3>
            <ul><li><b>先回答，再說明</b><span>首頁與服務頁使用直接答案結構。</span></li><li><b>建立可理解的品牌</b><span>統一服務、地區、作者與證據線索。</span></li><li><b>接上 GEO 成長循環</b><span>文章月曆、成效監測與持續改善。</span></li></ul>
          </article>
        </div>
      </div>
      <div v-else class="new-site-entry">
        <span>✦</span><div><b>不需要準備規格書。</b><p>只要說明你是誰、服務誰，以及希望客戶完成什麼；下一步再用按鈕補上網站類型與功能。</p></div>
      </div>
    </section>

    <div class="builder-shell">
      <aside class="builder-controls" aria-label="網站需求設定">
        <div class="control-heading">
          <span>02</span>
          <div><strong>先告訴我們你在做什麼</strong><small>自然語言就可以，不需要先有網站。</small></div>
        </div>
        <label class="field-label">品牌名稱<input v-model="brandName" maxlength="40" placeholder="例如：山嶼牙醫診所"></label>
        <label class="field-label">介紹你的生意<textarea v-model="businessBrief" rows="4" maxlength="260" placeholder="我們是誰、服務誰、最希望客戶感受到什麼？"></textarea></label>

        <div class="control-heading compact">
          <span>03</span>
          <div><strong>網站要幫你完成什麼</strong><small>點選後，右側預覽會跟著改變。</small></div>
        </div>
        <div class="choice-grid site-types">
          <button v-for="item in siteTypes" :key="item.id" type="button" :class="{ active: siteType === item.id }" @click="siteType = item.id">
            <strong>{{ item.label }}</strong><small>{{ item.note }}</small>
          </button>
        </div>

        <div class="module-grid">
          <button v-for="item in moduleOptions" :key="item.id" type="button" :aria-pressed="selectedModules.includes(item.id)" :class="{ active: selectedModules.includes(item.id) }" @click="toggleModule(item.id)">
            <span>{{ selectedModules.includes(item.id) ? '✓' : '+' }}</span><strong>{{ item.label }}</strong><small>{{ item.tag }}</small>
          </button>
        </div>

        <div class="theme-row" aria-label="選擇網站氛圍">
          <span>網站氛圍</span>
          <button v-for="item in themes" :key="item.id" type="button" :class="{ active: theme === item.id }" @click="theme = item.id">
            <i v-for="color in item.colors" :key="color" :style="{ background: color }"></i><b>{{ item.label }}</b>
          </button>
        </div>

        <button class="generate-button" type="button" :disabled="isGenerating" @click="generatePreview">
          <span>{{ isGenerating ? `正在建立預覽 ${generationStep}/4` : '重新生成互動預覽' }}</span><b>{{ isGenerating ? '•••' : '↗' }}</b>
        </button>
      </aside>

      <div class="preview-column">
        <div class="preview-toolbar">
          <div class="window-dots"><i></i><i></i><i></i></div>
          <div class="preview-url"><span>安全預覽</span>{{ domain || 'your-brand.tw' }}</div>
          <div class="viewport-buttons">
            <button type="button" :class="{ active: viewport === 'desktop' }" aria-label="桌面預覽" @click="viewport = 'desktop'">寬</button>
            <button type="button" :class="{ active: viewport === 'mobile' }" aria-label="手機預覽" @click="viewport = 'mobile'">窄</button>
          </div>
        </div>

        <div class="site-stage" :class="[`is-${viewport}`, { 'is-generating': isGenerating }]">
          <div class="generated-site">
            <header class="generated-nav">
              <strong>{{ brandName || '你的品牌' }}</strong>
              <nav><span>關於我們</span><span>服務項目</span><span v-if="siteType !== 'one-page'">專業內容</span></nav>
              <button>{{ selectedModules.includes('booking') ? '立即預約' : '聯絡我們' }}</button>
            </header>
            <main>
              <section class="generated-hero">
                <p>TRUSTED LOCAL EXPERT · GEO READY</p>
                <h2>{{ siteType === 'commerce' ? '把喜歡的日常，帶回你的生活。' : '專業不該讓人緊張，應該讓人更安心。' }}</h2>
                <p>{{ previewDescription }}</p>
                <div><button>{{ selectedModules.includes('booking') ? '預約第一次諮詢' : siteType === 'commerce' ? '開始選購' : '了解服務' }}</button><span>看看我們如何幫助你 →</span></div>
              </section>
              <section v-if="siteType === 'commerce'" class="preview-products">
                <article v-for="item in ['人氣商品', '本月精選', '專屬組合']" :key="item"><div></div><small>NEW COLLECTION</small><strong>{{ item }}</strong><span>NT$ 1,280</span></article>
              </section>
              <section v-else class="trust-strip">
                <div><b>4.9</b><small>真實顧客評價</small></div><div><b>12+</b><small>專業服務經驗</small></div><div><b>安心</b><small>透明說明流程</small></div>
              </section>
              <section v-if="siteType === 'brand-blog'" class="preview-editorial">
                <div><small>ANSWER-FIRST CONTENT</small><h3>第一次來之前，你最想知道的三件事。</h3><p>把客戶真正會問的問題，整理成 Google 與 AI 都容易理解的可靠答案。</p></div>
                <ol><li>第一次諮詢會發生什麼？</li><li>如何選擇適合自己的服務？</li><li>費用與時間應該怎麼評估？</li></ol>
              </section>
            </main>
            <button v-if="selectedModules.includes('ai')" class="preview-ai"><span>✦</span><b>問問品牌 AI 助手</b><small>立即回答常見問題</small></button>
            <div v-if="isGenerating" class="generation-mask"><span></span><p>正在整理品牌與 GEO 網站結構…</p></div>
          </div>
        </div>

        <div class="preview-evidence">
          <span>{{ diagnosisRevealed && entryMode === 'existing' ? '依診斷生成的改善預覽' : '這份預覽已示範' }}</span>
          <ul><li>清楚的直接答案</li><li>可延伸的內容架構</li><li>Schema 與網站速度規劃</li><li>{{ selectedModules.length }} 個選用模組</li></ul>
        </div>
      </div>
    </div>

    <section class="launch-config">
      <header><p>04 · FROM PREVIEW TO PRODUCTION</p><h2>喜歡這個方向，就把它變成真的。</h2><span>以下金額與網域狀態都是概念示範。</span></header>
      <div class="launch-grid">
        <div class="plan-panel">
          <h3>選擇持續服務</h3>
          <button v-for="item in plans" :key="item.id" type="button" :class="{ active: plan === item.id }" @click="plan = item.id">
            <span><b>{{ item.label }}</b><small>{{ item.description }}</small></span><strong>{{ item.price ? `NT$${formatMoney(item.price)}／月起` : '不訂閱' }}</strong>
          </button>
          <div v-if="plan !== 'launch'" class="cadence-control">
            <span>優質 GEO 內容頻率</span>
            <div><button v-for="days in [3, 7, 15, 30]" :key="days" type="button" :class="{ active: cadence === days }" @click="cadence = days">每 {{ days }} 天</button></div>
          </div>
        </div>

        <div class="domain-panel">
          <h3>網域與上線</h3>
          <label>想要的網址<div><input v-model="domain" placeholder="your-brand.tw"><button type="button">模擬查詢</button></div></label>
          <p class="domain-result"><span>●</span> {{ domain || 'your-brand.tw' }} 在這份展示中標示為可選</p>
          <ul><li>建立獨立私有網站專案</li><li>設定 DNS 與 HTTPS</li><li>部署正式 Astro／Nuxt 網站</li><li v-if="selectedModules.includes('admin')">包含專屬內容後台</li></ul>
        </div>

        <aside class="order-card">
          <p>YOUR PROJECT</p>
          <h3>{{ brandName || '你的品牌網站' }}</h3>
          <div><span>{{ siteTypes.find((item) => item.id === siteType)?.label }}</span><b>NT$ {{ formatMoney(siteBasePrice) }}</b></div>
          <div><span>{{ selectedModules.length }} 個加購模組</span><b>NT$ {{ formatMoney(moduleTotal) }}</b></div>
          <ul><li v-for="label in selectedLabels.slice(0, 5)" :key="label">{{ label }}</li></ul>
          <div class="order-total"><span>網站建置預估</span><strong>NT$ {{ formatMoney(launchPrice) }}</strong></div>
          <div v-if="cadencePrice" class="order-monthly"><span>12 個月 GEO 方案</span><strong>NT$ {{ formatMoney(cadencePrice) }}／月</strong></div>
          <button type="button" @click="showHandoff = true">保留這份設計並進入購買 <b>→</b></button>
          <small>正式版會先建立訂單，再進行付款、網域與 API 授權。</small>
        </aside>
      </div>
    </section>

    <div v-if="showHandoff" class="handoff-backdrop" role="presentation" @click.self="showHandoff = false">
      <section class="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <button class="close-dialog" type="button" aria-label="關閉" @click="showHandoff = false">×</button>
        <p>PREVIEW HANDOFF</p>
        <h2 id="handoff-title">這裡，就是預覽轉成正式專案的交接點。</h2>
        <div class="handoff-path"><span>留下聯絡資料</span><i>→</i><span>確認規格與付款</span><i>→</i><span>購買網域</span><i>→</i><span>自動部署</span></div>
        <p>系統會保存這一版的網站規格、功能、文案、設計版本與價格。需要 Google、LINE、金流或發票 API 的部分，付款後再由專人協助授權。</p>
        <button type="button" @click="showHandoff = false">了解，繼續調整概念</button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.concept-builder { --navy:#131c2d; --blue:#315bd6; --cream:#f5f1e8; --ink:#19202b; color:var(--ink); background:#f2eee5; min-height:100vh; padding:clamp(2.5rem,6vw,6rem) clamp(1rem,4vw,4rem) 6rem; font-family:'Noto Sans TC',sans-serif; }
.concept-intro { max-width:88rem; margin:0 auto clamp(2rem,5vw,4.5rem); display:grid; grid-template-columns:1.35fr .65fr; gap:3rem; align-items:end; }
.concept-kicker { display:flex; gap:.8rem; align-items:center; color:#625f59; font:500 .68rem/1.4 'DM Mono',monospace; letter-spacing:.11em; }
.concept-kicker span { color:#fff; background:#315bd6; border-radius:999px; padding:.35rem .75rem; }
.concept-intro h1 { margin:1.4rem 0 0; font:700 clamp(2.8rem,6vw,6.3rem)/.98 'Noto Serif TC',serif; letter-spacing:-.05em; }
.concept-intro h1 em { color:#315bd6; font-style:normal; }
.concept-intro > p { max-width:32rem; font-size:1.04rem; line-height:1.85; color:#55534d; }
.entry-gateway { max-width:88rem; margin:0 auto 1rem; padding:clamp(1.3rem,3vw,2.2rem); background:#17233b; color:#fff; border-radius:1.2rem; box-shadow:0 1.5rem 4rem rgba(23,35,59,.16); }
.entry-gateway>header { display:flex; gap:1rem; align-items:flex-start; margin-bottom:1.3rem; }.entry-gateway>header>span{display:grid;place-items:center;flex:0 0 2.2rem;height:2.2rem;border-radius:50%;background:#ff7a59;font:600 .7rem 'DM Mono',monospace}.entry-gateway>header div{display:grid;gap:.25rem}.entry-gateway>header p{color:#8fa7ef;font:600 .6rem 'DM Mono',monospace;letter-spacing:.12em}.entry-gateway>header h2{font:700 clamp(1.5rem,3vw,2.4rem) 'Noto Serif TC',serif}.entry-gateway>header small{color:#aeb6c6;font-size:.72rem}
.entry-tabs{display:grid;grid-template-columns:1fr 1fr;gap:.65rem}.entry-tabs button{display:grid;gap:.3rem;text-align:left;border:1px solid rgba(255,255,255,.18);border-radius:.8rem;padding:1rem;background:rgba(255,255,255,.05);color:#fff;cursor:pointer}.entry-tabs button b{font-size:.85rem}.entry-tabs button span{color:#aeb6c6;font-size:.68rem}.entry-tabs button.active{border-color:#8fa7ef;background:rgba(143,167,239,.16);box-shadow:inset 0 0 0 1px #8fa7ef}
.diagnosis-entry,.new-site-entry{margin-top:1rem;border-top:1px solid rgba(255,255,255,.12);padding-top:1rem}.diagnosis-form{display:grid;grid-template-columns:minmax(12rem,1fr) auto;gap:.6rem}.diagnosis-form label{display:grid;gap:.35rem;color:#aeb6c6;font-size:.65rem}.diagnosis-form input{width:100%;border:1px solid rgba(255,255,255,.2);border-radius:.6rem;background:rgba(255,255,255,.08);color:#fff;padding:.75rem;font:500 .75rem 'DM Mono',monospace}.diagnosis-form>button{align-self:end;border:0;border-radius:.6rem;background:#ff7a59;color:#fff;padding:.78rem 1rem;font-weight:800;cursor:pointer}.diagnosis-form>button span{margin-left:.5rem}.diagnosis-form>small{grid-column:1/-1;color:#8f98a9;font-size:.58rem}
.diagnosis-comparison{display:grid;grid-template-columns:1fr auto 1fr;gap:.8rem;align-items:center;margin-top:1rem}.diagnosis-comparison article{height:100%;border-radius:.8rem;padding:1rem}.diagnosis-comparison article>p{font:600 .55rem 'DM Mono',monospace;letter-spacing:.09em}.diagnosis-comparison h3{margin:.35rem 0 .6rem;font:700 1rem 'Noto Serif TC',serif}.diagnosis-comparison ul{list-style:none;padding:0;margin:0;display:grid;gap:.5rem}.diagnosis-comparison li{display:grid;grid-template-columns:auto 1fr;gap:.25rem .7rem}.diagnosis-comparison li::before{content:'•';grid-row:span 2;color:#ff7a59}.diagnosis-comparison li b{font-size:.68rem}.diagnosis-comparison li span{grid-column:2;color:#aeb6c6;font-size:.6rem;line-height:1.5}.before-card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}.before-card>p{color:#e8a68f}.after-card{background:#f3f5ff;color:#17233b}.after-card>p{color:#315bd6}.after-card li span{color:#626b7c}.comparison-arrow{color:#8fa7ef;font-size:1.3rem}.new-site-entry{display:flex;gap:.8rem;align-items:center;color:#dbe1ec}.new-site-entry>span{display:grid;place-items:center;width:2.2rem;height:2.2rem;border-radius:.65rem;background:rgba(143,167,239,.16);color:#8fa7ef}.new-site-entry div{display:grid;gap:.2rem}.new-site-entry b{font-size:.75rem}.new-site-entry p{color:#aeb6c6;font-size:.65rem}
.builder-shell { max-width:88rem; margin:auto; display:grid; grid-template-columns:minmax(20rem,.72fr) minmax(34rem,1.28fr); background:#fff; border:1px solid rgba(25,32,43,.14); box-shadow:0 2rem 6rem rgba(37,32,23,.1); border-radius:1.25rem; overflow:hidden; }
.builder-controls { padding:clamp(1.4rem,3vw,2.6rem); border-right:1px solid #e5e2da; background:#fbfaf7; }
.control-heading { display:flex; gap:1rem; align-items:flex-start; margin-bottom:1.2rem; }
.control-heading.compact { margin-top:2rem; }
.control-heading > span { display:grid; place-items:center; width:2rem; height:2rem; border-radius:50%; background:#17233b; color:#fff; font:500 .7rem 'DM Mono',monospace; }
.control-heading div { display:grid; gap:.25rem; }
.control-heading strong { font-size:1rem; }
.control-heading small,.field-label { color:#77736b; font-size:.76rem; }
.field-label { display:grid; gap:.45rem; margin-top:.8rem; font-weight:700; }
.field-label input,.field-label textarea { width:100%; border:1px solid #d9d5cc; background:#fff; border-radius:.7rem; padding:.85rem 1rem; color:#20252d; font:500 .9rem/1.65 inherit; resize:vertical; outline:none; transition:.2s ease; }
.field-label input:focus,.field-label textarea:focus { border-color:#315bd6; box-shadow:0 0 0 3px rgba(49,91,214,.1); }
.choice-grid { display:grid; gap:.55rem; }
.site-types { grid-template-columns:repeat(3,1fr); }
.choice-grid button { text-align:left; border:1px solid #dfdcd4; border-radius:.7rem; background:#fff; padding:.75rem; color:#252932; cursor:pointer; }
.choice-grid button strong,.choice-grid button small { display:block; }
.choice-grid button strong { font-size:.76rem; }
.choice-grid button small { margin-top:.3rem; color:#7a766f; line-height:1.4; font-size:.65rem; }
.choice-grid button.active { border-color:#315bd6; background:#eef2ff; box-shadow:inset 0 0 0 1px #315bd6; }
.module-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:.5rem; margin-top:1.2rem; }
.module-grid button { display:grid; grid-template-columns:1.4rem 1fr auto; align-items:center; gap:.45rem; border:1px solid #dfdcd4; border-radius:.65rem; padding:.65rem .7rem; background:#fff; cursor:pointer; color:#333842; text-align:left; }
.module-grid button > span { display:grid; place-items:center; width:1.25rem; height:1.25rem; border:1px solid #c6c2ba; border-radius:.35rem; font-size:.7rem; }
.module-grid button strong { font-size:.74rem; }
.module-grid button small { color:#77736b; font-size:.58rem; font-family:'DM Mono',monospace; }
.module-grid button.active { border-color:#315bd6; background:#f2f5ff; }
.module-grid button.active > span { color:#fff; background:#315bd6; border-color:#315bd6; }
.theme-row { margin-top:1.2rem; display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; }
.theme-row > span { width:100%; color:#77736b; font-size:.7rem; font-weight:700; }
.theme-row button { display:flex; align-items:center; gap:0; background:#fff; border:1px solid #dfdcd4; border-radius:999px; padding:.35rem .55rem; cursor:pointer; }
.theme-row button i { width:.72rem; height:.72rem; border-radius:50%; margin-left:-.12rem; border:1px solid rgba(255,255,255,.6); }
.theme-row button b { margin-left:.4rem; font-size:.64rem; }
.theme-row button.active { border-color:#315bd6; box-shadow:0 0 0 1px #315bd6; }
.generate-button { width:100%; margin-top:1.5rem; min-height:3.2rem; border:0; border-radius:.7rem; padding:.8rem 1rem; background:#315bd6; color:#fff; display:flex; justify-content:space-between; align-items:center; cursor:pointer; font:700 .84rem inherit; box-shadow:0 .6rem 1.5rem rgba(49,91,214,.22); }
.generate-button:disabled { cursor:wait; opacity:.78; }
.preview-column { min-width:0; background:#e9e7e1; padding:1rem; }
.preview-toolbar { height:2.7rem; display:grid; grid-template-columns:1fr minmax(12rem,1.7fr) 1fr; align-items:center; background:#f8f8f6; border:1px solid #d6d3cc; border-radius:.8rem .8rem 0 0; padding:0 .8rem; }
.window-dots { display:flex; gap:.35rem; }.window-dots i { width:.55rem; height:.55rem; border-radius:50%; background:#c6c4bd; }.window-dots i:first-child{background:#ff7a59}.window-dots i:nth-child(2){background:#e9bb5d}.window-dots i:last-child{background:#5ab985}
.preview-url { justify-self:center; width:100%; padding:.35rem .7rem; background:#eae9e5; border-radius:.35rem; color:#69665f; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center; font:500 .64rem 'DM Mono',monospace; }
.preview-url span { margin-right:.5rem; color:#258052; }
.viewport-buttons { justify-self:end; display:flex; gap:.25rem; }.viewport-buttons button{border:0;background:transparent;color:#8b8881;font-size:.65rem;cursor:pointer}.viewport-buttons button.active{color:#315bd6;font-weight:800}
.site-stage { min-height:36rem; display:flex; justify-content:center; background:#dcd9d2; border-inline:1px solid #d6d3cc; overflow:hidden; transition:.35s ease; }
.generated-site { width:100%; min-height:36rem; position:relative; overflow:hidden; background:var(--preview-paper); color:var(--preview-primary); transition:width .4s ease; }
.site-stage.is-mobile .generated-site { width:22rem; box-shadow:0 0 0 1px rgba(0,0,0,.1),0 1rem 3rem rgba(0,0,0,.16); }
.generated-nav { min-height:4.5rem; padding:0 clamp(1rem,4vw,3rem); display:flex; align-items:center; justify-content:space-between; gap:1rem; border-bottom:1px solid color-mix(in srgb,var(--preview-primary) 15%,transparent); }
.generated-nav strong { font-family:'Noto Serif TC',serif; font-size:1rem; }.generated-nav nav{display:flex;gap:1.1rem;font-size:.66rem}.generated-nav button,.generated-hero button{border:0;background:var(--preview-primary);color:var(--preview-paper);border-radius:999px;padding:.6rem 1rem;font-weight:700;font-size:.67rem}
.generated-hero { min-height:20rem; padding:clamp(2rem,6vw,5rem) clamp(1.5rem,7vw,5rem); position:relative; }
.generated-hero::after { content:""; position:absolute; right:7%; top:17%; width:clamp(5rem,14vw,10rem); aspect-ratio:1; border:1.5rem solid var(--preview-accent); border-radius:50% 45% 60% 38%; opacity:.68; transform:rotate(12deg); }
.generated-hero > * { position:relative; z-index:1; max-width:70%; }.generated-hero > p:first-child{font:600 .57rem 'DM Mono',monospace;letter-spacing:.12em}.generated-hero h2{margin:.9rem 0 1rem;font:700 clamp(1.7rem,4vw,3.7rem)/1.12 'Noto Serif TC',serif;letter-spacing:-.04em}.generated-hero > p{font-size:.75rem;line-height:1.8;max-width:31rem}.generated-hero > div{display:flex;align-items:center;gap:1rem;margin-top:1.5rem}.generated-hero > div span{font-size:.66rem;font-weight:700}
.trust-strip { display:grid; grid-template-columns:repeat(3,1fr); background:var(--preview-primary); color:var(--preview-paper); padding:1.2rem 4rem; }.trust-strip div{display:grid;text-align:center;border-right:1px solid color-mix(in srgb,var(--preview-paper) 25%,transparent)}.trust-strip div:last-child{border:0}.trust-strip b{font:700 1.4rem 'Noto Serif TC',serif}.trust-strip small{opacity:.72;font-size:.58rem}
.preview-editorial { display:grid; grid-template-columns:1.1fr .9fr; gap:2rem; padding:2rem 3rem; background:#fff; }.preview-editorial small{font:.55rem 'DM Mono',monospace;color:var(--preview-accent)}.preview-editorial h3{font:700 1.25rem/1.3 'Noto Serif TC',serif;margin:.5rem 0}.preview-editorial p,.preview-editorial li{font-size:.65rem;line-height:1.6}.preview-editorial ol{margin:0;padding-left:1.2rem}.preview-editorial li{padding:.35rem 0;border-bottom:1px solid #e8e4dc}
.preview-products { display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;padding:1.5rem 2rem 2rem;background:#fff}.preview-products article{display:grid;gap:.25rem}.preview-products article div{height:7rem;background:linear-gradient(135deg,var(--preview-paper),color-mix(in srgb,var(--preview-accent) 35%,white));border-radius:.4rem}.preview-products small{font:.5rem 'DM Mono',monospace;color:#777}.preview-products strong{font:700 .75rem 'Noto Serif TC',serif}.preview-products span{font-size:.62rem}
.preview-ai { position:absolute;right:1.2rem;bottom:1.2rem;display:grid;grid-template-columns:1.5rem 1fr;column-gap:.4rem;align-items:center;border:0;border-radius:1rem;background:var(--preview-primary);color:var(--preview-paper);padding:.65rem .85rem;box-shadow:0 .6rem 2rem rgba(0,0,0,.2);text-align:left}.preview-ai span{grid-row:span 2;font-size:1rem}.preview-ai b{font-size:.64rem}.preview-ai small{font-size:.52rem;opacity:.68}
.generation-mask { position:absolute;inset:0;z-index:3;display:grid;place-content:center;justify-items:center;gap:1rem;background:color-mix(in srgb,var(--preview-paper) 88%,transparent);backdrop-filter:blur(5px)}.generation-mask span{width:2.2rem;height:2.2rem;border:3px solid rgba(49,91,214,.15);border-top-color:#315bd6;border-radius:50%;animation:spin .75s linear infinite}.generation-mask p{font-size:.72rem;font-weight:700}.is-generating .generated-site{transform:scale(.99)}@keyframes spin{to{transform:rotate(360deg)}}
.site-stage.is-mobile .generated-nav nav,.site-stage.is-mobile .generated-hero::after{display:none}.site-stage.is-mobile .generated-hero>*{max-width:100%}.site-stage.is-mobile .trust-strip{padding:1rem}.site-stage.is-mobile .preview-editorial{grid-template-columns:1fr;padding:1.4rem}.site-stage.is-mobile .preview-products{grid-template-columns:1fr}.site-stage.is-mobile .preview-products article:nth-child(n+2){display:none}
.preview-evidence { padding:1rem 1.2rem; border:1px solid #d6d3cc; border-radius:0 0 .8rem .8rem; background:#f8f8f6; display:flex; align-items:center; gap:1rem; }.preview-evidence>span{font-size:.66rem;font-weight:800}.preview-evidence ul{display:flex;flex-wrap:wrap;gap:.35rem;margin:0;padding:0;list-style:none}.preview-evidence li{background:#e8ebf5;color:#34436e;padding:.3rem .55rem;border-radius:999px;font-size:.58rem}
.launch-config { max-width:88rem; margin:clamp(3rem,7vw,7rem) auto 0; }
.launch-config>header { display:grid;grid-template-columns:1fr 1fr;gap:1rem 3rem;align-items:end;margin-bottom:2rem}.launch-config>header p{grid-column:1/-1;color:#315bd6;font:600 .68rem 'DM Mono',monospace;letter-spacing:.12em}.launch-config>header h2{font:700 clamp(2rem,4vw,4rem)/1.05 'Noto Serif TC',serif}.launch-config>header span{color:#69665f;font-size:.85rem}
.launch-grid { display:grid;grid-template-columns:1fr .9fr .8fr;gap:1rem;align-items:start}.plan-panel,.domain-panel,.order-card{background:#fff;border:1px solid #ded9cf;border-radius:1rem;padding:1.4rem}.plan-panel h3,.domain-panel h3{margin:0 0 1rem;font:700 1.15rem 'Noto Serif TC',serif}.plan-panel>button{width:100%;display:flex;justify-content:space-between;gap:1rem;text-align:left;background:#fff;border:1px solid #e2ded5;border-radius:.7rem;padding:.8rem;margin-top:.55rem;cursor:pointer}.plan-panel>button span{display:grid;gap:.25rem}.plan-panel>button b{font-size:.8rem}.plan-panel>button small{color:#77736b;font-size:.65rem;line-height:1.5}.plan-panel>button>strong{font-size:.67rem;white-space:nowrap}.plan-panel>button.active{border-color:#315bd6;background:#f0f3ff;box-shadow:inset 0 0 0 1px #315bd6}
.cadence-control{margin-top:1.2rem}.cadence-control>span{font-size:.7rem;font-weight:800}.cadence-control>div{display:flex;gap:.35rem;margin-top:.55rem}.cadence-control button{flex:1;border:1px solid #ddd8ce;background:#fff;border-radius:.5rem;padding:.5rem .2rem;font-size:.62rem;cursor:pointer}.cadence-control button.active{background:#17233b;color:#fff;border-color:#17233b}
.domain-panel label{font-size:.7rem;font-weight:800}.domain-panel label div{display:flex;margin-top:.5rem}.domain-panel input{min-width:0;flex:1;border:1px solid #ddd8ce;border-radius:.55rem 0 0 .55rem;padding:.72rem;font:500 .75rem 'DM Mono',monospace}.domain-panel label button{border:0;background:#17233b;color:#fff;padding:0 .8rem;border-radius:0 .55rem .55rem 0;font-size:.65rem}.domain-result{margin-top:.7rem;color:#24744e;font-size:.68rem}.domain-result span{font-size:.55rem}.domain-panel ul{padding:1rem 0 0 1rem;margin:1rem 0 0;border-top:1px solid #ebe7df}.domain-panel li{padding:.3rem 0;font-size:.7rem}
.order-card{background:#17233b;color:#fff;box-shadow:0 1rem 3rem rgba(23,35,59,.18)}.order-card>p{color:#8fa7ef;font:600 .6rem 'DM Mono',monospace;letter-spacing:.1em}.order-card h3{font:700 1.4rem 'Noto Serif TC',serif;margin:.7rem 0 1.2rem}.order-card>div:not(.order-total):not(.order-monthly){display:flex;justify-content:space-between;padding:.5rem 0;color:#d4d8e0;font-size:.7rem}.order-card ul{display:flex;flex-wrap:wrap;gap:.3rem;padding:0;margin:.8rem 0;list-style:none}.order-card li{background:rgba(255,255,255,.1);border-radius:999px;padding:.25rem .5rem;font-size:.58rem}.order-total,.order-monthly{border-top:1px solid rgba(255,255,255,.18);display:grid!important;gap:.25rem;padding-top:1rem!important;margin-top:.8rem}.order-total span,.order-monthly span{font-size:.6rem;color:#9da6b7}.order-total strong{font-size:1.25rem}.order-monthly strong{color:#a9bbf2;font-size:.9rem}.order-card>button{width:100%;display:flex;justify-content:space-between;margin-top:1.2rem;border:0;border-radius:.65rem;padding:.85rem;background:#ff7a59;color:#fff;font-weight:800;cursor:pointer}.order-card>small{display:block;margin-top:.7rem;color:#9da6b7;line-height:1.5;font-size:.57rem}
.handoff-backdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:1rem;background:rgba(15,20,30,.72);backdrop-filter:blur(8px)}.handoff-dialog{position:relative;width:min(42rem,100%);background:#f8f4eb;border-radius:1.2rem;padding:clamp(1.5rem,5vw,3.5rem);box-shadow:0 2rem 7rem rgba(0,0,0,.35)}.close-dialog{position:absolute;right:1rem;top:1rem;border:0;background:transparent;font-size:1.5rem;cursor:pointer}.handoff-dialog>p:first-of-type{color:#315bd6;font:600 .65rem 'DM Mono',monospace;letter-spacing:.1em}.handoff-dialog h2{font:700 clamp(1.8rem,4vw,3rem)/1.15 'Noto Serif TC',serif;margin:.8rem 0 1.2rem}.handoff-dialog>p:last-of-type{color:#666159;line-height:1.8;font-size:.85rem}.handoff-path{display:flex;align-items:center;gap:.5rem;margin:1.2rem 0;padding:1rem;background:#ebe6db;border-radius:.7rem;overflow:auto}.handoff-path span{white-space:nowrap;font-size:.7rem;font-weight:800}.handoff-path i{font-style:normal;color:#315bd6}.handoff-dialog>button:last-child{margin-top:1.5rem;border:0;border-radius:.6rem;background:#17233b;color:#fff;padding:.8rem 1rem;font-weight:800;cursor:pointer}
@media(max-width:72rem){.builder-shell{grid-template-columns:1fr}.builder-controls{border-right:0;border-bottom:1px solid #e5e2da}.launch-grid{grid-template-columns:1fr 1fr}.order-card{grid-column:1/-1}.concept-intro{grid-template-columns:1fr}.concept-intro>p{max-width:46rem}}
@media(max-width:44rem){.concept-builder{padding-inline:.75rem}.concept-intro h1{font-size:2.55rem}.entry-tabs,.diagnosis-form,.diagnosis-comparison{grid-template-columns:1fr}.comparison-arrow{transform:rotate(90deg);justify-self:center}.site-types{grid-template-columns:1fr}.module-grid{grid-template-columns:1fr}.preview-column{padding:.45rem}.preview-toolbar{grid-template-columns:1fr 2fr}.window-dots{display:none}.site-stage{min-height:32rem}.generated-nav nav{display:none}.generated-hero>*{max-width:100%}.generated-hero::after{opacity:.22}.trust-strip{padding:1rem}.preview-editorial{grid-template-columns:1fr;padding:1.2rem}.preview-evidence{align-items:flex-start;flex-direction:column}.launch-config>header,.launch-grid{grid-template-columns:1fr}.order-card{grid-column:auto}.handoff-path{align-items:flex-start;flex-direction:column}.handoff-path i{transform:rotate(90deg)}}
</style>
