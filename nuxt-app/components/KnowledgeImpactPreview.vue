<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { KnowledgeImpactCategory, KnowledgeImpactLineageRef, KnowledgeImpactReport } from '../server/knowledge/impact-types'

type ImpactEntity = { id: number, canonicalName: string, entityType: string }
type ImpactClaim = { id: number, statement: string, claimType: string }
type ImpactSource = { id: number, title: string | null, canonicalUrl: string }
type SubjectKind = 'entity' | 'claim' | 'source'
type ImpactOption = { id: number, label: string }
type PanelState = 'idle' | 'loading' | 'unauthorized' | 'invalid' | 'not-found' | 'conflict' | 'unavailable' | 'empty' | 'ready'

const props = defineProps<{
  entities: readonly ImpactEntity[]
  claims: readonly ImpactClaim[]
  sources: readonly ImpactSource[]
}>()

const categories: readonly KnowledgeImpactCategory[] = ['content', 'schema', 'dataset', 'public_api', 'benchmark_prompt', 'reviewer']
const labels: Record<KnowledgeImpactCategory, string> = {
  content: '受影響內容',
  schema: '受影響結構化資料',
  dataset: '受影響資料集',
  public_api: '受影響公開 API 輸出',
  benchmark_prompt: '受影響 Benchmark Prompts',
  reviewer: '所需審查者',
}
const reasonLabels: Record<string, string> = {
  explicit_content_entity_binding: '內容明確連結',
  projection_inputs_only: '結構化輸入關聯',
  exact_registered_dependency: '已登錄的精確依賴',
  exact_registered_dependency_stale: '登錄依賴版本已變動',
}
const knowledgeKindLabels: Record<KnowledgeImpactLineageRef['kind'], string> = { entity: '實體', claim: '主張', source: '來源', source_version: '來源版本', content: '內容' }
const subjectLabels: Record<SubjectKind, string> = { entity: '實體', claim: '主張', source: '來源' }
const kind = ref<SubjectKind>('entity')
const selectedId = ref('')
const state = ref<PanelState>('idle')
const report = ref<KnowledgeImpactReport | null>(null)
let requestGeneration = 0

const options = computed<ImpactOption[]>(() => {
  if (kind.value === 'entity') return props.entities.filter(row => Number.isSafeInteger(row.id) && row.id > 0).map(row => ({ id: row.id, label: `${row.canonicalName} · ${row.entityType} · #${row.id}` }))
  if (kind.value === 'claim') return props.claims.filter(row => Number.isSafeInteger(row.id) && row.id > 0).map(row => ({ id: row.id, label: `${row.statement} · #${row.id}` }))
  return props.sources.filter(row => Number.isSafeInteger(row.id) && row.id > 0).map(row => ({ id: row.id, label: `${row.title || row.canonicalUrl} · #${row.id}` }))
})
const canPreview = computed(() => state.value !== 'loading' && options.value.some(option => String(option.id) === selectedId.value))

watch(kind, () => {
  requestGeneration += 1
  selectedId.value = ''
  report.value = null
  state.value = 'idle'
})
watch(selectedId, () => {
  requestGeneration += 1
  report.value = null
  state.value = 'idle'
})
watch([() => props.entities, () => props.claims, () => props.sources], () => {
  requestGeneration += 1
  selectedId.value = ''
  report.value = null
  state.value = 'idle'
}, { deep: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validLineage(value: unknown): value is KnowledgeImpactLineageRef[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(ref => isRecord(ref)
    && ['entity', 'claim', 'source', 'source_version', 'content'].includes(String(ref.kind))
    && typeof ref.id === 'number' && Number.isSafeInteger(ref.id) && ref.id > 0
    && typeof ref.relation === 'string' && ref.relation.length > 0 && ref.relation.length <= 80
    && (ref.version === null || (typeof ref.version === 'string' && ref.version.length <= 128) || (typeof ref.version === 'number' && Number.isSafeInteger(ref.version)))
    && (ref.contentHash === null || (typeof ref.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(ref.contentHash))))
}

function isImpactReport(value: unknown, expectedKind: SubjectKind, expectedId: number): value is KnowledgeImpactReport {
  if (!isRecord(value) || value.coverageScope !== 'known_explicit_dependencies_only' || value.exhaustive !== false) return false
  if (value.automaticPublication !== false || value.productionActivation !== false || value.automaticTrainingAdmission !== false) return false
  if (typeof value.ownerUserId !== 'number' || !Number.isSafeInteger(value.ownerUserId) || value.ownerUserId < 1 || typeof value.graphFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.graphFingerprint)) return false
  if (typeof value.outputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.outputFingerprint)) return false
  if (!isRecord(value.subject) || value.subject.kind !== expectedKind || value.subject.id !== expectedId || !Number.isSafeInteger(value.subject.id) || Number(value.subject.id) < 1) return false
  if (!validLineage(value.affectedKnowledge)) return false
  if (!Array.isArray(value.buckets) || value.buckets.length !== categories.length) return false
  let itemCount = 0
  let lineageCount = value.affectedKnowledge.length
  return value.buckets.every((bucket, index) => {
    if (!isRecord(bucket) || bucket.category !== categories[index] || !['complete', 'unconfigured'].includes(String(bucket.state))) return false
    if (typeof bucket.scope !== 'string' || bucket.scope.length > 500
      || !Array.isArray(bucket.limitationCodes) || bucket.limitationCodes.length > 32 || !bucket.limitationCodes.every(code => typeof code === 'string' && code.length <= 80)
      || !Array.isArray(bucket.items) || bucket.items.length > 1_000 || (bucket.state === 'unconfigured' && bucket.items.length !== 0)) return false
    itemCount += bucket.items.length
    if (itemCount > 1_000) return false
    return bucket.items.every(item => {
      if (!isRecord(item)
        || !['content', 'schema', 'consumer'].includes(String(item.kind))) return false
      if (!(typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128
        && typeof item.version === 'string' && item.version.length > 0 && item.version.length <= 128
        && (item.contentHash === null || (typeof item.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(item.contentHash)))
        && typeof item.dependencyFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(item.dependencyFingerprint)
        && ['explicit_content_entity_binding', 'projection_inputs_only', 'exact_registered_dependency', 'exact_registered_dependency_stale'].includes(String(item.reasonCode))
        && !(bucket.category === 'schema' && item.reasonCode === 'projection_inputs_only' && item.contentHash !== null)
        && validLineage(item.lineage))) return false
      lineageCount += item.lineage.length
      return lineageCount <= 10_000
    })
  })
}

function responseStatus(error: unknown): number | null {
  if (!isRecord(error)) return null
  if (Number.isInteger(error.statusCode)) return Number(error.statusCode)
  if (isRecord(error.response) && Number.isInteger(error.response.status)) return Number(error.response.status)
  return null
}

async function loadPreview() {
  if (!canPreview.value) return
  const id = Number(selectedId.value)
  if (!Number.isSafeInteger(id) || id < 1) return
  const generation = ++requestGeneration
  state.value = 'loading'
  report.value = null
  try {
    const fetchImpact = $fetch as unknown as (request: '/api/knowledge/impact-preview', options: { query: { kind: SubjectKind, id: number } }) => Promise<unknown>
    const reply = await fetchImpact('/api/knowledge/impact-preview', { query: { kind: kind.value, id } })
    if (generation !== requestGeneration) return
    if (!isRecord(reply) || reply.status !== 'ok' || !isImpactReport(reply.value, kind.value, id)) {
      state.value = 'unavailable'
      return
    }
    report.value = reply.value
    state.value = report.value.buckets.every(bucket => bucket.state === 'complete' && bucket.items.length === 0) ? 'empty' : 'ready'
  } catch (error) {
    if (generation !== requestGeneration) return
    const status = responseStatus(error)
    state.value = status === 401 ? 'unauthorized' : status === 422 ? 'invalid' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'unavailable'
  }
}
</script>

<template>
  <section class="impact-preview" aria-labelledby="impact-preview-title">
    <div class="heading">
      <div>
        <p class="eyebrow">OWNER-ONLY · READ-ONLY IMPACT</p>
        <h2 id="impact-preview-title">知識變更影響預覽</h2>
        <p>只檢視此快照中可追溯的明確關聯；不發布、不訓練，也不會自動啟用。</p>
      </div>
      <p class="boundary">雜湊供核對快照，不是 compare-and-swap 授權或寫入憑證。</p>
    </div>

    <div class="selectors">
      <label>項目類型
        <select v-model="kind" aria-label="預覽項目類型">
          <option value="entity">實體</option><option value="claim">主張</option><option value="source">來源</option>
        </select>
      </label>
      <label>已登錄項目
        <select v-model="selectedId" aria-label="選擇已登錄項目">
          <option value="" disabled>選擇{{ subjectLabels[kind] }}</option>
          <option v-for="option in options" :key="`${kind}:${option.id}`" :value="String(option.id)">{{ option.label }}</option>
        </select>
      </label>
      <button type="button" :disabled="!canPreview" @click="loadPreview">{{ state === 'loading' ? '讀取中…' : '唯讀預覽' }}</button>
    </div>

    <p v-if="options.length === 0" class="state empty">目前沒有可選的已登錄{{ subjectLabels[kind] }}；請先從本頁既有清單選取，不接受任意 owner 或 ID。</p>
    <p v-if="state === 'loading'" class="state" role="status">正在讀取影響快照…</p>
    <p v-else-if="state === 'unauthorized'" class="state blocked" role="alert">需要有效的 owner session；此預覽僅供擁有人使用。</p>
    <p v-else-if="state === 'invalid'" class="state blocked" role="alert">選取項目無效；請從目前 owner 清單重新選擇。</p>
    <p v-else-if="state === 'not-found'" class="state blocked" role="alert">找不到此 owner 項目；清單可能已更新，請重新載入頁面。</p>
    <p v-else-if="state === 'conflict'" class="state blocked" role="alert">資料或關聯無法完整核對，未截斷結果；請重新載入後再檢查。</p>
    <p v-else-if="state === 'unavailable'" class="state blocked" role="alert">影響快照目前無法安全顯示；沒有以假資料補足。</p>
    <p v-else-if="state === 'empty'" class="state empty">此快照未找到已知的明確關聯；範圍不是完整影響盤點，不代表沒有其他影響。</p>

    <template v-if="report && (state === 'ready' || state === 'empty')">
      <p class="scope">範圍：僅涵蓋已知明確依賴（known explicit dependencies only）；本報告非 exhaustive。</p>
      <dl class="fingerprints"><div><dt>Graph snapshot SHA-256</dt><dd><code>{{ report.graphFingerprint }}</code></dd></div><div><dt>Output SHA-256</dt><dd><code>{{ report.outputFingerprint }}</code></dd></div></dl>
      <section class="knowledge-lineage" aria-labelledby="impact-knowledge-title">
        <h3 id="impact-knowledge-title">直接關聯的知識紀錄</h3>
        <p v-if="report.affectedKnowledge.length === 0" class="empty">此快照未找到已知直接關聯；不代表沒有其他影響。</p>
        <ul v-else><li v-for="(ref, index) in report.affectedKnowledge" :key="`${ref.kind}:${ref.id}:${index}`"><strong>{{ knowledgeKindLabels[ref.kind] }} · #{{ ref.id }}</strong><small>關聯類型：{{ ref.relation }}</small><small>版本：{{ ref.version ?? '—' }}</small><small v-if="ref.contentHash">內容 SHA-256：{{ ref.contentHash }}</small></li></ul>
      </section>
      <div class="buckets">
        <article v-for="bucket in report.buckets" :key="bucket.category" class="bucket">
          <h3>{{ labels[bucket.category] }}</h3>
          <p v-if="bucket.state === 'unconfigured'" class="unknown">尚未接上，無法判定</p>
          <template v-else>
            <p v-if="bucket.items.length === 0" class="empty">未找到已知明確關聯；不能推論沒有影響。</p>
            <ul v-else><li v-for="item in bucket.items" :key="`${item.kind}:${item.id}:${item.version}`"><strong>{{ item.kind }} · {{ item.id }}</strong><small>版本 {{ item.version }} · {{ reasonLabels[item.reasonCode] || '精確登錄依賴' }}</small><small>Dependency fingerprint · {{ item.dependencyFingerprint }}</small><small v-if="item.contentHash">內容 SHA-256 · {{ item.contentHash }}</small><ul v-if="item.lineage.length" class="lineage"><li v-for="(ref, index) in item.lineage" :key="`${ref.kind}:${ref.id}:${index}`">{{ knowledgeKindLabels[ref.kind] }} #{{ ref.id }} · {{ ref.relation }}<small>版本 {{ ref.version ?? '—' }}<span v-if="ref.contentHash"> · SHA-256 {{ ref.contentHash }}</span></small></li></ul></li></ul>
          </template>
          <small class="scope-note">{{ bucket.scope }}</small>
        </article>
      </div>
      <p class="safety">此預覽不發布、不變更業務狀態、不啟用正式模型，也不自動准入訓練。</p>
    </template>
  </section>
</template>

<style scoped>
.impact-preview{margin:1rem 0;padding:1.2rem;border:1px solid #cbd7e8;border-radius:14px;background:#fff;color:#172033}.heading{display:flex;justify-content:space-between;gap:1rem;align-items:start}.eyebrow{font-size:.72rem;font-weight:800;letter-spacing:.1em;color:#52627a}.heading h2{margin:.25rem 0}.heading p{line-height:1.55}.boundary{max-width:18rem;padding:.65rem;border-radius:8px;background:#f2f5fa;color:#4c5c73;font-size:.84rem}.selectors{display:grid;grid-template-columns:minmax(8rem,1fr) minmax(14rem,3fr) auto;gap:.7rem;align-items:end}.selectors label{display:grid;gap:.25rem;font-size:.85rem;font-weight:700}.selectors select{box-sizing:border-box;width:100%;padding:.55rem;border:1px solid #b9c5d7;border-radius:7px;background:#fff;font:inherit}.selectors button{border:0;border-radius:8px;padding:.62rem .85rem;background:#213f7a;color:#fff;font:inherit;cursor:pointer}.selectors button:disabled{opacity:.55;cursor:not-allowed}.state{margin:.8rem 0;padding:.7rem;border-radius:8px;background:#f1f5fa}.blocked{background:#fff4e5;color:#754600}.empty{color:#52627a}.scope,.safety{font-size:.88rem;color:#4c5c73}.fingerprints{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.5rem}.fingerprints div{min-width:0;padding:.6rem;border-radius:8px;background:#f6f8fb}.fingerprints dt{font-size:.75rem;color:#596981}.fingerprints dd{margin:.25rem 0 0;overflow-wrap:anywhere}.fingerprints code{font-size:.72rem}.buckets{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:.7rem}.bucket{min-width:0;padding:.85rem;border:1px solid #dbe3ef;border-radius:10px}.bucket h3{margin:.1rem 0 .5rem;font-size:1rem}.bucket ul{padding-left:1rem;display:grid;gap:.6rem}.bucket li{overflow-wrap:anywhere}.bucket small{display:block;margin-top:.15rem;color:#5a6880}.unknown{padding:.6rem;border-radius:7px;background:#fff4e5;color:#754600;font-weight:700}.scope-note{display:block;margin-top:.7rem;overflow-wrap:anywhere;color:#65738a}.safety{margin-bottom:0;font-weight:700}@media(max-width:640px){.heading{display:grid}.boundary{max-width:none}.selectors{grid-template-columns:1fr}.selectors button{width:100%}}
</style>
