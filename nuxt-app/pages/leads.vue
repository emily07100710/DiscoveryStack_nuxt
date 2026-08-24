<script setup lang="ts">
type LeadStatus = 'new' | 'contacted' | 'qualified' | 'closed'
type Lead = {
  id: number
  name: string
  email: string
  company: string
  website: string | null
  packageInterest: string
  language: string
  message: string | null
  recontactConsent: boolean
  modelImprovementConsent: boolean
  status: LeadStatus
  createdAt: string
}

definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: '客戶名單 · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const state = ref<'loading' | 'signin' | 'ready' | 'error'>('loading')
const leads = ref<Lead[]>([])
const filter = ref<'' | LeadStatus>('')
const savingId = ref<number | null>(null)
const message = ref('')
const labels: Record<LeadStatus, string> = { new: '新名單', contacted: '已聯絡', qualified: '適合合作', closed: '已結案' }
const interests: Record<string, string> = { discover: '讓需求找到我', clarify: '讓服務更清楚', grow: '推進轉換', unsure: '仍在釐清' }

async function loadLeads() {
  state.value = 'loading'
  message.value = ''
  try {
    const response = await $fetch<{ leads: Lead[] }>('/api/leads', { query: filter.value ? { status: filter.value } : {} })
    leads.value = response.leads
    state.value = 'ready'
  } catch (error: unknown) {
    const status = (error as { statusCode?: number, status?: number }).statusCode || (error as { status?: number }).status
    state.value = status === 401 || status === 403 ? 'signin' : 'error'
  }
}

function signIn() {
  window.location.assign(`/api/auth/login?origin=${encodeURIComponent(window.location.origin)}`)
}

async function updateStatus(lead: Lead, status: LeadStatus) {
  savingId.value = lead.id
  message.value = ''
  try {
    await $fetch(`/api/leads/${lead.id}`, { method: 'PATCH', body: { status } })
    lead.status = status
    if (filter.value && filter.value !== status) leads.value = leads.value.filter(item => item.id !== lead.id)
    message.value = '狀態已更新。'
  } catch {
    message.value = '目前無法更新，請稍後再試。'
  } finally {
    savingId.value = null
  }
}

async function revokeModelConsent(lead: Lead) {
  if (!window.confirm('確定要撤回這筆名單的模型改善同意？相關候選資料會立即退出可用資料集。')) return
  savingId.value = lead.id
  message.value = ''
  try {
    await $fetch(`/api/leads/${lead.id}`, { method: 'PATCH', body: { revokeModelImprovementConsent: true } })
    lead.modelImprovementConsent = false
    message.value = '模型改善同意已撤回，相關候選資料已停用。'
  } catch {
    message.value = '目前無法撤回同意，請稍後再試。'
  } finally {
    savingId.value = null
  }
}

onMounted(loadLeads)
</script>

<template>
  <section class="lead-admin" aria-labelledby="lead-admin-title">
    <header class="lead-admin-head">
      <div><p class="eyebrow">PRIVATE / LEAD DESK</p><h1 id="lead-admin-title">客戶留下資料後，<br><em>就在這裡接手。</em></h1><p>這裡只顯示已成功寫入資料庫的詢問。模型改善同意與行銷聯絡同意分開呈現，不會混在一起。</p></div>
      <nav aria-label="私有工具"><NuxtLink to="/training-pipeline">資料管線</NuxtLink><NuxtLink to="/audit-lab">稽核實驗室</NuxtLink><NuxtLink to="/ml-lab-preview">ML 工作台</NuxtLink></nav>
    </header>

    <div v-if="state === 'loading'" class="lead-state" aria-live="polite">正在讀取客戶名單…</div>
    <div v-else-if="state === 'signin'" class="lead-state"><h2>需要 owner 登入。</h2><p>客戶姓名、Email 與合作背景不是公開內容。</p><button type="button" @click="signIn">登入查看名單 ↗</button></div>
    <div v-else-if="state === 'error'" class="lead-state" role="alert"><h2>目前無法讀取名單。</h2><p>請確認資料庫與私有登入設定。</p></div>

    <template v-else>
      <div class="lead-toolbar">
        <label><span>名單狀態</span><select v-model="filter" @change="loadLeads"><option value="">全部</option><option v-for="(label, value) in labels" :key="value" :value="value">{{ label }}</option></select></label>
        <p>{{ leads.length }} 筆結果</p>
      </div>
      <p class="lead-message" role="status" aria-live="polite">{{ message }}</p>
      <div v-if="leads.length" class="lead-list">
        <article v-for="lead in leads" :key="lead.id">
          <header><div><small>#{{ lead.id }} · {{ new Date(lead.createdAt).toLocaleString('zh-TW') }}</small><h2>{{ lead.company }}</h2><p>{{ lead.name }} · <a :href="`mailto:${lead.email}`">{{ lead.email }}</a></p></div><span>{{ labels[lead.status] }}</span></header>
          <dl>
            <div><dt>需求</dt><dd>{{ interests[lead.packageInterest] || lead.packageInterest }}</dd></div>
            <div><dt>網站</dt><dd><a v-if="lead.website" :href="lead.website" target="_blank" rel="noopener noreferrer">{{ lead.website }}</a><span v-else>未提供</span></dd></div>
            <div><dt>後續聯絡</dt><dd>{{ lead.recontactConsent ? '已同意' : '只回覆本次詢問' }}</dd></div>
            <div><dt>模型改善</dt><dd>{{ lead.modelImprovementConsent ? '已另外同意' : '未同意' }} <button v-if="lead.modelImprovementConsent" class="lead-revoke" type="button" :disabled="savingId === lead.id" @click="revokeModelConsent(lead)">撤回</button></dd></div>
          </dl>
          <details v-if="lead.message"><summary>查看客戶背景</summary><pre>{{ lead.message }}</pre></details>
          <label class="lead-status"><span>更新處理狀態</span><select :value="lead.status" :disabled="savingId === lead.id" @change="updateStatus(lead, ($event.target as HTMLSelectElement).value as LeadStatus)"><option v-for="(label, value) in labels" :key="value" :value="value">{{ label }}</option></select></label>
        </article>
      </div>
      <div v-else class="lead-empty">目前沒有符合條件的名單。</div>
    </template>
  </section>
</template>

<style scoped>
.lead-admin{min-height:100vh;padding:clamp(7rem,12vw,10rem) max(1.25rem,calc((100vw - 76rem)/2));background:var(--paper);color:var(--ink)}
.lead-admin-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2rem;padding-bottom:clamp(2rem,5vw,4rem);border-bottom:1px solid var(--line)}.lead-admin-head h1{margin:.9rem 0 1.2rem;font-size:clamp(2.5rem,6vw,5.8rem);line-height:.98}.lead-admin-head h1 em{color:var(--cobalt);font-style:normal}.lead-admin-head p:last-child{max-width:44rem;color:var(--ink-mid)}.lead-admin-head nav{display:flex;gap:1rem}.lead-admin-head nav a{height:fit-content;color:var(--cobalt);font:500 .7rem/1.4 var(--font-mono)}
.lead-state,.lead-empty{margin-top:2rem;padding:2rem;border:1px solid var(--line);background:var(--sand)}.lead-state button{margin-top:1rem;border:0;background:var(--cobalt);color:var(--paper);padding:.9rem 1.1rem}.lead-toolbar{display:flex;justify-content:space-between;align-items:end;gap:1rem;padding:1.5rem 0}.lead-toolbar label{display:grid;gap:.4rem}.lead-toolbar span,.lead-status span{font:500 .65rem/1.3 var(--font-mono);letter-spacing:.08em;color:var(--ink-soft)}.lead-toolbar select,.lead-status select{border:1px solid var(--line);background:var(--paper);padding:.7rem;color:var(--ink)}.lead-message{min-height:1.4rem;color:var(--cobalt)}
.lead-list{display:grid;gap:1rem}.lead-list article{padding:clamp(1.25rem,3vw,2rem);border:1px solid var(--line);background:var(--sand)}.lead-list article>header{display:flex;justify-content:space-between;gap:1rem}.lead-list h2{margin:.3rem 0;font-size:clamp(1.4rem,3vw,2rem)}.lead-list small{font-family:var(--font-mono);color:var(--ink-soft)}.lead-list header>span{color:var(--cobalt);font:500 .68rem/1.3 var(--font-mono)}.lead-list dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin:1.5rem 0}.lead-list dt{color:var(--ink-soft);font:500 .62rem/1.3 var(--font-mono)}.lead-list dd{margin:.3rem 0 0;overflow-wrap:anywhere}.lead-list details{padding:1rem 0;border-top:1px solid var(--line)}.lead-list summary{cursor:pointer;color:var(--cobalt)}.lead-list pre{margin-top:1rem;white-space:pre-wrap;font:400 .82rem/1.6 var(--font-body)}.lead-status{display:flex;align-items:center;justify-content:flex-end;gap:.7rem;padding-top:1rem;border-top:1px solid var(--line)}
.lead-revoke{margin-left:.4rem;border:0;background:transparent;color:var(--cobalt);text-decoration:underline;cursor:pointer}
@media(max-width:48rem){.lead-admin-head{grid-template-columns:1fr}.lead-admin-head nav{flex-wrap:wrap}.lead-list dl{grid-template-columns:repeat(2,minmax(0,1fr))}.lead-list article>header{display:grid}.lead-status{justify-content:flex-start}}@media(max-width:30rem){.lead-list dl{grid-template-columns:1fr}}
</style>
