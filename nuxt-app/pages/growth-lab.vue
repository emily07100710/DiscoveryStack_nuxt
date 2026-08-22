<script setup lang="ts">
definePageMeta({ layout: false })
useHead({ title: 'Growth Lab · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

type Overview = {
  intakes: Array<{ id: number, canonicalWebsiteUrl: string, domain: string, locale: string, status: string, ownerReviewNote: string | null, reviewedAt: string | null, consentRevokedAt: string | null, createdAt: string }>
  experiments: Array<{ id: number, intakeId: number, sourceUrl: string, sourceContentHash: string, locale: string, targetEngine: string, queryFingerprint: string, rewriteMode: string, modelId: string | null, modelRevision: string | null, ruleRevision: string | null, datasetRevision: string | null, status: string, autoPublish: boolean, createdAt: string }>
  provider: { foundationAvailable: boolean, providerConfigured: boolean, modelLoaded: boolean, liveApiApproved: boolean, autoPublishEnabled: boolean, status: 'blocked', reason: string }
}

const { data, error, refresh } = await useFetch<Overview>('/api/growth/overview', { credentials: 'include' })
const reviewNote = ref<Record<number, string>>({})
const actionError = ref('')
const revokeLeadId = ref<number | null>(null)
const draft = reactive({ intakeId: '', sourceUrl: '', sourceContentHash: '', locale: 'en' as 'en' | 'zh-hant', targetEngine: 'google_search', queryFingerprint: '', rewriteMode: 'manual' as 'manual' | 'autogeo_api' | 'autogeo_mini', modelId: '', modelRevision: '', ruleRevision: '', datasetRevision: '' })
const ownerFetch = $fetch as unknown as (url: string, options: { method: 'POST', credentials: 'include', body: Record<string, unknown> }) => Promise<unknown>

async function ownerAction(action: () => Promise<unknown>, fallback: string) {
  try { actionError.value = ''; await action(); await refresh() } catch (cause: any) { actionError.value = cause?.data?.statusMessage || fallback }
}
function reviewIntake(id: number, status: 'approved' | 'rejected') {
  return ownerAction(() => ownerFetch(`/api/growth/intakes/${id}/review`, { method: 'POST', credentials: 'include', body: { status, ownerReviewNote: reviewNote.value[id] || '' } }), 'The intake decision could not be saved.')
}
function revokeConsent() {
  if (!revokeLeadId.value) return
  return ownerAction(async () => { await ownerFetch('/api/growth/consents/revoke', { method: 'POST', credentials: 'include', body: { leadId: revokeLeadId.value! } }); revokeLeadId.value = null }, 'The consent could not be revoked.')
}
function createExperiment() {
  return ownerAction(() => ownerFetch('/api/growth/experiments', { method: 'POST', credentials: 'include', body: { ...draft, intakeId: Number(draft.intakeId), modelId: draft.modelId || undefined, modelRevision: draft.modelRevision || undefined, ruleRevision: draft.ruleRevision || undefined, datasetRevision: draft.datasetRevision || undefined } }), 'The experiment could not be created.')
}
</script>

<template>
  <main class="growth-lab">
    <header><p class="eyebrow">PRIVATE / GOVERNED RESEARCH</p><h1>Growth Experiment Ledger</h1><p>Consent-led SEO/GEO experiments. Contact data, messages and private credentials are never displayed here.</p></header>
    <p v-if="error" class="blocked">Owner authentication is required. This route is not a public dashboard.</p>
    <template v-else-if="data">
      <p v-if="actionError" class="blocked">{{ actionError }}</p>
      <section class="provider blocked"><h2>AutoGEO provider status: {{ data.provider.status }}</h2><p>{{ data.provider.reason }}</p><p>Foundation: {{ data.provider.foundationAvailable ? 'available' : 'unavailable' }} · Provider configured: {{ data.provider.providerConfigured ? 'yes' : 'no' }} · Model loaded: {{ data.provider.modelLoaded ? 'yes' : 'no' }} · Live API approved: {{ data.provider.liveApiApproved ? 'yes' : 'no' }} · Auto-publish: {{ data.provider.autoPublishEnabled ? 'enabled' : 'disabled' }}</p></section>
      <section><h2>Incoming research intakes</h2><p class="hint">Only consented public website references are listed. Approve or reject before an experiment can exist.</p><article v-for="intake in data.intakes" :key="intake.id" class="ledger-card"><div><strong>{{ intake.domain }}</strong><span>{{ intake.status }} · {{ intake.locale }}</span><code>{{ intake.canonicalWebsiteUrl }}</code></div><textarea v-model="reviewNote[intake.id]" maxlength="4000" placeholder="Internal review note; no customer PII."></textarea><div class="actions"><button :disabled="intake.status === 'revoked'" @click="reviewIntake(intake.id, 'approved')">Approve intake</button><button :disabled="intake.status === 'revoked'" class="secondary" @click="reviewIntake(intake.id, 'rejected')">Reject intake</button></div></article><p v-if="!data.intakes.length">No consented website intakes yet.</p></section>
      <section><h2>Consent withdrawal</h2><p class="hint">Submit the internal lead reference only. Revocation removes related intakes from future use, invalidates eligibility and revokes linked experiments.</p><form class="form-grid" @submit.prevent="revokeConsent"><input v-model.number="revokeLeadId" type="number" min="1" aria-label="Internal lead reference" placeholder="Internal lead reference"><button type="submit">Revoke research consent</button></form></section>
      <section><h2>Manual experiment record</h2><p class="hint">Create only from an approved intake. This stores reference metadata and hashes, not source or generated content. Publishing remains disabled.</p><form class="form-grid" @submit.prevent="createExperiment"><input v-model="draft.intakeId" type="number" min="1" required placeholder="Approved intake ID"><input v-model="draft.sourceUrl" required maxlength="2048" placeholder="Public source URL"><input v-model="draft.sourceContentHash" required pattern="[A-Fa-f0-9]{32,128}" placeholder="Source content SHA-256"><select v-model="draft.locale"><option value="en">English</option><option value="zh-hant">繁體中文</option></select><input v-model="draft.targetEngine" required maxlength="80" placeholder="Target engine"><input v-model="draft.queryFingerprint" required pattern="[A-Fa-f0-9]{32,128}" placeholder="Query fingerprint hash"><select v-model="draft.rewriteMode"><option value="manual">Manual</option><option value="autogeo_api">AutoGEO API (blocked unless configured)</option><option value="autogeo_mini">AutoGEO-Mini (blocked unless model loaded)</option></select><input v-model="draft.modelId" maxlength="240" placeholder="Model ID (optional)"><input v-model="draft.modelRevision" maxlength="128" placeholder="Model revision (optional)"><input v-model="draft.ruleRevision" maxlength="128" placeholder="Rule revision (optional)"><input v-model="draft.datasetRevision" maxlength="128" placeholder="Dataset revision (optional)"><button type="submit">Create draft experiment</button></form></section>
      <section><h2>Experiment ledger</h2><article v-for="experiment in data.experiments" :key="experiment.id" class="ledger-card"><div><strong>#{{ experiment.id }} · {{ experiment.status }}</strong><span>Intake #{{ experiment.intakeId }} · {{ experiment.rewriteMode }} · auto-publish {{ experiment.autoPublish ? 'enabled' : 'disabled' }}</span><code>source {{ experiment.sourceContentHash }} · query {{ experiment.queryFingerprint }}</code></div><NuxtLink :to="`/api/growth/experiments/${experiment.id}/eligibility`">View paired-training eligibility JSON</NuxtLink></article><p v-if="!data.experiments.length">No experiments recorded. Creating, publishing and training remain explicit owner actions.</p></section>
    </template>
  </main>
</template>

<style scoped>
.growth-lab{min-height:100vh;background:#0d1521;color:#e7eef8;padding:48px max(24px,8vw);font-family:ui-sans-serif,system-ui}.growth-lab>*{max-width:980px;margin-inline:auto}.eyebrow{color:#76d2a5;font-size:.75rem;letter-spacing:.16em}.growth-lab h1{font-size:clamp(2.1rem,5vw,4rem);margin:.2rem 0}.growth-lab section{margin-top:2.4rem}.blocked{border:1px solid #c58b48;background:#2d2118;padding:1rem}.provider{padding:1.2rem;border-radius:12px}.ledger-card{display:grid;gap:.8rem;padding:1rem;margin:.75rem 0;border:1px solid #27394f;border-radius:12px;background:#121f30}.ledger-card strong,.ledger-card span,.ledger-card code{display:block;margin:.2rem 0}.ledger-card span,.hint{color:#b4c3d4}.ledger-card code{font-size:.78rem;overflow-wrap:anywhere;color:#8fd1ff}.ledger-card textarea,.form-grid input,.form-grid select{min-height:2.5rem;background:#0b121c;border:1px solid #3a4c64;color:inherit;padding:.6rem}.ledger-card textarea{min-height:4rem}.actions{display:flex;gap:.6rem}.actions button,.form-grid button{padding:.55rem .8rem;border:0;border-radius:6px;background:#76d2a5;color:#082015;font-weight:700}.actions .secondary{background:#2b3e55;color:#eef5ff}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:.7rem;padding:1rem;border:1px solid #27394f;border-radius:12px;background:#121f30}
</style>
