<!-- Quiet Intelligence: restrained editorial frame, clear navigation and no inaccessible visual-only content. -->
<script setup lang="ts">
const route = useRoute()
const isPrivateOwnerRoute = computed(() => route.path === '/audit-lab' || route.path === '/ml-lab-preview')
const isZh = computed(() => isPrivateOwnerRoute.value || route.path.startsWith('/zh-hant'))
const htmlLang = computed(() => isZh.value ? 'zh-Hant' : 'en-US')

useHead({
  htmlAttrs: { lang: htmlLang, dir: 'ltr' },
})

// 導覽選單狀態
const navOpen = ref(false)
const toggleNav = () => { navOpen.value = !navOpen.value }

// 頁首 sticky 狀態
const headerStuck = ref(false)
onMounted(() => {
  let ticking = false
  const onScroll = () => {
    headerStuck.value = window.scrollY > 12
    ticking = false
  }
  window.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true
      requestAnimationFrame(onScroll)
    }
  }, { passive: true })
  onScroll()
})
</script>

<template>
  <div class="route-rail" aria-hidden="true"></div>
  
  <header class="site-header" :class="{ 'is-stuck': headerStuck }" id="siteHeader">
    <div class="shell header-inner">
      <NuxtLink :to="isZh ? '/zh-hant' : '/en'" class="brand">
        DISCOVERYSTACK<span>.</span>
      </NuxtLink>
      <nav class="site-nav" :class="{ 'is-open': navOpen }" id="siteNav" :aria-label="isZh ? '主要導覽' : 'Primary navigation'">
        <NuxtLink :to="`${isZh ? '/zh-hant' : '/en'}#departments`" @click="navOpen = false">{{ isZh ? '五個部門' : 'Departments' }}</NuxtLink>
        <NuxtLink :to="`${isZh ? '/zh-hant' : '/en'}#analysis`" @click="navOpen = false">{{ isZh ? '免費分析' : 'Free analysis' }}</NuxtLink>
        <NuxtLink :to="`${isZh ? '/zh-hant' : '/en'}#journey`" @click="navOpen = false">{{ isZh ? '合作流程' : 'Process' }}</NuxtLink>
        <NuxtLink :to="isZh ? '/zh-hant/services/seo-geo-growth-system' : '/en/services/seo-geo-growth-system'" @click="navOpen = false">SEO／GEO</NuxtLink>
        <NuxtLink :to="`${isZh ? '/zh-hant' : '/en'}#fit`" @click="navOpen = false">{{ isZh ? '合作諮詢' : 'Fit Review' }}</NuxtLink>
      </nav>
      <div style="display:flex; align-items:center; gap:0.75rem;">
        <NuxtLink class="lang-switch" :to="isZh ? '/en' : '/zh-hant'" :aria-label="isZh ? 'Switch to English' : '切換至繁體中文'">{{ isZh ? 'EN' : '繁' }}</NuxtLink>
        <button class="nav-toggle" id="navToggle" :aria-expanded="navOpen" aria-controls="siteNav" @click="toggleNav">
          {{ navOpen ? (isZh ? '關閉' : 'Close') : (isZh ? '選單' : 'Menu') }}
        </button>
      </div>
    </div>
  </header>

  <main id="top"><slot /></main>

  <footer class="site-footer">
    <div class="shell">
      <p class="footer-statement">{{ isZh ? '需求不是消失；它在路徑裡失去推進力。' : 'Demand does not vanish. It loses momentum on the route.' }}</p>

      <div class="footer-cols">
        <div class="footer-col">
          <h3>{{ isZh ? '服務' : 'Services' }}</h3>
          <ul>
            <li><NuxtLink :to="isZh ? '/zh-hant/services/seo-geo-growth-system' : '/en/services/seo-geo-growth-system'">{{ isZh ? 'SEO／GEO 成長系統' : 'SEO/GEO Growth System' }}</NuxtLink></li>
            <li><NuxtLink :to="`${isZh ? '/zh-hant' : '/en'}#fit`">{{ isZh ? '需求路徑診斷' : 'Demand Path Diagnosis' }}</NuxtLink></li>
          </ul>
        </div>
        <div class="footer-col">
          <h3>{{ isZh ? '方法' : 'Methodology' }}</h3>
          <ul>
            <li><NuxtLink :to="isZh ? '/zh-hant/methodology/journey-intelligence' : '/en/methodology/journey-intelligence'">{{ isZh ? '需求路徑情報' : 'Journey Intelligence' }}</NuxtLink></li>
            <li><NuxtLink :to="isZh ? '/zh-hant/methodology/bounded-ai-assistant' : '/en/methodology/bounded-ai-assistant'">{{ isZh ? '有邊界的 AI 助理' : 'Bounded AI Assistant' }}</NuxtLink></li>
          </ul>
        </div>
        <div class="footer-col">
          <h3>{{ isZh ? '詞彙' : 'Glossary' }}</h3>
          <ul>
            <li><NuxtLink :to="isZh ? '/zh-hant/glossary/seo' : '/en/glossary/seo'">SEO</NuxtLink></li>
            <li><NuxtLink :to="isZh ? '/zh-hant/glossary/geo' : '/en/glossary/geo'">GEO</NuxtLink></li>
            <li><NuxtLink :to="isZh ? '/zh-hant/glossary/journey-intelligence' : '/en/glossary/journey-intelligence'">{{ isZh ? '需求路徑情報' : 'Journey Intelligence' }}</NuxtLink></li>
          </ul>
        </div>
        <div class="footer-col">
          <h3>{{ isZh ? '出版品' : 'Publications' }}</h3>
          <ul>
            <li><NuxtLink :to="isZh ? '/zh-hant/publications/what-a-public-website-can-tell-you' : '/en/publications/what-a-public-website-can-tell-you'">{{ isZh ? '一個公開網站能告訴你什麼' : 'What a Public Website Can Tell You' }}</NuxtLink></li>
          </ul>
        </div>
      </div>

      <div class="footer-base">
        <span>© {{ new Date().getFullYear() }} DiscoveryStack</span>
        <span>{{ isZh ? '繁體中文' : 'English' }} · {{ isZh ? 'English' : '繁體中文' }}</span>
      </div>
    </div>
  </footer>
</template>
