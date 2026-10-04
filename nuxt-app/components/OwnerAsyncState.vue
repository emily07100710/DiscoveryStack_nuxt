<script setup lang="ts">
/**
 * Shared loading / error / empty envelope for owner workbench panels.
 * Renders the default slot only once data is present, so every owner list and
 * detail surface handles the same three states the same way.
 */
const props = withDefaults(defineProps<{
  loading: boolean
  error?: string
  empty?: boolean
  loadingLabel?: string
  emptyLabel?: string
  retryLabel?: string
  retryable?: boolean
}>(), {
  error: '',
  empty: false,
  loadingLabel: '載入中…',
  emptyLabel: '目前沒有資料。',
  retryLabel: '重新載入',
  retryable: true,
})

defineEmits<{ retry: [] }>()

const showEmpty = computed(() => !props.loading && !props.error && props.empty)
</script>

<template>
  <p v-if="loading" class="owner-state owner-state--loading" role="status">{{ loadingLabel }}</p>
  <div v-else-if="error" class="owner-state owner-state--error" role="alert">
    <p class="owner-state__message">{{ error }}</p>
    <button v-if="retryable" class="owner-state__retry" type="button" @click="$emit('retry')">{{ retryLabel }}</button>
  </div>
  <p v-else-if="showEmpty" class="owner-state owner-state--empty">
    <slot name="empty">{{ emptyLabel }}</slot>
  </p>
  <slot v-else />
</template>

<style scoped>
.owner-state{border:1px dashed #b6c5d3;border-radius:14px;background:#fff;color:#637184;padding:1.5rem;margin:0;text-align:center;font-size:.85rem;line-height:1.6}.owner-state--error{border-style:solid;border-color:#e3aaaa;background:#fff2f2;color:#873434}.owner-state__message{margin:0}.owner-state__retry{margin-top:.75rem;border:1px solid #c8a0a0;border-radius:999px;background:#fff;color:#873434;padding:.5rem .9rem;font:inherit;font-size:.75rem;font-weight:800;cursor:pointer}.owner-state__retry:hover,.owner-state__retry:focus-visible{border-color:#873434;outline:3px solid rgba(135,52,52,.18)}
</style>
