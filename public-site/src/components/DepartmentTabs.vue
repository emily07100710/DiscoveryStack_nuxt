<script setup lang="ts">
import { computed, defineProps, ref } from 'vue'

const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const isZh = computed(() => props.locale === 'zh-hant')
const departments = computed(() => isZh.value
  ? [
      { number: '01', name: '行銷部', english: 'Growth Strategy', promise: '讓每一分預算，都把對的人推向下一步。', services: ['品牌定位與市場研究', '整體行銷策略與轉換漏斗', '廣告、社群與內容行銷', '數據追蹤與轉換優化'] },
      { number: '02', name: '網站設計部', english: 'Brand Experience', promise: '讓網站不只好看，也能讓人理解並行動。', services: ['企業官網與品牌網站', '電商、預約與會員網站', 'Landing Page 與銷售頁', 'UX／UI、改版與維護'] },
      { number: '03', name: '系統規劃部', english: 'Digital Systems', promise: '把資料與流程接起來，讓訂單不再卡在人工交接。', services: ['CRM、CMS 與管理後台', '資料庫、API 與第三方串接', '自動化工作流程', '企業客製系統'] },
      { number: '04', name: 'AI 導入部', english: 'AI Applications', promise: '把 AI 放進真正能省時間、提高品質的工作。', services: ['官網 Chatbot 與知識庫', 'AI 助理與流程自動化', 'RAG、LLM 與系統整合', '機器學習與客製模型'] },
      { number: '05', name: 'SEO／GEO 部', english: 'Search Growth', promise: '讓搜尋找得到你，也讓 AI 有理由引用你。', services: ['技術 SEO 與網站結構', '內容、實體與 Schema', 'GEO／AEO 與 AI 搜尋', '排名、引用與流量監測'] },
    ]
  : [
      { number: '01', name: 'Marketing', english: 'Growth Strategy', promise: 'Not more activity for its own sake—a decision about who each dollar should move, and where.', services: ['Positioning and market research', 'Marketing strategy and funnels', 'Paid, social and content', 'Tracking and conversion optimisation'] },
      { number: '02', name: 'Web Design', english: 'Brand Experience', promise: 'Not just a better-looking site, but a brand entry point built to be found, understood and acted on.', services: ['Corporate and brand websites', 'Commerce, booking and membership', 'Landing and sales pages', 'UX/UI, redesign and care'] },
      { number: '03', name: 'Systems', english: 'Digital Systems', promise: 'Connect fragmented data, workflows and tools so growth no longer depends on manual hand-offs.', services: ['CRM, CMS and operations', 'Database, API and integrations', 'Workflow automation', 'Custom business systems'] },
      { number: '04', name: 'AI Adoption', english: 'AI Applications', promise: 'More than attaching a generic chat tool—we place AI inside the work that genuinely needs acceleration.', services: ['Website chatbot and knowledge base', 'AI assistants and automation', 'RAG, LLM and system integration', 'Machine learning and custom models'] },
      { number: '05', name: 'SEO / GEO', english: 'Search Growth', promise: 'Make the site discoverable to search engines and worth citing for answer engines.', services: ['Technical SEO and architecture', 'Content, entities and schema', 'GEO/AEO and AI search', 'Ranking, citation and traffic tracking'] },
    ])
const activeDepartmentIndex = ref(0)
</script>

<template>
  <div class="department-system">
    <div class="department-tabs" role="tablist" :aria-label="isZh ? '選擇專業部門' : 'Choose a specialist department'">
      <button v-for="(department, index) in departments" :id="`department-tab-${index}`" :key="department.number" type="button" role="tab" :aria-selected="activeDepartmentIndex === index" :aria-controls="`department-panel-${index}`" :class="{ 'is-active': activeDepartmentIndex === index }" @click="activeDepartmentIndex = index" @mouseenter="activeDepartmentIndex = index" @focus="activeDepartmentIndex = index">
        <span>{{ department.number }}</span><strong>{{ department.name }}</strong><small>{{ department.english }}</small>
      </button>
    </div>
    <article :key="departments[activeDepartmentIndex]?.number" :id="`department-panel-${activeDepartmentIndex}`" class="department-panel" role="tabpanel" :aria-labelledby="`department-tab-${activeDepartmentIndex}`">
      <p class="department-code">{{ departments[activeDepartmentIndex]?.number }} / {{ departments[activeDepartmentIndex]?.english }}</p>
      <h3>{{ departments[activeDepartmentIndex]?.promise }}</h3>
      <ul><li v-for="service in departments[activeDepartmentIndex]?.services" :key="service">{{ service }}</li></ul>
    </article>
  </div>
</template>
