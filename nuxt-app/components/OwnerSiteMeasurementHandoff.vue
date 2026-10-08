<script setup lang="ts">
import { computed, ref } from 'vue'

type SiteMeasurementHandoff = {
  state: 'available' | 'confirmed' | 'blocked'
  publicationFingerprint: string | null
  confirmedAt: string | null
  reason: 'not_verified' | 'not_published' | 'content_changed' | 'observation_expired' | 'authority_invalid' | 'confirmed' | 'available'
}

const props = withDefaults(defineProps<{ value: unknown; busy?: boolean; error?: string }>(), { busy: false, error: '' })
const emit = defineEmits<{ confirm: [] }>()
const openConfirmation = ref(false)
const handoffKeys = ['state', 'publicationFingerprint', 'confirmedAt', 'reason'] as const
const fingerprintPattern = /^[a-f0-9]{64}$/u

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function validate(value: unknown): SiteMeasurementHandoff | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== handoffKeys.length || keys.some(key => typeof key !== 'string' || !(handoffKeys as readonly string[]).includes(key))) return null
    const descriptors = handoffKeys.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (descriptors.some(descriptor => !descriptor || !('value' in descriptor) || descriptor.enumerable !== true)) return null
    const fields = Object.fromEntries(handoffKeys.map((key, index) => [key, descriptors[index]!.value])) as Record<(typeof handoffKeys)[number], unknown>
    if (typeof fields.state !== 'string' || !(['available', 'confirmed', 'blocked'] as const).includes(fields.state as SiteMeasurementHandoff['state'])) return null
    if (typeof fields.reason !== 'string' || !(['not_verified', 'not_published', 'content_changed', 'observation_expired', 'authority_invalid', 'confirmed', 'available'] as const).includes(fields.reason as SiteMeasurementHandoff['reason'])) return null
    if (fields.publicationFingerprint !== null && (typeof fields.publicationFingerprint !== 'string' || !fingerprintPattern.test(fields.publicationFingerprint))) return null
    if (fields.confirmedAt !== null && !isoTimestamp(fields.confirmedAt)) return null

    if (fields.state === 'available') {
      if (fields.reason !== 'available' || typeof fields.publicationFingerprint !== 'string' || fields.confirmedAt !== null) return null
    } else if (fields.state === 'confirmed') {
      if (fields.reason !== 'confirmed' || typeof fields.publicationFingerprint !== 'string' || !isoTimestamp(fields.confirmedAt)) return null
    } else if (['confirmed', 'available'].includes(fields.reason)) {
      return null
    }

    return {
      state: fields.state as SiteMeasurementHandoff['state'],
      publicationFingerprint: fields.publicationFingerprint as string | null,
      confirmedAt: fields.confirmedAt as string | null,
      reason: fields.reason as SiteMeasurementHandoff['reason'],
    }
  } catch {
    return null
  }
}

const handoff = computed(() => validate(props.value))
const blockedMessage = computed(() => {
  const value = handoff.value
  if (!value || value.state !== 'blocked') return ''
  const messages: Record<Exclude<SiteMeasurementHandoff['reason'], 'available' | 'confirmed'>, string> = {
    not_verified: '尚無可用的網站發布核驗紀錄；請先完成網站核對。',
    not_published: '核驗時網站內容未公開或已封存；目前不可接入成效觀察。',
    content_changed: '網站公開內容與送入版本不符；目前不可接入成效觀察。',
    observation_expired: '網站核驗紀錄已過期；請重新核對後再確認。',
    authority_invalid: '目前網站或成效資料授權（包含已撤銷的同意）不符合接入條件；請先確認授權狀態。',
  }
  return messages[value.reason as keyof typeof messages] || '目前無法確認接入成效觀察；請先重新核對。'
})
const confirmedLabel = computed(() => handoff.value?.confirmedAt
  ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Taipei' }).format(new Date(handoff.value.confirmedAt))
  : '')
</script>

<template>
  <section class="site-measurement-handoff" aria-label="成效觀察接入確認">
    <template v-if="handoff?.state === 'available'">
      <strong>可確認接入成效觀察</strong>
      <span>此動作只保存成效觀察接入意願；尚未收集資料，也不會發布文章或啟動訓練。</span>
      <button v-if="!openConfirmation" class="handoff-button" type="button" :disabled="busy" @click="openConfirmation = true">確認接入成效觀察</button>
      <span v-if="error && !openConfirmation" class="handoff-error" role="alert">{{ error }}</span>
      <div v-if="openConfirmation" class="confirmation" role="group" aria-label="確認成效觀察範圍">
        <p>確認後只保存此網站發布版本的觀察接入意願；下一個已授權工作或明確排程才會收數，且執行前仍會重新核驗。這不會發布文章、代替客戶同意或訓練模型。</p>
        <div class="confirmation-actions">
          <button class="handoff-button" type="button" :disabled="busy" @click="emit('confirm')">{{ busy ? '正在確認…' : '我確認接入成效觀察' }}</button>
          <button class="cancel-button" type="button" :disabled="busy" @click="openConfirmation = false">取消</button>
        </div>
        <span v-if="error" class="handoff-error" role="alert">{{ error }}</span>
      </div>
    </template>
    <template v-else-if="handoff?.state === 'confirmed'">
      <strong>已確認接入成效觀察（歷史確認）</strong>
      <span v-if="confirmedLabel">確認時間：{{ confirmedLabel }}；此紀錄不代表目前授權或已完成收數。</span>
      <span>下一個已授權工作或明確排程執行前仍會重新核驗；不會因這次確認發布文章或啟動訓練。</span>
    </template>
    <template v-else-if="handoff?.state === 'blocked'">
      <strong>目前無法接入成效觀察</strong>
      <span>{{ blockedMessage }}</span>
      <span v-if="confirmedLabel">先前接入確認時間：{{ confirmedLabel }}；目前條件已遭阻擋，尚未代表已收數。</span>
      <span>此阻擋不會改變內容工作流程，也不會推定文章已刪除。</span>
    </template>
    <template v-else>
      <strong>成效觀察接入狀態尚未確認</strong>
      <span>回傳資料不完整或互相矛盾；目前不會送出接入確認、收數或訓練。</span>
    </template>
  </section>
</template>

<style scoped>
.site-measurement-handoff{display:grid;gap:.4rem;margin-top:.7rem;padding:.8rem;border:1px solid #cbd6df;border-radius:9px;background:#f6f8fa;color:#344654;font-size:.8rem;line-height:1.5}.site-measurement-handoff strong{font-size:.86rem}.handoff-button,.cancel-button{width:fit-content;border:1px solid #9aabba;border-radius:7px;padding:.5rem .75rem;background:#fff;color:#223b52;font:inherit;font-weight:700;cursor:pointer}.handoff-button:disabled,.cancel-button:disabled{opacity:.55;cursor:not-allowed}.cancel-button{background:#eef2f5}.confirmation{display:grid;gap:.5rem;margin-top:.15rem;padding:.7rem;border-left:3px solid #7f9bb1;background:#fff}.confirmation p{margin:0}.confirmation-actions{display:flex;flex-wrap:wrap;gap:.5rem}.handoff-error{color:#8d3030;font-weight:600}
</style>
