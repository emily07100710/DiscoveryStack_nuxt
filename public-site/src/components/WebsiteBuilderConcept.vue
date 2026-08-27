<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { publicApiFetch } from '../lib/publicApi'
import {
  builderSteps,
  cadences,
  generationStages,
  moduleOptions,
  normalizeDomain,
  normalizePublicUrl,
  pageLabels,
  pagesForSiteType,
  planFor,
  plans,
  siteTypeFor,
  siteTypes,
  stylePreferences,
  themeFor,
  themes,
  timeline,
  type BuilderStep,
  type EntryMode,
  type PlanKey,
  type PreviewPage,
  type SiteType,
  type ThemeKey,
  type Viewport,
  formatMoney,
} from '../lib/website-builder-model'
import '../styles/website-builder.css'

type SiteAnalysis = {
  finalUrl: string
  hostname: string
  analysedAt: string
  scope: string
  scores: { overall?: number; seo?: number; geo?: number; brandContent?: number; ux?: number }
  checks?: Record<string, unknown>
  recommendationKeys?: string[]
}

type DomainMode = 'new' | 'existing'

const currentStep = ref<BuilderStep>('entry')
const entryMode = ref<EntryMode | null>(null)
const brandName = ref('')
const businessBrief = ref('')
const audience = ref('')
const desiredAction = ref('')
const existingUrl = ref('')
const urlError = ref('')
const analysisError = ref('')
const analysisStage = ref(0)
const analysisResult = ref<SiteAnalysis | null>(null)
const analysisAccepted = ref(false)
const siteType = ref<SiteType | null>(null)
const selectedModules = ref<string[]>(['admin'])
const theme = ref<ThemeKey | null>(null)
const selectedStyles = ref<string[]>(['space'])
const styleReferenceUrl = ref('')
const styleReferenceError = ref('')
const generationStage = ref(0)
const generationFinished = ref(false)
const viewport = ref<Viewport>('desktop')
const previewPage = ref<PreviewPage>('home')
const assistantQuestion = ref('')
const assistantAnswer = ref('')
const demoNotice = ref('')
const plan = ref<PlanKey | null>(null)
const cadence = ref<(typeof cadences)[number]>(15)
const domainMode = ref<DomainMode | null>(null)
const domainInput = ref('')
const domainSimulation = ref<'idle' | 'checked'>('idle')
const domainError = ref('')
const reviewConfirmed = ref(false)
const showHandoff = ref(false)
const handoffSaved = ref(false)
const handoffCloseButton = ref<HTMLButtonElement | null>(null)
const handoffDialog = ref<HTMLElement | null>(null)
const handoffStepTrigger = ref<HTMLButtonElement | null>(null)
const reviewHandoffTrigger = ref<HTMLButtonElement | null>(null)
const lastHandoffTrigger = ref<HTMLElement | null>(null)
const timers = new Set<number>()
const viewportOptions: Array<[Viewport, string]> = [['desktop', '桌面'], ['tablet', '平板'], ['mobile', '手機']]

const currentIndex = computed(() => builderSteps.findIndex((step) => step.id === currentStep.value))
const currentStepMeta = computed(() => builderSteps[currentIndex.value] ?? builderSteps[0])
const isExistingPath = computed(() => entryMode.value === 'existing')
const currentSiteType = computed(() => siteTypeFor(siteType.value))
const currentTheme = computed(() => themeFor(theme.value ?? 'mineral'))
const currentPlan = computed(() => planFor(plan.value))
const currentPages = computed(() => pagesForSiteType(siteType.value ?? 'brand-blog'))
const selectedModuleDetails = computed(() => moduleOptions.filter((item) => selectedModules.value.includes(item.id)))
const selectedModuleLabels = computed(() => selectedModuleDetails.value.map((item) => item.label))
const currentDomain = computed(() => normalizeDomain(domainInput.value) || 'your-brand.tw')
const hasBrief = computed(() => Boolean(brandName.value.trim() && businessBrief.value.trim() && audience.value.trim() && desiredAction.value.trim()))
const canProceedFromBrief = computed(() => {
  if (isExistingPath.value) return Boolean(analysisResult.value && analysisAccepted.value)
  return hasBrief.value
})
const canProceedFromStyle = computed(() => Boolean(theme.value && normalizeReferenceUrl(styleReferenceUrl.value) !== false))
const canProceedFromDomain = computed(() => Boolean(domainMode.value && domainInput.value.trim() && !domainError.value))
const basePrice = computed(() => (siteType.value === 'commerce' ? 128800 : siteType.value === 'brand-blog' ? 88800 : 58800))
const modulePrice = computed(() => selectedModules.value.length * 3800)
const oneTimeEstimate = computed(() => basePrice.value + modulePrice.value)
const cadenceMultiplier: Record<number, number> = { 3: 2.1, 7: 1.45, 15: 1, 30: 0.72 }
const monthlyEstimate = computed(() => {
  if (!plan.value || plan.value === 'launch') return 0
  return Math.round(currentPlan.value.price * (cadenceMultiplier[cadence.value] ?? 1))
})
const previewTitle = computed(() => {
  if (siteType.value === 'commerce') return '把喜歡的日常，帶回你的生活。'
  if (siteType.value === 'one-page') return '讓每一次詢問，都更靠近你。'
  return '專業不該讓人緊張，應該讓人更安心。'
})
const previewDescription = computed(() => businessBrief.value.trim() || '把品牌、服務與專業內容整理成容易被理解的網站。')
const themeStyle = computed(() => ({
  '--builder-primary': currentTheme.value.colors[0],
  '--builder-paper': currentTheme.value.colors[1],
  '--builder-accent': currentTheme.value.colors[2],
}))

function addTimer(callback: () => void, delay: number) {
  const id = window.setTimeout(() => {
    timers.delete(id)
    callback()
  }, delay)
  timers.add(id)
  return id
}

function clearTimers() {
  timers.forEach((id) => window.clearTimeout(id))
  timers.clear()
}

function normalizeReferenceUrl(value: string): string | null | false {
  if (!value.trim()) return null
  return normalizePublicUrl(value) ?? false
}

function setStep(step: BuilderStep) {
  currentStep.value = step
  demoNotice.value = ''
  if (step === 'interactive_preview') {
    previewPage.value = currentPages.value[0] ?? 'home'
  }
}

function goBack() {
  if (currentStep.value === 'generating') {
    setStep('style_and_modules')
    return
  }
  if (currentStep.value === 'interactive_preview') {
    setStep('style_and_modules')
    return
  }
  const index = currentIndex.value
  if (index <= 0) return
  setStep(builderSteps[index - 1].id)
}

function chooseEntry(mode: EntryMode) {
  entryMode.value = mode
  analysisResult.value = null
  analysisAccepted.value = false
  analysisError.value = ''
  urlError.value = ''
}

function submitEntry() {
  if (!entryMode.value) return
  setStep('diagnosis_or_brief')
}

function validateBrief() {
  const missing: string[] = []
  if (!brandName.value.trim()) missing.push('品牌名稱')
  if (!businessBrief.value.trim()) missing.push('一句話介紹')
  if (!audience.value.trim()) missing.push('服務對象')
  if (!desiredAction.value.trim()) missing.push('希望訪客完成的動作')
  if (missing.length) {
    demoNotice.value = `請先完成：${missing.join('、')}。`
    return false
  }
  return true
}

async function runDiagnosis() {
  const normalized = normalizePublicUrl(existingUrl.value)
  analysisError.value = ''
  urlError.value = ''
  analysisResult.value = null
  analysisAccepted.value = false
  if (!normalized) {
    urlError.value = '請輸入完整的公開 http:// 或 https:// 網址。'
    return
  }

  clearTimers()
  analysisStage.value = 0
  currentStep.value = 'diagnosis_or_brief'
  const stages = [0, 1, 2, 3]
  stages.forEach((stage, index) => addTimer(() => { analysisStage.value = stage }, index * 560))
  try {
    const result = await publicApiFetch<SiteAnalysis>('/api/site-analysis', { body: { url: normalized } })
    analysisStage.value = 3
    analysisResult.value = result
  } catch {
    analysisError.value = '我們無法安全讀取這個公開首頁。請確認網址可以公開開啟後再試一次。'
  }
}

function acceptDiagnosis() {
  if (!analysisResult.value) return
  analysisAccepted.value = true
  if (!businessBrief.value.trim()) businessBrief.value = '根據公開首頁診斷，整理一個更清楚、更容易被理解的品牌網站。'
  setStep('site_architecture')
}

function submitBrief() {
  if (!validateBrief()) return
  setStep('site_architecture')
}

function submitArchitecture() {
  if (!siteType.value) {
    demoNotice.value = '請先選擇一種網站方向。'
    return
  }
  setStep('style_and_modules')
}

function toggleModule(id: string) {
  selectedModules.value = selectedModules.value.includes(id)
    ? selectedModules.value.filter((item) => item !== id)
    : [...selectedModules.value, id]
}

function toggleStyle(id: string) {
  selectedStyles.value = selectedStyles.value.includes(id)
    ? selectedStyles.value.filter((item) => item !== id)
    : [...selectedStyles.value, id]
}

function validateStyleReference() {
  const result = normalizeReferenceUrl(styleReferenceUrl.value)
  styleReferenceError.value = result === false ? '請輸入完整的公開 HTTPS 網址；概念版不會擷取它。' : ''
  return result !== false
}

function submitStyle() {
  if (!theme.value) {
    demoNotice.value = '請先選擇一種品牌氛圍。'
    return
  }
  if (!validateStyleReference()) return
  startGeneration()
}

function startGeneration() {
  clearTimers()
  generationStage.value = 0
  generationFinished.value = false
  setStep('generating')
  const duration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 760
  generationStages.forEach((_, index) => addTimer(() => {
    generationStage.value = index
    if (index === generationStages.length - 1) {
      generationFinished.value = true
      addTimer(() => setStep('interactive_preview'), duration ? 520 : 0)
    }
  }, index * duration))
}

function choosePreviewPage(page: PreviewPage) {
  if (currentPages.value.includes(page)) previewPage.value = page
}

function openAssistant(question: string) {
  assistantQuestion.value = question
  assistantAnswer.value = question === '費用怎麼評估？'
    ? '正式版會依服務範圍、內容頻率與需要的串接，由顧問一起確認；這份預覽不會產生付款。'
    : '這是概念版的示範答案。正式版會依核准的品牌內容與知識範圍回覆。'
}

function showDemoNotice(message: string) {
  demoNotice.value = message
  addTimer(() => { if (demoNotice.value === message) demoNotice.value = '' }, 3200)
}

function submitPreviewDemo(event: Event) {
  event.preventDefault()
  showDemoNotice('這是預覽中的互動示範，不會送出預約或聯絡資料。')
}

function submitPlan() {
  if (!plan.value) {
    demoNotice.value = '請先選擇你想要的持續方式。'
    return
  }
  setStep('domain_and_launch')
}

function chooseDomainMode(mode: DomainMode) {
  domainMode.value = mode
  domainInput.value = ''
  domainSimulation.value = 'idle'
  domainError.value = ''
}

function simulateDomain() {
  const value = normalizeDomain(domainInput.value)
  domainError.value = value ? '' : '請輸入想規劃的網域名稱。'
  if (!domainError.value) domainSimulation.value = 'checked'
}

function submitDomain() {
  const value = normalizeDomain(domainInput.value)
  if (!domainMode.value || !value) {
    domainError.value = '請選擇網域路徑並輸入名稱。'
    return
  }
  domainInput.value = value
  setStep('review_order')
}

function submitReview(event?: MouseEvent) {
  if (!reviewConfirmed.value) {
    demoNotice.value = '請先確認你理解這是預覽與預估，不是正式訂單。'
    return
  }
  const trigger = event?.currentTarget
  lastHandoffTrigger.value = reviewHandoffTrigger.value ?? (trigger instanceof HTMLElement ? trigger : document.activeElement instanceof HTMLElement ? document.activeElement : null)
  openHandoff(true)
}

async function openHandoff(preserveTrigger = false) {
  if (!preserveTrigger) lastHandoffTrigger.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  showHandoff.value = true
  await nextTick()
  handoffCloseButton.value?.focus()
}

function closeHandoff() {
  showHandoff.value = false
  nextTick(() => lastHandoffTrigger.value?.focus())
}

function trapHandoff(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const dialog = event.currentTarget as HTMLElement
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function confirmHandoff() {
  handoffSaved.value = true
  showHandoff.value = false
  setStep('handoff')
  await nextTick()
  const nextTrigger = handoffStepTrigger.value
  nextTrigger?.focus()
}

watch(showHandoff, (open) => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = open ? 'hidden' : ''
})

watch(siteType, () => {
  if (!currentPages.value.includes(previewPage.value)) previewPage.value = currentPages.value[0] ?? 'home'
})

onBeforeUnmount(() => {
  clearTimers()
  if (typeof document !== 'undefined') document.body.style.overflow = ''
})
</script>

<template>
  <main class="builder-experience" data-public-preview-api="/api/managed-sites/previews" :style="themeStyle">
    <div class="builder-atmosphere" aria-hidden="true"><span></span><span></span><span></span></div>
    <header class="builder-masthead">
      <div class="builder-masthead-copy">
        <p class="builder-eyebrow"><span>DISCOVERYSTACK</span> CLIENT WEBSITE BUILDER / CONCEPT PREVIEW</p>
        <h1>先看見你的網站，<em>再決定要不要買。</em></h1>
        <p class="builder-lede">用一句話開始。把品牌、網站結構與 GEO 成長方式整理成一個可以親手操作的方向。</p>
        <div class="builder-trust-row" aria-label="預覽限制">
          <span><i>01</i> 不會扣款</span><span><i>02</i> 不會購買網域</span><span><i>03</i> 不會部署</span>
        </div>
      </div>
      <div class="builder-masthead-visual" aria-hidden="true">
        <div class="builder-orbit builder-orbit-a"></div><div class="builder-orbit builder-orbit-b"></div>
        <div class="builder-visual-card"><span>YOUR SITE / 01</span><strong>從想法到<br><em>可見的方向</em></strong><b>↗</b></div>
      </div>
    </header>

    <section class="builder-workspace" aria-label="網站預覽建立流程">
      <aside class="builder-rail">
        <div class="builder-rail-top"><span>BUILDING / 01</span><strong>{{ String(currentIndex + 1).padStart(2, '0') }}<small>/ {{ String(builderSteps.length).padStart(2, '0') }}</small></strong></div>
        <div class="builder-current-label"><small>目前在做什麼</small><strong>{{ currentStepMeta.label }}</strong></div>
        <nav class="builder-progress" aria-label="建站步驟">
          <button v-for="(step, index) in builderSteps" :key="step.id" type="button" :disabled="index > currentIndex || step.id === currentStep" :class="{ active: step.id === currentStep, complete: index < currentIndex }" :aria-current="step.id === currentStep ? 'step' : undefined" @click="index < currentIndex && (currentStep = step.id)">
            <span>{{ String(index + 1).padStart(2, '0') }}</span><b>{{ step.shortLabel }}</b><i></i>
          </button>
        </nav>
        <div class="builder-rail-note"><span>↗</span><p>這是一份互動式概念預覽。正式版確認付款後，才會執行外部操作。</p></div>
      </aside>

      <section class="builder-panel">
        <div class="builder-panel-head">
          <button v-if="currentIndex > 0 && currentStep !== 'generating'" class="builder-back" type="button" @click="goBack">← 返回上一步</button>
          <span v-else class="builder-back-placeholder">CONCEPT / NO PAYMENT</span>
          <p aria-live="polite">{{ currentStepMeta.label }}</p>
        </div>

        <div v-if="demoNotice" class="builder-notice" role="status">{{ demoNotice }}</div>

        <section v-if="currentStep === 'entry'" class="builder-step builder-entry-step" aria-labelledby="entry-title">
          <div class="step-heading"><p class="builder-eyebrow">START WHERE YOU ARE</p><h2 id="entry-title">你現在有網站嗎？</h2><p>兩條路都會走到一份可以親手檢查的網站預覽。先選擇最接近你的現況。</p></div>
          <div class="entry-choice-grid">
            <button type="button" class="entry-choice" :class="{ selected: entryMode === 'existing' }" @click="chooseEntry('existing')">
              <span class="choice-index">A</span><span class="choice-arrow">↗</span><strong>我已經有網站</strong><p>先讀取公開首頁的可觀察訊號，再把改善方向整理成新的預覽。</p><small>適合想知道「現在卡在哪裡」的品牌。</small>
            </button>
            <button type="button" class="entry-choice" :class="{ selected: entryMode === 'new' }" @click="chooseEntry('new')">
              <span class="choice-index">B</span><span class="choice-arrow">↗</span><strong>我還沒有網站</strong><p>用自然語言介紹品牌，不需要先懂版型、SEO 或技術規格。</p><small>適合想從一個清楚方向開始的團隊。</small>
            </button>
          </div>
          <div class="step-footer"><p>可以隨時返回修改；這一頁不會儲存到 localStorage、cookie 或網址。</p><button class="builder-primary" type="button" :disabled="!entryMode" @click="submitEntry">從這裡開始 <span>→</span></button></div>
        </section>

        <section v-else-if="currentStep === 'diagnosis_or_brief'" class="builder-step" aria-labelledby="brief-title">
          <div class="step-heading"><p class="builder-eyebrow">{{ isExistingPath ? 'PUBLIC HOMEPAGE DIAGNOSIS' : 'A SHORT BRIEF IS ENOUGH' }}</p><h2 id="brief-title">{{ isExistingPath ? '先看見現在，再決定怎麼改善。' : '先讓我們理解你的品牌。' }}</h2><p>{{ isExistingPath ? '只分析你提供的公開首頁，不會讀取後台或要求帳號密碼。診斷失敗時不會補造結果。' : '一次只問必要的事。正式生成前，你仍然可以回來調整。' }}</p></div>

          <div v-if="isExistingPath" class="diagnosis-flow">
            <div class="field-block"><label for="builder-existing-url">公開網站網址</label><div class="field-with-action"><input id="builder-existing-url" v-model="existingUrl" type="url" inputmode="url" maxlength="256" placeholder="https://your-company.com" :aria-invalid="Boolean(urlError)" aria-describedby="builder-url-help builder-url-error" @input="urlError = ''"><button type="button" class="builder-secondary" :disabled="analysisStage > 0 && !analysisResult && !analysisError" @click="runDiagnosis">{{ analysisStage > 0 && !analysisResult && !analysisError ? '安全讀取中…' : '開始公開診斷' }} <span>↗</span></button></div><small id="builder-url-help">範圍：僅分析公開首頁；完整 URL 必須以 http:// 或 https:// 開頭。</small><p v-if="urlError" id="builder-url-error" class="field-error" role="alert">{{ urlError }}</p></div>
            <div v-if="analysisStage > 0 && !analysisResult && !analysisError" class="scan-sequence" aria-live="polite"><span v-for="(label, index) in ['確認公開網址', '讀取頁面結構', '整理 SEO／GEO 訊號', '建立改善預覽']" :key="label" :class="{ active: analysisStage >= index }"><i>{{ String(index + 1).padStart(2, '0') }}</i>{{ label }}</span></div>
            <div v-if="analysisError" class="builder-error-card" role="alert"><strong>這次沒有讀到可用結果。</strong><p>{{ analysisError }}</p><button type="button" class="text-action" @click="runDiagnosis">再試一次 <span>↗</span></button></div>
            <div v-if="analysisResult" class="diagnosis-result"><div class="diagnosis-score"><span>PUBLIC HOMEPAGE SIGNAL</span><strong>{{ analysisResult.scores.overall ?? '—' }}</strong><small>整體基礎訊號，不是排名、流量或成效保證。</small></div><div class="diagnosis-copy"><span class="result-tag">{{ analysisResult.scope === 'public_homepage_only' ? 'PUBLIC HOMEPAGE ONLY' : analysisResult.scope }}</span><h3>{{ analysisResult.hostname }} 的可觀察方向</h3><p>結果時間：{{ new Date(analysisResult.analysedAt).toLocaleDateString('zh-TW') }}。接下來可以把可用訊號帶入網站結構預覽。</p><button type="button" class="builder-primary" @click="acceptDiagnosis">使用這份診斷建立改善預覽 <span>→</span></button></div></div>
          </div>

          <div v-else class="brief-flow">
            <div class="brief-grid"><div class="field-block"><label for="builder-brand">品牌名稱</label><input id="builder-brand" v-model="brandName" maxlength="40" placeholder="例如：山嶼牙醫診所"></div><div class="field-block"><label for="builder-audience">你服務誰？</label><input id="builder-audience" v-model="audience" maxlength="120" placeholder="例如：第一次看牙的家庭"></div><div class="field-block field-wide"><label for="builder-brief">用一句話介紹你的業務</label><textarea id="builder-brief" v-model="businessBrief" maxlength="260" rows="3" placeholder="我們是誰、提供什麼、希望客戶感受到什麼？"></textarea></div><div class="field-block field-wide"><label for="builder-action">希望訪客完成什麼動作？</label><input id="builder-action" v-model="desiredAction" maxlength="120" placeholder="例如：預約第一次諮詢或加入 LINE"></div></div>
            <div class="prompt-examples"><span>可以這樣開始</span><button type="button" @click="businessBrief = businessBrief || '我們替忙碌的家庭提供安心、透明的日常照護。'">安心、透明的日常照護</button><button type="button" @click="businessBrief = businessBrief || '我們用設計與內容，讓在地品牌更容易被找到。'">讓在地品牌更容易被找到</button><small>示例不會覆蓋你已經輸入的內容。</small></div>
            <div class="step-footer"><p>不收集密碼、身分證、付款資料或 API key。</p><button class="builder-primary" type="button" @click="submitBrief">整理成網站方向 <span>→</span></button></div>
          </div>
        </section>

        <section v-else-if="currentStep === 'site_architecture'" class="builder-step" aria-labelledby="architecture-title">
          <div class="step-heading"><p class="builder-eyebrow">SITE ARCHITECTURE</p><h2 id="architecture-title">網站要先幫你完成什麼？</h2><p>選一個最接近現在目標的方向。這只決定預覽結構，不會限制未來的正式規劃。</p></div>
          <div class="architecture-grid"><button v-for="item in siteTypes" :key="item.id" type="button" class="architecture-choice" :class="{ selected: siteType === item.id }" :aria-pressed="siteType === item.id" @click="siteType = item.id"><span>{{ item.eyebrow }}</span><strong>{{ item.label }}</strong><p>{{ item.description }}</p><small>{{ item.bestFor }}</small><i>{{ siteType === item.id ? '已選擇' : '選擇方向' }} <b>→</b></i></button></div>
          <div class="architecture-map" aria-label="預覽頁面結構"><span>預覽會包含</span><i v-for="page in currentSiteType.pages" :key="page">{{ page }}</i></div>
          <div class="step-footer"><p>之後仍可以返回修改網站類型。</p><button class="builder-primary" type="button" :disabled="!siteType" @click="submitArchitecture">選擇功能與風格 <span>→</span></button></div>
        </section>

        <section v-else-if="currentStep === 'style_and_modules'" class="builder-step" aria-labelledby="style-title">
          <div class="step-heading"><p class="builder-eyebrow">STYLE / MODULES</p><h2 id="style-title">你希望它給人的第一印象是什麼？</h2><p>這些選擇只會影響本地預覽的 design tokens、排版與互動示範；需要人工授權的模組會清楚標示。</p></div>
          <div class="theme-grid"><button v-for="item in themes" :key="item.id" type="button" class="theme-choice" :class="[`theme-${item.id}`, { selected: theme === item.id }]" :aria-pressed="theme === item.id" @click="theme = item.id"><span class="theme-swatch"><i v-for="color in item.colors" :key="color" :style="{ background: color }"></i></span><strong>{{ item.label }}</strong><small>{{ item.descriptor }}</small><b>{{ theme === item.id ? '✓' : '＋' }}</b></button></div>
          <div class="preference-block"><div class="section-label"><span>LAYOUT PREFERENCES</span><small>可複選</small></div><div class="preference-row"><button v-for="item in stylePreferences" :key="item.id" type="button" :class="{ selected: selectedStyles.includes(item.id) }" :aria-pressed="selectedStyles.includes(item.id)" @click="toggleStyle(item.id)"><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></button></div></div>
          <div class="reference-block"><div class="section-label"><span>OPTIONAL REFERENCE</span><small>不會發出 network request</small></div><label for="builder-reference">貼上喜歡的風格參考網址</label><input id="builder-reference" v-model="styleReferenceUrl" type="url" maxlength="256" placeholder="https://example.com" :aria-invalid="Boolean(styleReferenceError)" @blur="validateStyleReference"><small>只作為方向參考；不會複製對方品牌、Logo、文字、圖片或原始碼。</small><p v-if="styleReferenceError" class="field-error" role="alert">{{ styleReferenceError }}</p></div>
          <div class="module-selection"><div class="section-label"><span>FEATURE MODULES</span><small>{{ selectedModules.length }} 個已選</small></div><div class="module-grid"><button v-for="item in moduleOptions" :key="item.id" type="button" :class="{ selected: selectedModules.includes(item.id) }" :aria-pressed="selectedModules.includes(item.id)" @click="toggleModule(item.id)"><span class="module-check">{{ selectedModules.includes(item.id) ? '✓' : '+' }}</span><strong>{{ item.label }}</strong><small>{{ item.outcome }}</small><em>{{ item.note }}</em></button></div></div>
          <div class="step-footer"><p>簡易電商未建立商店；未來可受控串接 Shopify。</p><button class="builder-primary" type="button" :disabled="!canProceedFromStyle" @click="submitStyle">開始生成預覽 <span>✦</span></button></div>
        </section>

        <section v-else-if="currentStep === 'generating'" class="builder-step generation-step" aria-labelledby="generation-title"><div class="generation-core"><div class="generation-ring"><span></span><b>{{ String(generationStage + 1).padStart(2, '0') }}</b></div><p class="builder-eyebrow">CONCEPT GENERATION / NO AI REQUEST</p><h2 id="generation-title">正在把方向整理成一個可以互動的預覽。</h2><p>這是一段本地概念生成示範，不代表此刻真的呼叫 AI 或建立正式網站。</p></div><div class="generation-stages" aria-live="polite"><div v-for="(stage, index) in generationStages" :key="stage" :class="{ active: generationStage >= index, current: generationStage === index }"><i>{{ String(index + 1).padStart(2, '0') }}</i><span>{{ stage }}</span><b>{{ generationStage > index ? '完成' : generationStage === index ? '整理中' : '等待中' }}</b></div></div><button type="button" class="builder-secondary" @click="setStep('style_and_modules')">返回調整方向</button></section>

        <section v-else-if="currentStep === 'interactive_preview'" class="builder-step preview-step" aria-labelledby="preview-title"><div class="step-heading preview-heading"><div><p class="builder-eyebrow">INTERACTIVE CONCEPT / VERSION 01</p><h2 id="preview-title">這個方向，像你的品牌嗎？</h2><p>切換裝置、頁面與模組，看看網站如何被訪客理解。所有表單都是 disabled demo。</p></div><span class="preview-status">PREVIEW ONLY / NO DEPLOY</span></div><div class="preview-toolbar"><div class="viewport-switch" role="group" aria-label="預覽裝置"><button v-for="item in viewportOptions" :key="item[0]" type="button" :class="{ active: viewport === item[0] }" @click="viewport = item[0]">{{ item[1] }}</button></div><div class="preview-address"><span>SAFE PREVIEW</span>{{ currentDomain }}</div><span class="preview-live-dot">概念版本</span></div><div class="preview-browser-wrap" :class="`viewport-${viewport}`"><div class="preview-browser"><div class="preview-browser-top"><span></span><span></span><span></span><small>{{ currentDomain }}</small></div><div class="generated-preview"><header class="generated-header"><strong>{{ brandName || '你的品牌' }}</strong><nav><button v-for="page in currentPages" :key="page" type="button" :class="{ active: previewPage === page }" @click="choosePreviewPage(page)">{{ pageLabels[page] }}</button></nav><button type="button" class="preview-header-cta" @click="showDemoNotice('這個聯絡入口目前是預覽示範。')">{{ selectedModules.includes('booking') ? '立即預約' : '聯絡我們' }}</button></header><main class="generated-main" :class="`page-${previewPage}`"><div class="preview-watermark">PREVIEW / CONCEPT ONLY</div><section v-if="previewPage === 'home'" class="generated-hero"><div class="hero-grid-mark" aria-hidden="true"><span></span><span></span><span></span></div><p class="generated-kicker">{{ currentTheme.label.toUpperCase() }} · GEO STRUCTURE READY</p><h3>{{ previewTitle }}</h3><p>{{ previewDescription }}</p><div class="generated-actions"><button type="button" @click="showDemoNotice('這是預覽中的 CTA，不會送出資料。')">{{ selectedModules.includes('booking') ? '預約第一次諮詢' : siteType === 'commerce' ? '開始選購' : '了解服務' }} <span>→</span></button><button type="button" class="ghost-action" @click="choosePreviewPage(siteType === 'commerce' ? 'products' : 'services')">看看內容結構 <span>↗</span></button></div></section><section v-else-if="previewPage === 'services'" class="generated-content-view"><p class="generated-kicker">ANSWER-FIRST SERVICE PAGE</p><h3>先回答問題，再讓人放心採取下一步。</h3><div class="answer-columns"><article><span>01</span><strong>你會得到什麼？</strong><p>以清楚段落整理服務範圍、流程與適合對象。</p></article><article><span>02</span><strong>為什麼相信你？</strong><p>把專業、地區與真實證據放在容易理解的位置。</p></article></div></section><section v-else-if="previewPage === 'about'" class="generated-content-view about-view"><p class="generated-kicker">ABOUT THE BRAND</p><h3>{{ brandName || '你的品牌' }}，把專業變成讓人安心的選擇。</h3><p>{{ audience || '你的理想客戶' }}可以在這裡快速理解你怎麼工作、為什麼在乎，以及下一步如何開始。</p><div class="signature-line"><span>品牌故事</span><b>↗</b></div></section><section v-else-if="previewPage === 'content'" class="generated-content-view content-view"><p class="generated-kicker">ANSWER-FIRST CONTENT</p><h3>把客戶真的會問的事，整理成可靠答案。</h3><ol><li>第一次接觸前，最需要知道什麼？</li><li>如何選擇適合自己的服務？</li><li>做決定時，哪些資訊最重要？</li></ol></section><section v-else class="generated-content-view products-view"><p class="generated-kicker">SHOPIFY READY / NOT CONNECTED</p><h3>商品先被看見，正式結帳日後再接上。</h3><div class="product-row"><article v-for="item in ['日常組合', '本月精選', '入門體驗']" :key="item"><div class="product-art"></div><small>CONCEPT ITEM</small><strong>{{ item }}</strong><span>示意價格</span></article></div><p class="integration-note">這份預覽不會建立 Shopify 商店、不會處理付款，也不會保存任何金流資料。</p></section></main><button v-if="selectedModules.includes('ai')" type="button" class="preview-assistant" @click="assistantQuestion = assistantQuestion ? '' : '你最常被問到什麼？'"><span>✦</span><b>品牌 AI 助手</b><small>互動示範</small></button></div></div></div><div v-if="selectedModules.includes('ai') && assistantQuestion" class="assistant-demo"><div class="assistant-demo-head"><span>CONCEPT ASSISTANT</span><button type="button" aria-label="關閉 AI 助手示範" @click="assistantQuestion = ''">×</button></div><p class="assistant-question">{{ assistantQuestion }}</p><div class="assistant-prompts"><button type="button" @click="openAssistant('第一次來之前要知道什麼？')">第一次來之前要知道什麼？</button><button type="button" @click="openAssistant('費用怎麼評估？')">費用怎麼評估？</button></div><p v-if="assistantAnswer" class="assistant-answer">{{ assistantAnswer }}</p></div><div v-if="selectedModules.includes('booking') || selectedModules.includes('line')" class="demo-module-row"><button v-if="selectedModules.includes('booking')" type="button" @click="showDemoNotice('預約入口只在這份預覽中示範，不會真的送出。')">◎ 示範預約入口</button><button v-if="selectedModules.includes('line')" type="button" @click="showDemoNotice('LINE 入口只在正式授權後啟用。')">↗ 示範 LINE 聯絡</button></div><div class="preview-evidence"><span>這份概念已示範</span><ul><li>直接答案結構</li><li>可延伸內容架構</li><li>GEO 結構規劃</li><li>{{ selectedModules.length }} 個選用模組</li></ul></div><div class="step-footer preview-footer"><button type="button" class="builder-secondary" @click="setStep('style_and_modules')">這個方向不對</button><button type="button" class="builder-primary" @click="setStep('plan_and_cadence')">我喜歡這個方向 <span>→</span></button></div></section>

        <section v-else-if="currentStep === 'plan_and_cadence'" class="builder-step" aria-labelledby="plan-title"><div class="step-heading"><p class="builder-eyebrow">PLAN / CADENCE</p><h2 id="plan-title">你希望網站完成後，誰持續照顧它？</h2><p>價格是示意／預估，正式確認前不會扣款。每個方案寫的是你會得到什麼，而不是保證結果。</p></div><div class="plan-grid"><button v-for="item in plans" :key="item.id" type="button" class="plan-choice" :class="{ selected: plan === item.id }" :aria-pressed="plan === item.id" @click="plan = item.id"><span class="plan-accent">{{ item.accent }}</span><strong>{{ item.label }}</strong><p>{{ item.description }}</p><small>{{ item.outcome }}</small><b>{{ item.price ? `NT$ ${formatMoney(item.price)}／月起` : '一次完成基礎' }}</b></button></div><div v-if="plan && plan !== 'launch'" class="cadence-panel"><div><span>CONTENT CADENCE</span><strong>內容更新頻率</strong><p>頻率越高代表預留更多內容營運節奏，不代表保證排名或流量。</p></div><div class="cadence-options" role="group" aria-label="文章頻率"><button v-for="days in cadences" :key="days" type="button" :class="{ active: cadence === days }" @click="cadence = days">每 {{ days }} 天</button></div></div><div class="price-disclosure"><span>價格說明</span><p>一次性網站建置費與每月 GEO 訂閱費分開計算；網域、API 與第三方服務費用尚未正式查詢，正式付款前會重新確認。</p></div><div class="step-footer"><p>不保證排名、流量、ROI 或被任何 AI 引用。</p><button class="builder-primary" type="button" :disabled="!plan" @click="submitPlan">規劃網域與上線 <span>→</span></button></div></section>

        <section v-else-if="currentStep === 'domain_and_launch'" class="builder-step" aria-labelledby="domain-title"><div class="step-heading"><p class="builder-eyebrow">DOMAIN / LAUNCH PLAN</p><h2 id="domain-title">網站要住在哪裡？</h2><p>現在只做規劃與模擬，不會查詢可用性、不會購買、不會要求帳號密碼。</p></div><div class="domain-choice-grid"><button type="button" class="domain-choice" :class="{ selected: domainMode === 'new' }" @click="chooseDomainMode('new')"><span>01</span><strong>我想購買新網域</strong><p>輸入想要的名稱，按下模擬查詢。正式付款前會重新確認價格與可用性。</p></button><button type="button" class="domain-choice" :class="{ selected: domainMode === 'existing' }" @click="chooseDomainMode('existing')"><span>02</span><strong>我已經有網域</strong><p>付款後會透過 DNS 或授權驗證所有權，現在不需要交出帳號或 API key。</p></button></div><div v-if="domainMode" class="domain-form"><label for="builder-domain">{{ domainMode === 'new' ? '想規劃的網域' : '現有網域' }}</label><div class="field-with-action"><input id="builder-domain" v-model="domainInput" maxlength="120" placeholder="your-brand.tw" :aria-invalid="Boolean(domainError)" @input="domainError = ''; domainSimulation = 'idle'"><button type="button" class="builder-secondary" @click="simulateDomain">模擬查詢</button></div><small>示意：{{ currentDomain }} 將登記給客戶，DiscoveryStack 負責技術代管與營運。</small><p v-if="domainError" class="field-error" role="alert">{{ domainError }}</p><p v-else-if="domainSimulation === 'checked'" class="simulation-status" role="status"><span>◌</span> 目前只完成模擬，尚未確認可購買。</p></div><div class="launch-timeline"><div v-for="(item, index) in timeline" :key="item.label" class="timeline-item"><span>{{ String(index + 1).padStart(2, '0') }}</span><i></i><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></div></div><div class="step-footer"><p>所有節點目前都是「付款後執行」。</p><button class="builder-primary" type="button" :disabled="!canProceedFromDomain" @click="submitDomain">查看完整摘要 <span>→</span></button></div></section>

        <section v-else-if="currentStep === 'review_order'" class="builder-step review-step" aria-labelledby="review-title"><div class="step-heading"><p class="builder-eyebrow">REVIEW BEFORE HANDOFF</p><h2 id="review-title">這是你要保存的方向嗎？</h2><p>最後看一次規格、預估費用與尚未執行的外部操作。這不是正式訂單。</p></div><div class="review-layout"><div class="review-list"><article><span>品牌</span><strong>{{ brandName || '尚未命名' }}</strong><button type="button" @click="setStep('diagnosis_or_brief')">修改</button></article><article><span>網站架構</span><strong>{{ currentSiteType.label }} · {{ currentSiteType.pages.join('／') }}</strong><button type="button" @click="setStep('site_architecture')">修改</button></article><article><span>風格與功能</span><strong>{{ currentTheme.label }} · {{ selectedModuleLabels.join('、') || '尚未選擇模組' }}</strong><button type="button" @click="setStep('style_and_modules')">修改</button></article><article><span>GEO 方案</span><strong>{{ currentPlan.label }}{{ plan !== 'launch' ? ` · 每 ${cadence} 天` : '' }}</strong><button type="button" @click="setStep('plan_and_cadence')">修改</button></article><article><span>網域方向</span><strong>{{ domainMode === 'new' ? '新網域規劃' : '使用現有網域' }} · {{ currentDomain }}</strong><button type="button" @click="setStep('domain_and_launch')">修改</button></article></div><aside class="review-price"><p>ESTIMATED PROJECT SUMMARY</p><h3>{{ brandName || '你的品牌' }}</h3><div><span>一次性網站建置預估</span><strong>NT$ {{ formatMoney(oneTimeEstimate) }}</strong></div><div v-if="monthlyEstimate"><span>每月 GEO 訂閱預估</span><strong>NT$ {{ formatMoney(monthlyEstimate) }}</strong></div><small>網域費用、API／第三方服務可能另計；以上均為示意或預估。</small><label><input v-model="reviewConfirmed" type="checkbox"> 我理解這是互動式預覽，不是已付款、已購買網域或已部署的正式成品。</label></aside></div><div class="ownership-note"><span>CLIENT OWNED DOMAIN</span><p>網域原則上歸客戶所有；DiscoveryStack 代管程式碼、部署與長期維護。V1 不提供完整原始碼下載。</p></div><div class="step-footer"><p>不會建立真實訂單，也不會呼叫付款、網域或部署服務。</p><button ref="reviewHandoffTrigger" class="builder-primary" type="button" :disabled="!reviewConfirmed" @click="submitReview">保存這份預覽，聯絡我們確認 <span>→</span></button></div></section>

        <section v-else class="builder-step handoff-step" aria-labelledby="handoff-step-title"><div class="handoff-success-mark" aria-hidden="true">✓</div><div class="step-heading"><p class="builder-eyebrow">PREVIEW HANDOFF</p><h2 id="handoff-step-title">方向已經整理好了。</h2><p>下一步是由你與 DiscoveryStack 確認規格、付款、網域與人工授權；這一頁沒有假裝任何外部操作已經完成。</p></div><div class="handoff-next-grid"><article v-for="(item, index) in ['確認規格與付款', '重新確認網域與服務費', '完成授權後設定 DNS／SSL', '部署並啟動 GEO 營運']" :key="item"><span>0{{ index + 1 }}</span><strong>{{ item }}</strong></article></div><div class="handoff-honesty"><span>NOT A PRODUCTION ORDER</span><p>本概念頁沒有送出真實訂單、沒有保存聯絡資料，也沒有呼叫私人 API。正式版會由確認後的受控流程接手。</p></div><div class="step-footer"><button type="button" class="builder-secondary" @click="setStep('review_order')">返回摘要</button><button ref="handoffStepTrigger" type="button" class="builder-primary" @click="openHandoff">開啟交接說明 <span>↗</span></button></div></section>
      </section>
    </section>

    <div v-if="showHandoff" class="handoff-layer" role="presentation" @click.self="closeHandoff"><section ref="handoffDialog" class="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title" tabindex="-1" @keydown.esc="closeHandoff" @keydown="trapHandoff"><button ref="handoffCloseButton" class="dialog-close" type="button" aria-label="關閉交接說明" @click="closeHandoff">×</button><p class="builder-eyebrow">HANDOFF / NO EXTERNAL WRITE</p><h2 id="handoff-dialog-title">把這份方向交給下一步，但現在不會假裝完成。</h2><div class="handoff-dialog-path"><span>保存預覽方向</span><i>→</i><span>人工確認規格</span><i>→</i><span>付款與授權</span><i>→</i><span>部署上線</span></div><p>正式版會保留這份預覽的品牌、頁面、模組、風格、GEO 方案與網域意圖，再由你確認後進行外部操作。現在只是一個可操作的產品體驗。</p><div v-if="handoffSaved" class="handoff-saved" role="status">已在本次瀏覽中記住你的確認意圖；沒有送出訂單或保存任何個人資料。</div><div class="handoff-dialog-actions"><button type="button" class="builder-secondary" @click="closeHandoff">返回繼續調整</button><button type="button" class="builder-primary" @click="confirmHandoff">{{ handoffSaved ? '確認完成' : '我了解，保存這份預覽' }} <span>→</span></button></div></section></div>
  </main>
</template>
