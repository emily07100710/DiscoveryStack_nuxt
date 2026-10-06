<script setup lang="ts">
definePageMeta({ layout: 'owner' })
useHead({ title: '上線設定｜DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })
type Check = { id: string; label: string; status: 'configured' | 'missing' | 'invalid' | 'verification_required' | 'verified'; required: boolean; settings: string[]; action: string }
type Setup = { configurationReady: boolean; providerVerificationComplete: boolean; productionAccepted: false; checks: Check[]; acceptance: string[] }
type Readiness = { setupReadiness: Setup; launchReadiness: { ready: boolean; blockers: Array<{ code: string; messageZh: string }> } }
const fetchSetup = $fetch as unknown as <T>(path: string) => Promise<T>
const report = ref<Readiness | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const labels: Record<Check['status'], string> = { configured: '設定已填', missing: '尚未設定', invalid: '設定需修正', verification_required: '等待供應商驗證', verified: '供應商已驗證' }
const remaining = computed(() => report.value?.setupReadiness.checks.filter(check => check.required && ['missing', 'invalid', 'verification_required'].includes(check.status)).length || 0)
async function refresh() {
  loading.value = true; errorMessage.value = ''; report.value = null
  try { report.value = await fetchSetup<Readiness>('/api/managed-sites/live-connectors/readiness') }
  catch (error: any) { errorMessage.value = error?.data?.message || '無法讀取上線設定。請確認擁有人已登入，以及資料庫連線和 migration 已完成。' }
  finally { loading.value = false }
}
onMounted(refresh)
</script>

<template>
  <section class="setup-page">
    <header class="setup-header">
      <div><p class="eyebrow">DISCOVERYSTACK / SETUP</p><h1>上線設定</h1><p>確認網站、登入、寄信、付款及開站流程還缺哪些設定。</p></div>
      <div class="actions"><NuxtLink to="/audit-lab/managed-sites">供應商設定</NuxtLink><NuxtLink to="/audit-lab/managed-sites/media">圖片倉庫</NuxtLink><NuxtLink to="/audit-lab/managed-sites/customer-runtime">客戶交易網站</NuxtLink><NuxtLink to="/audit-lab/managed-sites/design-care">售後美術需求</NuxtLink><button :disabled="loading" type="button" @click="refresh">{{ loading ? '檢查中…' : '重新檢查' }}</button></div>
    </header>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <p v-if="loading" role="status">正在讀取目前服務設定…</p>
    <template v-if="report">
      <section class="summary" aria-label="設定進度">
        <div><strong>{{ remaining }}</strong><span>必要項目待處理</span></div>
        <div><strong>{{ report.setupReadiness.configurationReady ? '已填齊' : '待補齊' }}</strong><span>必要設定</span></div>
        <div><strong>{{ report.setupReadiness.providerVerificationComplete ? '已完成' : '待完成' }}</strong><span>供應商驗證</span></div>
      </section>
      <p class="explanation">這個檢查只讀取設定與已保存的驗證紀錄。設定已填齊後，仍需實際收信、付款、開站與背景排程驗收。</p>
      <section v-if="report.launchReadiness.blockers.length" class="blockers" aria-label="正式啟用待處理">
        <h2>正式啟用待處理</h2><ul><li v-for="blocker in report.launchReadiness.blockers" :key="blocker.code + blocker.messageZh">{{ blocker.messageZh }}</li></ul>
      </section>
      <section class="checks" aria-label="必要設定清單">
        <article v-for="check in report.setupReadiness.checks" :key="check.id" class="check">
          <div class="check-heading"><h2>{{ check.label }}</h2><span class="badge" :class="`badge--${check.status}`">{{ labels[check.status] }}</span></div>
          <p>{{ !check.required ? '依專案需要設定：' : '' }}{{ check.action }}</p>
          <ul v-if="check.settings.length" class="settings"><li v-for="setting in check.settings" :key="setting"><code>{{ setting }}</code></li></ul>
        </article>
      </section>
      <section class="acceptance"><h2>設定完成後的實際驗收</h2><ol><li v-for="item in report.setupReadiness.acceptance" :key="item">{{ item }}</li></ol><p>請先完成 Stripe 測試模式流程。新網域的真實採購需要正式付款證據與客戶授權。</p></section>
    </template>
  </section>
</template>

<style scoped>
.setup-page{max-width:1180px;margin:0 auto;padding:clamp(1.2rem,4vw,3rem);color:#17253d}.setup-header,.check-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem}.setup-header h1{margin:.2rem 0;font-size:clamp(2rem,4vw,3rem)}.setup-header p{color:#5d6c7e}.eyebrow{font-size:.68rem;font-weight:800;letter-spacing:.12em}.actions{display:flex;flex-wrap:wrap;gap:.6rem}.actions a,.actions button{border:1px solid #c8d3df;border-radius:.6rem;padding:.7rem 1rem;color:#23466d;background:#fff;text-decoration:none;font:inherit;cursor:pointer}.actions button:disabled{opacity:.6;cursor:wait}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin:1.5rem 0}.summary div{display:grid;gap:.4rem;padding:1.2rem;border:1px solid #dbe3eb;border-radius:.8rem;background:#fff}.summary strong{font-size:1.6rem}.summary span{color:#5d6c7e}.explanation{line-height:1.7}.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1.5rem 0}.check,.acceptance,.blockers{padding:1.2rem;border:1px solid #dbe3eb;border-radius:.8rem;background:#fff}.check h2,.acceptance h2,.blockers h2{margin:0;font-size:1rem}.check p,.acceptance li,.blockers li{font-size:.85rem;line-height:1.7;color:#5d6c7e}.settings{list-style:none;padding:0;margin:.6rem 0 0}.settings li{padding:.2rem 0}.settings code{font-size:.72rem;overflow-wrap:anywhere}.badge{flex-shrink:0;border-radius:999px;background:#fff0e6;color:#995116;padding:.35rem .55rem;font-size:.68rem}.badge--configured,.badge--verified{background:#e3f4e9;color:#206b3c}.badge--invalid{background:#ffebe8;color:#8d3027}.badge--verification_required{background:#e5f1ff;color:#264d86}.blockers{background:#fff5ec;margin:1rem 0}.error{padding:1rem;border-radius:.6rem;background:#ffebe8;color:#8d3027}@media(max-width:700px){.setup-header{display:block}.checks,.summary{grid-template-columns:1fr}.actions{margin:1rem 0}.check-heading{align-items:flex-start}}
</style>
