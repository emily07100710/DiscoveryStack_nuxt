<script setup lang="ts">
/**
 * Two-step confirmation for destructive or irreversible owner actions.
 * The operator must retype the target object's name before the action unlocks,
 * so a mis-click can never release a domain or end a tenant.
 * Whether an action can be undone differs per action, so callers pass `consequence`.
 */
const props = withDefaults(defineProps<{
  open: boolean
  title: string
  /** Exact string the operator has to retype, e.g. the project or tenant name. */
  target: string
  description?: string
  /** What happens afterwards and whether it can be undone; omitted when the server gives no such guarantee. */
  consequence?: string
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  error?: string
  simulated?: boolean
}>(), {
  description: '',
  consequence: '',
  confirmLabel: '確認執行',
  cancelLabel: '取消',
  busy: false,
  error: '',
  simulated: false,
})

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const typed = ref('')
const matches = computed(() => typed.value.trim() === props.target.trim() && props.target.trim().length > 0)
const canConfirm = computed(() => matches.value && !props.busy)

watch(() => props.open, (open) => { if (!open) typed.value = '' })

function confirm() { if (canConfirm.value) emit('confirm') }
function cancel() { if (!props.busy) emit('cancel') }
</script>

<template>
  <div v-if="open" class="owner-confirm" role="dialog" aria-modal="true" :aria-label="title">
    <div class="owner-confirm__panel">
      <h3 class="owner-confirm__title">{{ title }}</h3>
      <p v-if="description" class="owner-confirm__description">{{ description }}</p>
      <p v-if="simulated" class="owner-confirm__simulated">未接真實對端:這個操作只會寫入本地紀錄,不會真的開通或變更外部服務。</p>
      <p v-if="consequence" class="owner-confirm__consequence">{{ consequence }}</p>
      <p class="owner-confirm__prompt">請輸入 <code class="owner-confirm__target">{{ target }}</code> 以確認。</p>
      <label class="owner-confirm__label">
        <span class="owner-confirm__label-text">輸入名稱以解鎖</span>
        <input v-model="typed" class="owner-confirm__input" type="text" autocomplete="off" spellcheck="false" :disabled="busy" :placeholder="target" @keyup.enter="confirm">
      </label>
      <p v-if="error" class="owner-confirm__error" role="alert">{{ error }}</p>
      <div class="owner-confirm__actions">
        <button class="button" type="button" :disabled="busy" @click="cancel">{{ cancelLabel }}</button>
        <button class="button button--danger" type="button" :disabled="!canConfirm" @click="confirm">{{ busy ? '執行中…' : confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.owner-confirm{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:rgba(15,23,32,.55)}.owner-confirm__panel{width:min(28rem,100%);border:1px solid #e3aaaa;border-radius:16px;background:#fff;padding:1.5rem;box-shadow:0 22px 48px rgba(15,23,32,.28)}.owner-confirm__title{margin:0 0 .5rem;font-size:1.05rem;color:#873434}.owner-confirm__description,.owner-confirm__prompt{margin:0 0 .75rem;color:#40505f;font-size:.82rem;line-height:1.6}.owner-confirm__consequence{margin:0 0 .75rem;color:#873434;font-size:.82rem;font-weight:700;line-height:1.6}.owner-confirm__simulated{margin:0 0 .75rem;border:1px solid #d8c48a;border-radius:10px;background:#fdf7e3;color:#6b5518;padding:.6rem .75rem;font-size:.75rem;line-height:1.6}.owner-confirm__target{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;background:#f4f7fa;border-radius:6px;padding:.1rem .35rem}.owner-confirm__label{display:block;margin-bottom:.85rem}.owner-confirm__label-text{display:block;margin-bottom:.35rem;color:#637184;font-size:.72rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.owner-confirm__input{width:100%;border:1px solid #c9d6e2;border-radius:10px;padding:.55rem .7rem;font:inherit;font-size:.85rem;box-sizing:border-box}.owner-confirm__input:focus-visible{border-color:#873434;outline:3px solid rgba(135,52,52,.16)}.owner-confirm__error{margin:0 0 .75rem;color:#873434;font-size:.78rem}.owner-confirm__actions{display:flex;justify-content:flex-end;gap:.6rem}.owner-confirm__actions .button{border:1px solid #c9d6e2;border-radius:999px;background:#fff;color:#1f2933;padding:.5rem 1rem;font:inherit;font-size:.78rem;font-weight:800;cursor:pointer}.owner-confirm__actions .button--danger{border-color:#c8a0a0;background:#873434;color:#fff}.owner-confirm__actions .button:disabled{opacity:.5;cursor:not-allowed}
</style>
