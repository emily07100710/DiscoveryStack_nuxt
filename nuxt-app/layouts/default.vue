<!-- Quiet Intelligence: restrained editorial frame, clear navigation and no inaccessible visual-only content. -->
<script setup lang="ts">
const route = useRoute()
const isZh = computed(() => route.path.startsWith('/zh-hant'))
const htmlLang = computed(() => isZh.value ? 'zh-Hant' : 'en-US')

useHead({
  htmlAttrs: { lang: htmlLang, dir: 'ltr' },
})
</script>

<template>
  <a class="skip-link" href="#main-content">{{ isZh ? '跳至主要內容' : 'Skip to content' }}</a>
  <div class="site-shell">
    <header class="site-header">
      <NuxtLink :to="isZh ? '/zh-hant' : '/en'" class="brand" aria-label="DiscoveryStack home">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>DISCOVERYSTACK</span>
      </NuxtLink>
      <nav class="site-nav" :aria-label="isZh ? '主要導覽' : 'Primary navigation'">
        <NuxtLink :to="isZh ? '/zh-hant' : '/en'">{{ isZh ? '首頁' : 'Home' }}</NuxtLink>
        <NuxtLink :to="isZh ? '/zh-hant/methodology/journey-intelligence' : '/en/methodology/journey-intelligence'">{{ isZh ? '方法' : 'Approach' }}</NuxtLink>
        <NuxtLink :to="isZh ? '/zh-hant/methodology/bounded-ai-assistant' : '/en/methodology/bounded-ai-assistant'">AI QA</NuxtLink>
      </nav>
      <NuxtLink class="locale-switch" :to="isZh ? '/en' : '/zh-hant'" :aria-label="isZh ? 'Switch to English' : '切換至繁體中文'">{{ isZh ? 'EN' : '繁' }}</NuxtLink>
    </header>
    <main id="main-content"><slot /></main>
    <footer class="site-footer">
      <span>© {{ new Date().getFullYear() }} DiscoveryStack</span>
      <span>{{ isZh ? '需求不是消失；它在路徑裡失去推進力。' : 'Demand does not vanish. It loses momentum on the route.' }}</span>
    </footer>
  </div>
</template>
