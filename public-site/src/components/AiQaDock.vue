<!-- A bounded, low-pressure advisor: visible when useful without competing with the page narrative. -->
<script setup lang="ts">
import { computed, defineExpose, nextTick, onBeforeUnmount, onMounted, reactive, ref, withDefaults, defineProps } from 'vue'
import { answerBoundedQa } from '../lib/boundedAiQa'
import { publicApiFetch } from '../lib/publicApi'

const props = withDefaults(defineProps<{
  locale: 'en' | 'zh-hant'
  mode?: 'dock' | 'inline'
  proactiveDelay?: number
}>(), {
  mode: 'dock',
  proactiveDelay: 45_000,
})
const isZh = computed(() => props.locale === 'zh-hant')
const isInline = computed(() => props.mode === 'inline')
const question = ref('')
const expanded = ref(props.mode === 'inline')
const launcher = ref<HTMLButtonElement | null>(null)
const messages = ref<Array<{ role: 'assistant' | 'user'; text: string }>>([])
const nudgeVisible = ref(false)
const gatePassed = ref(false)
const gateStatus = ref<'idle' | 'submitting' | 'error'>('idle')
const gateFeedback = ref('')
const contact = reactive({ name: '', email: '', company: '', privacyConsent: false, recontactConsent: true, companyFax: '' })
const panelId = computed(() => `ai-qa-panel-${props.locale}-${props.mode}`)
const titleId = computed(() => `ai-qa-title-${props.locale}-${props.mode}`)
const questionId = computed(() => `qa-question-${props.locale}-${props.mode}`)

const copy = computed(() => isZh.value
  ? {
      launcher: '一起釐清下一步',
      nudge: '你的網站，可能正漏掉客戶。',
      scope: 'AI QA / 第一線行銷顧問',
      close: '收合 AI QA 助手',
      gateTitle: '先留下基本資料，再讓 AI 直接看你的問題。',
      gateDeck: '我們會把對話與需求交給適合的部門；不會用一個通用答案敷衍你。',
      name: '姓名', email: '工作 Email', company: '公司／品牌', privacy: '我同意 DiscoveryStack 為回答問題與後續交接而處理這些資料。', followup: '可以寄送對話摘要與相關後續資訊給我。', start: '開始對話', starting: '正在建立對話…', gateError: '目前無法建立對話，請稍後再試。',
      welcome: '告訴我現在最卡的地方。我會先判斷該由哪個部門接手。',
      placeholder: '想先釐清什麼？',
      ask: '送出問題',
      boundary: '先提供可靠方向；商業判斷仍由真人與你一起確認。',
      prompts: ['網站做了，為什麼還是沒人找到？', '有流量但沒有訂單，該先改哪裡？', '我想把網站、系統和 AI 一次做好。'],
    }
  : {
      launcher: 'Clarify the next step',
      nudge: 'Your website may be losing customers.',
      scope: 'AI QA / Front-line marketing advisor',
      close: 'Close AI QA assistant',
      gateTitle: 'Leave the essentials, then let AI look directly at the problem.',
      gateDeck: 'We pass the conversation to the right department instead of giving you a generic answer.',
      name: 'Name', email: 'Work email', company: 'Company / brand', privacy: 'I agree that DiscoveryStack may process these details to answer and hand off this conversation.', followup: 'You may email the conversation summary and relevant follow-up information to me.', start: 'Start conversation', starting: 'Starting…', gateError: 'We could not start this conversation right now. Please try again shortly.',
      welcome: 'Tell me where things are stuck. I will first work out which department should take it forward.',
      placeholder: 'What would you like to clarify?',
      ask: 'Send question',
      boundary: 'A grounded starting point; commercial judgment remains a human conversation.',
      prompts: ['Why is nobody finding the site we built?', 'We have traffic but no orders. What comes first?', 'I want web, systems and AI handled together.'],
    })

function answerFor(input: string) {
  return answerBoundedQa(input, props.locale).answer
}

function submit(value = question.value) {
  const text = value.trim()
  if (!text) return
  messages.value.push({ role: 'user', text })
  messages.value.push({ role: 'assistant', text: answerFor(text) })
  question.value = ''
  expanded.value = true
}

function closeDock() {
  if (isInline.value) return
  expanded.value = false
  nextTick(() => launcher.value?.focus())
}

function openDock() {
  nudgeVisible.value = false
  expanded.value = true
}

function toggleDock() {
  nudgeVisible.value = false
  expanded.value = !expanded.value
}

async function submitContact() {
  gateStatus.value = 'submitting'
  gateFeedback.value = ''
  try {
    await publicApiFetch('/api/leads', { body: { name: contact.name, email: contact.email, company: contact.company, website: '', packageInterest: 'unsure', language: props.locale, message: 'Source: AI QA conversation entry', privacyConsent: contact.privacyConsent, recontactConsent: contact.recontactConsent, companyFax: contact.companyFax } })
    gatePassed.value = true
    gateStatus.value = 'idle'
  } catch {
    gateStatus.value = 'error'
    gateFeedback.value = copy.value.gateError
  }
}

let nudgeTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  if (isInline.value) return
  nudgeTimer = setTimeout(() => {
    if (!expanded.value) nudgeVisible.value = true
  }, props.proactiveDelay)
})
onBeforeUnmount(() => { if (nudgeTimer) clearTimeout(nudgeTimer) })

defineExpose({ openDock })
</script>

<template>
  <aside class="ai-qa-dock" :class="{ 'is-open': expanded, 'is-inline': isInline, 'has-nudge': nudgeVisible }" @keydown.esc="closeDock">
    <button
      v-if="!isInline"
      ref="launcher"
      id="qa-launcher"
      class="qa-launcher"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      :aria-label="`AI QA — ${copy.launcher}`"
      @click="toggleDock"
    >
      <span class="qa-assistant-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M5.5 12a6.5 6.5 0 0 1 13 0v3.8a2.7 2.7 0 0 1-2.7 2.7H8.2a2.7 2.7 0 0 1-2.7-2.7V12Z" />
          <path d="M8.8 11.7h.01M15.2 11.7h.01M9.5 15.1c1.35.72 3.65.72 5 0" stroke-linecap="round" />
          <path d="M12 3.1v2.1" stroke-linecap="round" />
        </svg>
      </span>
      <span class="qa-launcher-copy" aria-hidden="true">
        <strong>{{ isZh ? 'AI QA 助手' : 'AI QA assistant' }}</strong>
        <small>{{ nudgeVisible ? copy.nudge : copy.launcher }}</small>
      </span>
      <span class="qa-launcher-arrow" aria-hidden="true">↗</span>
    </button>

    <section :id="panelId" class="qa-panel" :aria-hidden="!expanded" :aria-labelledby="titleId">
      <div class="ai-qa-topline">
        <p :id="titleId">{{ copy.scope }}</p>
        <span v-if="isInline" class="qa-availability">{{ isZh ? '可直接提問' : 'Ready for a question' }}</span>
        <button v-else type="button" class="qa-toggle" :aria-label="copy.close" @click="closeDock">×</button>
      </div>
      <form v-if="!gatePassed" class="qa-contact-gate" @submit.prevent="submitContact">
        <div><h2>{{ copy.gateTitle }}</h2><p>{{ copy.gateDeck }}</p></div>
        <label><span>{{ copy.name }}</span><input v-model="contact.name" autocomplete="name" required minlength="2"></label>
        <label><span>{{ copy.email }}</span><input v-model="contact.email" type="email" autocomplete="email" required></label>
        <label><span>{{ copy.company }}</span><input v-model="contact.company" autocomplete="organization" required minlength="2"></label>
        <label class="qa-gate-consent"><input v-model="contact.privacyConsent" type="checkbox" required><span>{{ copy.privacy }}</span></label>
        <label class="qa-gate-consent"><input v-model="contact.recontactConsent" type="checkbox"><span>{{ copy.followup }}</span></label>
        <label class="qa-gate-honeypot" aria-hidden="true"><span>Company fax</span><input v-model="contact.companyFax" tabindex="-1" autocomplete="off"></label>
        <button type="submit" :disabled="gateStatus === 'submitting'">{{ gateStatus === 'submitting' ? copy.starting : copy.start }} <span aria-hidden="true">↗</span></button>
        <p class="qa-gate-feedback" role="status" aria-live="polite">{{ gateFeedback }}</p>
      </form>
      <template v-else>
        <div class="qa-conversation" aria-live="polite">
          <p v-if="!messages.length" class="qa-welcome">{{ copy.welcome }}</p>
          <p v-for="(message, index) in messages" :key="index" class="qa-message" :class="message.role">{{ message.text }}</p>
        </div>
        <div class="qa-prompts">
          <button v-for="prompt in copy.prompts" :key="prompt" type="button" @click="submit(prompt)">{{ prompt }}</button>
        </div>
        <form class="qa-form" @submit.prevent="submit()">
          <label class="sr-only" :for="questionId">{{ isZh ? '詢問 AI QA 助手' : 'Ask the AI QA assistant' }}</label>
          <input :id="questionId" v-model="question" :placeholder="copy.placeholder" autocomplete="off">
          <button type="submit" :aria-label="copy.ask">↗</button>
        </form>
        <p class="qa-boundary">{{ copy.boundary }}</p>
      </template>
    </section>
  </aside>
</template>
