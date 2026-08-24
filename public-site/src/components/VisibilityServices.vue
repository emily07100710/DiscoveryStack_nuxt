<script setup lang="ts">
import { computed, defineProps, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const isZh = computed(() => props.locale === 'zh-hant')
const visibilityServices = computed(() => isZh.value
  ? [
      { num: '01', tag: 'Discover', title: '先知道市場正在問什麼。', body: '盤點品牌、品類、競品與高意圖問題，建立提示詞地圖與搜尋需求地圖；不是拿一張關鍵字表就開始寫文章。', output: '交付：需求地圖／競品差距／AI 能見度基準' },
      { num: '02', tag: 'Structure', title: '讓網站成為機器讀得懂的事實來源。', body: '整理抓取、索引、網站架構、內部連結、Schema 與品牌實體，讓搜尋引擎和答案引擎能辨認你是誰、做什麼、憑什麼。', output: '交付：技術稽核／實體架構／Schema 規格' },
      { num: '03', tag: 'Answer', title: '把專業變成可以被引用的答案。', body: '重整服務頁、比較頁、FAQ、案例與知識內容，補上明確主張、來源、作者與更新紀錄，讓內容既能說服人，也方便 AI 正確擷取。', output: '交付：內容藍圖／答案模組／編輯規範' },
      { num: '04', tag: 'Authority', title: '只在自己網站說自己好，還不夠。', body: '建立一致的品牌資料、評論、媒體與產業引用訊號，修正網路上互相矛盾的資訊，讓答案背後有可交叉驗證的證據。', output: '交付：權威訊號清單／外部資料修正／數位公關方向' },
      { num: '05', tag: 'Measure', title: '不只看排名，也看誰正在引用你。', body: '持續追蹤 Google 搜尋、AI Overview、ChatGPT、Gemini、Perplexity 等環境中的提示詞覆蓋、品牌描述、引用來源與競品差距。', output: '交付：排名與引用監測／月度變化／優化優先序' },
      { num: '06', tag: 'Convert', title: '被看見之後，必須接得住訂單。', body: '把高意圖流量接到對的頁面、表單、AI QA、CRM 與真人跟進，讓行銷部、網站部、系統部和 AI 部共同對轉換負責。', output: '交付：轉換路徑／追蹤事件／跨部門執行清單' },
    ]
  : [
      { num: '01', tag: 'Discover', title: 'Start with what the market is actually asking.', body: 'Map brand, category, competitor and high-intent questions into a prompt and demand landscape—not a keyword spreadsheet without context.', output: 'Deliverables: demand map / competitor gaps / AI visibility baseline' },
      { num: '02', tag: 'Structure', title: 'Turn the site into a machine-readable source of truth.', body: 'Fix crawl, indexation, architecture, internal links, schema and entities so search and answer engines can identify who you are and why you are credible.', output: 'Deliverables: technical audit / entity architecture / schema specification' },
      { num: '03', tag: 'Answer', title: 'Make expertise quotable.', body: 'Restructure services, comparisons, FAQs, cases and knowledge content with clear claims, sources, authors and update history.', output: 'Deliverables: content blueprint / answer modules / editorial rules' },
      { num: '04', tag: 'Authority', title: 'Your own website cannot be the only proof.', body: 'Build consistent brand data, reviews, media and industry references while correcting conflicting information across the web.', output: 'Deliverables: authority signal plan / data corrections / digital PR direction' },
      { num: '05', tag: 'Measure', title: 'Track who cites you—not rankings alone.', body: 'Monitor prompt coverage, brand descriptions, citations and competitor gaps across Google, AI Overviews, ChatGPT, Gemini and Perplexity.', output: 'Deliverables: rank and citation tracking / monthly shifts / priorities' },
      { num: '06', tag: 'Convert', title: 'Visibility still has to become revenue.', body: 'Connect intent to the right page, form, AI QA, CRM and human follow-up so every department shares responsibility for conversion.', output: 'Deliverables: conversion route / tracked events / cross-team execution plan' },
    ])
const activeVisibilityIndex = ref(0)
let visibilityObserver: IntersectionObserver | undefined
onMounted(() => {
  if (!('IntersectionObserver' in window)) return
  const visibilitySteps = Array.from(document.querySelectorAll<HTMLElement>('.visibility-step'))
  visibilityObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
    if (visible) activeVisibilityIndex.value = Number((visible.target as HTMLElement).dataset.visibilityIndex || 0)
  }, { rootMargin: '-28% 0px -42% 0px', threshold: [0, .25, .6] })
  visibilitySteps.forEach(step => visibilityObserver?.observe(step))
})
onBeforeUnmount(() => visibilityObserver?.disconnect())
</script>

<template>
  <section class="section visibility-system" id="seo-geo">
    <div class="shell"><div class="section-head reveal"><p class="eyebrow">{{ isZh ? 'SEO／GEO／AEO · 從問題到訂單' : 'SEO / GEO / AEO · Question to revenue' }}</p><h2>{{ isZh ? '當客戶問 AI，你要成為答案，不是遺漏。' : 'When customers ask AI, become the answer—not the omission.' }}</h2></div><div class="visibility-grid"><aside class="visibility-stage" aria-live="polite"><p class="visibility-stage-label">{{ isZh ? '目前處理階段' : 'Current layer' }} / {{ visibilityServices[activeVisibilityIndex]?.num }}</p><div class="visibility-query"><span>{{ visibilityServices[activeVisibilityIndex]?.tag }}</span><strong>{{ visibilityServices[activeVisibilityIndex]?.title }}</strong></div><div class="visibility-output"><span>{{ isZh ? '可檢查的成果' : 'Inspectable output' }}</span><p>{{ visibilityServices[activeVisibilityIndex]?.output }}</p></div><div class="visibility-progress" aria-hidden="true"><i :style="{ width: `${((activeVisibilityIndex + 1) / visibilityServices.length) * 100}%` }"></i></div><p class="visibility-count">0{{ activeVisibilityIndex + 1 }} <span>/ 0{{ visibilityServices.length }}</span></p></aside><div class="visibility-steps"><article v-for="(service, index) in visibilityServices" :key="service.num" class="visibility-step" :class="{ 'is-active': activeVisibilityIndex === index }" :data-visibility-index="index"><p><span>{{ service.num }}</span>{{ service.tag }}</p><h3>{{ service.title }}</h3><p>{{ service.body }}</p><small>{{ service.output }}</small></article></div></div></div>
  </section>
</template>
