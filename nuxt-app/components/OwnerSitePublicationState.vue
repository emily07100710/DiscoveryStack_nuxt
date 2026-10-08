<script setup lang="ts">
import { computed } from 'vue'

type SitePublicationView = {
  state: 'published' | 'private' | 'archived'
  contentMatch: 'matched' | 'changed' | 'unverifiable' | 'not_published'
  observedAt: string
  publishedAt: string | null
  postVersion: number
  publishedVersion: number | null
  hasUnpublishedChanges: boolean
  receiptIsCurrentState: false
}

const props = defineProps<{ value: unknown }>()
const stateKeys = [
  'state', 'contentMatch', 'observedAt', 'publishedAt', 'postVersion',
  'publishedVersion', 'hasUnpublishedChanges', 'receiptIsCurrentState',
] as const

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function validateState(value: unknown): SitePublicationView | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== stateKeys.length || ownKeys.some(key => typeof key !== 'string' || !(stateKeys as readonly string[]).includes(key))) return null
    const descriptors = stateKeys.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (descriptors.some(descriptor => !descriptor || !('value' in descriptor) || descriptor.enumerable !== true)) return null
    const fields = Object.fromEntries(stateKeys.map((key, index) => [key, descriptors[index]!.value])) as Record<(typeof stateKeys)[number], unknown>

    if (typeof fields.state !== 'string' || !(['published', 'private', 'archived'] as const).includes(fields.state as SitePublicationView['state'])) return null
    if (typeof fields.contentMatch !== 'string' || !(['matched', 'changed', 'unverifiable', 'not_published'] as const).includes(fields.contentMatch as SitePublicationView['contentMatch'])) return null
    if (!isIsoTimestamp(fields.observedAt)) return null
    if (fields.publishedAt !== null && !isIsoTimestamp(fields.publishedAt)) return null
    if (!Number.isSafeInteger(fields.postVersion) || (fields.postVersion as number) < 1) return null
    if (fields.publishedVersion !== null && (!Number.isSafeInteger(fields.publishedVersion) || (fields.publishedVersion as number) < 1)) return null
    if (typeof fields.hasUnpublishedChanges !== 'boolean' || fields.receiptIsCurrentState !== false) return null

    if (fields.state === 'published') {
      if (fields.contentMatch === 'not_published' || (fields.publishedVersion as number | null) === null || (fields.publishedVersion as number) < 2) return null
      if ((fields.publishedVersion as number) > (fields.postVersion as number)) return null
      if (fields.publishedAt !== null && Date.parse(fields.publishedAt) > Date.parse(fields.observedAt)) return null
      if (fields.hasUnpublishedChanges !== ((fields.publishedVersion as number) !== (fields.postVersion as number))) return null
    } else {
      if (fields.contentMatch !== 'not_published' || fields.publishedAt !== null || fields.publishedVersion !== null || fields.hasUnpublishedChanges !== false) return null
    }

    return {
      state: fields.state as SitePublicationView['state'],
      contentMatch: fields.contentMatch as SitePublicationView['contentMatch'],
      observedAt: fields.observedAt,
      publishedAt: fields.publishedAt,
      postVersion: fields.postVersion as number,
      publishedVersion: fields.publishedVersion as number | null,
      hasUnpublishedChanges: fields.hasUnpublishedChanges,
      receiptIsCurrentState: false,
    }
  } catch {
    return null
  }
}

const checkedState = computed(() => validateState(props.value))
const stateMessage = computed(() => {
  const value = checkedState.value
  if (!value) return '網站發布狀態尚未核驗，或回傳資料不完整。'
  if (value.state === 'private') return '核驗當時，文章未公開。'
  if (value.state === 'archived') return '核驗當時，文章已封存且未公開。'
  if (value.contentMatch === 'matched') return '網站確認已發布，公開版本與送入內容一致。'
  if (value.contentMatch === 'changed') return '網站已發布，但公開內容與送入版本不同，需重新核對。'
  return '網站已發布，但舊收件紀錄缺少內容指紋，無法確認版本一致。'
})
const observedLabel = computed(() => checkedState.value ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(checkedState.value.observedAt)) : '')
</script>

<template>
  <aside class="owner-site-publication-state" aria-label="網站發布核驗紀錄">
    <strong>{{ stateMessage }}</strong>
    <span v-if="checkedState">核驗時間：{{ observedLabel }}；此紀錄只代表核驗當時，之後狀態可能改變。</span>
    <span v-if="checkedState?.state === 'published' && checkedState.contentMatch === 'matched' && checkedState.hasUnpublishedChanges">另有尚未發布的編輯；公開版本仍與送入內容一致。</span>
    <span v-else-if="!checkedState">請重新核對；不會依此資料推定已發布、已刪除或已核准。</span>
    <span v-if="checkedState">此核驗不會授予發布權限、替代客戶同意或觸發成效學習。</span>
  </aside>
</template>

<style scoped>
.owner-site-publication-state{display:grid;gap:.25rem;margin-top:.65rem;padding:.7rem .8rem;border:1px solid #c8d2db;border-radius:8px;background:#f4f7f9;color:#354653;font-size:.78rem;line-height:1.45}.owner-site-publication-state strong{font-size:.82rem}
</style>
