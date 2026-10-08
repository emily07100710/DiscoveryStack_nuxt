<script setup lang="ts">
import { OWNER_NAVIGATION_GROUPS, resolveOwnerNavigation } from '../utils/owner-navigation'

const config = useRuntimeConfig()
const publicSiteOrigin = String(config.public.discoveryStackPublicSiteOrigin || 'https://www.example.com').replace(/\/$/, '')
const route = useRoute()
const navigationOpen = ref(false)
const advancedOpen = ref(false)
const currentNavigation = computed(() => resolveOwnerNavigation(route.path))
const isOverview = computed(() => route.path === '/audit-lab')

watch(() => route.path, () => {
  navigationOpen.value = false
  if (currentNavigation.value.activeGroup?.advanced) advancedOpen.value = true
})

function itemIsCurrent(to: string): boolean {
  return currentNavigation.value.activeItem?.to === to || (to === '/audit-lab' && isOverview.value)
}

useHead({ htmlAttrs: { lang: 'zh-Hant', dir: 'ltr' }, bodyAttrs: { class: 'ds-owner-workbench' } })
</script>

<template>
  <div class="owner-layout">
    <a class="owner-layout__skip-link" href="#owner-workbench-content">跳至頁面內容</a>

    <aside class="owner-layout__sidebar" aria-label="DiscoveryStack 工作台">
      <div class="owner-layout__sidebar-top">
        <NuxtLink class="owner-layout__brand" to="/audit-lab" aria-label="DiscoveryStack 工作總覽">
          <span class="owner-layout__brand-name">DISCOVERYSTACK<span>.</span></span>
          <small>OWNER WORKBENCH</small>
        </NuxtLink>

        <a class="owner-layout__exit" :href="`${publicSiteOrigin}/zh-hant`">返回公開網站 <span aria-hidden="true">↗</span></a>

        <button
          class="owner-layout__menu-toggle"
          type="button"
          aria-controls="owner-workbench-navigation"
          :aria-expanded="navigationOpen"
          @click="navigationOpen = !navigationOpen"
        >
          {{ navigationOpen ? '收合導覽' : '展開導覽' }}
        </button>
      </div>

      <nav
        id="owner-workbench-navigation"
        class="owner-layout__nav"
        :class="{ 'is-open': navigationOpen }"
        aria-label="工作台導覽"
      >
        <NuxtLink class="owner-layout__overview" to="/audit-lab" :aria-current="itemIsCurrent('/audit-lab') ? 'page' : undefined">
          <span class="owner-layout__item-label">工作總覽</span>
          <span class="owner-layout__item-description">查看整體工作狀態</span>
        </NuxtLink>

        <section v-for="group in OWNER_NAVIGATION_GROUPS.filter(group => !group.advanced)" :key="group.id" class="owner-layout__group" :aria-labelledby="`owner-group-${group.id}`">
          <h2 :id="`owner-group-${group.id}`" class="owner-layout__group-title">{{ group.label }}</h2>
          <NuxtLink
            v-for="item in group.items"
            :key="item.id"
            class="owner-layout__item"
            :to="item.to"
            :aria-current="itemIsCurrent(item.to) ? 'page' : undefined"
          >
            <span class="owner-layout__item-label">{{ item.label }}</span>
            <span class="owner-layout__item-description">{{ item.description }}</span>
          </NuxtLink>
        </section>

        <details
          class="owner-layout__group owner-layout__advanced"
          :open="advancedOpen || currentNavigation.activeGroup?.advanced"
          @toggle="advancedOpen = ($event.currentTarget as HTMLDetailsElement).open"
        >
          <summary class="owner-layout__group-title">進階工具</summary>
          <NuxtLink
            v-for="item in OWNER_NAVIGATION_GROUPS.find(group => group.advanced)?.items || []"
            :key="item.id"
            class="owner-layout__item"
            :to="item.to"
            :aria-current="itemIsCurrent(item.to) ? 'page' : undefined"
          >
            <span class="owner-layout__item-label">{{ item.label }}</span>
            <span class="owner-layout__item-description">{{ item.description }}</span>
          </NuxtLink>
        </details>
      </nav>
    </aside>

    <main id="owner-workbench-content" class="owner-layout__main" tabindex="-1">
      <div class="owner-layout__context" aria-live="polite">
        <p class="owner-layout__breadcrumb">
          <span>工作總覽</span>
          <template v-if="currentNavigation.activeGroup">
            <span aria-hidden="true">›</span>
            <span>{{ currentNavigation.activeGroup.label }}</span>
          </template>
          <template v-if="currentNavigation.activeItem && !isOverview">
            <span aria-hidden="true">›</span>
            <span>{{ currentNavigation.activeItem.label }}</span>
          </template>
          <span v-else-if="!isOverview" class="owner-layout__unknown-route">目前頁面</span>
        </p>
        <p v-if="currentNavigation.activeItem" class="owner-layout__context-description">{{ currentNavigation.activeItem.description }}</p>
      </div>
      <div class="owner-layout__page"><slot /></div>
    </main>
  </div>
</template>

<style scoped>
.owner-layout { --owner-ink:#17253d; --owner-muted:#627084; --owner-line:#e3e8ee; display:grid; grid-template-columns:17rem minmax(0,1fr); min-height:100vh; background:#f4f6f8; color:var(--owner-ink); font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.owner-layout,.owner-layout :deep(*) { box-sizing:border-box; }
.owner-layout__skip-link { position:fixed; z-index:100; top:.75rem; left:.75rem; transform:translateY(-180%); padding:.7rem 1rem; border-radius:.6rem; background:#fff; color:#142239; box-shadow:0 4px 18px #0003; }
.owner-layout__skip-link:focus { transform:translateY(0); }
.owner-layout__sidebar { position:sticky; top:0; display:flex; flex-direction:column; width:17rem; height:100vh; overflow-y:auto; overscroll-behavior:contain; padding:1.25rem .9rem 1.5rem; border-right:1px solid #29313c; background:#101319; color:#eff3f7; }
.owner-layout__sidebar-top { display:flex; flex-direction:column; gap:1rem; padding:.15rem .3rem 1.1rem; }
.owner-layout__brand { display:flex; flex-direction:column; gap:.3rem; width:max-content; max-width:100%; color:#fff; text-decoration:none; }
.owner-layout__brand-name { font-size:.91rem; font-weight:800; letter-spacing:.1em; }.owner-layout__brand-name > span { color:#8eb7ec; }
.owner-layout__brand small { color:#aeb9c5; font-size:.62rem; letter-spacing:.13em; }
.owner-layout__exit { align-self:flex-start; color:#b9c3ce; font-size:.76rem; text-decoration:none; }
.owner-layout__exit:hover,.owner-layout__exit:focus-visible { color:#fff; }
.owner-layout__nav { display:flex; flex-direction:column; gap:.45rem; }
.owner-layout__overview,.owner-layout__item { display:flex; flex-direction:column; gap:.18rem; padding:.55rem .62rem; border-radius:.62rem; color:#d5dde6; text-decoration:none; }
.owner-layout__overview { margin-bottom:.28rem; border:1px solid #3a4553; }
.owner-layout__group { display:flex; flex-direction:column; gap:.16rem; padding:.2rem 0 .35rem; }
.owner-layout__group-title { margin:0; padding:.4rem .6rem .3rem; color:#94a1b1; font-size:.68rem; font-weight:800; letter-spacing:.06em; }
.owner-layout__advanced > summary { cursor:pointer; list-style:none; }
.owner-layout__advanced > summary::-webkit-details-marker { display:none; }
.owner-layout__advanced > summary::after { float:right; content:'＋'; color:#aeb9c5; }
.owner-layout__advanced[open] > summary::after { content:'−'; }
.owner-layout__item-label { font-size:.81rem; font-weight:700; line-height:1.35; }
.owner-layout__item-description { color:#9eabb9; font-size:.67rem; line-height:1.4; }
.owner-layout__overview[aria-current='page'],.owner-layout__item[aria-current='page'],.owner-layout__overview:hover,.owner-layout__item:hover,.owner-layout__overview:focus-visible,.owner-layout__item:focus-visible { background:#dce9f6; color:#111820; outline:none; }
.owner-layout__overview[aria-current='page'] .owner-layout__item-description,.owner-layout__item[aria-current='page'] .owner-layout__item-description,.owner-layout__overview:hover .owner-layout__item-description,.owner-layout__item:hover .owner-layout__item-description,.owner-layout__item:focus-visible .owner-layout__item-description { color:#3b4a5d; }
.owner-layout__menu-toggle { display:none; }
.owner-layout__main { min-width:0; min-height:100vh; }
.owner-layout__context { padding:1.05rem clamp(1rem,3vw,2.5rem) .9rem; border-bottom:1px solid var(--owner-line); background:#fff; }
.owner-layout__breadcrumb { display:flex; flex-wrap:wrap; gap:.4rem; margin:0; color:#34435a; font-size:.78rem; font-weight:700; }
.owner-layout__unknown-route { color:var(--owner-muted); font-weight:500; }
.owner-layout__context-description { margin:.35rem 0 0; color:var(--owner-muted); font-size:.76rem; }
.owner-layout__page { min-width:0; }
.owner-layout__skip-link:focus-visible,.owner-layout__exit:focus-visible,.owner-layout__advanced > summary:focus-visible,.owner-layout__menu-toggle:focus-visible { outline:3px solid #83b4e6; outline-offset:3px; }
@media(max-width:760px) {
  .owner-layout { display:block; }
  .owner-layout__sidebar { position:relative; z-index:30; width:auto; height:auto; max-height:none; overflow:visible; padding:.8rem 1rem; border-right:0; border-bottom:1px solid #29313c; }
  .owner-layout__sidebar-top { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:.7rem; padding:0; }
  .owner-layout__brand-name { font-size:.79rem; letter-spacing:.06em; }.owner-layout__brand small { display:none; }
  .owner-layout__exit { justify-self:end; font-size:.68rem; }
  .owner-layout__menu-toggle { display:inline-flex; grid-column:1/-1; align-items:center; justify-content:center; min-height:2.65rem; padding:.5rem .8rem; border:1px solid #57616d; border-radius:.65rem; background:transparent; color:#eff3f7; font:inherit; font-size:.82rem; font-weight:700; cursor:pointer; }
  .owner-layout__nav { display:none; max-height:min(68vh,34rem); margin-top:.75rem; padding:.3rem .15rem .5rem; overflow-y:auto; }
  .owner-layout__nav.is-open { display:flex; }
  .owner-layout__group { gap:.12rem; }
  .owner-layout__overview,.owner-layout__item { padding:.58rem .62rem; }
  .owner-layout__context { padding:.78rem 1rem; }
  .owner-layout__page { overflow-wrap:anywhere; }
}
</style>

<style>
body.ds-owner-workbench { margin:0; }
</style>
