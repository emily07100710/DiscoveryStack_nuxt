<script setup lang="ts">
const route = useRoute()
const isZh = computed(() => route.path.startsWith('/zh-hant'))
const title = () => isZh.value ? '隱私與資料使用說明' : 'Privacy and data use'
const description = () => isZh.value ? 'DiscoveryStack 官網表單、Cookie、網站快檢與模型改善同意的資料使用邊界。' : 'How DiscoveryStack handles website forms, cookies, public-site checks and optional model-improvement consent.'
usePageSeo({ title, description })
</script>

<template>
  <article class="privacy-page">
    <header><p class="eyebrow">{{ isZh ? 'PRIVACY / CLEAR BOUNDARIES' : 'PRIVACY / CLEAR BOUNDARIES' }}</p><h1>{{ title() }}</h1><p>{{ description() }}</p></header>
    <div class="privacy-grid">
      <section><span>01</span><h2>{{ isZh ? '你主動留下的資料' : 'Information you submit' }}</h2><p>{{ isZh ? '合作諮詢、AI QA 與完整報告表單可能收集姓名、工作 Email、公司、網站及你主動填寫的合作背景，用於回覆本次要求。' : 'Fit-review, AI QA and report forms may collect your name, work email, company, website and context you choose to provide so we can respond to the request.' }}</p></section>
      <section><span>02</span><h2>{{ isZh ? '公開網站快檢' : 'Public website check' }}</h2><p>{{ isZh ? '快檢只讀取你輸入網址的公開首頁，暫時分析標題、H1、canonical、結構化資料、導覽與行動入口等結構訊號。不保存原始 HTML，也不會取得網站後台、流量或訂單。' : 'The check reads only the public homepage at the URL you enter and temporarily inspects structural signals such as title, H1, canonical, structured data, navigation and calls to action. It does not retain raw HTML or access private analytics, orders or back-office systems.' }}</p></section>
      <section><span>03</span><h2>{{ isZh ? '兩種同意分開處理' : 'Separate permissions' }}</h2><p>{{ isZh ? '回覆本次詢問所需的資料處理同意、後續行銷聯絡同意，以及模型改善同意是三件不同的事。選填的模型改善方框預設不勾，不影響你取得報告或提出諮詢。' : 'Permission to process an enquiry, permission for later marketing contact and optional model-improvement consent are separate. The model-improvement box is off by default and does not affect access to the report or enquiry.' }}</p></section>
      <section><span>04</span><h2>{{ isZh ? '模型改善如何運作' : 'How model improvement works' }}</h2><p>{{ isZh ? '你另外同意後，後台可能定期重新檢查所填網站的公開首頁，只保存去識別化的結構訊號與雜湊，不保存原始 HTML；姓名、Email、電話、預算與自由填寫內容不會進入訓練。每筆標籤及資料集仍需 owner 人工核准，同意撤回後會退出後續資料集，模型也不會自動部署到網站。' : 'After separate opt-in, the private pipeline may periodically recheck the submitted site’s public homepage and retain only de-identified structural signals and hashes, not raw HTML. Names, email addresses, phone numbers, budgets and free-form enquiry text do not enter training. Every label and dataset still requires owner approval; withdrawal removes the candidate from future datasets, and models are never deployed to the site automatically.' }}</p></section>
      <section><span>05</span><h2>Cookie</h2><p>{{ isZh ? '必要 Cookie 用於安全、登入及記住 Cookie 選擇。目前沒有啟用第三方分析追蹤；若未來啟用，必須先取得你的分析 Cookie 同意。' : 'Necessary cookies support security, sign-in and remembering your cookie choice. No third-party analytics are currently active; if they are added later, analytics consent must be obtained first.' }}</p></section>
      <section><span>06</span><h2>{{ isZh ? '查詢、更正或刪除' : 'Access, correction or deletion' }}</h2><p>{{ isZh ? '如需查詢、更正、刪除資料或撤回選填同意，請透過合作諮詢表單提出，並使用當初留下的工作 Email 供我們核對。' : 'To request access, correction, deletion or withdrawal of optional consent, use the fit-review form and provide the same work email so we can verify the request.' }}</p><NuxtLink :to="`${isZh ? '/zh-hant' : '/en'}#fit`">{{ isZh ? '提出資料請求' : 'Make a data request' }} →</NuxtLink></section>
    </div>
  </article>
</template>

<style scoped>
.privacy-page{padding:clamp(8rem,14vw,12rem) max(1.25rem,calc((100vw - 76rem)/2));background:var(--paper);color:var(--ink)}.privacy-page>header{display:grid;grid-template-columns:minmax(10rem,.4fr) minmax(0,1fr);gap:1rem clamp(2rem,7vw,7rem);padding-bottom:clamp(3rem,7vw,6rem);border-bottom:1px solid var(--line)}.privacy-page h1{font-size:clamp(2.7rem,7vw,6.5rem);line-height:.98}.privacy-page>header>p:last-child{grid-column:2;max-width:46rem;color:var(--ink-mid)}.privacy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.privacy-grid section{min-height:18rem;padding:clamp(1.5rem,4vw,3rem);border-bottom:1px solid var(--line)}.privacy-grid section:nth-child(odd){border-right:1px solid var(--line)}.privacy-grid span{color:var(--cobalt);font:500 .7rem/1.2 var(--font-mono)}.privacy-grid h2{margin:2rem 0 1rem;font-size:clamp(1.5rem,3vw,2.3rem)}.privacy-grid p{max-width:44rem;color:var(--ink-mid);line-height:1.8}.privacy-grid a{display:inline-block;margin-top:1rem;color:var(--cobalt)}@media(max-width:44rem){.privacy-page>header,.privacy-grid{grid-template-columns:1fr}.privacy-page>header>p:last-child{grid-column:auto}.privacy-grid section:nth-child(odd){border-right:0}}
</style>
