<script setup lang="ts">
definePageMeta({ layout: 'owner' })
useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })
type Manifest = { manifestFingerprint: string; config: { brandName: string; preset: string }; launch: { message: string; deployed: boolean }; capabilities: string[] }
const requestRuntime = $fetch as unknown as <T>(path: string, options?: { method: 'POST'; body: unknown }) => Promise<T>
const projectId = ref(''); const versionId = ref(''); const engine = ref<'commerce' | 'booking_blog'>('commerce'); const mode = ref<'preview' | 'production'>('preview')
const result = ref<Manifest | null>(null); const busy = ref(false); const errorMessage = ref('')
const projects = ref<Array<{ id: number; canonicalClientIdentity: string }>>([])
const versions = ref<Array<{ id: number; version: number; status: string }>>([])
onMounted(async () => {
  try { projects.value = (await requestRuntime<{ projects: typeof projects.value }>('/api/managed-sites/projects')).projects }
  catch { errorMessage.value = '專案清單無法讀取，請確認已登入擁有人後台。' }
})
async function loadVersions() {
  result.value = null; versionId.value = ''; versions.value = []
  if (!projectId.value) return
  try { versions.value = (await requestRuntime<{ versions: typeof versions.value }>(`/api/managed-sites/projects/${projectId.value}/customer-runtime`)).versions; versionId.value = String(versions.value[0]?.id || '') }
  catch { errorMessage.value = '網站版本無法讀取，請稍後重試。' }
}
async function generate() {
  result.value = null; errorMessage.value = ''
  if (!/^[1-9][0-9]*$/u.test(projectId.value) || !/^[1-9][0-9]*$/u.test(versionId.value)) { errorMessage.value = '請填入專案與版本編號。'; return }
  busy.value = true
  try { result.value = await requestRuntime<Manifest>(`/api/managed-sites/projects/${projectId.value}/customer-runtime`, { method: 'POST', body: { versionId: Number(versionId.value), engine: engine.value, mode: mode.value } }) }
  catch (error: any) { errorMessage.value = error?.data?.statusMessage || error?.data?.message || '無法生成網站。請確認擁有人登入、專案狀態與版本權限。' }
  finally { busy.value = false }
}
function download() {
  if (!result.value) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'customer-site-manifest.json'; link.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="runtime-page">
    <header><p>DISCOVERYSTACK / CUSTOMER SITE</p><h1>客戶交易網站</h1><p>以已保存的品牌版本，生成完整電商或預約＋部落格的獨立網站核心。</p><NuxtLink to="/audit-lab/managed-sites/projects">回到專案</NuxtLink></header>
    <form @submit.prevent="generate">
      <label>客戶品牌<select v-model="projectId" required @change="loadVersions"><option value="">選擇品牌專案</option><option v-for="project in projects" :key="project.id" :value="String(project.id)">{{ project.canonicalClientIdentity }}</option></select></label>
      <label>網站版本<select v-model="versionId" required><option value="">選擇網站版本</option><option v-for="version in versions" :key="version.id" :value="String(version.id)">第 {{ version.version }} 版 · {{ version.status }}</option></select></label>
      <label>網站核心<select v-model="engine"><option value="commerce">品牌電商：商品、購物車、訂單、庫存與後台</option><option value="booking_blog">預約＋部落格：時段、會員堂數、預約與文章後台</option></select></label>
      <label>網站模式<select v-model="mode"><option value="preview">預覽：禁止搜尋收錄，不啟用真實付款</option><option value="production">正式設定：仍需部署與營運驗收</option></select></label>
      <button type="submit" :disabled="busy">{{ busy ? '生成中…' : '生成獨立網站設定' }}</button>
    </form>
    <p v-if="errorMessage" class="notice" role="alert">{{ errorMessage }}</p>
    <article v-if="result"><h2>{{ result.config.brandName }}</h2><p>品牌版型：{{ result.config.preset }}</p><p class="notice">{{ result.launch.message }}</p><button type="button" @click="download">下載網站生成設定</button><p>設定不包含登入密碼、金流憑證或客戶資料；每站使用自己的資料庫與媒體儲存。生成不會把既有 Shopify 模組標為完成，也不會修改或取代已上線版本。</p></article>
    <aside><h2>交付後的美術照顧</h2><p>正式交付後 30 天，原功能內的排版、色彩、字體與圖片配置免費調整。客戶可從網站工作區提交需求並查詢進度。新功能、舊資料搬遷、新串接與第三方費用另行確認。</p><h2>正式啟用前</h2><p>請先提供獨立 Node 託管、持久磁碟、HTTPS 網域、安全密碼與備份；本頁不會買網域、部署、搬移會員或啟用扣款。</p></aside>
  </section>
</template>

<style scoped>
.runtime-page{max-width:1000px;margin:auto;padding:3rem 1.5rem;color:#202a36}.runtime-page header>p:first-child{letter-spacing:.14em;font-size:.7rem}h1{font-size:2.6rem}form,article,aside{background:#fff;border:1px solid #d8dee5;border-radius:1rem;padding:1.5rem;margin:1.5rem 0}form{display:grid;gap:1rem}label{display:grid;gap:.5rem}input,select,button{font:inherit;padding:.8rem;border:1px solid #c8d0d9;border-radius:.5rem}button{background:#26392e;color:white;cursor:pointer}button:disabled{opacity:.6}.notice{padding:1rem;background:#fff4df;border-radius:.6rem}p{line-height:1.8}
</style>
