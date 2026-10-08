<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { KnowledgeRevisionHistory, KnowledgeRevisionHistoryItem, KnowledgeRevisionSubjectKind } from '../server/knowledge/revision-types'

type HistoryEntity = { id: number, canonicalName: string, entityType: string }
type HistoryClaim = { id: number, statement: string, claimType: string }
type HistorySource = { id: number, title: string | null, canonicalUrl: string }
type SubjectOption = { id: number, label: string }
type HistoryState = 'idle' | 'loading' | 'loading-more' | 'unauthorized' | 'invalid' | 'not-found' | 'conflict' | 'unavailable' | 'empty' | 'ready'
type HistoryRequest = (path: '/api/knowledge/revision-history', options: { query: { kind: KnowledgeRevisionSubjectKind, id: number, cursor?: string } }) => Promise<unknown>

const props = defineProps<{
  entities: readonly HistoryEntity[]
  claims: readonly HistoryClaim[]
  sources: readonly HistorySource[]
}>()
const fetchHistory = $fetch as unknown as HistoryRequest
const kind = ref<KnowledgeRevisionSubjectKind>('entity')
const selectedId = ref('')
const items = ref<KnowledgeRevisionHistoryItem[]>([])
const nextCursor = ref<string | null>(null)
const state = ref<HistoryState>('idle')
let requestGeneration = 0

const kindLabels: Record<KnowledgeRevisionSubjectKind, string> = { entity: '實體', claim: '主張', source: '來源' }
const allowedOperations = [
  'deleteContentEntityLink', 'insertClaim', 'insertClaimEntityLink', 'insertClaimEvidence',
  'insertContentEntityLink', 'insertEntity', 'insertEntityAlias', 'insertEntityExternalId',
  'insertSource', 'insertSourceVersion', 'legacy_baseline', 'updateClaim', 'updateEntity', 'upsertPublisherSetting',
] as const
const options = computed<SubjectOption[]>(() => {
  if (kind.value === 'entity') return props.entities.filter(item => Number.isSafeInteger(item.id) && item.id > 0).map(item => ({ id: item.id, label: `${item.canonicalName} · ${item.entityType} · #${item.id}` }))
  if (kind.value === 'claim') return props.claims.filter(item => Number.isSafeInteger(item.id) && item.id > 0).map(item => ({ id: item.id, label: `${item.statement} · #${item.id}` }))
  return props.sources.filter(item => Number.isSafeInteger(item.id) && item.id > 0).map(item => ({ id: item.id, label: `${item.title || item.canonicalUrl} · #${item.id}` }))
})
const canLoad = computed(() => state.value !== 'loading' && state.value !== 'loading-more' && options.value.some(item => String(item.id) === selectedId.value))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every(key => expected.includes(key))
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

const historyItemKeys = ['revisionId', 'revisionNumber', 'revisionKind', 'contentHash', 'previousRevisionFingerprint', 'revisionFingerprint', 'eventFingerprint', 'operations', 'occurredAt'] as const

function isHistoryItem(value: unknown): value is KnowledgeRevisionHistoryItem {
  if (!isRecord(value) || !hasExactKeys(value, historyItemKeys)) return false
  const operations = value.operations
  const validOperations = Array.isArray(operations) && operations.length > 0 && operations.length <= allowedOperations.length
    && operations.every((operation: unknown) => typeof operation === 'string' && (allowedOperations as readonly string[]).includes(operation))
    && new Set(operations).size === operations.length
    && operations.join('\u0000') === [...operations].sort().join('\u0000')
  const legacyOperations = value.revisionKind === 'legacy_baseline'
    ? value.revisionNumber === 1 && value.previousRevisionFingerprint === null && Array.isArray(operations) && operations.length === 1 && operations[0] === 'legacy_baseline'
    : Array.isArray(operations) && !operations.includes('legacy_baseline')
  return isPositiveId(value.revisionId) && isPositiveId(value.revisionNumber)
    && (value.revisionKind === 'legacy_baseline' || value.revisionKind === 'mutation')
    && isFingerprint(value.contentHash)
    && validOperations && legacyOperations
    && ((value.revisionNumber === 1) === (value.previousRevisionFingerprint === null))
    && (value.previousRevisionFingerprint === null || isFingerprint(value.previousRevisionFingerprint))
    && isFingerprint(value.revisionFingerprint) && isFingerprint(value.eventFingerprint)
    && isCanonicalIso(value.occurredAt)
}

function isHistory(value: unknown, expectedKind: KnowledgeRevisionSubjectKind, expectedId: number): value is KnowledgeRevisionHistory {
  if (!isRecord(value) || !hasExactKeys(value, ['subject', 'items', 'nextCursor', 'historyScope', 'rawSnapshotIncluded', 'automaticPublication', 'productionActivation', 'automaticTrainingAdmission'])) return false
  if (!isRecord(value.subject) || !hasExactKeys(value.subject, ['kind', 'id']) || value.subject.kind !== expectedKind || value.subject.id !== expectedId) return false
  if (value.historyScope !== 'recorded_mutations_only' || value.rawSnapshotIncluded !== false
    || value.automaticPublication !== false || value.productionActivation !== false || value.automaticTrainingAdmission !== false) return false
  const pageItems = value.items
  if (!Array.isArray(pageItems) || pageItems.length > 25 || !pageItems.every(isHistoryItem)) return false
  if (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length < 1 || value.nextCursor.length > 1024)) return false
  if (value.nextCursor !== null && pageItems.length === 0) return false
  return new Set(pageItems.map(item => item.revisionId)).size === pageItems.length
    && (value.nextCursor !== null ? pageItems.length === 25 : pageItems.length === 0 || pageItems[pageItems.length - 1]!.revisionNumber === 1)
    && pageItems.every((item, index) => index === 0 || (
      pageItems[index - 1]!.revisionNumber === item.revisionNumber + 1
      && pageItems[index - 1]!.revisionId > item.revisionId
      && pageItems[index - 1]!.previousRevisionFingerprint === item.revisionFingerprint
    ))
}

function statusFor(error: unknown): Exclude<HistoryState, 'idle' | 'loading' | 'loading-more' | 'empty' | 'ready'> {
  const status = isRecord(error) && Number.isInteger(error.statusCode) ? Number(error.statusCode)
    : isRecord(error) && isRecord(error.response) && Number.isInteger(error.response.status) ? Number(error.response.status) : null
  return status === 401 || status === 403 ? 'unauthorized' : status === 422 ? 'invalid' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'unavailable'
}

function clearHistory() {
  requestGeneration += 1
  items.value = []
  nextCursor.value = null
  state.value = 'idle'
}

watch(kind, clearHistory)
watch(selectedId, clearHistory)
watch([() => props.entities, () => props.claims, () => props.sources], clearHistory, { deep: true })

async function loadHistory(cursor?: string) {
  if (!canLoad.value) return
  const id = Number(selectedId.value)
  const selectedKind = kind.value
  if (!Number.isSafeInteger(id) || id < 1 || !options.value.some(option => option.id === id)) return
  if (cursor !== undefined && (!nextCursor.value || cursor !== nextCursor.value || state.value === 'loading-more')) return
  const generation = ++requestGeneration
  if (cursor === undefined) {
    items.value = []
    nextCursor.value = null
    state.value = 'loading'
  } else state.value = 'loading-more'
  try {
    const reply = await fetchHistory('/api/knowledge/revision-history', { query: { kind: selectedKind, id, ...(cursor === undefined ? {} : { cursor }) } })
    if (generation !== requestGeneration) return
    if (!isRecord(reply) || !hasExactKeys(reply, ['status', 'history']) || reply.status !== 'success' || !isHistory(reply.history, selectedKind, id)) {
      items.value = []
      nextCursor.value = null
      state.value = 'unavailable'
      return
    }
    const page = reply.history
    const previousPage = items.value
    const overlaps = cursor !== undefined && page.items.some(item => previousPage.some(existing => existing.revisionId === item.revisionId))
    const discontinuous = cursor !== undefined && (page.items.length === 0 || previousPage.length === 0 || (
      previousPage[previousPage.length - 1]!.revisionNumber !== page.items[0]!.revisionNumber + 1
      || previousPage[previousPage.length - 1]!.revisionId <= page.items[0]!.revisionId
      || previousPage[previousPage.length - 1]!.previousRevisionFingerprint !== page.items[0]!.revisionFingerprint
    ))
    if ((cursor !== undefined && page.nextCursor === cursor) || overlaps || discontinuous) {
      items.value = []
      nextCursor.value = null
      state.value = 'conflict'
      return
    }
    items.value = cursor === undefined ? [...page.items] : [...items.value, ...page.items]
    nextCursor.value = page.nextCursor
    state.value = items.value.length ? 'ready' : 'empty'
  } catch (error) {
    if (generation !== requestGeneration) return
    items.value = []
    nextCursor.value = null
    state.value = statusFor(error)
  }
}

function selectKind(value: string) {
  if (value === 'entity' || value === 'claim' || value === 'source') kind.value = value
}
</script>

<template>
  <section class="history" aria-labelledby="revision-history-title">
    <header><div><p class="eyebrow">OWNER-ONLY · IMMUTABLE HISTORY</p><h2 id="revision-history-title">知識修訂與變更事件</h2><p>唯讀查看已記錄的不可變修訂與事件；每次最多 25 筆，依序載入。這不是完整回溯保證，也不會審批、發布或訓練。</p></div><span class="badge">READ-ONLY</span></header>
    <div class="selectors">
      <label>紀錄類型<select :value="kind" aria-label="歷史紀錄類型" @change="selectKind(($event.target as HTMLSelectElement).value)"><option value="entity">實體</option><option value="claim">主張</option><option value="source">來源</option></select></label>
      <label>本頁已登錄項目<select v-model="selectedId" aria-label="選擇歷史 subject"><option value="" disabled>選擇{{ kindLabels[kind] }}</option><option v-for="option in options" :key="`${kind}:${option.id}`" :value="String(option.id)">{{ option.label }}</option></select></label>
      <button type="button" :disabled="!canLoad" @click="loadHistory()">{{ state === 'loading' ? '載入中…' : '讀取歷史' }}</button>
    </div>
    <p v-if="options.length === 0" class="state empty">目前沒有可選的已登錄{{ kindLabels[kind] }}；只接受本頁 owner 清單內的項目。</p>
    <p v-if="state === 'loading'" class="state" role="status">正在讀取修訂與事件摘要…</p>
    <p v-else-if="state === 'unauthorized'" class="state blocked" role="alert">需要有效的 owner session；歷史只供擁有人讀取。</p>
    <p v-else-if="state === 'invalid'" class="state blocked" role="alert">查詢無效；請從目前清單重新選擇項目。</p>
    <p v-else-if="state === 'not-found'" class="state blocked" role="alert">找不到此 owner 項目；可能已更新清單。</p>
    <p v-else-if="state === 'conflict'" class="state blocked" role="alert">歷史游標或資料狀態無法完整核對；請重新讀取，不顯示部分結果。</p>
    <p v-else-if="state === 'unavailable'" class="state blocked" role="alert">知識歷史目前無法安全載入；沒有以假資料替代。</p>
    <p v-else-if="state === 'empty'" class="state empty">此項目尚無可顯示的修訂／事件紀錄；不推測或補造歷史。</p>

    <template v-if="items.length">
      <p class="scope">範圍：僅顯示已記錄的 mutation history（recorded mutations only）。雜湊僅供核對，不是授權、CAS 或審批憑證。</p>
      <ol class="timeline"><li v-for="item in items" :key="item.revisionId" class="entry">
        <div class="entry-heading"><div><strong>Revision #{{ item.revisionNumber }} · {{ item.revisionKind === 'legacy_baseline' ? '舊資料基線' : 'Mutation revision' }}</strong><span v-if="item.revisionKind === 'legacy_baseline'" class="legacy">Legacy baseline · 不是原始舊歷史事件</span></div><time :datetime="item.occurredAt">{{ item.occurredAt }}</time></div>
        <dl><div><dt>Revision ID</dt><dd>{{ item.revisionId }}</dd></div><div><dt>Operations</dt><dd>{{ item.operations.length ? item.operations.join(' · ') : '—' }}</dd></div><div><dt>Snapshot content SHA-256</dt><dd><code>{{ item.contentHash }}</code></dd></div><div><dt>Previous revision SHA-256</dt><dd><code>{{ item.previousRevisionFingerprint ?? '—' }}</code></dd></div><div><dt>Revision fingerprint</dt><dd><code>{{ item.revisionFingerprint }}</code></dd></div><div><dt>Mutation event fingerprint</dt><dd><code>{{ item.eventFingerprint }}</code></dd></div></dl>
      </li></ol>
      <div v-if="state === 'loading-more'" class="state" role="status">正在載入下一頁…</div>
      <button v-if="nextCursor" type="button" :disabled="state === 'loading-more'" @click="loadHistory(nextCursor)">{{ state === 'loading-more' ? '載入中…' : '載入更早的 25 筆' }}</button>
      <p v-else class="end">已到目前可讀取歷史的末端。</p>
      <p class="safety">此元件不提供任何修訂、審批、發布、模型准入或訓練操作；未回傳原始 snapshot。</p>
    </template>
  </section>
</template>

<style scoped>
.history{margin:1rem 0;padding:1.2rem;border:1px solid #cbd7e8;border-radius:14px;background:#fff;color:#172033}.history header{display:flex;justify-content:space-between;gap:1rem;align-items:start}.history h2{margin:.25rem 0}.history header p{line-height:1.55}.eyebrow{font-size:.72rem;font-weight:800;letter-spacing:.1em;color:#52627a}.badge,.legacy{display:inline-flex;padding:.3rem .5rem;border-radius:999px;background:#edf2fb;color:#284b86;font-size:.72rem;font-weight:800;white-space:nowrap}.selectors{display:grid;grid-template-columns:minmax(8rem,1fr) minmax(14rem,3fr) auto;gap:.7rem;align-items:end}.selectors label{display:grid;gap:.25rem;font-size:.85rem;font-weight:700}.selectors select{box-sizing:border-box;width:100%;padding:.55rem;border:1px solid #b9c5d7;border-radius:7px;background:#fff;font:inherit}.history button{border:0;border-radius:8px;padding:.62rem .85rem;background:#213f7a;color:#fff;font:inherit;cursor:pointer}.history button:disabled{opacity:.55;cursor:not-allowed}.state{margin:.8rem 0;padding:.7rem;border-radius:8px;background:#f1f5fa}.blocked{background:#fff4e5;color:#754600}.empty,.end{color:#596981}.scope,.safety{font-size:.86rem;line-height:1.5;color:#4c5c73}.timeline{display:grid;gap:.7rem;padding:0;list-style:none}.entry{padding:.85rem;border:1px solid #dbe3ef;border-radius:10px;background:#fbfcfe}.entry-heading{display:flex;justify-content:space-between;gap:1rem;align-items:start}.entry-heading strong{display:block}.legacy{margin-top:.35rem;background:#fff1dc;color:#754600}.entry time{font-size:.8rem;color:#596981}.entry dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.45rem;margin:.75rem 0 0}.entry dl div{min-width:0;padding:.55rem;border-radius:7px;background:#f1f5fa}.entry dt{font-size:.72rem;color:#596981}.entry dd{margin:.2rem 0 0;overflow-wrap:anywhere;font-size:.82rem}.entry code{font-size:.72rem}.end{font-size:.82rem}@media(max-width:640px){.history{padding:.85rem}.history header,.entry-heading{display:grid}.selectors{grid-template-columns:1fr}.selectors button{width:100%}}
</style>
