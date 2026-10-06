<script setup lang="ts">
import { buildManagedSiteMediaStorageRequest, projectManagedSiteMediaSetupStatus, type ManagedSiteMediaHealthProjection } from '../../../utils/managedSiteMediaSetup'

type ManagedMediaFetch = <T = unknown>(path: string, options?: { method?: 'POST'; body?: Record<string, unknown> }) => Promise<T>
type ProjectRow = { id: number; canonicalClientIdentity: string; canonicalWebsiteIdentity: string; status: string }
type ProjectsResponse = { projects: ProjectRow[] }
type ConfigureResponse = { projectId: number; providerKey: string; configurationFingerprint: string; status: 'configured'; credentialValueStored: false; healthChecked: false }

const fetchManagedMedia = $fetch as unknown as ManagedMediaFetch
definePageMeta({ layout: 'owner' })
useHead({ title: 'Managed Sites 媒體儲存｜DiscoveryStack Private Workbench', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const { data, pending, error, refresh } = await useAsyncData<ProjectsResponse>(
  'managed-site-media-projects',
  () => fetchManagedMedia<ProjectsResponse>('/api/managed-sites/projects'),
  { server: false, default: () => ({ projects: [] }) },
)
const projects = computed(() => data.value?.projects || [])
const selectedProjectId = ref('')
const busy = ref<'configure' | 'health' | null>(null)
const failure = ref('')
const notice = ref('')
const healthConfirmed = ref(false)
const configuredProjects = reactive<Record<number, boolean>>({})
const verificationByProject = reactive<Record<number, ManagedSiteMediaHealthProjection | null>>({})
const form = reactive({
  credentialReference: 'DS_MEDIA_S3_CREDENTIAL',
  bucket: '',
  region: 'auto',
  prefix: 'managed-sites-media-v1',
  endpoint: '',
  publicCdnOrigin: '',
})

watch(projects, rows => {
  if (!selectedProjectId.value && rows.length) selectedProjectId.value = String(rows[0]!.id)
}, { immediate: true })
watch(selectedProjectId, () => {
  failure.value = ''
  notice.value = ''
  healthConfirmed.value = false
})

const selectedProject = computed(() => projects.value.find(project => project.id === Number(selectedProjectId.value)) || null)
const selectedId = computed(() => selectedProject.value?.id || 0)
const verification = computed(() => verificationByProject[selectedId.value] || null)
const setupStatus = computed(() => projectManagedSiteMediaSetupStatus(Boolean(configuredProjects[selectedId.value]), verification.value))
const statusLabel = (value: string) => ({
  not_checked: '尚未檢查',
  configured: '已保存，待驗證',
  verified: '已驗證',
  blocked: '驗證失敗',
  quarantined: '隔離模式',
} as Record<string, string>)[value] || value
const statusClass = (value: string) => `state state--${value}`

function errorMessage(caught: any, fallback: string): string {
  return String(caught?.data?.message || caught?.data?.statusMessage || caught?.statusMessage || fallback)
}

async function configureStorage() {
  if (!selectedId.value || busy.value) return
  const request = buildManagedSiteMediaStorageRequest(form)
  failure.value = ''
  notice.value = ''
  if (!request.ok) { failure.value = request.message; return }
  busy.value = 'configure'
  try {
    const result = await fetchManagedMedia<ConfigureResponse>('/api/managed-sites/editor/storage-connections', {
      method: 'POST',
      body: {
        projectId: selectedId.value,
        providerKey: 's3_compatible',
        credentialReference: request.credentialReference,
        configuration: request.configuration,
      },
    })
    configuredProjects[result.projectId] = true
    verificationByProject[result.projectId] = null
    healthConfirmed.value = false
    notice.value = '儲存連線 metadata 已保存；尚未取得健康驗證 receipt，現在還不能上傳媒體。'
  } catch (caught: any) { failure.value = errorMessage(caught, '儲存連線未保存。') }
  finally { busy.value = null }
}

async function verifyHealth() {
  if (!selectedId.value || busy.value || !healthConfirmed.value) return
  busy.value = 'health'
  failure.value = ''
  notice.value = ''
  try {
    const result = await fetchManagedMedia<ManagedSiteMediaHealthProjection>('/api/managed-sites/editor/storage-connections/health', {
      method: 'POST',
      body: { projectId: selectedId.value },
    })
    configuredProjects[selectedId.value] = true
    verificationByProject[selectedId.value] = result
    notice.value = result.health.ready && result.scannerHealth.ready
      ? 'S3 與安全掃描器都已取得 server health receipt；新上傳可以進入處理流程。'
      : result.health.ready
        ? 'S3 已驗證，但 scanner 未通過；上傳內容會留在隔離區，不會公開。'
        : 'S3 健康驗證失敗；媒體上傳維持關閉。'
  } catch (caught: any) { failure.value = errorMessage(caught, '健康驗證失敗；沒有 readiness receipt 被推定。') }
  finally { busy.value = null }
}
</script>

<template>
  <main class="media-page">
    <header class="hero">
      <div>
        <p class="eyebrow">OWNER ONLY / MEDIA AUTHORITY</p>
        <h1>媒體儲存與安全掃描</h1>
        <p>為每個 Managed Site 保存 S3/R2 的非秘密 metadata，再由 server 對儲存與掃描器做真實健康驗證。設定存在不等於已驗證。</p>
      </div>
      <nav aria-label="Managed Sites 導覽">
        <NuxtLink to="/audit-lab/managed-sites">Managed Sites</NuxtLink>
        <NuxtLink to="/audit-lab/managed-sites/setup">上線設定</NuxtLink>
        <NuxtLink to="/audit-lab/managed-sites/projects">專案交付</NuxtLink>
      </nav>
    </header>

    <p v-if="error" class="notice notice--error" role="alert">專案清單目前無法載入；沒有任何連線被修改。 <button type="button" @click="refresh">重試</button></p>
    <p v-if="failure" class="notice notice--error" role="alert">{{ failure }}</p>
    <p v-if="notice" class="notice notice--success" role="status">{{ notice }}</p>

    <section class="panel" aria-labelledby="project-title">
      <div class="panel-heading"><div><p class="eyebrow">PROJECT SCOPE</p><h2 id="project-title">選擇客戶專案</h2></div><span>{{ projects.length }} 個專案</span></div>
      <label class="field">專案
        <select v-model="selectedProjectId" :disabled="pending || busy !== null">
          <option disabled value="">請選擇專案</option>
          <option v-for="project in projects" :key="project.id" :value="String(project.id)">#{{ project.id }} · {{ project.canonicalClientIdentity }} · {{ project.status }}</option>
        </select>
      </label>
      <p v-if="selectedProject" class="project-origin">網站識別：{{ selectedProject.canonicalWebsiteIdentity || '尚未設定' }}</p>
      <p v-else-if="!pending && !projects.length" class="empty">目前沒有可設定的 Managed Site 專案。</p>
    </section>

    <section class="status-grid" aria-label="媒體就緒狀態">
      <article>
        <span>連線設定</span><strong :class="statusClass(setupStatus.configuration)">{{ statusLabel(setupStatus.configuration) }}</strong>
        <p>只表示 bucket、region、prefix 與 credential reference 已保存。</p>
      </article>
      <article>
        <span>S3 / R2 health</span><strong :class="statusClass(setupStatus.storage)">{{ statusLabel(setupStatus.storage) }}</strong>
        <p>{{ verification?.health.mode || '尚未由 server 執行 HeadBucket。' }}<template v-if="verification?.health.reason"> · {{ verification.health.reason }}</template></p>
      </article>
      <article>
        <span>安全掃描器</span><strong :class="statusClass(setupStatus.scanner)">{{ statusLabel(setupStatus.scanner) }}</strong>
        <p>{{ verification?.scannerHealth.mode || '尚未驗證 scanner authority。' }}<template v-if="verification?.scannerHealth.reason"> · {{ verification.scannerHealth.reason }}</template></p>
      </article>
    </section>

    <section class="panel" aria-labelledby="storage-title">
      <div class="panel-heading"><div><p class="eyebrow">NON-SECRET CONFIGURATION</p><h2 id="storage-title">S3 / R2 連線 metadata</h2></div><span>s3_compatible</span></div>
      <p class="boundary">這個表單不接受 access key、secret key、session token 或 scanner bearer token。請先在伺服器 Secrets 建立 JSON credential，再只填入它的大寫環境變數名稱。</p>
      <form class="form-grid" @submit.prevent="configureStorage">
        <label class="field">Credential reference
          <input v-model="form.credentialReference" required maxlength="160" pattern="[A-Z][A-Z0-9_]{7,159}" autocomplete="off" placeholder="DS_MEDIA_S3_CREDENTIAL">
          <small>這是 server env 名稱，不是 credential 值。</small>
        </label>
        <label class="field">Bucket<input v-model="form.bucket" required maxlength="63" autocomplete="off" placeholder="discoverystack-media-prod"></label>
        <label class="field">Region<input v-model="form.region" required maxlength="32" autocomplete="off" placeholder="auto"></label>
        <label class="field">Object prefix<input v-model="form.prefix" required maxlength="128" autocomplete="off" placeholder="managed-sites-media-v1"></label>
        <label class="field">S3 endpoint（R2 / MinIO 才需填）<input v-model="form.endpoint" type="url" autocomplete="off" placeholder="https://account-id.r2.cloudflarestorage.com"></label>
        <label class="field">Public CDN origin（選填）<input v-model="form.publicCdnOrigin" type="url" autocomplete="off" placeholder="https://media.your-domain.com"></label>
        <div class="form-actions"><button type="submit" :disabled="!selectedProject || busy !== null">{{ busy === 'configure' ? '保存中…' : '保存連線設定' }}</button></div>
      </form>
      <p class="boundary">重新保存會清除舊的 storage 與 scanner health receipt；必須再次驗證才能恢復處理。</p>
    </section>

    <section class="panel" aria-labelledby="health-title">
      <div class="panel-heading"><div><p class="eyebrow">EXPLICIT EXTERNAL CHECK</p><h2 id="health-title">取得健康驗證 receipt</h2></div></div>
      <p>此操作會由 server 對已保存的 bucket 執行一次 read-only HeadBucket；若已設定 scanner，還會送出一張固定 1×1 PNG 進行已知樣本掃描。它不會上傳客戶素材。</p>
      <p><code>NUXT_MEDIA_SCANNER_ENDPOINT</code> 與 <code>NUXT_MEDIA_SCANNER_CREDENTIAL_REF</code> 只能在伺服器設定。scanner 未設定、憑證 reference 無法解析或健康檢查不是 <code>passed</code> 時，新素材一律留在隔離區。</p>
      <label class="confirm"><input v-model="healthConfirmed" type="checkbox"> 我了解這會對 S3/R2 與已設定的 scanner 發出真實、有限的健康檢查。</label>
      <button type="button" :disabled="!selectedProject || !healthConfirmed || busy !== null" @click="verifyHealth">{{ busy === 'health' ? '驗證中…' : '執行 server 健康驗證' }}</button>
    </section>
  </main>
</template>

<style scoped>
.media-page{max-width:1100px;margin:0 auto;padding:clamp(1.25rem,4vw,3.5rem);color:#17253d}.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:2rem;margin-bottom:1.4rem}.hero h1{margin:.2rem 0;font-size:clamp(2rem,5vw,4rem);letter-spacing:-.04em}.hero p:not(.eyebrow){max-width:720px;color:#5c6d80;line-height:1.7}.hero nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5rem}.hero a,.media-page button{border:1px solid #c5d1dd;border-radius:.65rem;background:#fff;color:#23466d;padding:.7rem .9rem;text-decoration:none;font:inherit;font-weight:750;cursor:pointer}.media-page button:disabled{cursor:not-allowed;opacity:.52}.eyebrow{margin:0;color:#66809b;font-size:.68rem;font-weight:850;letter-spacing:.13em}.panel{margin-top:1rem;padding:1.25rem;border:1px solid #d9e2eb;border-radius:1rem;background:#fff;box-shadow:0 12px 34px rgba(25,52,80,.05)}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.panel-heading h2{margin:.25rem 0 .9rem;font-size:1.2rem}.panel-heading>span,.project-origin{color:#64778b;font-size:.76rem}.field{display:grid;gap:.38rem;color:#344b64;font-size:.78rem;font-weight:800}.field input,.field select{width:100%;box-sizing:border-box;border:1px solid #c5d1dd;border-radius:.55rem;background:#fff;color:#17253d;padding:.72rem;font:inherit}.field small{color:#718296;font-weight:500}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.form-actions{display:flex;align-items:flex-end}.form-actions button{background:#244f78;color:#fff}.status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.8rem}.status-grid article{padding:1rem;border:1px solid #d9e2eb;border-radius:.85rem;background:#fff}.status-grid article>span{display:block;color:#708195;font-size:.7rem;font-weight:800;text-transform:uppercase}.status-grid strong{display:inline-flex;margin:.45rem 0;border-radius:999px;padding:.3rem .55rem;font-size:.72rem}.status-grid p,.boundary,.panel>p,.confirm{color:#5f7184;font-size:.8rem;line-height:1.65}.state--verified,.state--configured{background:#e8f6ed;color:#246640}.state--blocked,.state--quarantined{background:#ffebe8;color:#8d3027}.state--not_checked{background:#eef2f6;color:#556678}.notice{margin:1rem 0;border-radius:.7rem;padding:.85rem 1rem}.notice--error{background:#ffebe8;color:#8d3027}.notice--success{background:#e8f6ed;color:#246640}.boundary{border-left:3px solid #9db7cf;padding-left:.75rem}.confirm{display:flex;align-items:flex-start;gap:.55rem;margin:1rem 0}.confirm input{margin-top:.28rem}.empty{color:#718296}@media(max-width:760px){.hero{display:block}.hero nav{justify-content:flex-start;margin-top:1rem}.status-grid,.form-grid{grid-template-columns:1fr}}
</style>
