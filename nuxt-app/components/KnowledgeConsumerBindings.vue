<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

type SubjectKind = 'entity' | 'claim' | 'source'
type ConsumerKind = 'geo_dataset' | 'benchmark_prompt'
type SubjectEntity = { id: number, canonicalName: string, entityType: string }
type SubjectClaim = { id: number, statement: string, claimType: string }
type SubjectSource = { id: number, title: string | null, canonicalUrl: string }
type CatalogItem = { consumerKind: ConsumerKind, consumerId: number, consumerVersion: string, consumerContentHash: string }
type BindingHead = {
  id: number, consumerKind: ConsumerKind, consumerId: number, consumerVersion: string, consumerContentHash: string,
  subjectKind: SubjectKind, subjectId: number, revisionId: number, revisionNumber: number, revisionContentHash: string,
  revisionFingerprint: string, operation: 'bind' | 'revoke', sequenceNumber: number, bindingFingerprint: string,
  previousBindingFingerprint: string | null, nativeAvailability: 'present' | 'missing',
}
type RevisionHead = { revisionId: number, revisionNumber: number, contentHash: string, revisionFingerprint: string }
type PendingCommand = { body: Record<string, unknown>, operation: 'bind' | 'revoke', consumer: CatalogItem, binding: BindingHead | null, revision: RevisionHead | null }
type FetchRequest = (path: string, options?: { query?: Record<string, string | number>, method?: 'POST', body?: Record<string, unknown> }) => Promise<unknown>
type PanelState = 'idle' | 'loading' | 'ready' | 'unauthorized' | 'invalid' | 'not-found' | 'conflict' | 'unavailable'

const props = defineProps<{
  entities: readonly SubjectEntity[]
  claims: readonly SubjectClaim[]
  sources: readonly SubjectSource[]
}>()
const request = $fetch as unknown as FetchRequest
const subjectKind = ref<SubjectKind>('entity')
const subjectId = ref('')
const consumerKind = ref<ConsumerKind>('geo_dataset')
const consumerId = ref('')
const bindings = ref<BindingHead[]>([])
const catalogItems = ref<CatalogItem[]>([])
const catalogAfterId = ref<number | null>(null)
const catalogHasMore = ref(false)
const coverageState = ref<PanelState>('idle')
const revisionState = ref<PanelState>('idle')
const revision = ref<RevisionHead | null>(null)
const checked = ref(false)
const pending = ref(false)
const pendingCommand = ref<PendingCommand | null>(null)
const requireReload = ref(false)
const notice = ref('')
const errorText = ref('')
let requestGeneration = 0
let revisionGeneration = 0
let catalogGeneration = 0
let mounted = true

const subjects = computed(() => subjectKind.value === 'entity' ? props.entities : subjectKind.value === 'claim' ? props.claims : props.sources)
const selectedSubjectId = computed(() => Number(subjectId.value))
const selectedNative = computed(() => catalogItems.value.find(item => String(item.consumerId) === consumerId.value && item.consumerKind === consumerKind.value) ?? null)
const currentBinding = computed(() => bindings.value.find(item => item.consumerKind === consumerKind.value && String(item.consumerId) === consumerId.value && item.subjectKind === subjectKind.value && item.subjectId === selectedSubjectId.value) ?? null)
const missingNativeBindings = computed(() => bindings.value.filter(item => item.consumerKind === consumerKind.value && item.nativeAvailability === 'missing' && item.operation === 'bind' && item.subjectKind === subjectKind.value && item.subjectId === selectedSubjectId.value && !catalogItems.value.some(anchor => anchor.consumerKind === item.consumerKind && anchor.consumerId === item.consumerId)))
// Retain a removed native anchor in the selector after bindings are loaded so its
// owner can inspect and revoke it; this fallback never enables a fresh bind.
const selectedConsumer = computed(() => selectedNative.value ?? (currentBinding.value ? {
  consumerKind: currentBinding.value.consumerKind, consumerId: currentBinding.value.consumerId,
  consumerVersion: currentBinding.value.consumerVersion, consumerContentHash: currentBinding.value.consumerContentHash,
} : null))
const bindingIsStale = computed(() => currentBinding.value?.operation === 'bind' && !!revision.value && currentBinding.value.revisionFingerprint !== revision.value.revisionFingerprint)
const locked = computed(() => pending.value || pendingCommand.value !== null || requireReload.value)
const canRead = computed(() => !pending.value && pendingCommand.value === null && coverageState.value !== 'loading')
const canCheckRevision = computed(() => !locked.value && Number.isSafeInteger(selectedSubjectId.value) && selectedSubjectId.value > 0 && subjects.value.some(item => item.id === selectedSubjectId.value) && revisionState.value !== 'loading')
const canBind = computed(() => !locked.value && checked.value && !!selectedNative.value && !!revision.value && revisionState.value === 'ready' && coverageState.value === 'ready' && currentBinding.value?.operation !== 'bind')
const canRepin = computed(() => !locked.value && checked.value && !!selectedNative.value && !!revision.value && bindingIsStale.value && coverageState.value === 'ready')
const canRevoke = computed(() => !locked.value && checked.value && !!currentBinding.value && currentBinding.value.operation === 'bind' && coverageState.value === 'ready')

const subjectOptions = computed(() => subjects.value.filter(item => Number.isSafeInteger(item.id) && item.id > 0).map(item => ({
  id: item.id,
  label: subjectKind.value === 'entity' ? `${(item as SubjectEntity).canonicalName} · ${(item as SubjectEntity).entityType} · #${item.id}`
    : subjectKind.value === 'claim' ? `${(item as SubjectClaim).statement} · #${item.id}`
      : `${(item as SubjectSource).title || (item as SubjectSource).canonicalUrl} · #${item.id}`,
})))

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function positiveId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 }
function fingerprint(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function statusOf(error: unknown): number | null {
  if (!record(error)) return null
  if (Number.isInteger(error.statusCode)) return Number(error.statusCode)
  if (record(error.response) && Number.isInteger(error.response.status)) return Number(error.response.status)
  return null
}
function stateFor(error: unknown): PanelState {
  const status = statusOf(error)
  return status === 401 || status === 403 ? 'unauthorized' : status === 422 ? 'invalid' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'unavailable'
}
function isCatalogItem(value: unknown, kind: ConsumerKind): value is CatalogItem {
  if (!record(value) || !exactKeys(value, ['consumerKind', 'consumerId', 'consumerVersion', 'consumerContentHash']) || value.consumerKind !== kind || !positiveId(value.consumerId) || !fingerprint(value.consumerContentHash) || typeof value.consumerVersion !== 'string' || value.consumerVersion.length === 0 || value.consumerVersion.length > 80) return false
  return kind === 'geo_dataset' ? value.consumerVersion === value.consumerContentHash : /^[1-9]\d{0,9}$/u.test(value.consumerVersion) && Number(value.consumerVersion) <= 2_147_483_647
}
const bindingKeys = ['id', 'consumerKind', 'consumerId', 'consumerVersion', 'consumerContentHash', 'subjectKind', 'subjectId', 'revisionId', 'revisionNumber', 'revisionContentHash', 'revisionFingerprint', 'operation', 'sequenceNumber', 'bindingFingerprint', 'previousBindingFingerprint', 'nativeAvailability'] as const
function isBindingHead(value: unknown): value is BindingHead {
  return record(value) && exactKeys(value, bindingKeys)
    && positiveId(value.id) && (value.consumerKind === 'geo_dataset' || value.consumerKind === 'benchmark_prompt') && positiveId(value.consumerId)
    && typeof value.consumerVersion === 'string' && value.consumerVersion.length > 0 && value.consumerVersion.length <= 80
    && fingerprint(value.consumerContentHash) && (value.subjectKind === 'entity' || value.subjectKind === 'claim' || value.subjectKind === 'source')
    && positiveId(value.subjectId) && positiveId(value.revisionId) && positiveId(value.revisionNumber) && fingerprint(value.revisionContentHash)
    && fingerprint(value.revisionFingerprint) && (value.operation === 'bind' || value.operation === 'revoke') && positiveId(value.sequenceNumber)
    && fingerprint(value.bindingFingerprint) && (value.previousBindingFingerprint === null || fingerprint(value.previousBindingFingerprint))
    && (value.nativeAvailability === 'present' || value.nativeAvailability === 'missing')
    && (value.consumerKind !== 'geo_dataset' || value.consumerVersion === value.consumerContentHash)
    && (value.consumerKind !== 'benchmark_prompt' || /^[1-9]\d{0,9}$/u.test(value.consumerVersion) && Number(value.consumerVersion) <= 2_147_483_647)
}
function isCoverageBucket(value: unknown, category: string): boolean {
  return record(value) && exactKeys(value, ['category', 'state', 'scope', 'limitationCodes', 'registeredConsumerCount'])
    && value.category === category && ['complete', 'unconfigured'].includes(String(value.state))
    && typeof value.scope === 'string' && value.scope.length <= 500
    && Array.isArray(value.limitationCodes) && value.limitationCodes.length <= 32
    && value.limitationCodes.every(code => typeof code === 'string' && code.length <= 80)
    && Number.isSafeInteger(value.registeredConsumerCount) && Number(value.registeredConsumerCount) >= 0 && Number(value.registeredConsumerCount) <= 1_000
}
function isBindingsReply(value: unknown): value is { bindings: BindingHead[] } {
  if (!record(value) || !exactKeys(value, ['status', 'coverage', 'bindings', 'exhaustive', 'automaticPublication', 'automaticTrainingAdmission', 'productionActivation']) || value.status !== 'ok' || value.exhaustive !== false || value.automaticPublication !== false || value.automaticTrainingAdmission !== false || value.productionActivation !== false || !Array.isArray(value.coverage) || value.coverage.length !== 6 || !Array.isArray(value.bindings) || value.bindings.length > 2_000) return false
  const expected = ['content', 'schema', 'dataset', 'public_api', 'benchmark_prompt', 'reviewer']
  return value.coverage.every((bucket, index) => isCoverageBucket(bucket, expected[index]!)) && value.bindings.every(isBindingHead)
}
function isCatalogReply(value: unknown, kind: ConsumerKind, afterId: number): value is { catalog: { items: CatalogItem[], nextAfterId: number | null } } {
  if (!record(value) || !exactKeys(value, ['status', 'catalog']) || value.status !== 'ok' || !record(value.catalog) || !exactKeys(value.catalog, ['consumerKind', 'items', 'nextAfterId', 'scope', 'rawTextIncluded', 'automaticPublication', 'automaticTrainingAdmission', 'productionActivation'])) return false
  const catalog = value.catalog
  if (catalog.consumerKind !== kind || catalog.scope !== 'owner_native_immutable_consumers_v1' || catalog.rawTextIncluded !== false || catalog.automaticPublication !== false || catalog.automaticTrainingAdmission !== false || catalog.productionActivation !== false || !Array.isArray(catalog.items) || catalog.items.length > 25 || !(catalog.nextAfterId === null || positiveId(catalog.nextAfterId))) return false
  if (!catalog.items.every(item => isCatalogItem(item, kind)) || new Set(catalog.items.map(item => item.consumerId)).size !== catalog.items.length) return false
  const ids = catalog.items.map(item => item.consumerId)
  if (ids.some(id => id <= afterId) || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) return false
  if (catalog.nextAfterId !== null && (catalog.items.length !== 25 || catalog.nextAfterId <= afterId || catalog.nextAfterId !== ids.at(-1))) return false
  return true
}
function isRevisionReply(value: unknown, kind: SubjectKind, id: number): RevisionHead | null | false {
  if (!record(value) || !exactKeys(value, ['status', 'history']) || value.status !== 'success' || !record(value.history)) return false
  const history = value.history
  if (!exactKeys(history, ['subject', 'items', 'nextCursor', 'historyScope', 'rawSnapshotIncluded', 'automaticPublication', 'productionActivation', 'automaticTrainingAdmission']) || !record(history.subject) || !exactKeys(history.subject, ['kind', 'id']) || history.subject.kind !== kind || history.subject.id !== id || history.historyScope !== 'recorded_mutations_only' || history.rawSnapshotIncluded !== false || history.automaticPublication !== false || history.productionActivation !== false || history.automaticTrainingAdmission !== false || !(history.nextCursor === null || typeof history.nextCursor === 'string' && history.nextCursor.length <= 500) || !Array.isArray(history.items) || history.items.length > 25) return false
  if (Object.hasOwn(history, 'canonicalSnapshot') || history.items.some(item => !record(item) || Object.hasOwn(item, 'canonicalSnapshot') || Object.hasOwn(item, 'rawSnapshot'))) return false
  const head = history.items[0]
  if (!head) return history.items.length === 0 ? null : false
  if (!exactKeys(head, ['revisionId', 'revisionNumber', 'revisionKind', 'contentHash', 'previousRevisionFingerprint', 'revisionFingerprint', 'eventFingerprint', 'operations', 'occurredAt']) || !positiveId(head.revisionId) || !positiveId(head.revisionNumber) || !fingerprint(head.contentHash) || !fingerprint(head.revisionFingerprint)) return false
  return { revisionId: head.revisionId, revisionNumber: head.revisionNumber, contentHash: head.contentHash, revisionFingerprint: head.revisionFingerprint }
}
function parseMutationReply(value: unknown): { binding: Omit<BindingHead, 'nativeAvailability'>, replayed: boolean } | null {
  if (!record(value) || !exactKeys(value, ['status', 'value']) || value.status !== 'ok' || !record(value.value) || !exactKeys(value.value, ['binding', 'replayed', 'automaticPublication', 'automaticTrainingAdmission', 'productionActivation']) || typeof value.value.replayed !== 'boolean' || value.value.automaticPublication !== false || value.value.automaticTrainingAdmission !== false || value.value.productionActivation !== false || !record(value.value.binding)) return null
  const binding = value.value.binding
  const keys = bindingKeys.filter(key => key !== 'nativeAvailability')
  if (!(exactKeys(binding, keys) && positiveId(binding.id) && (binding.consumerKind === 'geo_dataset' || binding.consumerKind === 'benchmark_prompt') && positiveId(binding.consumerId) && typeof binding.consumerVersion === 'string' && binding.consumerVersion.length > 0 && binding.consumerVersion.length <= 80 && fingerprint(binding.consumerContentHash) && (binding.subjectKind === 'entity' || binding.subjectKind === 'claim' || binding.subjectKind === 'source') && positiveId(binding.subjectId) && positiveId(binding.revisionId) && positiveId(binding.revisionNumber) && fingerprint(binding.revisionContentHash) && fingerprint(binding.revisionFingerprint) && (binding.operation === 'bind' || binding.operation === 'revoke') && positiveId(binding.sequenceNumber) && fingerprint(binding.bindingFingerprint) && (binding.previousBindingFingerprint === null || fingerprint(binding.previousBindingFingerprint)) && (binding.consumerKind === 'geo_dataset' ? binding.consumerVersion === binding.consumerContentHash : /^[1-9]\d{0,9}$/u.test(String(binding.consumerVersion)) && Number(binding.consumerVersion) <= 2_147_483_647))) return null
  return { binding: binding as unknown as Omit<BindingHead, 'nativeAvailability'>, replayed: value.value.replayed }
}

function invalidateReads() { requestGeneration += 1; revisionGeneration += 1; catalogGeneration += 1 }
watch(subjectKind, () => {
  if (pendingCommand.value) { subjectKind.value = String(pendingCommand.value.body.subjectKind) as SubjectKind; return }
  revisionGeneration += 1; subjectId.value = ''; revision.value = null; revisionState.value = 'idle'; checked.value = false
})
watch(subjectId, () => {
  if (pendingCommand.value) { subjectId.value = String(pendingCommand.value.body.subjectId); return }
  revisionGeneration += 1; revision.value = null; revisionState.value = 'idle'; checked.value = false
})
watch(consumerKind, () => {
  if (pendingCommand.value) { consumerKind.value = pendingCommand.value.consumer.consumerKind; return }
  requestGeneration += 1; catalogGeneration += 1; coverageState.value = 'idle'; catalogItems.value = []; catalogAfterId.value = null; catalogHasMore.value = false; consumerId.value = ''; checked.value = false
})
watch(consumerId, () => {
  if (pendingCommand.value) { consumerId.value = String(pendingCommand.value.consumer.consumerId); return }
  checked.value = false
})
watch([() => props.entities, () => props.claims, () => props.sources], () => { invalidateReads(); subjectId.value = ''; revision.value = null; checked.value = false; revisionState.value = 'idle'; coverageState.value = 'idle'; bindings.value = []; catalogItems.value = []; consumerId.value = '' }, { deep: true })
onBeforeUnmount(() => { mounted = false; invalidateReads() })

async function loadBindingsAndCatalog() {
  if (!canRead.value) return
  const generation = ++requestGeneration
  const selectedKind = consumerKind.value
  coverageState.value = 'loading'; notice.value = ''; errorText.value = ''
  catalogItems.value = []; catalogAfterId.value = null; catalogHasMore.value = false
  try {
    const [bindingReply, catalogReply] = await Promise.all([
      request('/api/knowledge/consumer-bindings'),
      request('/api/knowledge/consumer-catalog', { query: { kind: selectedKind } }),
    ])
    if (!mounted || generation !== requestGeneration || selectedKind !== consumerKind.value) return
    if (!isBindingsReply(bindingReply) || !isCatalogReply(catalogReply, selectedKind, 0)) { coverageState.value = 'unavailable'; errorText.value = '伺服器回應無法安全核對；請重新載入。'; return }
    checked.value = false
    bindings.value = bindingReply.bindings
    catalogItems.value = catalogReply.catalog.items
    catalogAfterId.value = catalogReply.catalog.nextAfterId
    catalogHasMore.value = catalogReply.catalog.nextAfterId !== null
    // A 409 recovery requires a fresh workspace and revision check before any new command.
    revision.value = null
    revisionState.value = 'idle'
    requireReload.value = false
    coverageState.value = 'ready'
  } catch (error) {
    if (!mounted || generation !== requestGeneration) return
    coverageState.value = stateFor(error)
    if (coverageState.value === 'unauthorized') {
      bindings.value = []; catalogItems.value = []; catalogAfterId.value = null; catalogHasMore.value = false
      revision.value = null; revisionState.value = 'unauthorized'; checked.value = false; requireReload.value = true
    }
    errorText.value = coverageState.value === 'unauthorized' ? '需要有效的 owner session。' : coverageState.value === 'conflict' ? '連結資料無法完整核對，請重新載入。' : '連結與 native 選項目前無法安全載入。'
  }
}

async function loadMoreCatalog() {
  if (locked.value || coverageState.value !== 'ready' || !catalogHasMore.value || catalogAfterId.value === null) return
  const generation = ++catalogGeneration
  const selectedKind = consumerKind.value
  const afterId = catalogAfterId.value
  try {
    const reply = await request('/api/knowledge/consumer-catalog', { query: { kind: selectedKind, afterId } })
    if (!mounted || generation !== catalogGeneration || selectedKind !== consumerKind.value) return
    if (!isCatalogReply(reply, selectedKind, afterId)) { coverageState.value = 'conflict'; errorText.value = 'Catalog 游標或排序無法核對；請重新載入。'; return }
    const page = reply.catalog
    if (page.items.some(item => catalogItems.value.some(existing => existing.consumerId === item.consumerId))) { coverageState.value = 'conflict'; errorText.value = 'Catalog 重複了已載入的 consumer；請重新載入。'; return }
    catalogItems.value = [...catalogItems.value, ...page.items]
    catalogAfterId.value = page.nextAfterId
    catalogHasMore.value = page.nextAfterId !== null
  } catch (error) {
    if (!mounted || generation !== catalogGeneration) return
    coverageState.value = stateFor(error)
    errorText.value = coverageState.value === 'unauthorized' ? '需要有效的 owner session。' : '下一頁選項無法安全載入；已保留目前選取項目。'
  }
}

async function checkCurrentRevision() {
  if (!canCheckRevision.value) return
  const generation = ++revisionGeneration
  const kind = subjectKind.value
  const id = selectedSubjectId.value
  revisionState.value = 'loading'; revision.value = null; checked.value = false
  try {
    const result = await request('/api/knowledge/revision-history', { query: { kind, id } })
    if (!mounted || generation !== revisionGeneration || kind !== subjectKind.value || id !== selectedSubjectId.value) return
    const head = isRevisionReply(result, kind, id)
    if (head === false) { revisionState.value = 'unavailable'; return }
    revision.value = head
    revisionState.value = 'ready'
  } catch (error) {
    if (!mounted || generation !== revisionGeneration) return
    revisionState.value = stateFor(error)
  }
}

function uuid(): string | null {
  try { return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : null } catch { return null }
}
function commandFor(operation: 'bind' | 'revoke'): PendingCommand | null {
  const consumer = selectedNative.value ?? (operation === 'revoke' ? selectedConsumer.value : null)
  if (!consumer || !currentBinding.value && operation === 'revoke' || operation === 'bind' && !revision.value) return null
  const idempotencyKey = uuid()
  if (!idempotencyKey) return null
  return {
    operation, consumer, binding: currentBinding.value, revision: revision.value,
    body: {
      consumerKind: consumerKind.value, consumerId: consumer.consumerId, subjectKind: subjectKind.value, subjectId: selectedSubjectId.value,
      operation, expectedRevisionFingerprint: operation === 'bind' ? revision.value!.revisionFingerprint : null,
      expectedBindingFingerprint: currentBinding.value?.bindingFingerprint ?? null, idempotencyKey,
    },
  }
}
function applyReceipt(receipt: { binding: Omit<BindingHead, 'nativeAvailability'>, replayed: boolean }, command: PendingCommand) {
  const row: BindingHead = { ...receipt.binding, nativeAvailability: command.operation === 'revoke' ? command.binding?.nativeAvailability ?? 'missing' : 'present' }
  const found = bindings.value.findIndex(item => item.consumerKind === row.consumerKind && item.consumerId === row.consumerId && item.subjectKind === row.subjectKind && item.subjectId === row.subjectId)
  if (found < 0) bindings.value = [...bindings.value, row]
  else bindings.value = bindings.value.map((item, index) => index === found ? row : item)
  notice.value = command.operation === 'revoke' ? '已記錄撤銷；原始歷史仍保留。' : '已記錄精確知識修訂依賴。'
}
async function submit(command: PendingCommand) {
  if (pending.value) return
  pending.value = true; notice.value = ''; errorText.value = ''
  try {
    const reply = await request('/api/knowledge/consumer-bindings', { method: 'POST', body: command.body })
    if (!mounted) return
    const parsed = parseMutationReply(reply)
    const prior = command.binding
    const expectedPrevious = prior?.bindingFingerprint ?? null
    const expectedSequence = (prior?.sequenceNumber ?? 0) + 1
    const revisionMatches = !!parsed && (command.operation === 'bind'
      ? !!command.revision && parsed.binding.revisionId === command.revision.revisionId && parsed.binding.revisionNumber === command.revision.revisionNumber && parsed.binding.revisionContentHash === command.revision.contentHash && parsed.binding.revisionFingerprint === command.revision.revisionFingerprint
      : !!prior && parsed.binding.revisionId === prior.revisionId && parsed.binding.revisionNumber === prior.revisionNumber && parsed.binding.revisionContentHash === prior.revisionContentHash && parsed.binding.revisionFingerprint === prior.revisionFingerprint)
    if (!parsed || parsed.binding.consumerKind !== command.consumer.consumerKind || parsed.binding.consumerId !== command.consumer.consumerId || parsed.binding.subjectKind !== String(command.body.subjectKind) || parsed.binding.subjectId !== command.body.subjectId || parsed.binding.operation !== command.operation || parsed.binding.consumerContentHash !== command.consumer.consumerContentHash || parsed.binding.consumerVersion !== command.consumer.consumerVersion || parsed.binding.previousBindingFingerprint !== expectedPrevious || parsed.binding.sequenceNumber !== expectedSequence || !revisionMatches) {
      pendingCommand.value = command
      errorText.value = '成功回應無法安全核對；請只重試原命令，勿建立新命令。'
      return
    }
    applyReceipt(parsed, command)
    pendingCommand.value = null
    requireReload.value = false
    checked.value = false
    revision.value = null
    revisionState.value = 'idle'
  } catch (error) {
    if (!mounted) return
    const status = statusOf(error)
    if (status === null || status >= 500) {
      pendingCommand.value = command
      errorText.value = '結果不確定。已保留原命令；只能重試同一命令與 key。'
    } else if (status === 409) {
      pendingCommand.value = null
      requireReload.value = true
      checked.value = false
      revision.value = null
      revisionState.value = 'idle'
      errorText.value = '資料已變動或無法核對；請重新載入連結與修訂後再操作。'
    } else {
      pendingCommand.value = null
      if (status === 401 || status === 403) {
        coverageState.value = 'unauthorized'; bindings.value = []; catalogItems.value = []; catalogAfterId.value = null; catalogHasMore.value = false
        revision.value = null; revisionState.value = 'unauthorized'; checked.value = false; requireReload.value = true
      }
      errorText.value = status === 401 || status === 403 ? '需要有效的 owner session。' : status === 404 ? '找不到 native consumer 或 Knowledge subject。' : status === 422 ? '命令格式無效；請重新載入後確認選項。' : '操作未完成；請重新載入狀態。'
    }
  } finally { if (mounted) pending.value = false }
}
function startOperation(operation: 'bind' | 'revoke') {
  if (locked.value || !checked.value) return
  const allowed = operation === 'revoke' ? canRevoke.value : bindingIsStale.value ? canRepin.value : canBind.value
  if (!allowed) return
  const command = commandFor(operation)
  if (!command) { errorText.value = '目前環境無法建立安全的隨機命令 key。'; return }
  void submit(command)
}
function retryOriginal() { if (pendingCommand.value && !pending.value) void submit(pendingCommand.value) }
</script>

<template>
  <section class="consumer-bindings" aria-labelledby="consumer-bindings-title">
    <header class="heading">
      <div><p class="eyebrow">OWNER-ONLY · EXACT REVISION REGISTRY</p><h2 id="consumer-bindings-title">資料集與 Prompt 知識依賴</h2><p>只登錄你明確選取的 native ID 與目前不可變修訂；不依名稱猜測，也不核准訓練或發布。</p></div>
      <span class="badge">OWNER REVIEW REQUIRED</span>
    </header>
    <p class="boundary">Dataset 以 manifest fingerprint 作版本與 hash；Prompt 以不可變版本 ID、版本號與 prompt hash 核對。公開 API 與 reviewer 尚未接入。</p>

    <div class="selectors">
      <label>Native consumer 類型<select v-model="consumerKind" aria-label="Native consumer 類型" :disabled="locked"><option value="geo_dataset">GEO 資料集 manifest</option><option value="benchmark_prompt">Benchmark prompt version</option></select></label>
      <label>知識紀錄類型<select v-model="subjectKind" aria-label="知識紀錄類型" :disabled="locked"><option value="entity">實體</option><option value="claim">主張</option><option value="source">來源</option></select></label>
      <label>本頁知識紀錄<select v-model="subjectId" aria-label="選擇知識紀錄" :disabled="locked"><option value="" disabled>選擇{{ subjectKind }}</option><option v-for="item in subjectOptions" :key="`${subjectKind}:${item.id}`" :value="String(item.id)">{{ item.label }}</option></select></label>
      <button type="button" :disabled="!canRead" @click="loadBindingsAndCatalog">{{ coverageState === 'loading' ? '載入中…' : '載入連結與選項' }}</button>
    </div>
    <p v-if="subjectOptions.length === 0" class="state empty">本頁目前沒有可選的{{ subjectKind }}。</p>
    <p v-if="coverageState === 'loading'" class="state" role="status">正在讀取 owner-scoped binding 與 native 清單…</p>
    <p v-else-if="coverageState === 'unauthorized'" class="state blocked" role="alert">需要有效的 owner session；此登錄僅供擁有人操作。</p>
    <p v-else-if="coverageState === 'conflict'" class="state blocked" role="alert">連結狀態無法完整核對；請重新載入，不顯示猜測結果。</p>
    <p v-else-if="coverageState === 'unavailable'" class="state blocked" role="alert">連結資料目前無法安全載入；沒有以示範資料替代。</p>
    <p v-else-if="coverageState === 'invalid'" class="state blocked" role="alert">查詢無效；請重新載入頁面後再試。</p>
    <p v-else-if="coverageState === 'not-found'" class="state blocked" role="alert">找不到目前 owner 的項目；請重新載入清單。</p>
    <p v-if="errorText" class="state blocked" role="alert">{{ errorText }}</p>

    <template v-if="coverageState === 'ready'">
      <div class="selectors native-select">
        <label>{{ consumerKind === 'geo_dataset' ? '精確 Dataset ID' : '精確 Prompt version ID' }}<select v-model="consumerId" aria-label="選擇 native consumer" :disabled="locked"><option value="" disabled>選擇已載入的 ID</option><option v-for="item in catalogItems" :key="`${item.consumerKind}:${item.consumerId}`" :value="String(item.consumerId)">#{{ item.consumerId }} · {{ item.consumerVersion }} · {{ item.consumerContentHash }}</option><option v-for="item in missingNativeBindings" :key="`missing:${item.consumerKind}:${item.consumerId}`" :value="String(item.consumerId)">#{{ item.consumerId }} · 原 native 已移除（可撤銷）</option></select></label>
        <button v-if="catalogHasMore" type="button" :disabled="locked" @click="loadMoreCatalog">載入下一頁</button>
        <span class="scope">{{ catalogItems.length }} 個明確 native IDs · 每頁最多 25 筆</span>
      </div>
      <p v-if="catalogItems.length === 0" class="state empty">此 owner 尚無此類 native 項目，或清單尚未載入。</p>
      <section v-if="selectedConsumer" class="details" aria-label="選取項目摘要">
        <p>Native ID <strong>#{{ selectedConsumer.consumerId }}</strong> · Version <code>{{ selectedConsumer.consumerVersion }}</code></p>
        <p>Native content hash <code>{{ selectedConsumer.consumerContentHash }}</code></p>
        <p v-if="currentBinding?.nativeAvailability === 'missing'" class="blocked">此 native consumer 已不存在；仍可撤銷其舊依賴。</p>
        <p v-if="currentBinding?.operation === 'bind'">目前登錄 Revision #{{ currentBinding.revisionNumber }} · {{ currentBinding.revisionFingerprint }}</p>
        <p v-if="currentBinding?.operation === 'revoke'">最近狀態為已撤銷；重新登錄需核對目前修訂。</p>
        <p v-if="revisionState === 'loading'" role="status">正在核對目前不可變修訂…</p>
        <p v-else-if="revisionState === 'unauthorized'" class="blocked">需要有效的 owner session。</p>
        <p v-else-if="revisionState === 'not-found'" class="blocked">找不到此 Knowledge subject。</p>
        <p v-else-if="revisionState === 'conflict'" class="blocked">修訂歷史無法核對；停止新增依賴。</p>
        <p v-else-if="revisionState === 'unavailable'" class="blocked">修訂目前無法核對；停止新增依賴。</p>
        <p v-else-if="revisionState === 'ready' && revision">目前修訂：{{ revision.revisionFingerprint }}<span v-if="bindingIsStale" class="stale"> · 與既有 pin 不同，需要重新綁定</span><span v-else-if="currentBinding?.operation === 'bind'"> · 與目前 pin 一致</span></p>
        <button type="button" :disabled="!canCheckRevision" @click="checkCurrentRevision">{{ revisionState === 'loading' ? '核對中…' : '核對目前修訂' }}</button>
        <label class="confirm"><input v-model="checked" type="checkbox" :disabled="locked">我了解這只登錄依賴，不核准訓練或發布。</label>
        <div class="actions">
          <button v-if="!currentBinding || currentBinding.operation === 'revoke'" type="button" :disabled="!canBind" @click="startOperation('bind')">建立依賴</button>
          <button v-if="bindingIsStale" type="button" :disabled="!canRepin" @click="startOperation('bind')">重新綁定目前修訂</button>
          <button v-if="currentBinding?.operation === 'bind'" type="button" class="secondary" :disabled="!canRevoke" @click="startOperation('revoke')">撤銷依賴</button>
          <span v-if="pending" role="status">命令傳送中…</span>
        </div>
      </section>
      <section v-if="pendingCommand" class="uncertain" aria-live="polite">
        <strong>命令結果尚未確認</strong>
        <p>為避免重複追加，只能使用保存的原始命令與 key 重試；欄位已鎖定。</p>
        <button type="button" :disabled="pending" @click="retryOriginal">{{ pending ? '重試中…' : '重試同一命令' }}</button>
      </section>
      <section v-if="requireReload" class="uncertain" aria-live="polite">
        <strong>需要重新核對</strong><p>CAS 衝突後已清除待送命令。重新載入 binding 與 native 清單，並重新核對修訂後才能操作。</p>
      </section>
      <p v-if="notice" class="state success" role="status">{{ notice }}</p>
      <p class="scope">此清單僅涵蓋已登錄明確依賴；未登錄關係不在範圍內。撤銷保留 append-only 歷史。</p>
    </template>
    <p class="safety">任何登錄都不會自動發布內容、准入訓練資料或啟用模型。未找到修訂時只能撤銷既有依賴，不能補造歷史。</p>
  </section>
</template>

<style scoped>
.consumer-bindings{margin:1rem 0;padding:1.2rem;border:1px solid #cbd7e8;border-radius:14px;background:#fff;color:#172033}.heading{display:flex;justify-content:space-between;gap:1rem;align-items:start}.heading h2{margin:.25rem 0}.heading p{line-height:1.5}.eyebrow{font-size:.72rem;font-weight:800;letter-spacing:.1em;color:#52627a}.badge{display:inline-flex;padding:.3rem .5rem;border-radius:999px;background:#edf2fb;color:#284b86;font-size:.72rem;font-weight:800;white-space:nowrap}.boundary,.scope,.safety{font-size:.86rem;line-height:1.5;color:#4c5c73}.selectors{display:grid;grid-template-columns:repeat(3,minmax(9rem,1fr)) auto;gap:.7rem;align-items:end}.selectors label{display:grid;gap:.25rem;font-size:.85rem;font-weight:700}.selectors select{box-sizing:border-box;width:100%;padding:.55rem;border:1px solid #b9c5d7;border-radius:7px;background:#fff;font:inherit}.consumer-bindings button{border:0;border-radius:8px;padding:.62rem .85rem;background:#213f7a;color:#fff;font:inherit;cursor:pointer}.consumer-bindings button:disabled{opacity:.55;cursor:not-allowed}.state,.details,.uncertain{margin:.8rem 0;padding:.75rem;border-radius:8px;background:#f1f5fa}.blocked,.stale{color:#754600}.blocked{background:#fff4e5}.empty{color:#596981}.native-select{grid-template-columns:minmax(12rem,3fr) auto minmax(10rem,1fr);margin-top:.8rem}.native-select select{max-width:100%;overflow:hidden;text-overflow:ellipsis}.native-select select option{max-width:100%}.details{border:1px solid #dbe3ef}.details p{overflow-wrap:anywhere}.details code{font-size:.76rem;overflow-wrap:anywhere}.confirm{display:flex;align-items:start;gap:.55rem;margin:.85rem 0;font-weight:700}.confirm input{margin-top:.25rem}.actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}.secondary{background:#596981!important}.uncertain{border:1px solid #dfb66c;background:#fff8e9}.uncertain p{line-height:1.5}.success{background:#eaf7ef;color:#245b36}.safety{margin-bottom:0;font-weight:700}@media(max-width:720px){.consumer-bindings{padding:.85rem}.heading{display:grid}.selectors,.native-select{grid-template-columns:1fr}.selectors button{width:100%}}
</style>
