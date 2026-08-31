<script setup lang="ts">
definePageMeta({ layout: 'owner' })
useHead({ title: '成效測量｜DiscoveryStack Private Workbench', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type Workspace = {
  clients: Array<{ id: number; displayName: string; canonicalSiteOrigin: string; timeZone: string }>
  connections: Array<Record<string, any> & { id: number; clientId: number; publicationTargetId: number | null; source: string; status: string; credentialConfigured: boolean; readiness: string }>
  runs: Array<Record<string, any> & { id: number; clientId: number; entryId: number; targetId: number; source: string; checkpointDays: number; state: string }>
  snapshots: Array<Record<string, any> & { id: number; runId: number; phase: string; sourceHash: string; scopeFingerprint: string; limitations: string[] }>
  checkpoints: Record<string, { state: string; baselineReady: boolean; followUpReady: boolean; outcomeStatus: string; limitations: string[] }>
  capabilities: { schedulerAvailable: boolean; realGoogleOAuth: boolean; realProviderCalls: boolean; outcomeCollectionConfigured: boolean }
  limitations: string[]
}

const workspace = ref<Workspace | null>(null)
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
const selectedClientId = ref<number | null>(null)
const actingConnectionId = ref<number | null>(null)

const selectedClient = computed(() => workspace.value?.clients.find(client => client.id === selectedClientId.value) || null)
const selectedConnections = computed(() => (workspace.value?.connections || []).filter(connection => selectedClientId.value === null || connection.clientId === selectedClientId.value))
const selectedRuns = computed(() => (workspace.value?.runs || []).filter(run => selectedClientId.value === null || run.clientId === selectedClientId.value))

function sourceLabel(source: string) {
  return source === 'google_search_console' ? 'Google Search Console' : source === 'first_party_analytics' ? 'GA4 第一方分析' : source === 'llm_visibility' ? 'LLM Visibility（API observation）' : source
}
function stateLabel(value: string) {
  const labels: Record<string, string> = { queued: '排隊中', processing: '處理中', retry_wait: '等待重試', succeeded: '完成', insufficient_data: '資料不足', blocked: '已阻擋', failed: '失敗', cancelled: '已取消', ready: '可用', not_ready: '尚未連接', paused: '已暫停', revoked: '已撤銷', needs_reauthorization: '需要重新授權', not_scheduled: '尚未排程' }
  return labels[value] || value
}
function outcomeLabel(value: string) {
  const labels: Record<string, string> = { not_ready: '尚未產生', ready: 'Outcome ready', partial: '部分資料', insufficient_data: '資料不足', blocked: '已阻擋' }
  return labels[value] || value
}
function pretty(value: unknown) {
  try { return JSON.stringify(value, null, 2) } catch { return '不可顯示' }
}
function runSnapshots(runId: number) { return (workspace.value?.snapshots || []).filter(snapshot => snapshot.runId === runId) }
function connectionNotice(connection: Record<string, any>) {
  if (connection.status === 'revoked') return '已撤銷；不會建立新的 provider request。'
  if (connection.status === 'paused') return '已暫停；恢復前不會執行。'
  if (connection.source !== 'llm_visibility' && !connection.credentialConfigured) return '尚未連接；尚未配置 opaque credential reference。'
  if (connection.source === 'llm_visibility') return '已設定既有 visibility project；provider API observation 僅作 secondary-only evidence。'
  return '已配置 connection reference；實際 Google OAuth 尚未在本 V1 執行。'
}

async function loadWorkspace() {
  loading.value = true
  errorMessage.value = ''
  try {
    workspace.value = await $fetch<Workspace>('/api/measurement-collection/workspace')
    if (selectedClientId.value !== null && !workspace.value.clients.some(client => client.id === selectedClientId.value)) selectedClientId.value = null
  } catch (error: any) {
    workspace.value = null
    errorMessage.value = error?.data?.message || '工作台目前無法載入。'
  } finally { loading.value = false }
}

async function changeConnection(connection: Record<string, any>, action: 'pause' | 'revoke') {
  actingConnectionId.value = connection.id
  notice.value = ''
  errorMessage.value = ''
  try {
    await $fetch(`/api/measurement-collection/connections/${connection.id}/${action}`, { method: 'POST' })
    notice.value = action === 'pause' ? 'Connection 已暫停。' : 'Connection 已撤銷；歷史 snapshots 與 outcome lineage 保留。'
    await loadWorkspace()
  } catch (error: any) { errorMessage.value = error?.data?.message || 'Connection 狀態更新失敗。' }
  finally { actingConnectionId.value = null }
}

async function dryRun(run: Record<string, any>) {
  notice.value = ''
  errorMessage.value = ''
  try {
    const result = await $fetch(`/api/measurement-collection/runs/${run.id}/dry-run`, { method: 'POST' })
    notice.value = `Dry-run 完成：已產生 ${Array.isArray((result as any)?.planned) ? (result as any).planned.length : 0} 筆 planned request metadata；未呼叫 provider。`
  } catch (error: any) { errorMessage.value = error?.data?.message || 'Dry-run 失敗。' }
}

onMounted(loadWorkspace)
</script>

<template>
  <section class="measurement-page">
    <div class="measurement-page__hero">
      <div>
        <p class="eyebrow">PRIVATE / MEASUREMENT COLLECTION</p>
        <h1>成效測量與 Outcome Automation</h1>
        <p class="lede">只呈現可追溯的 connection、measurement window、snapshot 與 outcome 狀態；本頁不推算排名、流量、AI 曝光、ROI 或轉換因果。</p>
      </div>
      <button class="button button--primary" type="button" :disabled="loading" @click="loadWorkspace">{{ loading ? '載入中…' : '重新整理' }}</button>
    </div>

    <p v-if="notice" class="notice notice--success" role="status">{{ notice }}</p>
    <p v-if="errorMessage" class="notice notice--error" role="alert">{{ errorMessage }}</p>
    <p v-if="loading" class="empty-state" role="status">正在載入 owner measurement workspace…</p>
    <p v-else-if="!workspace" class="empty-state">目前沒有可顯示的 workspace 資料。</p>

    <template v-else>
      <div class="toolbar">
        <label for="client-select">客戶／網站</label>
        <select id="client-select" v-model="selectedClientId">
          <option :value="null">全部 owner scope</option>
          <option v-for="client in workspace.clients" :key="client.id" :value="client.id">{{ client.displayName }} · {{ client.canonicalSiteOrigin }}</option>
        </select>
        <span v-if="selectedClient" class="toolbar__meta">timezone：{{ selectedClient.timeZone }}</span>
      </div>

      <div class="capability-grid">
        <article class="capability-card"><span class="card-label">Scheduler</span><strong>{{ workspace.capabilities.schedulerAvailable ? '可執行' : '未配置' }}</strong><small>每次 tick 最多 50 runs，使用 durable claim/lease。</small></article>
        <article class="capability-card"><span class="card-label">Google OAuth</span><strong>{{ workspace.capabilities.realGoogleOAuth ? '已執行' : 'NOT RUN' }}</strong><small>顯示部署是否已設定 Google service account 唯讀憑證；不代表 Google 端已授予存取權。</small></article>
        <article class="capability-card"><span class="card-label">Provider calls</span><strong>{{ workspace.capabilities.realProviderCalls ? '已執行' : 'NONE' }}</strong><small>畫面資料不代表真實 GSC、GA4 或 LLM provider validation。</small></article>
        <article class="capability-card"><span class="card-label">Outcome</span><strong>{{ workspace.capabilities.outcomeCollectionConfigured ? '已接既有 service' : '未配置' }}</strong><small>Outcome 仍透過既有 recordOwnerOutcomeAssessment()。</small></article>
      </div>

      <section class="panel">
        <div class="panel__heading"><div><p class="eyebrow">CONNECTIONS</p><h2>資料來源連接狀態</h2></div><span class="count">{{ selectedConnections.length }} connections</span></div>
        <p v-if="!selectedConnections.length" class="empty-inline">沒有資料，或尚未配置此 owner/site 的 measurement connection。</p>
        <div v-else class="connection-grid">
          <article v-for="connection in selectedConnections" :key="connection.id" class="connection-card">
            <div class="connection-card__top"><div><h3>{{ sourceLabel(connection.source) }}</h3><p>client #{{ connection.clientId }} · {{ connection.publicationTargetId ? `target #${connection.publicationTargetId}` : 'primary origin' }} · connection #{{ connection.id }}</p></div><span class="status-badge" :data-status="connection.readiness">{{ stateLabel(connection.readiness) }}</span></div>
            <dl class="facts"><div><dt>credentialReference</dt><dd>{{ connection.credentialConfigured ? '已配置 opaque reference（值不顯示）' : '尚未連接' }}</dd></div><div><dt>網站 scope</dt><dd>{{ connection.canonicalOrigin }}</dd></div><div><dt>source lag</dt><dd>{{ connection.sourceAvailabilityLagDays }} 天</dd></div><div><dt>connection status</dt><dd>{{ stateLabel(connection.status) }}</dd></div></dl>
            <p class="limitation">{{ connectionNotice(connection) }}</p>
            <div class="actions"><button v-if="connection.status === 'configured'" class="button" type="button" :disabled="actingConnectionId === connection.id" @click="changeConnection(connection, 'pause')">暫停</button><button v-if="connection.status !== 'revoked'" class="button button--danger" type="button" :disabled="actingConnectionId === connection.id" @click="changeConnection(connection, 'revoke')">撤銷</button></div>
          </article>
        </div>
      </section>

      <section class="panel">
        <div class="panel__heading"><div><p class="eyebrow">CHECKPOINT RUNS</p><h2>7／15／30／60／90 日狀態</h2></div><span class="count">{{ selectedRuns.length }} runs</span></div>
        <p v-if="!selectedRuns.length" class="empty-inline">尚未有已驗證 delivered publication 的 measurement runs。</p>
        <div v-else class="run-list">
          <article v-for="run in selectedRuns" :key="run.id" class="run-card">
            <div class="run-card__top"><div><h3>{{ sourceLabel(run.source) }} · {{ run.checkpointDays }} 天</h3><p>entry #{{ run.entryId }} · target #{{ run.targetId }} · run #{{ run.id }}</p></div><span class="status-badge" :data-status="run.state">{{ stateLabel(run.state) }}</span></div>
            <div class="run-card__grid"><div><span class="card-label">Baseline</span><strong>{{ new Date(run.baselineWindowStart).toLocaleDateString('zh-TW') }} – {{ new Date(run.baselineWindowEnd).toLocaleDateString('zh-TW') }}</strong></div><div><span class="card-label">Follow-up</span><strong>{{ new Date(run.followUpWindowStart).toLocaleDateString('zh-TW') }} – {{ new Date(run.followUpWindowEnd).toLocaleDateString('zh-TW') }}</strong></div><div><span class="card-label">Due</span><strong>{{ new Date(run.dueAt).toLocaleString('zh-TW') }}</strong></div><div><span class="card-label">Attempt</span><strong>{{ run.attemptNumber }}</strong></div></div>
            <div class="run-card__actions"><button class="button" type="button" :disabled="run.state === 'succeeded'" @click="dryRun(run)">Dry-run（不會呼叫 provider）</button></div>
            <details class="advanced"><summary>Advanced details</summary><div class="advanced__body"><dl class="facts"><div><dt>receipt fingerprint</dt><dd class="mono">{{ run.publicationReceiptFingerprint }}</dd></div><div><dt>content hash</dt><dd class="mono">{{ run.contentHash }}</dd></div><div><dt>evidence hash</dt><dd class="mono">{{ run.evidenceSnapshotHash }}</dd></div><div><dt>input fingerprint</dt><dd class="mono">{{ run.inputFingerprint }}</dd></div><div><dt>error</dt><dd>{{ run.errorCode || 'none' }}{{ run.errorSummary ? ` · ${run.errorSummary}` : '' }}</dd></div></dl><div v-for="snapshot in runSnapshots(run.id)" :key="snapshot.id" class="snapshot"><strong>{{ snapshot.phase }} snapshot · source hash {{ snapshot.sourceHash }}</strong><p class="mono">scope fingerprint：{{ snapshot.scopeFingerprint }}</p><p>limitations：{{ snapshot.limitations.join('、') || 'none' }}</p><pre>{{ pretty(snapshot.providerProvenance) }}</pre></div></div></details>
          </article>
        </div>
      </section>

      <section class="panel">
        <div class="panel__heading"><div><p class="eyebrow">TRUTHFUL LIMITATIONS</p><h2>政策與資料限制</h2></div></div>
        <ul class="limitations"><li v-for="limitation in workspace.limitations" :key="limitation">{{ limitation }}</li></ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.measurement-page{max-width:1180px;margin:0 auto;padding:clamp(1.25rem,3vw,3.5rem);color:#17253d}.measurement-page__hero{display:flex;justify-content:space-between;align-items:flex-end;gap:2rem;margin-bottom:1.4rem}.eyebrow{margin:0 0 .45rem;color:#55708e;font-size:.68rem;font-weight:800;letter-spacing:.14em}.measurement-page h1{max-width:800px;margin:0;color:#14243e;font-size:clamp(2rem,5vw,4.2rem);line-height:.98;letter-spacing:-.05em}.lede{max-width:720px;margin:1rem 0 0;color:#526174;font-size:1rem;line-height:1.7}.button{border:1px solid #c8d3df;border-radius:999px;background:#fff;color:#20324c;padding:.65rem .9rem;font:inherit;font-size:.78rem;font-weight:800;cursor:pointer}.button:hover,.button:focus-visible{border-color:#486d9d;outline:3px solid rgba(72,109,157,.18)}.button:disabled{cursor:not-allowed;opacity:.55}.button--primary{border-color:#1e4d79;background:#1e4d79;color:#fff}.button--danger{color:#a83f3f}.notice{border:1px solid;border-radius:12px;padding:.8rem 1rem;margin:0 0 1rem;font-size:.85rem}.notice--success{border-color:#9bc9b0;background:#effaf3;color:#205a38}.notice--error{border-color:#e3aaaa;background:#fff2f2;color:#873434}.empty-state,.empty-inline{border:1px dashed #b6c5d3;border-radius:14px;background:#fff;color:#637184;padding:1.5rem;text-align:center}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:.7rem;margin:1.25rem 0}.toolbar label{font-size:.75rem;font-weight:800}.toolbar select{min-width:min(100%,28rem);border:1px solid #c8d3df;border-radius:9px;background:#fff;padding:.65rem;color:#17253d;font:inherit}.toolbar__meta{color:#65748a;font-size:.75rem}.capability-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem;margin:1.25rem 0}.capability-card,.connection-card,.run-card,.panel{border:1px solid #dbe3eb;background:#fff;box-shadow:0 12px 35px rgba(27,51,78,.06)}.capability-card{min-height:8rem;border-radius:14px;padding:1rem}.card-label{display:block;color:#718196;font-size:.67rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.capability-card strong{display:block;margin:.35rem 0;color:#1b3858;font-size:1rem}.capability-card small{display:block;color:#637184;line-height:1.5}.panel{border-radius:18px;padding:clamp(1rem,2vw,1.5rem);margin-top:1.2rem}.panel__heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}.panel h2{margin:0;color:#172c48;font-size:1.2rem}.count{color:#6b7b8d;font-size:.72rem;font-weight:800}.connection-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.8rem}.connection-card,.run-card{border-radius:14px;padding:1rem}.connection-card__top,.run-card__top{display:flex;justify-content:space-between;align-items:flex-start;gap:.8rem}.connection-card h3,.run-card h3{margin:0;color:#193655;font-size:.95rem}.connection-card p,.run-card p{margin:.25rem 0 0;color:#718096;font-size:.73rem}.status-badge{display:inline-flex;align-items:center;border:1px solid #cbd6e2;border-radius:999px;padding:.28rem .55rem;color:#40546c;font-size:.66rem;font-weight:800;white-space:nowrap}.status-badge[data-status='ready'],.status-badge[data-status='succeeded']{border-color:#8fbca3;background:#effaf3;color:#205a38}.status-badge[data-status='not_ready'],.status-badge[data-status='insufficient_data'],.status-badge[data-status='retry_wait']{border-color:#d8bd84;background:#fff9eb;color:#745318}.status-badge[data-status='blocked'],.status-badge[data-status='failed'],.status-badge[data-status='revoked'],.status-badge[data-status='needs_reauthorization']{border-color:#dfa1a1;background:#fff2f2;color:#873434}.facts{margin:1rem 0 0}.facts div{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-top:1px solid #edf1f4}.facts dt{color:#7a8797;font-size:.68rem}.facts dd{margin:0;color:#30445d;font-size:.72rem;text-align:right;overflow-wrap:anywhere}.limitation{border-left:3px solid #9cb8d4;margin:1rem 0;padding-left:.65rem;color:#5d6c7e;font-size:.75rem;line-height:1.5}.actions,.run-card__actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.run-list{display:grid;gap:.8rem}.run-card__grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.8rem;margin-top:1rem}.run-card__grid strong{display:block;margin-top:.3rem;color:#334963;font-size:.76rem;line-height:1.4}.advanced{margin-top:1rem;border-top:1px solid #e7edf2;padding-top:.8rem}.advanced summary{color:#315a83;cursor:pointer;font-size:.76rem;font-weight:800}.advanced__body{margin-top:.6rem}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.66rem!important}.snapshot{margin-top:.75rem;border:1px solid #e3eaf0;border-radius:9px;background:#f8fafc;padding:.75rem}.snapshot pre{max-width:100%;overflow:auto;margin:.5rem 0 0;color:#506174;font-size:.65rem}.limitations{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem 1.5rem;margin:0;padding-left:1.2rem;color:#596a7d;font-size:.8rem;line-height:1.55}@media(max-width:920px){.capability-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.connection-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.run-card__grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.measurement-page__hero{display:block}.measurement-page__hero .button{margin-top:1rem}.capability-grid,.connection-grid,.limitations{grid-template-columns:1fr}.run-card__grid{grid-template-columns:1fr}.connection-card__top,.run-card__top{display:block}.status-badge{margin-top:.6rem}}
</style>
