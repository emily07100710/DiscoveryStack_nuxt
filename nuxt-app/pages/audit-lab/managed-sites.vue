<script setup lang="ts">
type Capability = 'website_generator' | 'payment' | 'domain_registration' | 'dns_tls' | 'deployment'
type Readiness = { capability: Capability; providerKey: string | null; status: string; configured: boolean; verified: boolean; credentialReferenceConfigured: boolean; credentialResolvable: boolean; liveMutationAllowed: boolean; missing: string[]; blockedReasonCode: string | null; verifiedAt: string | null }
type Workspace = {
  readiness: { capabilities: Readiness[]; liveReady: boolean; dryRunAllowed: boolean; mockedAllowed: boolean; truthfulBoundary: string[] }
  projects: Array<{ project: any; prePurchaseBinding: any | null; candidates: any[]; releases: any[]; attempts: any[]; receipts: any[] }>
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
const operationStates = reactive<Record<string, 'idle' | 'loading' | 'success' | 'error' | 'blocked' | 'retry_wait'>>({})
const form = reactive<{ capability: Capability; providerKey: string; readinessStatus: 'disabled' | 'configured'; credentialReference: string; endpointOrigin: string; model: string }>({ capability: 'website_generator', providerKey: '', readinessStatus: 'disabled', credentialReference: '', endpointOrigin: '', model: '' })
const conversion = reactive({ previewId: '', quoteId: '', leadIntentId: '', draftOrderId: '' })
const domains = reactive<Record<number, string>>({})
const rollbacks = reactive<Record<number, { fromReleaseId: string; toReleaseId: string }>>({})
watchEffect(() => { for (const row of workspace.value.projects) rollbacks[row.project.id] ||= { fromReleaseId: '', toReleaseId: '' } })
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

async function verifyProvider(item: Readiness) {
  const key = `verify-${item.capability}`; operationStates[key] = 'loading'; failure.value = ''; notice.value = ''
  try { await $fetch(`/api/managed-sites/live-connectors/providers/${item.capability}/verify`, { method: 'POST', body: {} }); operationStates[key] = 'success'; notice.value = `${capabilityLabels[item.capability]} connection verification receipt 已保存。`; await refresh() }
  catch (caught: any) { operationStates[key] = 'blocked'; failure.value = caught?.data?.message || 'Provider verification fail closed；設定仍不等於 verified。' }
}

async function convertPrePurchase() {
  const key = 'prepurchase'; operationStates[key] = 'loading'; failure.value = ''; notice.value = ''
  try { const result: any = await $fetch('/api/managed-sites/projects/prepurchase', { method: 'POST', body: { previewId: Number(conversion.previewId), quoteId: Number(conversion.quoteId), leadIntentId: Number(conversion.leadIntentId), draftOrderId: Number(conversion.draftOrderId), idempotencyKey: crypto.randomUUID() } }); operationStates[key] = 'success'; notice.value = `Draft project #${result.projectId} 已建立；未付款、未啟用訂閱。`; await refresh() }
  catch (caught: any) { operationStates[key] = 'error'; failure.value = caught?.data?.message || 'Pre-purchase lineage conversion 未完成。' }
}

async function generationDryRun(project: any) {
  const sourceVersionId = project.prePurchaseBinding?.sourceVersionId || project.project.activeVersionId
  if (!sourceVersionId) return
  saving.value = true; notice.value = ''; failure.value = ''
  try {
    const result: any = await $fetch(`/api/managed-sites/projects/${project.project.id}/live-generation`, { method: 'POST', body: { sourceVersionId, executionMode: 'dry_run', idempotencyKey: `dry-${crypto.randomUUID()}` } })
    notice.value = `Dry-run 完成：${result.request?.requestFingerprint || 'request validated'}；沒有外部呼叫或部署。`
    await refresh()
  } catch (caught: any) { failure.value = caught?.data?.message || 'Dry-run 未完成。' }
  finally { saving.value = false }
}

async function generateCandidate(row: any) {
  const key = `generation-${row.project.id}`; operationStates[key] = 'loading'; failure.value = ''; notice.value = ''
  try { await $fetch(`/api/managed-sites/projects/${row.project.id}/live-generation`, { method: 'POST', body: { sourceVersionId: row.prePurchaseBinding?.sourceVersionId, executionMode: 'live', idempotencyKey: crypto.randomUUID() } }); operationStates[key] = 'success'; notice.value = 'Immutable generation candidate 已保存；尚未部署。'; await refresh() }
  catch (caught: any) { operationStates[key] = 'blocked'; failure.value = caught?.data?.message || 'Generation blocked；沒有 provider authority 被接受。' }
}

async function createRelease(row: any, candidate: any) {
  const key = `release-${candidate.id}`; operationStates[key] = 'loading'; failure.value = ''; notice.value = ''
  try { await $fetch(`/api/managed-sites/projects/${row.project.id}/releases/generated`, { method: 'POST', body: { generationCandidateId: candidate.id, canonicalDomain: domains[row.project.id] || '', targetKey: 'production-primary', idempotencyKey: crypto.randomUUID() } }); operationStates[key] = 'success'; notice.value = 'Immutable release candidate 已建立；尚未付款或部署。'; await refresh() }
  catch (caught: any) { operationStates[key] = 'error'; failure.value = caught?.data?.message || 'Release candidate 未建立。' }
}

async function createExistingRelease(row: any) {
  const key = `existing-${row.project.id}`; operationStates[key] = 'loading'; failure.value = ''; notice.value = ''
  try { await $fetch(`/api/managed-sites/projects/${row.project.id}/releases/existing`, { method: 'POST', body: { canonicalDomain: domains[row.project.id] || '', targetKey: 'existing-primary', idempotencyKey: crypto.randomUUID() } }); operationStates[key] = 'success'; notice.value = 'Existing-site ownership release 已建立；尚未驗證 ownership。'; await refresh() }
  catch (caught: any) { operationStates[key] = 'error'; failure.value = caught?.data?.message || 'Existing-site release 未建立。' }
}

async function rollbackRelease(row: any) {
  const key = `rollback-${row.project.id}`; const input = rollbacks[row.project.id]; operationStates[key] = 'loading'; failure.value = ''; notice.value = ''
  try { await $fetch(`/api/managed-sites/projects/${row.project.id}/releases/rollback`, { method: 'POST', body: { fromReleaseId: Number(input?.fromReleaseId), toReleaseId: Number(input?.toReleaseId), executionMode: 'live', idempotencyKey: crypto.randomUUID() } }); operationStates[key] = 'success'; notice.value = 'Rollback provider receipt 已驗證並更新 release projection。'; await refresh() }
  catch (caught: any) { operationStates[key] = 'blocked'; failure.value = caught?.data?.message || 'Rollback fail closed；live authority 未改變。'; await refresh() }
}

const actionLabels: Record<string, string> = { build_preview: '建立 preview 並執行 gates', inspect_preview_gates: '檢查 gates', approve_preview: '明確核准 preview', create_checkout_session: '建立 checkout', bind_verified_payment: '綁定 verified payment', quote_domain: '查詢網域報價', confirm_domain_purchase: '確認 purchase intent', configure_dns_tls: '執行 / 重試 DNS/TLS', deploy_production: '部署 production', retry_preview_after_eligibility: '重試 preview', retry_dns_tls_after_eligibility: '重試 DNS/TLS', retry_deployment_after_eligibility: '重試部署', verify_existing_site_ownership: '建立 ownership challenge', complete_existing_site_ownership_verification: '驗證 ownership', retry_ownership_after_eligibility: '重試 ownership', activate_geo: '啟用 GEO / Content Ops' }

async function performReleaseAction(row: any, release: any) {
  const key = `action-${release.id}`; operationStates[key] = 'loading'; failure.value = ''; notice.value = ''
  const base = `/api/managed-sites/projects/${row.project.id}/releases/${release.id}`
  const action = release.nextSafeAction
  try {
    if (action === 'inspect_preview_gates') await $fetch(`${base}/gates`)
    else if (action === 'approve_preview') await $fetch(`${base}/approve`, { method: 'POST', body: { idempotencyKey: crypto.randomUUID() } })
    else if (action === 'create_checkout_session') await $fetch(`${base}/checkout`, { method: 'POST', body: { executionMode: 'live', idempotencyKey: crypto.randomUUID() } })
    else if (action === 'bind_verified_payment') await $fetch(`${base}/payment-bind`, { method: 'POST', body: { idempotencyKey: crypto.randomUUID() } })
    else if (action === 'quote_domain') await $fetch(`${base}/domain-quote`, { method: 'POST', body: { executionMode: 'live', idempotencyKey: crypto.randomUUID() } })
    else if (action === 'confirm_domain_purchase') await $fetch(`${base}/domain-purchase`, { method: 'POST', body: { explicitConfirmation: true, executionMode: 'live', idempotencyKey: crypto.randomUUID() } })
    else if (['configure_dns_tls', 'retry_dns_tls_after_eligibility'].includes(action)) await $fetch(`${base}/dns-tls`, { method: 'POST', body: { executionMode: 'live', idempotencyKey: crypto.randomUUID() } })
    else if (['deploy_production', 'retry_deployment_after_eligibility'].includes(action)) await $fetch(`${base}/deploy`, { method: 'POST', body: { executionMode: 'live', idempotencyKey: crypto.randomUUID() } })
    else if (['build_preview', 'retry_preview_after_eligibility'].includes(action)) await $fetch(`${base}/preview-build`, { method: 'POST', body: { executionMode: 'live', idempotencyKey: crypto.randomUUID() } })
    else if (action === 'verify_existing_site_ownership') await $fetch(`${base}/ownership-challenge`, { method: 'POST', body: { idempotencyKey: crypto.randomUUID() } })
    else if (['complete_existing_site_ownership_verification', 'retry_ownership_after_eligibility'].includes(action)) await $fetch(`${base}/ownership-verify`, { method: 'POST', body: { executionMode: 'live', idempotencyKey: crypto.randomUUID() } })
    else if (action === 'activate_geo') await $fetch(`${base}/geo-activate`, { method: 'POST', body: { timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 12, idempotencyKey: crypto.randomUUID() } })
    else throw new Error('No safe runtime action is projected.')
    operationStates[key] = 'success'; notice.value = `${actionLabels[action] || action} 已由 server receipt 更新。`; await refresh()
  } catch (caught: any) { operationStates[key] = release.status === 'retry_wait' ? 'retry_wait' : 'blocked'; failure.value = caught?.data?.message || caught?.message || 'Operation fail closed；沒有成功 authority 被保存。'; await refresh() }
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
          <p v-if="item.capability === 'website_generator' && item.providerKey === 'bailian-qwen' && item.status === 'configured'" class="muted">按下驗證會由 server 發出一個不含客戶資料的極小模型探測請求，可能產生微量 token 費用；這只驗證指定 model 的存取能力，不代表帳號身分、內容品質或正式生成成功。</p>
          <button v-if="item.status === 'configured'" type="button" :disabled="operationStates[`verify-${item.capability}`] === 'loading'" @click="verifyProvider(item)">{{ operationStates[`verify-${item.capability}`] === 'loading' ? '驗證中…' : 'Server connection verify' }}</button>
          <p v-if="operationStates[`verify-${item.capability}`]" class="muted">operation: {{ operationStates[`verify-${item.capability}`] }}</p>
        </article>
      </div>
    </section>

    <section class="panel">
      <p class="eyebrow">PRE-PURCHASE OWNER CLAIM</p><h2>從 exact preview lineage 建立 draft project</h2><p class="muted">只接受已由 owner session claim 的 preview / quote / lead / draft order。此步不代表付款，也不會啟用 subscription。</p>
      <form class="config-form" @submit.prevent="convertPrePurchase">
        <label>Preview ID<input v-model="conversion.previewId" inputmode="numeric" required /></label><label>Quote ID<input v-model="conversion.quoteId" inputmode="numeric" required /></label><label>Lead intent ID<input v-model="conversion.leadIntentId" inputmode="numeric" required /></label><label>Draft order ID<input v-model="conversion.draftOrderId" inputmode="numeric" required /></label>
        <button type="submit" :disabled="operationStates.prepurchase === 'loading'">{{ operationStates.prepurchase === 'loading' ? '建立中…' : '建立 draft project' }}</button><p class="muted">operation: {{ operationStates.prepurchase || 'idle' }}</p>
      </form>
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
      <div class="section-title"><div><p class="eyebrow">PROJECT {{ row.project.id }}</p><h2>{{ row.project.canonicalClientIdentity }}</h2><p class="muted">{{ row.project.canonicalWebsiteIdentity }}</p></div><div><button type="button" :disabled="saving || !(row.prePurchaseBinding?.sourceVersionId || row.project.activeVersionId)" @click="generationDryRun(row)">Generation dry-run</button> <button v-if="row.prePurchaseBinding && !row.candidates.length" type="button" :disabled="operationStates[`generation-${row.project.id}`] === 'loading'" @click="generateCandidate(row)">{{ operationStates[`generation-${row.project.id}`] === 'loading' ? '生成中…' : '生成 live candidate' }}</button></div></div>
      <p v-if="row.prePurchaseBinding" class="muted">pre-purchase lineage: preview #{{ row.prePurchaseBinding.previewId }} · quote #{{ row.prePurchaseBinding.quoteId }} · order #{{ row.prePurchaseBinding.draftOrderId }} · source version #{{ row.prePurchaseBinding.sourceVersionId }} · 未付款</p>
      <div v-if="row.candidates.length && !row.releases.length" class="release-create"><label>Canonical domain<input v-model="domains[row.project.id]" placeholder="client.example.com" /></label><button v-for="candidate in row.candidates" :key="candidate.id" type="button" :disabled="!domains[row.project.id] || operationStates[`release-${candidate.id}`] === 'loading'" @click="createRelease(row, candidate)">建立 candidate #{{ candidate.id }} release</button></div>
      <div v-if="row.project.activeVersionId && !row.prePurchaseBinding && !row.releases.length" class="release-create"><label>Verified-site domain target<input v-model="domains[row.project.id]" placeholder="existing.example.com" /></label><button type="button" :disabled="!domains[row.project.id] || operationStates[`existing-${row.project.id}`] === 'loading'" @click="createExistingRelease(row)">建立 ownership challenge flow</button></div>
      <div class="summary-grid"><div><strong>{{ row.candidates.length }}</strong><span>immutable candidates</span></div><div><strong>{{ row.releases.length }}</strong><span>release projections</span></div><div><strong>{{ row.attempts.length }}</strong><span>bounded attempts</span></div><div><strong>{{ row.receipts.length }}</strong><span>verified / ignored receipts</span></div></div>
      <div v-if="row.releases.length" class="table-wrap"><table><thead><tr><th>Release</th><th>種類</th><th>狀態</th><th>Domain</th><th>下一安全動作</th><th>Operation</th><th>Blocked reason</th></tr></thead><tbody><tr v-for="release in row.releases" :key="release.id"><td>#{{ release.id }}</td><td>{{ release.releaseKind }}</td><td><span :class="statusClass(release.status)">{{ release.status }}</span></td><td>{{ release.canonicalDomain }}</td><td>{{ release.nextSafeAction }}</td><td><button v-if="actionLabels[release.nextSafeAction]" type="button" :disabled="operationStates[`action-${release.id}`] === 'loading'" @click="performReleaseAction(row, release)">{{ operationStates[`action-${release.id}`] === 'loading' ? '處理中…' : actionLabels[release.nextSafeAction] }}</button><span v-else>{{ operationStates[`action-${release.id}`] || 'blocked / wait' }}</span></td><td>{{ release.blockedReasonCode || '—' }}</td></tr></tbody></table></div>
      <details v-for="release in row.releases.filter((item: any) => item.gateResults.length)" :key="`gates-${release.id}`"><summary>Release #{{ release.id }} gate receipts</summary><p v-for="gate in release.gateResults" :key="gate.receiptFingerprint">{{ gate.gateType }} · {{ gate.result }} · {{ gate.reasonCodes.join(', ') }} · {{ gate.receiptFingerprint }}</p></details>
      <details v-if="row.attempts.length"><summary>All bounded attempts</summary><p v-for="attempt in row.attempts" :key="`attempt-${attempt.id}`">#{{ attempt.id }} · release {{ attempt.releaseId || '—' }} · {{ attempt.capability }}/{{ attempt.operation }} · {{ attempt.executionMode }} · {{ attempt.status }} · attempt {{ attempt.attemptNumber }}/{{ attempt.maxAttempts }} · {{ attempt.errorCode || 'no redacted error' }} · {{ attempt.retryEligibleAt || 'no retry wait' }}</p></details>
      <details v-if="row.receipts.length"><summary>Append-only provider / authority receipts</summary><p v-for="receipt in row.receipts" :key="`receipt-${receipt.id}`">#{{ receipt.id }} · release {{ receipt.releaseId || '—' }} · {{ receipt.receiptType }} · {{ receipt.receiptStatus }} · {{ receipt.providerKey }} · event {{ receipt.providerEventId }} · exact identity {{ receipt.exactResponseIdentity }} · authority {{ receipt.receiptFingerprint }}</p></details>
      <form v-if="row.releases.some((item: any) => ['live_verified', 'geo_active', 'rolled_back'].includes(item.status)) && row.releases.filter((item: any) => item.activeDeploymentReceiptFingerprint).length > 1" class="config-form" @submit.prevent="rollbackRelease(row)"><label>Current release ID<input v-model="rollbacks[row.project.id]!.fromReleaseId" inputmode="numeric" required /></label><label>Prior verified release ID<input v-model="rollbacks[row.project.id]!.toReleaseId" inputmode="numeric" required /></label><button type="submit" :disabled="operationStates[`rollback-${row.project.id}`] === 'loading'">Verified rollback</button></form>
      <div v-if="row.attempts.some((attempt: any) => attempt.status === 'retry_wait' || attempt.status === 'failed')" class="attempts"><h3>需要安全處理的 attempts</h3><p v-for="attempt in row.attempts.filter((item: any) => item.status === 'retry_wait' || item.status === 'failed')" :key="attempt.id">#{{ attempt.id }} · {{ attempt.operation }} · {{ attempt.status }} · attempt {{ attempt.attemptNumber }}/{{ attempt.maxAttempts }} · {{ attempt.errorCode }} · {{ attempt.retryEligibleAt || '不可再自動重試' }}</p></div>
    </section>

    <section class="panel boundary"><p v-for="item in workspace.limitations" :key="item">{{ item }}</p></section>
  </main>
</template>

<style scoped>
.workbench{padding:3rem clamp(1rem,4vw,4rem);display:grid;gap:1.2rem}.hero,.section-title{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem}.hero{padding:2rem;border-radius:1rem;background:#121b2a;color:#fff}.hero p{max-width:55rem;color:#bdc8d7;line-height:1.65}.eyebrow{margin:0 0 .45rem;color:#5572a8;font:800 .68rem/1.2 ui-monospace,monospace;letter-spacing:.12em}.hero .eyebrow{color:#8eb7ec}h1{margin:0;font-size:clamp(2rem,5vw,4rem)}h2,h3{margin:.2rem 0}.panel{padding:1.4rem;border:1px solid #d9e0e8;border-radius:.9rem;background:#fff}.capability-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.75rem;margin-top:1rem}.card{padding:1rem;border:1px solid #e1e6ec;border-radius:.7rem}.status{display:inline-flex;padding:.25rem .5rem;border-radius:999px;background:#edf1f5;color:#46566e;font:800 .65rem/1.2 ui-monospace,monospace}.status--ready{background:#e3f4e9;color:#1f6a3b}.status--blocked{background:#fff0e6;color:#9a4e19}.muted{color:#6e7b8d}.config-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.8rem;margin-top:1rem}.config-form label{display:grid;gap:.35rem;color:#4a586b;font-size:.78rem}.config-form input,.config-form select{width:100%;padding:.7rem;border:1px solid #ccd5df;border-radius:.5rem;background:#fff}.config-form button,.hero button,.section-title button{align-self:end;border:0;border-radius:.55rem;padding:.75rem 1rem;background:#315bd6;color:#fff;font-weight:800}.summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.7rem;margin-top:1rem}.summary-grid div{display:grid;padding:.8rem;border-radius:.6rem;background:#f2f5f8}.summary-grid strong{font-size:1.5rem}.summary-grid span{color:#6e7b8d;font-size:.72rem}.table-wrap{overflow:auto;margin-top:1rem}table{width:100%;border-collapse:collapse;font-size:.76rem}th,td{padding:.65rem;text-align:left;border-bottom:1px solid #e4e8ed;white-space:nowrap}.attempts{margin-top:1rem;padding:1rem;border-radius:.6rem;background:#fff5ec;color:#704421}.alert{padding:.8rem 1rem;border-radius:.6rem;background:#e5f1ff}.alert--error{background:#ffebe8;color:#8d3027}.boundary{color:#5d6878;font-size:.78rem;line-height:1.6}@media(max-width:1100px){.capability-grid{grid-template-columns:repeat(2,1fr)}.config-form{grid-template-columns:1fr 1fr}}@media(max-width:700px){.hero,.section-title{display:block}.capability-grid,.config-form,.summary-grid{grid-template-columns:1fr}.hero button,.section-title button{margin-top:1rem}}
</style>
