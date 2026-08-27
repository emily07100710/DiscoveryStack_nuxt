<script setup lang="ts">
type Capability = 'website_generator' | 'payment' | 'domain_registration' | 'dns_tls' | 'deployment'
type Readiness = { capability: Capability; providerKey: string | null; status: string; configured: boolean; verified: boolean; credentialReferenceConfigured: boolean; credentialResolvable: boolean; liveMutationAllowed: boolean; missing: string[]; blockedReasonCode: string | null; verifiedAt: string | null }
type Workspace = {
  readiness: { capabilities: Readiness[]; liveReady: boolean; dryRunAllowed: boolean; mockedAllowed: boolean; truthfulBoundary: string[] }
  projects: Array<{ project: any; candidates: any[]; releases: any[]; attempts: any[]; receipts: any[] }>
  nextSafeActions: Array<{ capability: Capability; action: string; blocked: boolean }>
  executionModes: { dryRun: boolean; mocked: boolean; live: boolean }
  authority: Record<string, boolean>
  limitations: string[]
}

definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: 'Managed Sites · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const emptyWorkspace = (): Workspace => ({ readiness: { capabilities: [], liveReady: false, dryRunAllowed: true, mockedAllowed: false, truthfulBoundary: [] }, projects: [], nextSafeActions: [], executionModes: { dryRun: true, mocked: false, live: false }, authority: {}, limitations: [] })
const workspaceEndpoint: string = '/api/managed-sites/live-connectors/workspace'
const { data, pending, error, refresh } = await useAsyncData<Workspace>('managed-site-live-connectors', () => $fetch<Workspace>(workspaceEndpoint), { server: false, default: emptyWorkspace })
const workspace = computed(() => data.value || emptyWorkspace())
const saving = ref(false)
const notice = ref('')
const failure = ref('')
const form = reactive<{ capability: Capability; providerKey: string; readinessStatus: 'disabled' | 'configured'; credentialReference: string; endpointOrigin: string; model: string }>({ capability: 'website_generator', providerKey: '', readinessStatus: 'disabled', credentialReference: '', endpointOrigin: '', model: '' })
const capabilityLabels: Record<Capability, string> = { website_generator: 'AI 網站生成', payment: '付款', domain_registration: '網域註冊', dns_tls: 'DNS / TLS', deployment: '部署' }

async function configureProvider() {
  saving.value = true; notice.value = ''; failure.value = ''
  try {
    const transportConfiguration: Record<string, string> = {}
    if (form.endpointOrigin.trim()) transportConfiguration.endpointOrigin = form.endpointOrigin.trim()
    if (form.model.trim()) transportConfiguration.model = form.model.trim()
    await $fetch('/api/managed-sites/live-connectors/provider-configurations', { method: 'POST', body: { capability: form.capability, providerKey: form.providerKey.trim(), readinessStatus: form.readinessStatus, credentialReference: form.readinessStatus === 'configured' ? form.credentialReference.trim() : null, transportConfiguration, idempotencyKey: crypto.randomUUID() } })
    notice.value = 'Provider reference 已保存；configured 仍不代表 verified。'
    await refresh()
  } catch (caught: any) { failure.value = caught?.data?.message || 'Provider reference 未保存，沒有 live authority 被啟用。' }
  finally { saving.value = false }
}

async function generationDryRun(project: any) {
  if (!project.project.activeVersionId) return
  saving.value = true; notice.value = ''; failure.value = ''
  try {
    const result: any = await $fetch(`/api/managed-sites/projects/${project.project.id}/live-generation`, { method: 'POST', body: { sourceVersionId: project.project.activeVersionId, executionMode: 'dry_run', idempotencyKey: `dry-${crypto.randomUUID()}` } })
    notice.value = `Dry-run 完成：${result.request?.requestFingerprint || 'request validated'}；沒有外部呼叫或部署。`
    await refresh()
  } catch (caught: any) { failure.value = caught?.data?.message || 'Dry-run 未完成。' }
  finally { saving.value = false }
}

const statusClass = (status: string) => status === 'verified' || status === 'live_verified' || status === 'geo_active' ? 'status status--ready' : status === 'blocked' || status === 'failed' || status === 'retry_wait' ? 'status status--blocked' : 'status'
</script>

<template>
  <main class="workbench">
    <header class="hero">
      <div><p class="eyebrow">OWNER ONLY / LIVE CONNECTORS V1</p><h1>Managed AI Website + GEO</h1><p>這裡顯示 provider、生成候選、付款、網域、DNS/TLS、部署與 GEO 啟用的真實 receipt 狀態。意圖、configured 或瀏覽器回傳都不算成功。</p></div>
      <button type="button" :disabled="pending || saving" @click="refresh">重新整理</button>
    </header>

    <p v-if="error" class="alert alert--error">Owner workspace 無法載入；沒有任何外部操作被執行。</p>
    <p v-if="notice" class="alert" role="status">{{ notice }}</p>
    <p v-if="failure" class="alert alert--error" role="alert">{{ failure }}</p>

    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">READINESS</p><h2>五項 server capability</h2></div><span :class="statusClass(workspace.readiness.liveReady ? 'verified' : 'blocked')">{{ workspace.readiness.liveReady ? 'LIVE READY' : 'FAIL CLOSED' }}</span></div>
      <div class="capability-grid">
        <article v-for="item in workspace.readiness.capabilities" :key="item.capability" class="card">
          <p class="eyebrow">{{ capabilityLabels[item.capability] }}</p><h3>{{ item.providerKey || '未設定 provider' }}</h3>
          <p :class="statusClass(item.status)">{{ item.status }}</p>
          <dl><div><dt>credential reference</dt><dd>{{ item.credentialReferenceConfigured ? '已設定（值不顯示）' : '缺少' }}</dd></div><div><dt>server verified</dt><dd>{{ item.verified ? '是' : '否' }}</dd></div><div><dt>live mutation</dt><dd>{{ item.liveMutationAllowed ? '允許' : '拒絕' }}</dd></div></dl>
          <p v-if="item.missing.length" class="muted">缺少：{{ item.missing.join('、') }}</p>
        </article>
      </div>
    </section>

    <section class="panel">
      <p class="eyebrow">OWNER CONFIGURATION REQUIRED</p><h2>保存 opaque reference</h2><p class="muted">此表單不接受 API key、token、webhook secret 或 credential value。真正 credential 只能由 server runtime registry 注入。</p>
      <form class="config-form" @submit.prevent="configureProvider">
        <label>Capability<select v-model="form.capability"><option v-for="(_, key) in capabilityLabels" :key="key" :value="key">{{ capabilityLabels[key as Capability] }}</option></select></label>
        <label>Provider key<input v-model="form.providerKey" required maxlength="96" placeholder="bailian-qwen" /></label>
        <label>狀態<select v-model="form.readinessStatus"><option value="disabled">disabled</option><option value="configured">configured</option></select></label>
        <label>Opaque credential reference<input v-model="form.credentialReference" :required="form.readinessStatus === 'configured'" maxlength="160" placeholder="vault:managed-qwen-prod" autocomplete="off" /></label>
        <label>HTTPS endpoint（非 secret）<input v-model="form.endpointOrigin" maxlength="2048" placeholder="https://provider.example/v1" /></label>
        <label>Model（可選）<input v-model="form.model" maxlength="128" placeholder="qwen-plus" /></label>
        <button type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存 reference' }}</button>
      </form>
    </section>

    <section v-for="row in workspace.projects" :key="row.project.id" class="panel">
      <div class="section-title"><div><p class="eyebrow">PROJECT {{ row.project.id }}</p><h2>{{ row.project.canonicalClientIdentity }}</h2><p class="muted">{{ row.project.canonicalWebsiteIdentity }}</p></div><button type="button" :disabled="saving || !row.project.activeVersionId" @click="generationDryRun(row)">Generation dry-run</button></div>
      <div class="summary-grid"><div><strong>{{ row.candidates.length }}</strong><span>immutable candidates</span></div><div><strong>{{ row.releases.length }}</strong><span>release projections</span></div><div><strong>{{ row.attempts.length }}</strong><span>bounded attempts</span></div><div><strong>{{ row.receipts.length }}</strong><span>verified / ignored receipts</span></div></div>
      <div v-if="row.releases.length" class="table-wrap"><table><thead><tr><th>Release</th><th>種類</th><th>狀態</th><th>Domain</th><th>下一安全動作</th><th>Blocked reason</th></tr></thead><tbody><tr v-for="release in row.releases" :key="release.id"><td>#{{ release.id }}</td><td>{{ release.releaseKind }}</td><td><span :class="statusClass(release.status)">{{ release.status }}</span></td><td>{{ release.canonicalDomain }}</td><td>{{ release.nextSafeAction }}</td><td>{{ release.blockedReasonCode || '—' }}</td></tr></tbody></table></div>
      <div v-if="row.attempts.some((attempt: any) => attempt.status === 'retry_wait' || attempt.status === 'failed')" class="attempts"><h3>需要安全處理的 attempts</h3><p v-for="attempt in row.attempts.filter((item: any) => item.status === 'retry_wait' || item.status === 'failed')" :key="attempt.id">#{{ attempt.id }} · {{ attempt.operation }} · {{ attempt.status }} · attempt {{ attempt.attemptNumber }}/{{ attempt.maxAttempts }} · {{ attempt.errorCode }} · {{ attempt.retryEligibleAt || '不可再自動重試' }}</p></div>
    </section>

    <section class="panel boundary"><p v-for="item in workspace.limitations" :key="item">{{ item }}</p></section>
  </main>
</template>

<style scoped>
.workbench{padding:3rem clamp(1rem,4vw,4rem);display:grid;gap:1.2rem}.hero,.section-title{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem}.hero{padding:2rem;border-radius:1rem;background:#121b2a;color:#fff}.hero p{max-width:55rem;color:#bdc8d7;line-height:1.65}.eyebrow{margin:0 0 .45rem;color:#5572a8;font:800 .68rem/1.2 ui-monospace,monospace;letter-spacing:.12em}.hero .eyebrow{color:#8eb7ec}h1{margin:0;font-size:clamp(2rem,5vw,4rem)}h2,h3{margin:.2rem 0}.panel{padding:1.4rem;border:1px solid #d9e0e8;border-radius:.9rem;background:#fff}.capability-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.75rem;margin-top:1rem}.card{padding:1rem;border:1px solid #e1e6ec;border-radius:.7rem}.status{display:inline-flex;padding:.25rem .5rem;border-radius:999px;background:#edf1f5;color:#46566e;font:800 .65rem/1.2 ui-monospace,monospace}.status--ready{background:#e3f4e9;color:#1f6a3b}.status--blocked{background:#fff0e6;color:#9a4e19}.muted{color:#6e7b8d}.config-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.8rem;margin-top:1rem}.config-form label{display:grid;gap:.35rem;color:#4a586b;font-size:.78rem}.config-form input,.config-form select{width:100%;padding:.7rem;border:1px solid #ccd5df;border-radius:.5rem;background:#fff}.config-form button,.hero button,.section-title button{align-self:end;border:0;border-radius:.55rem;padding:.75rem 1rem;background:#315bd6;color:#fff;font-weight:800}.summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.7rem;margin-top:1rem}.summary-grid div{display:grid;padding:.8rem;border-radius:.6rem;background:#f2f5f8}.summary-grid strong{font-size:1.5rem}.summary-grid span{color:#6e7b8d;font-size:.72rem}.table-wrap{overflow:auto;margin-top:1rem}table{width:100%;border-collapse:collapse;font-size:.76rem}th,td{padding:.65rem;text-align:left;border-bottom:1px solid #e4e8ed;white-space:nowrap}.attempts{margin-top:1rem;padding:1rem;border-radius:.6rem;background:#fff5ec;color:#704421}.alert{padding:.8rem 1rem;border-radius:.6rem;background:#e5f1ff}.alert--error{background:#ffebe8;color:#8d3027}.boundary{color:#5d6878;font-size:.78rem;line-height:1.6}@media(max-width:1100px){.capability-grid{grid-template-columns:repeat(2,1fr)}.config-form{grid-template-columns:1fr 1fr}}@media(max-width:700px){.hero,.section-title{display:block}.capability-grid,.config-form,.summary-grid{grid-template-columns:1fr}.hero button,.section-title button{margin-top:1rem}}
</style>
