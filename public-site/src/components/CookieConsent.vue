<script setup lang="ts">
import { computed, defineExpose, defineProps, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ locale: 'en' | 'zh-hant' }>()

type ConsentLevel = 'necessary' | 'all'

const consent = ref<ConsentLevel | null>(null)
const readConsent = () => document.cookie.split('; ').find(cookie => cookie.startsWith('discoverystack_consent='))?.split('=')[1] as ConsentLevel | undefined
const writeConsent = (level: ConsentLevel) => { document.cookie = `discoverystack_consent=${level}; Max-Age=${60 * 60 * 24 * 180}; Path=/; SameSite=Lax` }

const visible = ref(false)
const customizing = ref(false)
const analyticsAllowed = ref(false)
const hasSavedChoice = computed(() => consent.value === 'necessary' || consent.value === 'all')
const isZh = computed(() => props.locale === 'zh-hant')

const copy = computed(() => isZh.value
  ? {
      eyebrow: 'COOKIE 選擇',
      title: '讓我們先說清楚 Cookie。',
      body: '必要 Cookie 用於登入、安全與記住你的選擇。分析 Cookie 只會在你同意後使用；目前本站尚未啟用第三方分析追蹤。',
      necessaryOnly: '只使用必要項目',
      acceptAll: '接受全部',
      settings: '查看設定',
      back: '返回',
      save: '儲存選擇',
      close: '關閉 Cookie 設定',
      necessaryTitle: '必要 Cookie',
      necessaryBody: '維持登入、安全功能與儲存 Cookie 選擇，無法關閉。',
      analyticsTitle: '分析 Cookie',
      analyticsBody: '未來若啟用匿名流量分析，只會在你同意後載入。現在沒有第三方分析追蹤。',
      always: '永遠開啟',
    }
  : {
      eyebrow: 'COOKIE CHOICE',
      title: 'A clear word about cookies.',
      body: 'Necessary cookies support sign-in, security and remembering your choice. Analytics cookies load only with consent; no third-party analytics are currently enabled.',
      necessaryOnly: 'Necessary only',
      acceptAll: 'Accept all',
      settings: 'View settings',
      back: 'Back',
      save: 'Save choices',
      close: 'Close cookie settings',
      necessaryTitle: 'Necessary cookies',
      necessaryBody: 'Required for sign-in, security and remembering your cookie choice. They cannot be disabled.',
      analyticsTitle: 'Analytics cookies',
      analyticsBody: 'If anonymous traffic analytics are added later, they will load only with your consent. None are active now.',
      always: 'Always on',
    })

onMounted(() => {
  consent.value = readConsent() || null
  analyticsAllowed.value = consent.value === 'all'
  visible.value = !hasSavedChoice.value
  window.addEventListener('discoverystack:open-cookie-settings', open)
})

onBeforeUnmount(() => window.removeEventListener('discoverystack:open-cookie-settings', open))

function save(level: ConsentLevel) {
  consent.value = level
  writeConsent(level)
  analyticsAllowed.value = level === 'all'
  visible.value = false
  customizing.value = false
  window.dispatchEvent(new CustomEvent('discoverystack:consent-change', {
    detail: { necessary: true, analytics: level === 'all' },
  }))
}

function saveCustom() {
  save(analyticsAllowed.value ? 'all' : 'necessary')
}

function open() {
  analyticsAllowed.value = consent.value === 'all'
  customizing.value = false
  visible.value = true
}

function close() {
  if (hasSavedChoice.value) visible.value = false
}

defineExpose({ open })
</script>

<template>
    <section
      v-if="visible"
      class="cookie-consent"
      role="dialog"
      aria-live="polite"
      aria-labelledby="cookie-consent-title"
    >
      <button
        v-if="hasSavedChoice"
        class="cookie-close"
        type="button"
        :aria-label="copy.close"
        @click="close"
      >×</button>

      <template v-if="!customizing">
        <div class="cookie-copy">
          <p>{{ copy.eyebrow }}</p>
          <h2 id="cookie-consent-title">{{ copy.title }}</h2>
          <p>{{ copy.body }}</p>
        </div>
        <div class="cookie-actions">
          <button type="button" class="cookie-button cookie-button-secondary" @click="save('necessary')">{{ copy.necessaryOnly }}</button>
          <button type="button" class="cookie-button cookie-button-primary" @click="save('all')">{{ copy.acceptAll }}</button>
          <button type="button" class="cookie-settings-link" @click="customizing = true">{{ copy.settings }} →</button>
        </div>
      </template>

      <template v-else>
        <div class="cookie-copy">
          <button type="button" class="cookie-back" @click="customizing = false">← {{ copy.back }}</button>
          <h2 id="cookie-consent-title">{{ copy.title }}</h2>
        </div>
        <div class="cookie-options">
          <div class="cookie-option">
            <div><strong>{{ copy.necessaryTitle }}</strong><p>{{ copy.necessaryBody }}</p></div>
            <span>{{ copy.always }}</span>
          </div>
          <label class="cookie-option">
            <div><strong>{{ copy.analyticsTitle }}</strong><p>{{ copy.analyticsBody }}</p></div>
            <input v-model="analyticsAllowed" type="checkbox">
          </label>
        </div>
        <div class="cookie-actions cookie-actions-custom">
          <button type="button" class="cookie-button cookie-button-primary" @click="saveCustom">{{ copy.save }}</button>
        </div>
      </template>
    </section>
</template>

<style scoped>
.cookie-consent {
  position: fixed;
  z-index: 120;
  right: clamp(1rem, 2.5vw, 2.5rem);
  bottom: clamp(1rem, 2.5vw, 2.5rem);
  width: min(42rem, calc(100vw - 2rem));
  padding: clamp(1.25rem, 2.5vw, 2rem);
  border: 1px solid rgba(23, 26, 24, .24);
  background: rgba(247, 243, 234, .97);
  color: #171a18;
  box-shadow: 0 1.5rem 5rem rgba(23, 26, 24, .18);
  backdrop-filter: blur(18px);
}

.cookie-close {
  position: absolute;
  top: .8rem;
  right: .9rem;
  width: 2rem;
  height: 2rem;
  border: 0;
  background: transparent;
  color: inherit;
  font: 400 1.3rem/1 var(--font-mono);
  cursor: pointer;
}

.cookie-copy > p:first-child {
  color: #2946c7;
  font: 500 .62rem/1.3 var(--font-mono);
  letter-spacing: .14em;
}

.cookie-copy h2 {
  max-width: 22ch;
  margin-top: .65rem;
  font-size: clamp(1.45rem, 2.6vw, 2.2rem);
  line-height: 1.16;
}

.cookie-copy > p:last-child {
  max-width: 58ch;
  margin-top: .8rem;
  color: #5c5a53;
  font-size: .9rem;
  line-height: 1.65;
}

.cookie-actions {
  display: flex;
  flex-wrap: wrap;
  gap: .7rem;
  align-items: center;
  margin-top: 1.4rem;
}

.cookie-button {
  min-height: 2.8rem;
  padding: .75rem 1.05rem;
  border: 1px solid #2946c7;
  font: 500 .67rem/1.2 var(--font-mono);
  letter-spacing: .06em;
  cursor: pointer;
}

.cookie-button-primary { background: #2946c7; color: #f7f3ea; }
.cookie-button-secondary { background: transparent; color: #2946c7; }
.cookie-button:hover,
.cookie-button:focus-visible { outline: 2px solid #d3e567; outline-offset: 2px; }

.cookie-settings-link,
.cookie-back {
  padding: .6rem .2rem;
  border: 0;
  border-bottom: 1px solid currentColor;
  background: transparent;
  color: #2946c7;
  font: 500 .65rem/1.2 var(--font-mono);
  cursor: pointer;
}

.cookie-back { margin-bottom: .8rem; }

.cookie-options {
  display: grid;
  margin-top: 1.25rem;
  border-top: 1px solid rgba(23, 26, 24, .18);
}

.cookie-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1.25rem;
  align-items: center;
  padding-block: 1rem;
  border-bottom: 1px solid rgba(23, 26, 24, .18);
}

.cookie-option strong { font-family: var(--font-display); font-size: 1rem; }
.cookie-option p { margin-top: .3rem; color: #68665e; font-size: .8rem; line-height: 1.5; }
.cookie-option > span { color: #68665e; font: 500 .6rem/1.2 var(--font-mono); letter-spacing: .06em; }
.cookie-option input { width: 2.7rem; height: 1.35rem; accent-color: #2946c7; cursor: pointer; }
.cookie-actions-custom { justify-content: flex-end; }

.cookie-panel-enter-active,
.cookie-panel-leave-active { transition: opacity .3s ease, transform .45s cubic-bezier(.22, 1, .36, 1); }
.cookie-panel-enter-from,
.cookie-panel-leave-to { opacity: 0; transform: translateY(1.5rem); }

@media (max-width: 38rem) {
  .cookie-consent { right: 0; bottom: 0; width: 100%; border-inline: 0; border-bottom: 0; }
  .cookie-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .cookie-settings-link { grid-column: 1 / -1; justify-self: start; }
  .cookie-actions-custom { grid-template-columns: 1fr; }
  .cookie-actions-custom .cookie-button { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .cookie-panel-enter-active,
  .cookie-panel-leave-active { transition: none; }
}
</style>
