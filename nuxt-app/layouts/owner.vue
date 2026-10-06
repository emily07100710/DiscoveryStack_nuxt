<script setup lang="ts">
const config = useRuntimeConfig()
const publicSiteOrigin = String(config.public.discoveryStackPublicSiteOrigin || 'https://www.example.com').replace(/\/$/, '')
const route = useRoute()
const navigationOpen = ref(false)
watch(() => route.path, () => { navigationOpen.value = false })
const activeSection = computed(() => route.path === '/audit-lab/learning-loop' ? 'learning-loop' : route.path === '/audit-lab/site-evidence' ? 'site-evidence' : route.path === '/audit-lab/system-factory' ? 'system-factory' : route.path === '/audit-lab/geo' ? 'geo' : route.path === '/audit-lab/geo-outcome-model' ? 'geo-outcome-model' : route.path === '/audit-lab/seo-geo' ? 'core' : route.path === '/audit-lab/llm-visibility' ? 'visibility' : route.path === '/audit-lab/weekly-content' ? 'weekly-content' : route.path === '/audit-lab/content-operations' ? 'content-operations' : route.path === '/audit-lab/measurement-operations' ? 'measurement' : route.path === '/audit-lab/interventions' ? 'interventions' : route.path === '/audit-lab/managed-sites' ? 'managed-sites' : 'audit')
useHead({ htmlAttrs: { lang: 'zh-Hant', dir: 'ltr' } })
</script>

<template>
  <div class="owner-layout">
    <header class="owner-layout__header">
      <NuxtLink class="owner-layout__brand" to="/audit-lab" aria-label="DiscoveryStack 私有稽核實驗室首頁">DISCOVERYSTACK<span>.</span><small>PRIVATE WORKBENCH</small></NuxtLink>
      <a class="owner-layout__exit" :href="`${publicSiteOrigin}/zh-hant`">返回公開網站 <span aria-hidden="true">↗</span></a>
      <button class="owner-layout__menu-toggle" type="button" aria-controls="owner-workbench-navigation" :aria-expanded="navigationOpen" @click="navigationOpen = !navigationOpen">{{ navigationOpen ? '收合導覽' : '展開導覽' }}</button>
      <nav id="owner-workbench-navigation" class="owner-layout__nav" :class="{ 'is-open': navigationOpen }" aria-label="私有工作台導覽">
        <NuxtLink to="/audit-lab" :aria-current="activeSection === 'audit' ? 'page' : undefined">Audit Lab</NuxtLink>
        <NuxtLink to="/audit-lab/geo" :aria-current="activeSection === 'geo' ? 'page' : undefined">GEO Workbench</NuxtLink>
        <NuxtLink to="/audit-lab/geo-outcome-model" :aria-current="activeSection === 'geo-outcome-model' ? 'page' : undefined">GEO 模型</NuxtLink>
        <NuxtLink to="/audit-lab/learning-loop" :aria-current="route.path === '/audit-lab/learning-loop' ? 'page' : undefined">學習閉環</NuxtLink>
        <NuxtLink to="/audit-lab/seo-geo" :aria-current="activeSection === 'core' ? 'page' : undefined">SEO / GEO Core</NuxtLink>
        <NuxtLink to="/audit-lab/llm-visibility" :aria-current="activeSection === 'visibility' ? 'page' : undefined">LLM Visibility</NuxtLink>
        <NuxtLink to="/audit-lab/site-evidence" :aria-current="activeSection === 'site-evidence' ? 'page' : undefined">站台證據</NuxtLink>
        <NuxtLink to="/audit-lab/content-operations" :aria-current="activeSection === 'content-operations' ? 'page' : undefined">內容營運</NuxtLink>
        <NuxtLink to="/audit-lab/weekly-content" :aria-current="activeSection === 'weekly-content' ? 'page' : undefined">每週文章送審</NuxtLink>
        <NuxtLink to="/audit-lab/measurement-operations" :aria-current="activeSection === 'measurement' ? 'page' : undefined">成效測量</NuxtLink>
        <NuxtLink to="/audit-lab/interventions" :aria-current="activeSection === 'interventions' ? 'page' : undefined">改動追蹤</NuxtLink>
        <NuxtLink to="/audit-lab/managed-sites" :aria-current="activeSection === 'managed-sites' ? 'page' : undefined">Managed Sites</NuxtLink>
        <NuxtLink to="/audit-lab/system-factory" :aria-current="activeSection === 'system-factory' ? 'page' : undefined">系統工廠</NuxtLink>
      </nav>
    </header>
    <main id="owner-workbench"><slot /></main>
  </div>
</template>

<style scoped>
.owner-layout { min-height:100vh; background:#101319; color:#eff3f7; }.owner-layout__header { position:sticky; top:0; z-index:30; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:.8rem 1rem; padding:.75rem clamp(1rem,4vw,4rem); border-bottom:1px solid rgba(230,238,246,.13); background:rgba(16,19,25,.94); backdrop-filter:blur(16px); }.owner-layout__brand,.owner-layout__exit,.owner-layout__nav a { color:inherit; text-decoration:none; }.owner-layout__brand { display:inline-flex; align-items:baseline; gap:.32rem; width:max-content; max-width:100%; color:#fff; font-size:.83rem; font-weight:800; letter-spacing:.11em; }.owner-layout__brand span { color:#8eb7ec; }.owner-layout__brand small { color:#aeb9c5; font-size:.55rem; letter-spacing:.1em; }.owner-layout__nav { grid-column:1/-1; display:flex; flex-wrap:wrap; justify-content:center; gap:.35rem; padding:.35rem; border:1px solid rgba(230,238,246,.12); border-radius:16px; }.owner-layout__nav a,.owner-layout__exit { display:inline-flex; align-items:center; justify-content:center; min-width:0; padding:.55rem .7rem; border-radius:999px; color:#b9c3ce; font-size:.72rem; font-weight:700; line-height:1.35; text-align:center; overflow-wrap:anywhere; }.owner-layout__nav a[aria-current='page'],.owner-layout__nav a:hover,.owner-layout__nav a:focus-visible { color:#111820; background:#dce9f6; outline:none; }.owner-layout__exit { justify-self:end; border:1px solid rgba(230,238,246,.18); }.owner-layout__menu-toggle { display:none; }#owner-workbench { min-height:calc(100vh - 4.5rem); background:#f4f6f8; color:#17253d; }.owner-layout__menu-toggle:focus-visible,.owner-layout__exit:focus-visible { outline:3px solid #83b4e6; outline-offset:3px; }
@media(max-width:760px){.owner-layout__header{grid-template-columns:minmax(0,1fr) auto;gap:.7rem}.owner-layout__brand{font-size:.75rem;letter-spacing:.06em}.owner-layout__brand small{display:none}.owner-layout__menu-toggle{display:inline-flex;align-items:center;justify-content:center;grid-column:1/-1;min-height:2.75rem;padding:.55rem .8rem;border:1px solid rgba(230,238,246,.25);border-radius:10px;background:transparent;color:#eff3f7;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer}.owner-layout__nav{display:none;grid-column:1/-1;justify-content:flex-start;border-radius:12px}.owner-layout__nav.is-open{display:flex}.owner-layout__nav a{flex:1 1 9rem}.owner-layout__exit{font-size:.68rem;padding:.48rem .58rem}}
</style>
