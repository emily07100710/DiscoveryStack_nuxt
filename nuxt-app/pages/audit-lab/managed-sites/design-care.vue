<script setup lang="ts">
definePageMeta({ layout: 'owner' })
useHead({
  title: '30 天設計照顧｜DiscoveryStack Private Workbench',
  meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }],
})

type Project = {
  id: number
  canonicalClientIdentity: string
  canonicalWebsiteIdentity: string
  status: string
}
type CareStatus = 'not_started' | 'active' | 'expired'
type CareState = 'submitted' | 'reviewing' | 'accepted' | 'in_progress' | 'completed' | 'declined'
type NextCareState = Exclude<CareState, 'submitted'>
type CareRequest = {
  id: number
  category: 'layout' | 'color' | 'typography' | 'image_placement'
  description: string
  pageReference: string | null
  state: CareState
  ownerReason: string | null
  submittedAt: string
  updatedAt: string
}
type CareProjection = {
  schemaVersion: 'managed-site-design-care-v1'
  project: { id: number; label: string }
  window: {
    status: CareStatus
    startsAt: string | null
    expiresAt: string | null
    remainingDays: number
    canSubmit: boolean
    reason: string
    releaseId: number | null
    canonicalDomain: string | null
  }
  allowedCategories: Array<{ key: CareRequest['category']; label: string }>
  requests: CareRequest[]
  boundaries: {
    included: readonly string[]
    excluded: readonly string[]
    startsOnlyAfterVerifiedDelivery: true
    redeployDoesNotResetWindow: true
  }
}
type UpdateDraft = { state: NextCareState; reason: string; idempotencyKey: string }
type OwnerFetch = <T>(path: string, options?: { method: 'POST'; body: Record<string, unknown> }) => Promise<T>

const ownerFetch = $fetch as unknown as OwnerFetch
const projects = ref<Project[]>([])
const selectedProjectId = ref('')
const care = ref<CareProjection | null>(null)
const loadingProjects = ref(false)
const loadingCare = ref(false)
const updatingRequestId = ref<number | null>(null)
const pageError = ref('')
const actionError = ref('')
const notice = ref('')
const drafts = reactive<Record<number, UpdateDraft>>({})

const stateLabels: Record<CareState, string> = {
  submitted: '已送出',
  reviewing: '評估中',
  accepted: '已接受',
  in_progress: '處理中',
  completed: '已完成',
  declined: '不在本次範圍',
}
const statusLabels: Record<CareStatus, string> = {
  not_started: '尚未開始',
  active: '服務期間內',
  expired: '已到期',
}
const transitions: Record<CareState, readonly NextCareState[]> = {
  submitted: ['reviewing', 'accepted', 'in_progress', 'completed', 'declined'],
  reviewing: ['accepted', 'in_progress', 'completed', 'declined'],
  accepted: ['in_progress', 'completed', 'declined'],
  in_progress: ['completed', 'declined'],
  completed: [],
  declined: [],
}

const selectedProject = computed(() => projects.value.find(project => project.id === Number(selectedProjectId.value)) || null)
const categoryLabels = computed(() => Object.fromEntries((care.value?.allowedCategories || []).map(category => [category.key, category.label])) as Record<CareRequest['category'], string>)

function messageFrom(error: any, fallback: string): string {
  return String(error?.data?.statusMessage || error?.data?.message || error?.statusMessage || fallback)
}

function idempotencyKey(requestId: number): string {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `design-care-owner-${requestId}-${random}`
}

function firstNextState(request: CareRequest): NextCareState | null {
  return transitions[request.state][0] || null
}

function synchronizeDrafts(projection: CareProjection) {
  const visible = new Set(projection.requests.map(request => request.id))
  for (const key of Object.keys(drafts)) if (!visible.has(Number(key))) delete drafts[Number(key)]
  for (const request of projection.requests) {
    const state = firstNextState(request)
    if (!state) { delete drafts[request.id]; continue }
    if (!drafts[request.id] || !transitions[request.state].includes(drafts[request.id]!.state)) {
      drafts[request.id] = { state, reason: '', idempotencyKey: idempotencyKey(request.id) }
    }
  }
}

function renewIdempotency(requestId: number) {
  const draft = drafts[requestId]
  if (draft) draft.idempotencyKey = idempotencyKey(requestId)
}

function formatDate(value: string | null): string {
  if (!value) return '尚無正式交付時間'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '時間資料無法辨識'
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(date)
}

async function loadProjects() {
  loadingProjects.value = true
  pageError.value = ''
  try {
    const response = await ownerFetch<{ projects: Project[] }>('/api/managed-sites/projects')
    projects.value = response.projects
    if (!selectedProjectId.value && projects.value.length) {
      selectedProjectId.value = String(projects.value[0]!.id)
      await loadCare()
    }
  } catch (error: any) {
    pageError.value = messageFrom(error, '專案清單目前無法載入，請確認擁有人已登入。')
  } finally {
    loadingProjects.value = false
  }
}

async function loadCare() {
  care.value = null
  pageError.value = ''
  actionError.value = ''
  notice.value = ''
  if (!/^[1-9][0-9]*$/u.test(selectedProjectId.value)) return
  loadingCare.value = true
  try {
    const projection = await ownerFetch<CareProjection>(`/api/managed-sites/projects/${selectedProjectId.value}/design-care`)
    care.value = projection
    synchronizeDrafts(projection)
  } catch (error: any) {
    pageError.value = messageFrom(error, '售後設計需求目前無法載入。')
  } finally {
    loadingCare.value = false
  }
}

async function updateRequest(request: CareRequest) {
  const draft = drafts[request.id]
  if (!care.value || !draft || !draft.reason.trim() || updatingRequestId.value !== null) return
  updatingRequestId.value = request.id
  actionError.value = ''
  notice.value = ''
  try {
    const result = await ownerFetch<{ care: CareProjection; request: CareRequest; replayed: boolean }>(`/api/managed-sites/projects/${care.value.project.id}/design-care`, {
      method: 'POST',
      body: {
        requestId: request.id,
        state: draft.state,
        reason: draft.reason.trim(),
        idempotencyKey: draft.idempotencyKey,
      },
    })
    care.value = result.care
    synchronizeDrafts(result.care)
    notice.value = result.replayed ? '這次狀態更新先前已完成；畫面已同步最新結果。' : `需求 #${request.id} 已更新為「${stateLabels[result.request.state]}」。`
  } catch (error: any) {
    actionError.value = messageFrom(error, '需求狀態未更新；請保留目前畫面後重試。')
  } finally {
    updatingRequestId.value = null
  }
}

onMounted(loadProjects)
</script>

<template>
  <main class="care-owner-page">
    <header class="hero">
      <div>
        <p class="eyebrow">OWNER ONLY / VERIFIED DELIVERY AFTERCARE</p>
        <h1>30 天設計照顧</h1>
        <p>依正式交付收據查看客戶提出的排版、美術需求，並留下可追溯的處理狀態與說明。</p>
      </div>
      <nav aria-label="Managed Sites 導覽">
        <NuxtLink to="/audit-lab/managed-sites/projects">專案交付</NuxtLink>
        <NuxtLink to="/audit-lab/managed-sites/setup">上線設定</NuxtLink>
      </nav>
    </header>

    <p v-if="pageError" class="notice notice--error" role="alert">{{ pageError }}</p>
    <p v-if="actionError" class="notice notice--error" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="notice notice--success" role="status">{{ notice }}</p>

    <section class="panel" aria-labelledby="project-heading">
      <div class="panel-heading">
        <div><p class="eyebrow">PROJECT SCOPE</p><h2 id="project-heading">選擇品牌專案</h2></div>
        <span>{{ projects.length }} 個專案</span>
      </div>
      <label class="field">品牌專案
        <select v-model="selectedProjectId" :disabled="loadingProjects || loadingCare || updatingRequestId !== null" @change="loadCare">
          <option disabled value="">請選擇專案</option>
          <option v-for="project in projects" :key="project.id" :value="String(project.id)">#{{ project.id }} · {{ project.canonicalClientIdentity }} · {{ project.status }}</option>
        </select>
      </label>
      <p v-if="selectedProject" class="muted">網站識別：{{ selectedProject.canonicalWebsiteIdentity || '尚未設定' }}</p>
      <p v-else-if="!loadingProjects && !projects.length" class="empty">目前沒有 Managed Site 專案。</p>
    </section>

    <p v-if="loadingProjects || loadingCare" class="loading" role="status">正在讀取售後設計需求…</p>

    <template v-if="care && !loadingCare">
      <section class="window" :class="`window--${care.window.status}`" aria-labelledby="window-heading">
        <div>
          <p class="eyebrow">VERIFIED DELIVERY WINDOW</p>
          <h2 id="window-heading">{{ statusLabels[care.window.status] }}</h2>
          <p v-if="care.window.status === 'not_started'">尚未找到完整的正式交付收據，因此不會預先開始 30 天倒數。</p>
          <p v-else-if="care.window.status === 'active'">距離服務期結束尚有 {{ care.window.remainingDays }} 天；重新部署不會重設起算日。</p>
          <p v-else>服務期已結束。既有需求仍保留，可繼續完成處理紀錄，但客戶不能再新增需求。</p>
        </div>
        <dl>
          <div><dt>正式交付</dt><dd>{{ formatDate(care.window.startsAt) }}</dd></div>
          <div><dt>服務到期</dt><dd>{{ formatDate(care.window.expiresAt) }}</dd></div>
          <div><dt>正式網域</dt><dd>{{ care.window.canonicalDomain || '尚未驗證' }}</dd></div>
        </dl>
      </section>

      <section class="scope-grid" aria-label="售後設計服務範圍">
        <article><h2>本次包含</h2><ul><li v-for="item in care.boundaries.included" :key="item">{{ item }}</li></ul></article>
        <article class="scope-excluded"><h2>需另行評估</h2><ul><li v-for="item in care.boundaries.excluded" :key="item">{{ item }}</li></ul></article>
      </section>

      <section class="requests" aria-labelledby="requests-heading">
        <div class="panel-heading"><div><p class="eyebrow">CUSTOMER REQUESTS</p><h2 id="requests-heading">客戶需求</h2></div><span>{{ care.requests.length }} 筆</span></div>
        <p v-if="!care.requests.length" class="empty">這個專案目前沒有售後設計需求。</p>
        <article v-for="request in care.requests" :key="request.id" class="request-card">
          <div class="request-heading">
            <div><span class="request-id">需求 #{{ request.id }}</span><h3>{{ categoryLabels[request.category] || request.category }}</h3></div>
            <span class="state" :class="`state--${request.state}`">{{ stateLabels[request.state] }}</span>
          </div>
          <p v-if="request.pageReference" class="page-reference">頁面位置：{{ request.pageReference }}</p>
          <p class="description">{{ request.description }}</p>
          <dl class="timestamps"><div><dt>提出時間</dt><dd>{{ formatDate(request.submittedAt) }}</dd></div><div><dt>最後更新</dt><dd>{{ formatDate(request.updatedAt) }}</dd></div></dl>
          <p v-if="request.ownerReason" class="owner-reason"><strong>目前處理說明：</strong>{{ request.ownerReason }}</p>

          <form v-if="firstNextState(request) && drafts[request.id]" class="update-form" @submit.prevent="updateRequest(request)">
            <label class="field">下一個狀態
              <select v-model="drafts[request.id]!.state" required @change="renewIdempotency(request.id)">
                <option v-for="state in transitions[request.state]" :key="state" :value="state">{{ stateLabels[state] }}</option>
              </select>
            </label>
            <label class="field field--wide">給客戶看的處理說明
              <textarea v-model="drafts[request.id]!.reason" required maxlength="500" rows="3" placeholder="例如：已確認首頁圖片間距，預計明天下午完成。" @input="renewIdempotency(request.id)" />
            </label>
            <button type="submit" :disabled="updatingRequestId !== null || !drafts[request.id]!.reason.trim()">{{ updatingRequestId === request.id ? '更新中…' : '更新狀態' }}</button>
          </form>
          <p v-else class="terminal">這筆需求已結案，狀態不可再變更。</p>
        </article>
      </section>
    </template>
  </main>
</template>

<style scoped>
.care-owner-page{max-width:1120px;margin:0 auto;padding:clamp(1.25rem,4vw,3.5rem);color:#17253d}.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:2rem;margin-bottom:1.4rem}.hero h1{margin:.2rem 0;font-size:clamp(2.2rem,5vw,4rem);letter-spacing:-.04em}.hero>div>p:not(.eyebrow){max-width:720px;color:#5d6d7f;line-height:1.7}.hero nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5rem}.hero a,.care-owner-page button{border:1px solid #c5d1dd;border-radius:.65rem;background:#fff;color:#23466d;padding:.7rem .9rem;text-decoration:none;font:inherit;font-weight:750;cursor:pointer}.care-owner-page button{background:#244f78;color:#fff}.care-owner-page button:disabled{cursor:not-allowed;opacity:.5}.eyebrow{margin:0;color:#66809b;font-size:.68rem;font-weight:850;letter-spacing:.13em}.panel,.requests,.window,.scope-grid article{margin-top:1rem;padding:1.25rem;border:1px solid #d9e2eb;border-radius:1rem;background:#fff;box-shadow:0 12px 34px rgba(25,52,80,.05)}.panel-heading,.request-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.panel-heading h2,.request-heading h3{margin:.25rem 0 .9rem}.panel-heading>span,.muted{color:#64778b;font-size:.76rem}.field{display:grid;gap:.38rem;color:#344b64;font-size:.78rem;font-weight:800}.field select,.field textarea{width:100%;box-sizing:border-box;border:1px solid #c5d1dd;border-radius:.55rem;background:#fff;color:#17253d;padding:.72rem;font:inherit}.notice,.loading{margin:1rem 0;border-radius:.7rem;padding:.85rem 1rem}.notice--error{background:#ffebe8;color:#8d3027}.notice--success{background:#e8f6ed;color:#246640}.loading{background:#eef3f8;color:#425a74}.window{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(20rem,1fr);gap:2rem}.window--active{border-color:#95caa7;background:#f6fcf7}.window--expired{background:#f5f5f5}.window h2{margin:.3rem 0}.window p{color:#5d6d7f;line-height:1.7}.window dl,.timestamps{display:grid;gap:.7rem;margin:0}.window dl div,.timestamps div{display:grid;gap:.2rem}.window dt,.timestamps dt{color:#718195;font-size:.7rem;font-weight:800}.window dd,.timestamps dd{margin:0;overflow-wrap:anywhere}.scope-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.scope-grid article{margin:0;background:#f4faf6}.scope-grid .scope-excluded{background:#fff7ed}.scope-grid h2{margin-top:0;font-size:1rem}.scope-grid ul{margin-bottom:0;padding-left:1.2rem;line-height:1.8}.request-card{padding:1.25rem 0;border-top:1px solid #e1e7ed}.request-card:first-of-type{margin-top:1rem}.request-id{color:#718195;font-size:.7rem;font-weight:800}.state{border-radius:999px;padding:.35rem .6rem;background:#edf2f7;color:#52667a;font-size:.72rem;font-weight:800}.state--accepted,.state--in_progress{background:#e8f1ff;color:#295787}.state--completed{background:#e4f5ea;color:#246640}.state--declined{background:#ffebe8;color:#8d3027}.page-reference,.owner-reason{border-radius:.55rem;padding:.7rem;background:#f4f6f8;color:#53677b;font-size:.8rem}.description{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75}.timestamps{grid-template-columns:repeat(2,minmax(0,1fr));margin:.8rem 0}.update-form{display:grid;grid-template-columns:minmax(10rem,.45fr) minmax(18rem,1.55fr) auto;align-items:end;gap:.8rem;margin-top:1rem;padding:1rem;border-radius:.75rem;background:#f4f7fa}.field--wide textarea{resize:vertical}.terminal,.empty{color:#718296}.terminal{margin-bottom:0;font-size:.8rem}@media(max-width:760px){.hero{display:block}.hero nav{justify-content:flex-start;margin-top:1rem}.window,.scope-grid{grid-template-columns:1fr}.update-form{grid-template-columns:1fr}.timestamps{grid-template-columns:1fr}}
</style>
