<!-- A bounded, low-pressure advisor: visible when useful without competing with the page narrative. -->
<script setup lang="ts">
import { answerBoundedQa } from '~/utils/boundedAiQa'

const props = defineProps<{ locale: 'en' | 'zh-hant' }>()
const isZh = computed(() => props.locale === 'zh-hant')
const question = ref('')
const expanded = ref(false)
const launcher = ref<HTMLButtonElement | null>(null)
const messages = ref<Array<{ role: 'assistant' | 'user'; text: string }>>([])
const panelId = computed(() => `ai-qa-panel-${props.locale}`)

const copy = computed(() => isZh.value
  ? {
      launcher: '一起釐清下一步',
      scope: 'AI QA / 策略起點',
      close: '收合 AI QA 助手',
      welcome: '先從一個小問題開始，我們一起把下一步說清楚。',
      placeholder: '想先釐清什麼？',
      ask: '送出問題',
      boundary: '先提供可靠方向；商業判斷仍由真人與你一起確認。',
      prompts: ['我可以先問 SEO／GEO 嗎？', 'Audit 通常會一起看什麼？', '你們如何避免 AI 說得太滿？'],
    }
  : {
      launcher: 'Clarify the next step',
      scope: 'AI QA / A thoughtful starting point',
      close: 'Close AI QA assistant',
      welcome: 'Start with a small question. We can make the next step clearer together.',
      placeholder: 'What would you like to clarify?',
      ask: 'Send question',
      boundary: 'A grounded starting point; commercial judgment remains a human conversation.',
      prompts: ['Could we start with SEO/GEO?', 'What does an audit look at together?', 'How do you keep AI guidance grounded?'],
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
  expanded.value = false
  nextTick(() => launcher.value?.focus())
}
</script>

<template>
  <aside class="ai-qa-dock" :class="{ 'is-open': expanded }" @keydown.esc="closeDock">
    <button
      ref="launcher"
      id="qa-launcher"
      class="qa-launcher"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      :aria-label="`AI QA — ${copy.launcher}`"
      @click="expanded = !expanded"
    >
      <span class="qa-assistant-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M5.5 12a6.5 6.5 0 0 1 13 0v3.8a2.7 2.7 0 0 1-2.7 2.7H8.2a2.7 2.7 0 0 1-2.7-2.7V12Z" />
          <path d="M8.8 11.7h.01M15.2 11.7h.01M9.5 15.1c1.35.72 3.65.72 5 0" stroke-linecap="round" />
          <path d="M12 3.1v2.1" stroke-linecap="round" />
        </svg>
      </span>
      <span class="sr-only">AI QA — {{ copy.launcher }}</span>
      <span class="qa-launcher-pulse" aria-hidden="true"></span>
    </button>

    <section :id="panelId" class="qa-panel" :aria-hidden="!expanded" aria-labelledby="ai-qa-title">
      <div class="ai-qa-topline">
        <p id="ai-qa-title">{{ copy.scope }}</p>
        <button type="button" class="qa-toggle" :aria-label="copy.close" @click="closeDock">×</button>
      </div>
      <div class="qa-conversation" aria-live="polite">
        <p v-if="!messages.length" class="qa-welcome">{{ copy.welcome }}</p>
        <p v-for="(message, index) in messages" :key="index" class="qa-message" :class="message.role">{{ message.text }}</p>
      </div>
      <div class="qa-prompts">
        <button v-for="prompt in copy.prompts" :key="prompt" type="button" @click="submit(prompt)">{{ prompt }}</button>
      </div>
      <form class="qa-form" @submit.prevent="submit()">
        <label class="sr-only" for="qa-question">{{ isZh ? '詢問 AI QA 助手' : 'Ask the AI QA assistant' }}</label>
        <input id="qa-question" v-model="question" :placeholder="copy.placeholder" autocomplete="off">
        <button type="submit" :aria-label="copy.ask">↗</button>
      </form>
      <p class="qa-boundary">{{ copy.boundary }}</p>
    </section>
  </aside>
</template>
