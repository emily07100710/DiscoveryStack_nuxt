<script setup lang="ts">
/**
 * Shared list pager for owner workbench tables.
 * Owns nothing but presentation: the page emits `update:page` and refetches.
 */
const props = withDefaults(defineProps<{
  page: number
  pageSize: number
  total?: number
  hasMore?: boolean
  disabled?: boolean
}>(), {
  total: undefined,
  hasMore: undefined,
  disabled: false,
})

const emit = defineEmits<{ 'update:page': [value: number] }>()

const knownTotal = computed(() => typeof props.total === 'number' && Number.isFinite(props.total))
const totalPages = computed(() => (knownTotal.value ? Math.max(1, Math.ceil((props.total as number) / props.pageSize)) : 0))
const canPrev = computed(() => !props.disabled && props.page > 1)
const canNext = computed(() => {
  if (props.disabled) return false
  if (knownTotal.value) return props.page < totalPages.value
  return props.hasMore === true
})
const rangeStart = computed(() => (props.page - 1) * props.pageSize + 1)
const rangeEnd = computed(() => (knownTotal.value ? Math.min(props.page * props.pageSize, props.total as number) : props.page * props.pageSize))
const summary = computed(() => {
  if (knownTotal.value) {
    if ((props.total as number) === 0) return '沒有資料'
    return `第 ${rangeStart.value}–${rangeEnd.value} 筆,共 ${props.total} 筆`
  }
  return `第 ${props.page} 頁`
})

function goPrev() { if (canPrev.value) emit('update:page', props.page - 1) }
function goNext() { if (canNext.value) emit('update:page', props.page + 1) }
</script>

<template>
  <nav class="owner-pager" aria-label="分頁">
    <button class="owner-pager__button" type="button" :disabled="!canPrev" @click="goPrev">上一頁</button>
    <span class="owner-pager__summary">{{ summary }}</span>
    <button class="owner-pager__button" type="button" :disabled="!canNext" @click="goNext">下一頁</button>
  </nav>
</template>

<style scoped>
.owner-pager{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-top:1rem;padding-top:.85rem;border-top:1px solid #e3e9ef}.owner-pager__summary{color:#637184;font-size:.75rem;font-variant-numeric:tabular-nums}.owner-pager__button{border:1px solid #c9d6e2;border-radius:999px;background:#fff;color:#1f2933;padding:.45rem .95rem;font:inherit;font-size:.75rem;font-weight:800;cursor:pointer}.owner-pager__button:hover:not(:disabled),.owner-pager__button:focus-visible:not(:disabled){border-color:#1f6feb;color:#1f6feb;outline:3px solid rgba(31,111,235,.16)}.owner-pager__button:disabled{opacity:.45;cursor:not-allowed}
</style>
