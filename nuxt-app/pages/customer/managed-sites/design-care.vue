<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

useHead({ title: '30 天設計調整｜DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type CareStatus = 'not_started' | 'active' | 'expired'
type RequestState = 'submitted' | 'reviewing' | 'accepted' | 'in_progress' | 'completed' | 'declined'
type CareProjection = {
  project: { id: number; label: string }
  window: { status: CareStatus; startsAt: string | null; expiresAt: string | null; remainingDays: number; canSubmit: boolean; reason: string }
  allowedCategories: Array<{ key: string; label: string }>
  requests: Array<{ id: number; category: string; description: string; pageReference: string | null; state: RequestState; ownerReason: string | null; submittedAt: string; updatedAt: string }>
  boundaries: { included: readonly string[]; excluded: readonly string[] }
}
const fetchCare = $fetch as unknown as <T>(path: string, options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }) => Promise<T>

const care = ref<CareProjection | null>(null)
const loading = ref(true)
const submitting = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const requiresReaccess = ref(false)
const pendingIdempotencyKey = ref('')
const form = reactive({ category: 'layout', pageReference: '', description: '', scopeAcknowledged: false })

const statusLabel = computed(() => {
  if (care.value?.window.status === 'active') return `服務期間內，剩餘 ${care.value.window.remainingDays} 天`
  if (care.value?.window.status === 'expired') return '30 天服務期間已到期'
  return '尚未開始'
})
const requestStateLabel = (state: RequestState) => ({
  submitted: '已送出', reviewing: '確認中', accepted: '已接受', in_progress: '處理中', completed: '已完成', declined: '不在本次範圍',
} as Record<RequestState, string>)[state]
const categoryLabel = (key: string) => care.value?.allowedCategories.find(item => item.key === key)?.label || key
const displayDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-Hant-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'

async function loadCare() {
  loading.value = true
  errorMessage.value = ''
  requiresReaccess.value = false
  try {
    const loaded = await fetchCare<CareProjection>('/api/managed-sites/customer/design-care')
    care.value = loaded
    if (loaded.allowedCategories.length && !loaded.allowedCategories.some(item => item.key === form.category)) form.category = loaded.allowedCategories[0]!.key
  } catch (error: any) {
    care.value = null
    const status = error?.statusCode || error?.status || error?.response?.status
    requiresReaccess.value = status === 401
    errorMessage.value = status === 401 ? '登入已到期，請重新登入網站後台。' : '目前無法載入設計調整服務，請稍後再試。'
  } finally {
    loading.value = false
  }
}

async function submitRequest() {
  if (!care.value?.window.canSubmit || submitting.value) return
  submitting.value = true
  errorMessage.value = ''
  successMessage.value = ''
  if (!pendingIdempotencyKey.value) pendingIdempotencyKey.value = `design-care-${crypto.randomUUID()}`
  try {
    const result = await fetchCare<{ care: CareProjection }>('/api/managed-sites/customer/design-care', {
      method: 'POST',
      body: {
        category: form.category,
        description: form.description,
        pageReference: form.pageReference || null,
        scopeAcknowledged: form.scopeAcknowledged,
        idempotencyKey: pendingIdempotencyKey.value,
      },
    })
    care.value = result.care
    form.pageReference = ''
    form.description = ''
    form.scopeAcknowledged = false
    pendingIdempotencyKey.value = ''
    successMessage.value = '需求已安全送出。我們會在這裡更新處理狀態。'
  } catch (error: any) {
    const status = error?.statusCode || error?.status || error?.response?.status
    requiresReaccess.value = status === 401
    errorMessage.value = status === 401 ? '登入已到期，請重新登入後再送出。' : error?.data?.message || error?.statusMessage || '目前無法送出需求，請確認內容後再試。'
  } finally {
    submitting.value = false
  }
}

onMounted(loadCare)
</script>

<template>
  <main class="care-page">
    <header>
      <div><p class="eyebrow">CUSTOMER PORTAL / DESIGN CARE</p><h1>30 天設計調整</h1><p>正式交付後 30 天內，可提出既有網站的版面、色彩、字體與圖片安排調整。</p></div>
      <nav><NuxtLink to="/customer/managed-sites">回到網站管理</NuxtLink><button type="button" :disabled="loading" @click="loadCare">重新整理</button></nav>
    </header>

    <p v-if="loading" class="state" role="status">正在確認正式交付與服務期間…</p>
    <p v-else-if="errorMessage && !care" class="state error" role="alert">{{ errorMessage }} <NuxtLink v-if="requiresReaccess" to="/managed-site-access">重新登入</NuxtLink></p>

    <template v-else-if="care">
      <section class="window" :class="`window--${care.window.status}`">
        <div><p class="eyebrow">SERVICE WINDOW</p><h2>{{ statusLabel }}</h2><p>{{ care.project.label }}</p></div>
        <dl><div><dt>開始</dt><dd>{{ displayDate(care.window.startsAt) }}</dd></div><div><dt>到期</dt><dd>{{ displayDate(care.window.expiresAt) }}</dd></div></dl>
      </section>

      <section class="boundaries" aria-labelledby="care-boundaries">
        <h2 id="care-boundaries">本次服務範圍</h2>
        <div><article><h3>包含</h3><ul><li v-for="item in care.boundaries.included" :key="item">{{ item }}</li></ul></article><article class="excluded"><h3>不包含</h3><ul><li v-for="item in care.boundaries.excluded" :key="item">{{ item }}</li></ul></article></div>
        <p>服務期間只從通過付款、正式部署、客戶工作區與通知收據驗證的第一次交付開始；重新部署不會重算 30 天。</p>
      </section>

      <section v-if="care.window.canSubmit" class="request-form" aria-labelledby="care-request-title">
        <h2 id="care-request-title">提出設計調整</h2>
        <form @submit.prevent="submitRequest">
          <label>調整類別<select v-model="form.category" required><option v-for="item in care.allowedCategories" :key="item.key" :value="item.key">{{ item.label }}</option></select></label>
          <label>頁面位置（選填）<input v-model="form.pageReference" maxlength="240" placeholder="例如：首頁／服務介紹區"></label>
          <label>希望如何調整<textarea v-model="form.description" rows="6" maxlength="2000" required placeholder="請描述既有版面、顏色、字體或圖片安排要如何調整。"></textarea></label>
          <label class="ack"><input v-model="form.scopeAcknowledged" type="checkbox" required> 我確認這次需求不包含新增功能、頁面、系統或第三方串接。</label>
          <button type="submit" :disabled="submitting">{{ submitting ? '送出中…' : '送出調整需求' }}</button>
        </form>
      </section>
      <p v-else-if="care.window.status === 'not_started'" class="state">尚未找到完整的正式交付收據，因此 30 天服務尚未開始，也不會預先倒數。</p>
      <p v-else-if="care.window.status === 'expired'" class="state">服務期間已到期；既有需求仍保留在下方，新功能或後續調整可另行評估。</p>
      <p v-else class="state">你目前的網站角色可查看服務狀態，但不能送出調整需求。請聯絡網站管理員。</p>

      <p v-if="errorMessage" class="state error" role="alert">{{ errorMessage }} <NuxtLink v-if="requiresReaccess" to="/managed-site-access">重新登入</NuxtLink></p>
      <p v-if="successMessage" class="state success" role="status">{{ successMessage }}</p>

      <section class="requests" aria-labelledby="care-history-title">
        <h2 id="care-history-title">我的調整紀錄</h2>
        <p v-if="!care.requests.length" class="empty">目前沒有調整需求。</p>
        <article v-for="item in care.requests" :key="item.id">
          <div class="request-heading"><div><span>{{ categoryLabel(item.category) }}</span><h3>{{ item.pageReference || '網站整體' }}</h3></div><strong>{{ requestStateLabel(item.state) }}</strong></div>
          <p class="description">{{ item.description }}</p>
          <p v-if="item.ownerReason" class="owner-note">處理說明：{{ item.ownerReason }}</p>
          <time :datetime="item.updatedAt">送出 {{ displayDate(item.submittedAt) }} · 更新 {{ displayDate(item.updatedAt) }}</time>
        </article>
      </section>
    </template>
  </main>
</template>

<style scoped>
.care-page{max-width:68rem;margin:0 auto;padding:clamp(1.2rem,4vw,3.5rem);color:#192a40}header,.window,.request-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:1.2rem}header{margin-bottom:1.5rem}h1{font-size:clamp(2.2rem,5vw,4rem);margin:.35rem 0}h2{margin:.2rem 0 .8rem}h3{margin:.25rem 0}.eyebrow{font-size:.7rem;letter-spacing:.12em;font-weight:800;color:#5263a7}header p,.boundaries>p,time{color:#687486;line-height:1.7}.care-page a{color:#294d75}nav{display:flex;gap:.6rem;flex-wrap:wrap}nav a,button{padding:.75rem 1rem;border:1px solid #ccd5df;border-radius:.65rem;background:#fff;color:#224a73;text-decoration:none;font:inherit;cursor:pointer}button[type=submit]{background:#233f63;color:#fff;border-color:#233f63;font-weight:700}button:disabled{opacity:.6;cursor:wait}.window,.boundaries,.request-form,.requests{border:1px solid #dbe2eb;border-radius:.9rem;padding:1.4rem;margin:1rem 0;background:#fff}.window--active{border-color:#8fc9a5;background:#f4fbf6}.window--expired{background:#f7f7f7}.window dl{display:flex;gap:2rem;margin:0}.window dt{font-size:.72rem;color:#778293}.window dd{margin:.3rem 0;font-weight:700}.boundaries>div{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.boundaries article{padding:1rem;border-radius:.7rem;background:#f2f8f3}.boundaries .excluded{background:#fff6ec}.boundaries ul{padding-left:1.2rem;line-height:1.8}.request-form form{display:grid;gap:1rem}.request-form label{display:grid;gap:.45rem;font-weight:700}.request-form input,.request-form select,.request-form textarea{width:100%;padding:.8rem;border:1px solid #cbd4df;border-radius:.55rem;font:inherit;box-sizing:border-box}.request-form .ack{grid-template-columns:auto 1fr;align-items:start;font-weight:400;line-height:1.6}.request-form .ack input{width:auto;margin-top:.3rem}.request-form button{justify-self:start}.state{padding:1rem;border-radius:.7rem;background:#f4f6f8}.error{background:#fff0ee;color:#96382f}.success{background:#edf8f0;color:#27623e}.requests>article{border-top:1px solid #e2e7ed;padding:1.1rem 0}.request-heading span,.request-heading strong{font-size:.76rem;color:#5263a7}.description{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75}.owner-note{padding:.8rem;background:#f4f6f8;border-radius:.5rem}.empty{color:#778293}@media(max-width:700px){header,.window{display:block}nav,.window dl{margin-top:1rem}.boundaries>div{grid-template-columns:1fr}.window dl{display:grid;gap:.7rem}}
</style>
