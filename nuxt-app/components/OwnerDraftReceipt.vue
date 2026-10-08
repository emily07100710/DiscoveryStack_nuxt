<script setup lang="ts">
import { computed } from 'vue'

type DraftReceiptView = {
  status: 'draft_received'
  published: false
  receiptScope: 'draft_ingest_outcome'
  receiptIsCurrentState: false
  publicationId: string
  contentHash: string
  postId: string
  postVersion: 1
  replayed: boolean
}

const props = defineProps<{ receipt: unknown }>()

const receiptKeys = [
  'status', 'published', 'receiptScope', 'receiptIsCurrentState',
  'publicationId', 'contentHash', 'postId', 'postVersion', 'replayed',
] as const
const hashPattern = /^[a-f0-9]{64}$/u
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function validateReceipt(value: unknown): DraftReceiptView | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== receiptKeys.length || ownKeys.some(key => typeof key !== 'string' || !(receiptKeys as readonly string[]).includes(key))) return null
    const descriptors = receiptKeys.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (descriptors.some(descriptor => !descriptor || !('value' in descriptor) || descriptor.enumerable !== true)) return null
    const fields = Object.fromEntries(receiptKeys.map((key, index) => [key, descriptors[index]!.value])) as Record<(typeof receiptKeys)[number], unknown>

    if (fields.status !== 'draft_received' || fields.published !== false || fields.receiptScope !== 'draft_ingest_outcome' || fields.receiptIsCurrentState !== false || fields.postVersion !== 1 || typeof fields.replayed !== 'boolean') return null
    if (typeof fields.publicationId !== 'string' || !opaqueIdPattern.test(fields.publicationId)) return null
    if (typeof fields.contentHash !== 'string' || !hashPattern.test(fields.contentHash)) return null
    if (typeof fields.postId !== 'string' || !(opaqueIdPattern.test(fields.postId) || uuidPattern.test(fields.postId))) return null

    return {
      status: 'draft_received',
      published: false,
      receiptScope: 'draft_ingest_outcome',
      receiptIsCurrentState: false,
      publicationId: fields.publicationId,
      contentHash: fields.contentHash,
      postId: fields.postId,
      postVersion: 1,
      replayed: fields.replayed,
    }
  } catch {
    return null
  }
}

const validatedReceipt = computed(() => validateReceipt(props.receipt))
</script>

<template>
  <aside v-if="validatedReceipt" class="owner-draft-receipt" aria-label="草稿接收回執">
    <strong>網站已收到草稿（歷史回執）</strong>
    <span>目前發布狀態須另外核驗；此回執不代表文章目前狀態或已發布。</span>
    <span v-if="validatedReceipt.replayed">此次為重複送達，沿用原接收結果。</span>
  </aside>
</template>

<style scoped>
.owner-draft-receipt{display:grid;gap:.25rem;padding:.7rem .8rem;border:1px solid #d6dfca;border-radius:8px;background:#f7f9f2;color:#354432;font-size:.78rem;line-height:1.45}.owner-draft-receipt strong{font-size:.82rem}
</style>
