<script setup lang="ts">
definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: '系統工廠 · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const tabs = ['Overview', 'Requirements / SystemSpec', 'Templates / Modules', 'Preview', 'Quote / Payment', 'Provisioning timeline', 'Health', 'Users / Roles / Invitations', 'Integrations', 'Upgrade / Backup / Rollback', 'Audit / Receipts / Advanced']
const activeTab = ref(tabs[0])
const form = reactive({ requirements: '', clientId: '', websiteId: '', managedSiteProjectId: '', businessType: '', industry: '', preferredTemplate: 'light_crm' })
const saving = ref(false); const notice = ref(''); const failure = ref(''); const operationState = ref<'idle' | 'saving' | 'success' | 'error' | 'unauthorized' | 'retry_wait' | 'collision' | 'stale'>('idle')
const selectedSystemId = ref<number | null>(null)
const templatesData = ref<any>({ templates: [] }); const systemsData = ref<any>({ systems: [] }); const workspace = ref<any>(null)
const pending = ref(true); const error = ref<any>(null); const workspacePending = ref(false); const workspaceError = ref<any>(null)
const systems = computed(() => systemsData.value?.systems || [])
const selected = computed<any>(() => workspace.value as any)
const templatesEndpoint: string = '/api/system-factory/templates'; const systemsEndpoint: string = '/api/system-factory/systems?limit=50'; const draftsEndpoint: string = '/api/system-factory/drafts'

async function refresh() { pending.value = true; error.value = null; try { systemsData.value = await $fetch<any>(systemsEndpoint) } catch (caught) { error.value = caught } finally { pending.value = false } }
async function refreshWorkspace() { if (!selectedSystemId.value) { workspace.value = null; return }; workspacePending.value = true; workspaceError.value = null; try { const endpoint: string = `/api/system-factory/systems/${selectedSystemId.value}`; workspace.value = await $fetch<any>(endpoint) } catch (caught) { workspaceError.value = caught; workspace.value = null } finally { workspacePending.value = false } }
watch(selectedSystemId, refreshWorkspace)
onMounted(async () => { try { templatesData.value = await $fetch<any>(templatesEndpoint) } catch { templatesData.value = { templates: [] } }; await refresh() })

function classify(error: any) {
  const status = Number(error?.statusCode || error?.response?.status || 0); const message = String(error?.data?.message || error?.message || '')
  if (status === 401 || status === 403) return 'unauthorized' as const
  if (status === 409 && /collision|idempotency/i.test(message)) return 'collision' as const
  if (status === 409 && /stale|lease|retry/i.test(message)) return 'stale' as const
  return 'error' as const
}

async function createDraft() {
  saving.value = true; operationState.value = 'saving'; notice.value = ''; failure.value = ''
  try {
    const result: any = await $fetch(draftsEndpoint, { method: 'POST', body: { requirements: form.requirements, clientId: Number(form.clientId), websiteId: form.websiteId || null, managedSiteProjectId: form.managedSiteProjectId ? Number(form.managedSiteProjectId) : null, businessType: form.businessType, industry: form.industry, preferredTemplate: form.preferredTemplate, idempotencyKey: crypto.randomUUID() } })
    operationState.value = 'success'; notice.value = 'SystemSpec 與 synthetic preview 已建立；尚未報價、付款或部署。'; await refresh(); selectedSystemId.value = result.system.id
  } catch (caught: any) { operationState.value = classify(caught); failure.value = caught?.data?.message || '草稿未建立，沒有 provisioning 或外部寫入。' }
  finally { saving.value = false }
}

function truth(value: unknown, yes: string, no: string) { return value ? yes : no }
</script>

<template>
  <main class="factory">
    <header class="hero"><div><p class="eyebrow">OWNER ONLY / FRAPPE + ERPNEXT V16</p><h1>AI System Factory</h1><p>從需求、版本化 SystemSpec、互動預覽與 server quote，一路到 verified payment 後的隔離 Frappe site。預覽、意圖與 dry-run 都不會顯示成已部署。</p></div><button type="button" :disabled="pending" @click="refresh">重新整理</button></header>
    <nav class="tabs" aria-label="系統工廠區段"><button v-for="tab in tabs" :key="tab" type="button" :aria-pressed="activeTab === tab" @click="activeTab = tab">{{ tab }}</button></nav>
    <p v-if="pending" class="state" role="status">正在載入受治理系統清單…</p>
    <p v-else-if="error" class="state state--error" role="alert">無法載入 owner-scoped 系統；未執行任何外部操作。</p>
    <p v-if="notice" class="state state--success" role="status">{{ notice }}</p><p v-if="failure" class="state state--error" role="alert">{{ failure }}（狀態：{{ operationState }}）</p>

    <section v-if="activeTab === 'Overview'" class="panel">
      <div class="section-title"><div><p class="eyebrow">TRUTHFUL STATE</p><h2>系統與租戶</h2></div><span class="pill">{{ systems.length }} 個 repository records</span></div>
      <p v-if="!systems.length" class="empty">目前沒有系統。先建立需求草稿；這不會建立 Frappe site。</p>
      <div v-else class="cards"><button v-for="system in systems" :key="system.id" type="button" class="system-card" :aria-pressed="selectedSystemId === system.id" @click="selectedSystemId = system.id"><strong>{{ system.specId }}</strong><span>{{ system.status }}</span><small>client {{ system.clientId }} · website {{ system.websiteId || 'none' }}</small></button></div>
      <p v-if="workspacePending" class="state">載入 lineage、receipts 與 limitations…</p><p v-else-if="workspaceError" class="state state--error">選取的系統無法載入或不屬於目前 owner。</p>
      <div v-else-if="selected" class="facts"><div><span>SystemSpec</span><strong>v{{ selected.versions[0]?.version || '—' }}</strong></div><div><span>Preview</span><strong>{{ selected.previews[0]?.status || '未建立' }}</strong></div><div><span>Payment</span><strong>{{ selected.tenant?.verifiedPaymentReceiptFingerprint ? 'server verified' : '未驗證' }}</strong></div><div><span>Tenant</span><strong>{{ selected.tenant?.state || '未 provision' }}</strong></div><div><span>Health</span><strong>{{ truth(selected.tenant?.healthyReceiptFingerprint, 'receipt verified', '未驗證') }}</strong></div><div><span>Invitation</span><strong>{{ truth(selected.tenant?.invitationReceiptFingerprint, '已建立', '未建立') }}</strong></div></div>
    </section>

    <section v-if="activeTab === 'Requirements / SystemSpec'" class="panel">
      <p class="eyebrow">GUIDED DETERMINISTIC FALLBACK</p><h2>建立需求草稿</h2><p class="muted">LLM 未設定時使用 deterministic guided scaffold；任何 provider output 都會再次 schema、allowlist、normalize 與 fingerprint。</p>
      <form class="form" @submit.prevent="createDraft"><label>需求<textarea v-model="form.requirements" required minlength="8" maxlength="8000" rows="7" placeholder="描述 CRM、預約、庫存或專案流程…" /></label><label>Content Operations client ID<input v-model="form.clientId" required inputmode="numeric" /></label><label>Website ID（可留空，server 會綁定 client）<input v-model="form.websiteId" maxlength="128" /></label><label>Managed Site project ID（既有網站加購可填）<input v-model="form.managedSiteProjectId" inputmode="numeric" /></label><label>Business type<input v-model="form.businessType" required maxlength="120" /></label><label>Industry<input v-model="form.industry" required maxlength="120" /></label><label>Template<select v-model="form.preferredTemplate"><option v-for="template in templatesData.templates" :key="template.key" :value="template.key">{{ template.label }}</option></select></label><button type="submit" :disabled="saving">{{ saving ? '保存中…' : '建立 SystemSpec + Preview' }}</button></form>
    </section>

    <section v-if="activeTab === 'Templates / Modules'" class="panel"><p class="eyebrow">ALLOWLIST CATALOG</p><h2>模板能力矩陣</h2><div class="template-grid"><article v-for="template in templatesData.templates" :key="template.key"><h3>{{ template.label }}</h3><p>{{ template.key }}</p><dl><dt>Capabilities</dt><dd>{{ template.capabilities.join(', ') || 'custom bounded only' }}</dd><dt>Required entities</dt><dd>{{ template.requiredEntities.join(', ') || 'reviewed custom entities' }}</dd><dt>ERPNext modules</dt><dd>{{ template.erpNextModules.join(', ') || 'none' }}</dd><dt>Limitations</dt><dd>{{ template.limitations.join(' ') }}</dd></dl></article></div></section>

    <section v-if="activeTab === 'Preview'" class="panel"><p class="eyebrow">INTERACTIVE PREVIEW / NOT DEPLOYED</p><h2>只含 synthetic demo data</h2><p class="warning">未連真實 ERP、付款、發票或 LINE；任何數字都不是客戶 KPI。</p><pre v-if="selected?.previews?.[0]">{{ JSON.stringify(selected.previews[0].fixtureProjection, null, 2) }}</pre><p v-else class="empty">選取一個有 preview 的系統。</p></section>

    <section v-if="activeTab === 'Quote / Payment'" class="panel"><p class="eyebrow">EXISTING COMMERCE AUTHORITY</p><h2>Managed Site server quote 與 verified receipt</h2><p>本頁不接受價格或 paid 狀態。quote/order/payment 必須從既有 Managed Site server authority 與 signature-verified payment event 取得。</p><div class="facts"><div><span>Browser may mark paid</span><strong>否</strong></div><div><span>Order intent</span><strong>{{ selected?.binding?.managedSiteDraftOrderId ? `#${selected.binding.managedSiteDraftOrderId}` : '未綁定' }}</strong></div><div><span>Verified payment</span><strong>{{ selected?.tenant?.verifiedPaymentReceiptFingerprint ? 'receipt verified' : '未驗證' }}</strong></div></div></section>

    <section v-if="activeTab === 'Provisioning timeline'" class="panel"><p class="eyebrow">DURABLE / LEASED / BOUNDED</p><h2>Provisioning timeline</h2><ol class="timeline"><li v-for="step in ['create site', 'install pinned ERPNext + DiscoveryStack app', 'apply compiled spec', 'roles and permissions', 'modules', 'health check', 'one-time admin invitation']" :key="step">{{ step }}</li></ol><p class="muted">付款前不執行；最多三次、bounded exponential retry、stale lease recovery、每步 exact receipt。</p></section>

    <section v-if="activeTab === 'Health'" class="panel"><p class="eyebrow">FAIL CLOSED</p><h2>Health</h2><p>{{ selected?.tenant?.healthyReceiptFingerprint ? `已驗證 receipt ${selected.tenant.healthyReceiptFingerprint}` : '沒有 verified health receipt，因此不得顯示 healthy 或建立 invitation。' }}</p></section>
    <section v-if="activeTab === 'Users / Roles / Invitations'" class="panel"><p class="eyebrow">HASHED ONE-TIME TOKEN</p><h2>Users / Roles / Invitations</h2><p>只有 health 通過後可建立一次性 invitation。資料庫只保存 token hash；Frappe Administrator credential 永不送到 browser。</p><p>{{ selected?.invitations?.length || 0 }} 個 invitation records</p></section>
    <section v-if="activeTab === 'Integrations'" class="panel"><p class="eyebrow">OPAQUE CONNECTION REFERENCES</p><h2>Integrations</h2><p>所有 credential 都是 server-only opaque reference。Content projection 的真實 write 預設關閉，仍須走既有 risk/review/autopilot/publication receipt。</p></section>
    <section v-if="activeTab === 'Upgrade / Backup / Rollback'" class="panel"><p class="eyebrow">REVIEWED INTENT ONLY</p><h2>Upgrade / Backup / Rollback</h2><p>沒有 remote self-updater。每次 upgrade 先保存 reviewed version-lock intent 與 backup receipt；驗證失敗才產生 rollback receipt，原版本維持 active。</p><p>{{ selected?.upgrades?.intents?.length || 0 }} 個 reviewed intents</p></section>
    <section v-if="activeTab === 'Audit / Receipts / Advanced'" class="panel"><p class="eyebrow">APPEND-ONLY LEDGER</p><h2>Audit / Receipts / Advanced</h2><p v-if="!selected">選取一個系統以檢視 secret-free receipts。</p><div v-else class="receipt-list"><p v-for="receipt in selected.receipts" :key="receipt.receiptId"><strong>{{ receipt.receiptType }}</strong><span>{{ receipt.status }} · {{ receipt.receiptFingerprint }}</span></p><p v-if="!selected.receipts.length">尚無 provisioning receipt；這不代表部署或 health。</p></div></section>
  </main>
</template>

<style scoped>
.factory{padding:clamp(1rem,4vw,3.5rem);max-width:92rem;margin:auto}.hero,.section-title{display:flex;justify-content:space-between;align-items:flex-end;gap:1.5rem}.hero h1{margin:.2rem 0;font:900 clamp(2.5rem,6vw,5rem)/.95 Georgia,serif}.hero p{max-width:62rem;color:#596579;line-height:1.7}.eyebrow{margin:0;color:#4d5dad;font:700 .7rem/1.2 ui-monospace,monospace;letter-spacing:.12em}.tabs{display:flex;gap:.45rem;overflow:auto;padding:1rem 0;margin:1.5rem 0;border-block:1px solid #d8dee7}.tabs button,.hero button,.form button{border:1px solid #c8d0dc;border-radius:999px;background:white;padding:.65rem .85rem;white-space:nowrap}.tabs button[aria-pressed=true],.form button{background:#17253d;color:white}.panel{margin:1rem 0;padding:clamp(1rem,3vw,2rem);border:1px solid #dde2e9;border-radius:1rem;background:#fff}.panel h2{margin:.35rem 0 1rem;font:800 1.7rem/1.15 Georgia,serif}.state,.empty,.warning{padding:1rem;border-radius:.7rem;background:#eef2f7}.state--error{background:#fff0ee;color:#8a2b24}.state--success{background:#edf7ef;color:#27613f}.warning{background:#fff4de;color:#76510c}.cards,.template-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.8rem}.system-card,.template-grid article{display:grid;gap:.4rem;text-align:left;padding:1rem;border:1px solid #dde2e9;border-radius:.75rem;background:#f8fafc}.system-card[aria-pressed=true]{border-color:#4d5dad;box-shadow:0 0 0 2px #dce4ff}.system-card span,.system-card small,.muted{color:#667286}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.7rem;margin-top:1rem}.facts div{display:grid;gap:.35rem;padding:.85rem;background:#f4f6f8;border-radius:.65rem}.facts span{font-size:.72rem;color:#667286}.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.form label{display:grid;gap:.35rem;font-size:.8rem;font-weight:700}.form label:first-child{grid-column:1/-1}.form input,.form textarea,.form select{border:1px solid #cfd6df;border-radius:.55rem;padding:.75rem;font:inherit}.form button{width:max-content;border:0}.template-grid dl{display:grid;gap:.25rem}.template-grid dt{font-size:.68rem;text-transform:uppercase;color:#6a7586}.template-grid dd{margin:0 0 .7rem;line-height:1.5}.timeline{display:grid;gap:.6rem}.timeline li{padding:.65rem;border-left:3px solid #4d5dad;background:#f5f7fb}.receipt-list p{display:grid;gap:.2rem;border-bottom:1px solid #e2e7ed;padding:.7rem 0;overflow-wrap:anywhere}pre{max-height:38rem;overflow:auto;padding:1rem;background:#101319;color:#e8edf5;border-radius:.7rem;font-size:.72rem}@media(max-width:700px){.hero,.section-title{align-items:flex-start;flex-direction:column}.form{grid-template-columns:1fr}.form label:first-child{grid-column:auto}}
</style>
