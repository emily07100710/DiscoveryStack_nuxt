<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { gsap } from 'gsap'
import BuilderServiceOverview from './BuilderServiceOverview.vue'
import { publicApiFetch } from '../lib/publicApi'
import {
  builderPhases,
  builderSteps,
  cadences,
  generationStages,
  moduleOptions,
  motionOptions,
  normalizeDomain,
  normalizePublicUrl,
  pageLabels,
  phaseForStep,
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
  type MotionKey,
  type PlanKey,
  type PreviewPage,
  type SiteType,
  type ThemeKey,
  type Viewport,
  formatMoney,
} from '../lib/website-builder-model'
import '../styles/website-builder.css'

type DomainMode = 'new' | 'existing'

defineProps<{ customerStartUrl: string }>()

const currentStep = ref<BuilderStep>('diagnosis_or_brief')
const brandName = ref('')
const businessBrief = ref('')
const audience = ref('')
const desiredAction = ref('')
const siteType = ref<SiteType | null>(null)
const selectedModules = ref<string[]>(['admin'])
const theme = ref<ThemeKey | null>(null)
const selectedStyles = ref<string[]>(['space'])
const motionPreference = ref<MotionKey>('refined')
const styleDescription = ref('')
const previewPointer = ref({ x: 0, y: 0 })
let previewPointerFrame = 0
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
const handoffSubmitting = ref(false)
const handoffError = ref('')
const handoffContact = reactive({ name: '', email: '', company: '', website: '', privacyConsent: false, recontactConsent: false, companyFax: '' })
const handoffCloseButton = ref<HTMLButtonElement | null>(null)
const handoffDialog = ref<HTMLElement | null>(null)
const handoffStepTrigger = ref<HTMLElement | null>(null)
const reviewHandoffTrigger = ref<HTMLButtonElement | null>(null)
const builderPanel = ref<HTMLElement | null>(null)
const builderPanelHead = ref<HTMLElement | null>(null)
const lastHandoffTrigger = ref<HTMLElement | null>(null)
const timers = new Set<number>()
const panelTweens = new Map<HTMLElement, gsap.core.Tween>()
const heightTweens = new Map<HTMLElement, gsap.core.Tween>()
const panelObservers = new Map<HTMLElement, ResizeObserver>()
const activePanels = new Map<HTMLElement, HTMLElement>()
let reducedPreference: MediaQueryList | undefined
const viewportOptions: Array<[Viewport, string]> = [['desktop', '桌面'], ['tablet', '平板'], ['mobile', '手機']]

const currentIndex = computed(() => builderSteps.findIndex((step) => step.id === currentStep.value))
const currentStepMeta = computed(() => builderSteps[currentIndex.value] ?? builderSteps[0])
const currentPhase = computed(() => phaseForStep(currentStep.value))
const currentPhaseIndex = computed(() => builderPhases.findIndex(phase => phase.id === currentPhase.value.id))
const currentMotion = computed(() => motionOptions.find(item => item.id === motionPreference.value) ?? motionOptions[1])
const phaseHint = computed(() => currentPhase.value.id === 'create'
  ? '填資料、選風格，接著看網站預覽。'
  : currentPhase.value.id === 'plan'
    ? '看過成果，再決定建置與持續服務。'
    : '確認網域與需求，整理正式建置方向。')
const currentSiteType = computed(() => siteTypeFor(siteType.value))
const currentTheme = computed(() => themeFor(theme.value ?? 'mineral'))
const currentPlan = computed(() => planFor(plan.value))
const currentPages = computed(() => pagesForSiteType(siteType.value ?? 'brand-blog'))
const selectedModuleDetails = computed(() => moduleOptions.filter((item) => selectedModules.value.includes(item.id)))
const selectedModuleLabels = computed(() => selectedModuleDetails.value.map((item) => item.label))
const selectedStyleLabels = computed(() => stylePreferences.filter((item) => selectedStyles.value.includes(item.id)).map((item) => item.label))
const showDirection = computed(() => !['generating', 'interactive_preview', 'review_order', 'handoff'].includes(currentStep.value))
const currentDomain = computed(() => normalizeDomain(domainInput.value) || 'your-brand.tw')
const canProceedFromStyle = computed(() => Boolean(theme.value && normalizeReferenceUrl(styleReferenceUrl.value) !== false))
const canProceedFromDomain = computed(() => Boolean(domainMode.value && domainInput.value.trim() && !domainError.value))
const basePrice = computed(() => (siteType.value === 'commerce' ? 128800 : siteType.value === 'brand-blog' ? 88800 : 58800))
const oneTimeEstimate = computed(() => basePrice.value)
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
  '--preview-shift-x': `${previewPointer.value.x * 12}px`,
  '--preview-shift-y': `${previewPointer.value.y * 10}px`,
  '--preview-rotate': `${previewPointer.value.x * 3}deg`,
}))

function canAnimatePanels(element?: HTMLElement) {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
    && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    && document.documentElement.dataset.motionPaused !== 'true'
    && !element?.closest('.generated-preview[data-motion=none]')
}

function motionSeconds(element: HTMLElement, token: string, fallback: number) {
  const value = window.getComputedStyle(element).getPropertyValue(token).trim()
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? Math.max(.08, Math.min(1.2, value.endsWith('ms') ? parsed / 1000 : parsed)) : fallback
}

function panelHost(element: HTMLElement) {
  return element.closest<HTMLElement>('.builder-stage-host, .generated-view-shell')
}

function stopPanel(element: HTMLElement) {
  panelTweens.get(element)?.kill()
  panelTweens.delete(element)
  panelObservers.get(element)?.disconnect()
  panelObservers.delete(element)
}

function finishPanel(element: HTMLElement) {
  stopPanel(element)
  gsap.set(element, { clearProps: 'opacity,visibility,transform' })
  const host = panelHost(element)
  if (host && activePanels.get(host) === element) {
    heightTweens.get(host)?.kill()
    heightTweens.delete(host)
    host.style.removeProperty('height')
    activePanels.delete(host)
  }
}

function preparePanelLeave(node: Element) {
  const element = node as HTMLElement
  element.dataset.stageLeaving = 'true'
  element.setAttribute('aria-hidden', 'true')
  element.inert = true
  const host = panelHost(element)
  if (!host || !canAnimatePanels(element)) return
  const height = host.getBoundingClientRect().height
  if (height > 0) host.style.height = `${height}px`
}

function enterPanel(node: Element, done: () => void) {
  const element = node as HTMLElement
  const host = panelHost(element)
  const target = element.getBoundingClientRect().height
  if (!host || !canAnimatePanels(element) || target <= 0) { done(); return }
  stopPanel(element)
  activePanels.set(host, element)
  const resize = () => {
    if (activePanels.get(host) !== element) return
    const nextHeight = element.getBoundingClientRect().height
    if (nextHeight <= 0) return
    heightTweens.get(host)?.kill()
    heightTweens.set(host, gsap.to(host, {
      height: nextHeight, duration: motionSeconds(host, '--motion-panel', .42), ease: 'power3.inOut',
    }))
  }
  if (!host.style.height) host.style.height = `${target}px`
  try {
    resize()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(resize)
      observer.observe(element)
      panelObservers.set(element, observer)
    }
    panelTweens.set(element, gsap.fromTo(element, { autoAlpha: 0, y: 12 }, {
      autoAlpha: 1, y: 0, duration: motionSeconds(element, '--motion-reveal', .5), ease: 'power3.out',
      onComplete: () => { finishPanel(element); done() },
    }))
  } catch { finishPanel(element); done() }
}

function leavePanel(node: Element, done: () => void) {
  const element = node as HTMLElement
  stopPanel(element)
  if (!canAnimatePanels(element) || element.getBoundingClientRect().height <= 0) { done(); return }
  try {
    gsap.set(element, { position: 'absolute', left: 0, top: 0, width: '100%', pointerEvents: 'none' })
    panelTweens.set(element, gsap.to(element, {
      autoAlpha: 0, y: -7, duration: motionSeconds(element, '--motion-feedback', .18), ease: 'power2.out',
      onComplete: () => { stopPanel(element); done() },
    }))
  } catch { done() }
}

function cancelPanel(node: Element) {
  const element = node as HTMLElement
  finishPanel(element)
  delete element.dataset.stageLeaving
  element.removeAttribute('aria-hidden')
  element.inert = false
  gsap.set(element, { clearProps: 'position,left,top,width,pointerEvents' })
}

function settlePanelMotion() {
  if (canAnimatePanels()) return
  ;[...panelTweens.values()].forEach(tween => tween.progress(1))
  ;[...heightTweens.values()].forEach(tween => tween.progress(1))
  resetPreviewMotion()
}

function resetPreviewMotion() {
  window.cancelAnimationFrame(previewPointerFrame)
  previewPointerFrame = 0
  previewPointer.value = { x: 0, y: 0 }
}

function movePreview(event: PointerEvent) {
  if (motionPreference.value !== 'expressive' || event.pointerType === 'touch' || !canAnimatePanels()) return
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (!box.width || !box.height) return
  const x = Math.max(-1, Math.min(1, (event.clientX - box.left) / box.width * 2 - 1))
  const y = Math.max(-1, Math.min(1, (event.clientY - box.top) / box.height * 2 - 1))
  window.cancelAnimationFrame(previewPointerFrame)
  previewPointerFrame = window.requestAnimationFrame(() => {
    previewPointerFrame = 0
    previewPointer.value = { x, y }
  })
}

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
  if (currentStep.value === 'generating' && step !== 'generating') clearTimers()
  currentStep.value = step
  demoNotice.value = ''
  if (step === 'interactive_preview') {
    previewPage.value = currentPages.value[0] ?? 'home'
  }
}

function returnToPhase(index: number) {
  if (index >= currentPhaseIndex.value) return
  setStep(builderPhases[index].steps[0])
}

async function focusStudio() {
  await nextTick()
  const target = currentStep.value === 'diagnosis_or_brief'
    ? builderPanel.value?.querySelector<HTMLInputElement>('#builder-brand')
    : builderPanel.value?.querySelector<HTMLElement>('.builder-step:not([data-stage-leaving]) h2')
  target?.focus({ preventScroll: true })
  builderPanelHead.value?.closest<HTMLElement>('.builder-workspace')?.scrollIntoView({
    block: 'start',
    behavior: canAnimatePanels() ? 'smooth' : 'auto',
  })
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
  const duration = canAnimatePanels() ? 760 : 0
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
  if (!handoffContact.company.trim()) handoffContact.company = brandName.value.trim()
  handoffError.value = ''
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
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), a[href], [tabindex]:not([tabindex="-1"])'))
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
  if (handoffSubmitting.value) return
  if (!handoffSaved.value) {
    handoffError.value = ''
    if (handoffContact.name.trim().length < 2 || handoffContact.company.trim().length < 2 || !handoffContact.email.includes('@') || !handoffContact.privacyConsent) {
      handoffError.value = '請填寫姓名、工作 Email、公司／品牌，並同意資料處理。'
      return
    }
    handoffSubmitting.value = true
    try {
      const description = [
        '來源：一鍵建站互動預覽',
        `品牌：${brandName.value.trim().slice(0, 160) || '未命名'}`,
        `網站類型：${currentSiteType.value.label}`,
        `服務摘要：${businessBrief.value.trim().slice(0, 320) || '未填寫'}`,
        `目標客群：${audience.value.trim().slice(0, 160) || '未填寫'}`,
        `風格：${currentTheme.value.label}；${selectedStyleLabels.value.join('、') || '未選擇'}`,
        `動畫：${currentMotion.value.label}`,
        `功能：${selectedModuleLabels.value.join('、') || '未選擇'}`,
        `方案：${currentPlan.value.label}；文章節奏：${plan.value === 'launch' ? '未選擇' : `每 ${cadence.value} 天`}`,
        `網域方向：${domainMode.value === 'new' ? '新網域' : '既有網域'}；${domainInput.value.trim().slice(0, 120)}`,
        `預估：一次性 NT$ ${formatMoney(oneTimeEstimate.value)}；每月 NT$ ${formatMoney(monthlyEstimate.value)}`,
      ].join('\n').slice(0, 1900)
      const result = await publicApiFetch<{ received: boolean; duplicate: boolean }>('/api/leads', { body: {
        name: handoffContact.name.trim(), email: handoffContact.email.trim(), company: handoffContact.company.trim(), website: handoffContact.website.trim(),
        packageInterest: plan.value === 'launch' ? 'clarify' : 'grow', language: 'zh-hant', message: description,
        privacyConsent: handoffContact.privacyConsent, recontactConsent: handoffContact.recontactConsent, companyFax: handoffContact.companyFax,
      } })
      if (!result.received) throw new Error('handoff not received')
      if (result.duplicate) {
        handoffError.value = '這個聯絡方式近期已送出需求。新調整尚未更新，請 15 分鐘後再送一次。'
        return
      }
    } catch {
      handoffError.value = '目前無法送出，請檢查資料後再試一次。你的選擇仍留在此頁。'
      return
    } finally {
      handoffSubmitting.value = false
    }
  }
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

watch(currentStep, async (step) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  await nextTick()
  if (currentStep.value !== step || showHandoff.value || !builderPanelHead.value?.isConnected) return
  // Handoff completion owns its focus target; other steps begin at their heading.
  if (step !== 'handoff') builderPanel.value?.querySelector<HTMLElement>('.builder-step:not([data-stage-leaving]) h2')?.focus({ preventScroll: true })
  const reducedMotion = !canAnimatePanels()
  const stepStart = builderPanelHead.value.closest<HTMLElement>('.builder-workspace') ?? builderPanelHead.value
  stepStart.scrollIntoView?.({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' })
})

onMounted(() => {
  reducedPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  reducedPreference?.addEventListener?.('change', settlePanelMotion)
  document.addEventListener('discoverystack:motion-change', settlePanelMotion)
})

onBeforeUnmount(() => {
  clearTimers()
  reducedPreference?.removeEventListener?.('change', settlePanelMotion)
  if (typeof document !== 'undefined') document.removeEventListener('discoverystack:motion-change', settlePanelMotion)
  ;[...panelTweens.keys()].forEach(stopPanel)
  heightTweens.forEach(tween => tween.kill())
  heightTweens.clear()
  panelObservers.forEach(observer => observer.disconnect())
  panelObservers.clear()
  activePanels.clear()
  if (typeof window !== 'undefined') resetPreviewMotion()
  if (typeof document !== 'undefined') document.body.style.overflow = ''
})
</script>

<template>
  <main class="builder-experience" :style="themeStyle" :data-motion="motionPreference">
    <div class="builder-atmosphere" aria-hidden="true"><span></span><span></span></div>
    <header class="builder-masthead">
      <div class="builder-masthead-copy">
        <p class="builder-eyebrow">DISCOVERYSTACK / ONE-CLICK WEBSITE STUDIO</p>
        <h1><span class="studio-title-line"><span>一鍵建站。</span></span><span class="studio-title-line"><em>先看見你的第一版。</em></span></h1>
        <p class="builder-lede">說說你的生意，選擇風格與功能，<br class="studio-desktop-break">按一下，產生可以親手體驗的網站預覽。</p>
        <div class="studio-entry-actions"><a class="studio-start" href="#website-studio" @click.prevent="focusStudio">開始建立網站預覽 <span aria-hidden="true">↗</span></a><a class="studio-services-link" href="#builder-services">可以做哪些功能？ <span aria-hidden="true">↓</span></a></div>
        <p class="builder-care-note">預覽起步；上線後，可依方案持續觀察與改善。</p>
        <p class="builder-care-note">正式交付後 30 天，原功能範圍內的排版、美術調整免費。新增功能、資料搬遷、新串接及第三方費用另行確認。</p>
        <div class="builder-trust-row" aria-label="預覽體驗"><span>免信用卡</span><span>風格與動畫可選</span><span>先看成果，再選方案</span></div>
      </div>
      <div class="builder-timepiece">
        <div class="studio-time-orbit" aria-hidden="true"><svg viewBox="0 0 320 320" fill="none"><circle cx="160" cy="160" r="147" stroke="currentColor" stroke-opacity=".15"/><circle cx="160" cy="160" r="130" stroke="currentColor" stroke-opacity=".18" stroke-dasharray="1 11"/><path d="M160 13A147 147 0 0 1 305 184" stroke="currentColor" stroke-width="1.4"/><circle cx="305" cy="184" r="3" fill="currentColor"/></svg></div>
        <span class="studio-time-label">給自己一點時間，看見新的可能。</span>
        <div class="studio-time-value"><small>約</small><strong>10</strong><span>分鐘</span></div>
        <p class="studio-time-outcome">完成資料、風格選擇與第一版預覽</p>
        <p class="studio-time-note">操作時間預估，依資料準備與調整次數而異。正式上線另需確認付款、網域與服務設定。</p>
      </div>
    </header>

    <div class="studio-route" aria-label="從預覽到正式建置">
      <div><span>01</span><p><strong>建立網站</strong><small>品牌資料 → 風格與功能 → 預覽</small></p><b aria-hidden="true">↗</b></div>
      <div><span>02</span><p><strong>選擇方案</strong><small>先看成果，再選需要的服務</small></p><b aria-hidden="true">↗</b></div>
      <div><span>03</span><p><strong>確認上線</strong><small>網域、授權與正式建置另外確認</small></p><b aria-hidden="true">↗</b></div>
    </div>
    <p class="studio-preview-note">目前為互動概念預覽：不會扣款、不會購買網域、不會部署。</p>

    <section id="website-studio" class="builder-workspace" :class="{ 'has-direction': showDirection }" aria-label="網站預覽建立流程">
      <aside class="builder-rail">
        <div class="builder-rail-top"><span>YOUR WEBSITE</span><strong>{{ String(currentPhaseIndex + 1).padStart(2, '0') }}<small>/ {{ String(builderPhases.length).padStart(2, '0') }}</small></strong></div>
        <nav class="builder-progress" aria-label="建站步驟">
          <span class="builder-phase-track" aria-hidden="true"><i :style="{ transform: `scaleX(${currentPhaseIndex / (builderPhases.length - 1)})` }"></i></span>
          <button v-for="(phase, index) in builderPhases" :key="phase.id" type="button" :disabled="index >= currentPhaseIndex" :class="{ active: phase.id === currentPhase.id, complete: index < currentPhaseIndex }" :aria-current="phase.id === currentPhase.id ? 'step' : undefined" @click="returnToPhase(index)">
            <span>{{ String(index + 1).padStart(2, '0') }}</span><b>{{ phase.label }}</b>
          </button>
        </nav>
        <p class="builder-phase-note">{{ phaseHint }}</p>
      </aside>

      <section ref="builderPanel" class="builder-panel">
        <div ref="builderPanelHead" class="builder-panel-head">
          <button v-if="currentIndex > 0 && currentStep !== 'generating'" class="builder-back" type="button" @click="goBack">← 返回上一步</button>
          <span v-else class="builder-back-placeholder">互動概念預覽</span>
          <p aria-live="polite">{{ currentStepMeta.label }}</p>
        </div>

        <div v-if="demoNotice" class="builder-notice" role="status">{{ demoNotice }}</div>

        <div class="builder-stage-host">
        <Transition :css="false" @before-leave="preparePanelLeave" @enter="enterPanel" @leave="leavePanel" @enter-cancelled="cancelPanel" @leave-cancelled="cancelPanel">
        <section v-if="currentStep === 'diagnosis_or_brief'" class="builder-step" aria-labelledby="brief-title">
          <div class="step-heading"><p class="builder-eyebrow">01 / YOUR BRAND, FIRST</p><h2 id="brief-title" tabindex="-1">先說說你的生意。</h2><p>準備品牌名稱、服務介紹、客戶對象與聯絡目標。四個答案，就能開始。</p></div>

          <div class="brief-flow">
            <div class="brief-grid"><div class="field-block"><label for="builder-brand">品牌名稱</label><input id="builder-brand" v-model="brandName" maxlength="40" placeholder="例如：山嶼牙醫診所"></div><div class="field-block"><label for="builder-audience">你服務誰？</label><input id="builder-audience" v-model="audience" maxlength="120" placeholder="例如：第一次看牙的家庭"></div><div class="field-block field-wide"><label for="builder-brief">用一句話介紹你的業務</label><textarea id="builder-brief" v-model="businessBrief" maxlength="260" rows="3" placeholder="我們是誰、提供什麼、希望客戶感受到什麼？"></textarea></div><div class="field-block field-wide"><label for="builder-action">希望訪客完成什麼動作？</label><input id="builder-action" v-model="desiredAction" maxlength="120" placeholder="例如：預約第一次諮詢或加入 LINE"></div></div>
            <div class="prompt-examples"><span>可以這樣開始</span><button type="button" @click="businessBrief = businessBrief || '我們替忙碌的家庭提供安心、透明的日常照護。'">安心、透明的日常照護</button><button type="button" @click="businessBrief = businessBrief || '我們用設計與內容，讓在地品牌更容易被找到。'">讓在地品牌更容易被找到</button><small>示例不會覆蓋你已經輸入的內容。</small></div>
            <div class="step-footer"><p>不收集密碼、身分證、付款資料或 API key。</p><button class="builder-primary" type="button" @click="submitBrief">整理成網站方向 <span>→</span></button></div>
          </div>
        </section>

        <section v-else-if="currentStep === 'site_architecture'" class="builder-step" aria-labelledby="architecture-title">
          <div class="step-heading"><p class="builder-eyebrow">SITE ARCHITECTURE</p><h2 id="architecture-title" tabindex="-1">網站要先幫你完成什麼？</h2><p>選一個最接近現在目標的方向。這只決定預覽結構，不會限制未來的正式規劃。</p></div>
          <div class="architecture-grid"><button v-for="item in siteTypes" :key="item.id" type="button" class="architecture-choice" :class="{ selected: siteType === item.id }" :aria-pressed="siteType === item.id" @click="siteType = item.id"><span>{{ item.eyebrow }}</span><strong>{{ item.label }}</strong><p>{{ item.description }}</p><small>{{ item.bestFor }}</small><i>{{ siteType === item.id ? '已選擇' : '選擇方向' }} <b>→</b></i></button></div>
          <div class="architecture-map" aria-label="預覽頁面結構"><span>預覽會包含</span><i v-for="page in currentSiteType.pages" :key="page">{{ page }}</i></div>
          <div class="step-footer"><p>之後仍可以返回修改網站類型。</p><button class="builder-primary" type="button" :disabled="!siteType" @click="submitArchitecture">選擇功能與風格 <span>→</span></button></div>
        </section>

        <section v-else-if="currentStep === 'style_and_modules'" class="builder-step" aria-labelledby="style-title">
          <div class="step-heading"><p class="builder-eyebrow">03 / A DISTINCTIVE PRESENCE</p><h2 id="style-title" tabindex="-1">你希望它給人的第一印象是什麼？</h2><p>找到喜歡的氛圍，再選擇品牌需要的功能。</p></div>
          <div class="theme-grid"><button v-for="item in themes" :key="item.id" type="button" class="theme-choice" :class="[`theme-${item.id}`, { selected: theme === item.id }]" :aria-pressed="theme === item.id" @click="theme = item.id"><span class="theme-swatch"><i v-for="color in item.colors" :key="color" :style="{ background: color }"></i></span><strong>{{ item.label }}</strong><small>{{ item.descriptor }}</small><b>{{ theme === item.id ? '✓' : '＋' }}</b></button></div>
          <div class="preference-block"><div class="section-label"><span>LAYOUT PREFERENCES</span><small>可複選</small></div><div class="preference-row"><button v-for="item in stylePreferences" :key="item.id" type="button" :class="{ selected: selectedStyles.includes(item.id) }" :aria-pressed="selectedStyles.includes(item.id)" @click="toggleStyle(item.id)"><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></button></div></div>
          <fieldset class="motion-selection"><legend>動畫想要多少？</legend><p>選一種節奏，右側預覽會跟著變化。手機與減少動畫設定仍以閱讀為優先。</p><div class="motion-options"><button v-for="item in motionOptions" :key="item.id" class="motion-choice" type="button" :class="{ selected: motionPreference === item.id }" :aria-pressed="motionPreference === item.id" @click="motionPreference = item.id"><span class="motion-glyph" :class="`glyph-${item.id}`" aria-hidden="true"><i></i><i></i><i></i></span><strong>{{ item.label }}</strong><small>{{ item.description }}</small><b aria-hidden="true">{{ motionPreference === item.id ? '✓' : '+' }}</b></button></div></fieldset>
          <div class="style-intent"><label for="builder-style-description">用自己的話描述風格 <span>選填</span></label><textarea id="builder-style-description" v-model="styleDescription" maxlength="500" rows="3" placeholder="例如：深藍配卡其，文字少一點，留白多一點；動畫細緻，但不要太花。"></textarea><p>描述會加入最後的需求摘要。此預覽尚未連接 AI 風格判讀。</p></div>
          <div class="reference-block"><div class="section-label"><span>OPTIONAL REFERENCE</span><small>選填</small></div><label for="builder-reference">貼上喜歡的風格參考網址</label><input id="builder-reference" v-model="styleReferenceUrl" type="url" maxlength="256" placeholder="https://example.com" :aria-invalid="Boolean(styleReferenceError)" @blur="validateStyleReference"><small>此處只記錄方向，不會讀取或複製參考網站。</small><p v-if="styleReferenceError" class="field-error" role="alert">{{ styleReferenceError }}</p></div>
          <div class="module-selection"><div class="section-label"><span>FEATURE MODULES</span><small>{{ selectedModules.length }} 個已選</small></div><div class="module-grid"><button v-for="item in moduleOptions" :key="item.id" type="button" :class="{ selected: selectedModules.includes(item.id) }" :aria-pressed="selectedModules.includes(item.id)" @click="toggleModule(item.id)"><span class="module-check">{{ selectedModules.includes(item.id) ? '✓' : '+' }}</span><strong>{{ item.label }}</strong><small>{{ item.outcome }}</small><em>{{ item.note }}</em></button></div></div>
          <div class="step-footer"><p>簡易電商未建立商店；未來可受控串接 Shopify。</p><button class="builder-primary" type="button" :disabled="!canProceedFromStyle" @click="submitStyle">開始生成預覽 <span>✦</span></button></div>
        </section>

        <section v-else-if="currentStep === 'generating'" class="builder-step generation-step" aria-labelledby="generation-title" :aria-busy="!generationFinished"><div class="generation-core"><div class="generation-ring"><span></span><b>{{ String(generationStage + 1).padStart(2, '0') }}</b></div><p class="builder-eyebrow">BUILDING YOUR PREVIEW</p><h2 id="generation-title" tabindex="-1">讓你的想法，慢慢成形。</h2><p>正在套用你的選擇，整理概念預覽。此示範不會建立正式網站。</p></div><div class="generation-stages" :style="{ '--generation-progress': (generationStage + 1) / generationStages.length }" aria-live="polite"><div v-for="(stage, index) in generationStages" :key="stage" :class="{ active: generationStage >= index, current: generationStage === index }"><i>{{ String(index + 1).padStart(2, '0') }}</i><span>{{ stage }}</span><b>{{ generationStage > index ? '完成' : generationStage === index ? '整理中' : '等待中' }}</b></div></div><button type="button" class="builder-secondary" @click="setStep('style_and_modules')">返回調整方向</button></section>

        <section v-else-if="currentStep === 'interactive_preview'" class="builder-step preview-step" aria-labelledby="preview-title"><div class="step-heading preview-heading"><div><p class="builder-eyebrow">INTERACTIVE CONCEPT / VERSION 01</p><h2 id="preview-title" tabindex="-1">這個方向，像你的品牌嗎？</h2><p>切換裝置與頁面，親手看看你的網站。聯絡與預約僅為示範，不會送出。</p></div><span class="preview-status">PREVIEW ONLY / NO DEPLOY</span></div><div class="preview-toolbar"><div class="viewport-switch" role="group" aria-label="預覽裝置"><button v-for="item in viewportOptions" :key="item[0]" type="button" :class="{ active: viewport === item[0] }" :aria-pressed="viewport === item[0]" @click="viewport = item[0]">{{ item[1] }}</button></div><div class="preview-address"><span>SAFE PREVIEW</span>{{ currentDomain }}</div><span class="preview-live-dot">概念版本</span></div><div class="preview-browser-wrap" :class="`viewport-${viewport}`"><div class="preview-browser"><div class="preview-browser-top"><span></span><span></span><span></span><small>{{ currentDomain }}</small></div><div class="generated-preview" :data-motion="motionPreference" :data-styles="selectedStyles.join(' ')" @pointermove="movePreview" @pointerleave="resetPreviewMotion"><header class="generated-header"><strong>{{ brandName || '你的品牌' }}</strong><nav><button v-for="page in currentPages" :key="page" type="button" :class="{ active: previewPage === page }" :aria-pressed="previewPage === page" @click="choosePreviewPage(page)">{{ pageLabels[page] }}</button></nav><button type="button" class="preview-header-cta" @click="showDemoNotice('這個聯絡入口目前是預覽示範。')">{{ selectedModules.includes('booking') ? '立即預約' : '聯絡我們' }}</button></header><div class="generated-view-shell"><Transition :css="false" @before-leave="preparePanelLeave" @enter="enterPanel" @leave="leavePanel" @enter-cancelled="cancelPanel" @leave-cancelled="cancelPanel"><main :key="previewPage" class="generated-main" :class="`page-${previewPage}`"><div class="preview-watermark">PREVIEW / CONCEPT ONLY</div><section v-if="previewPage === 'home'" class="generated-hero"><div class="hero-grid-mark" aria-hidden="true"><span></span><span></span><span></span></div><p class="generated-kicker">{{ currentTheme.label.toUpperCase() }} · GEO STRUCTURE READY</p><h3>{{ previewTitle }}</h3><p>{{ previewDescription }}</p><div class="generated-actions"><button type="button" @click="showDemoNotice('這是預覽中的 CTA，不會送出資料。')">{{ selectedModules.includes('booking') ? '預約第一次諮詢' : siteType === 'commerce' ? '開始選購' : '了解服務' }} <span>→</span></button><button type="button" class="ghost-action" @click="choosePreviewPage(siteType === 'commerce' ? 'products' : 'services')">看看內容結構 <span>↗</span></button></div></section><section v-else-if="previewPage === 'services'" class="generated-content-view"><p class="generated-kicker">ANSWER-FIRST SERVICE PAGE</p><h3>先回答問題，再讓人放心採取下一步。</h3><div class="answer-columns"><article><span>01</span><strong>你會得到什麼？</strong><p>以清楚段落整理服務範圍、流程與適合對象。</p></article><article><span>02</span><strong>為什麼相信你？</strong><p>把專業、地區與真實證據放在容易理解的位置。</p></article></div></section><section v-else-if="previewPage === 'about'" class="generated-content-view about-view"><p class="generated-kicker">ABOUT THE BRAND</p><h3>{{ brandName || '你的品牌' }}，把專業變成讓人安心的選擇。</h3><p>{{ audience || '你的理想客戶' }}可以在這裡快速理解你怎麼工作、為什麼在乎，以及下一步如何開始。</p><div class="signature-line"><span>品牌故事</span><b>↗</b></div></section><section v-else-if="previewPage === 'content'" class="generated-content-view content-view"><p class="generated-kicker">ANSWER-FIRST CONTENT</p><h3>把客戶真的會問的事，整理成可靠答案。</h3><ol><li>第一次接觸前，最需要知道什麼？</li><li>如何選擇適合自己的服務？</li><li>做決定時，哪些資訊最重要？</li></ol></section><section v-else class="generated-content-view products-view"><p class="generated-kicker">SHOPIFY READY / NOT CONNECTED</p><h3>商品先被看見，正式結帳日後再接上。</h3><div class="product-row"><article v-for="item in ['日常組合', '本月精選', '入門體驗']" :key="item"><div class="product-art"></div><small>CONCEPT ITEM</small><strong>{{ item }}</strong><span>示意價格</span></article></div><p class="integration-note">這份預覽不會建立 Shopify 商店、不會處理付款，也不會保存任何金流資料。</p></section></main></Transition></div><button v-if="selectedModules.includes('ai')" type="button" class="preview-assistant" @click="assistantQuestion = assistantQuestion ? '' : '你最常被問到什麼？'"><span>✦</span><b>品牌 AI 助手</b><small>互動示範</small></button></div></div></div><div v-if="selectedModules.includes('ai') && assistantQuestion" class="assistant-demo"><div class="assistant-demo-head"><span>CONCEPT ASSISTANT</span><button type="button" aria-label="關閉 AI 助手示範" @click="assistantQuestion = ''">×</button></div><p class="assistant-question">{{ assistantQuestion }}</p><div class="assistant-prompts"><button type="button" @click="openAssistant('第一次來之前要知道什麼？')">第一次來之前要知道什麼？</button><button type="button" @click="openAssistant('費用怎麼評估？')">費用怎麼評估？</button></div><p v-if="assistantAnswer" class="assistant-answer">{{ assistantAnswer }}</p></div><div v-if="selectedModules.includes('booking') || selectedModules.includes('line')" class="demo-module-row"><button v-if="selectedModules.includes('booking')" type="button" @click="showDemoNotice('預約入口只在這份預覽中示範，不會真的送出。')">◎ 示範預約入口</button><button v-if="selectedModules.includes('line')" type="button" @click="showDemoNotice('LINE 入口只在正式授權後啟用。')">↗ 示範 LINE 聯絡</button></div><div class="preview-evidence"><span>這份概念已示範</span><ul><li>直接答案結構</li><li>可延伸內容架構</li><li>GEO 結構規劃</li><li>{{ selectedModules.length }} 個選用模組</li></ul></div><div class="step-footer preview-footer"><button type="button" class="builder-secondary" @click="setStep('style_and_modules')">這個方向不對</button><button type="button" class="builder-primary" @click="setStep('plan_and_cadence')">我喜歡這個方向 <span>→</span></button></div></section>

        <section v-else-if="currentStep === 'plan_and_cadence'" class="builder-step" aria-labelledby="plan-title"><div class="step-heading"><p class="builder-eyebrow">PLAN / CADENCE</p><h2 id="plan-title" tabindex="-1">你希望網站完成後，誰持續照顧它？</h2><p>價格是示意／預估，正式確認前不會扣款。每個方案寫的是你會得到什麼，而不是保證結果。</p></div><div class="plan-grid"><button v-for="item in plans" :key="item.id" type="button" class="plan-choice" :class="{ selected: plan === item.id }" :aria-pressed="plan === item.id" @click="plan = item.id"><span class="plan-accent">{{ item.accent }}</span><strong>{{ item.label }}</strong><p>{{ item.description }}</p><small>{{ item.outcome }}</small><b>{{ item.price ? `NT$ ${formatMoney(item.price)}／月起` : '一次完成基礎' }}</b></button></div><div v-if="plan && plan !== 'launch'" class="cadence-panel"><div><span>CONTENT CADENCE</span><strong>內容更新頻率</strong><p>頻率越高代表預留更多內容營運節奏，不代表保證排名或流量。</p></div><div class="cadence-options" role="group" aria-label="文章頻率"><button v-for="days in cadences" :key="days" type="button" :class="{ active: cadence === days }" @click="cadence = days">每 {{ days }} 天</button></div></div><div class="price-disclosure"><span>價格說明</span><p>一次性網站建置費與每月 GEO 訂閱費分開計算；網域、API 與第三方服務費用尚未正式查詢，正式付款前會重新確認。</p></div><div class="step-footer"><p>不保證排名、流量、ROI 或被任何 AI 引用。</p><button class="builder-primary" type="button" :disabled="!plan" @click="submitPlan">規劃網域與上線 <span>→</span></button></div></section>

        <section v-else-if="currentStep === 'domain_and_launch'" class="builder-step" aria-labelledby="domain-title"><div class="step-heading"><p class="builder-eyebrow">DOMAIN / LAUNCH PLAN</p><h2 id="domain-title" tabindex="-1">網站要住在哪裡？</h2><p>現在只做規劃與模擬，不會查詢可用性、不會購買、不會要求帳號密碼。</p></div><div class="domain-choice-grid"><button type="button" class="domain-choice" :class="{ selected: domainMode === 'new' }" @click="chooseDomainMode('new')"><span>01</span><strong>我想購買新網域</strong><p>輸入想要的名稱，按下模擬查詢。正式付款前會重新確認價格與可用性。</p></button><button type="button" class="domain-choice" :class="{ selected: domainMode === 'existing' }" @click="chooseDomainMode('existing')"><span>02</span><strong>我已經有網域</strong><p>付款後會透過 DNS 或授權驗證所有權，現在不需要交出帳號或 API key。</p></button></div><div v-if="domainMode" class="domain-form"><label for="builder-domain">{{ domainMode === 'new' ? '想規劃的網域' : '現有網域' }}</label><div class="field-with-action"><input id="builder-domain" v-model="domainInput" maxlength="120" placeholder="your-brand.tw" :aria-invalid="Boolean(domainError)" @input="domainError = ''; domainSimulation = 'idle'"><button type="button" class="builder-secondary" @click="simulateDomain">模擬查詢</button></div><small>示意：{{ currentDomain }} 將登記給客戶，DiscoveryStack 負責技術代管與營運。</small><p v-if="domainError" class="field-error" role="alert">{{ domainError }}</p><p v-else-if="domainSimulation === 'checked'" class="simulation-status" role="status"><span>◌</span> 目前只完成模擬，尚未確認可購買。</p></div><div class="launch-timeline"><div v-for="(item, index) in timeline" :key="item.label" class="timeline-item"><span>{{ String(index + 1).padStart(2, '0') }}</span><i></i><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></div></div><div class="step-footer"><p>所有節點目前都是「付款後執行」。</p><button class="builder-primary" type="button" :disabled="!canProceedFromDomain" @click="submitDomain">查看完整摘要 <span>→</span></button></div></section>

        <section v-else-if="currentStep === 'review_order'" class="builder-step review-step" aria-labelledby="review-title"><div class="step-heading"><p class="builder-eyebrow">REVIEW BEFORE HANDOFF</p><h2 id="review-title" tabindex="-1">這是你要保存的方向嗎？</h2><p>最後看一次規格、預估費用與尚未執行的外部操作。這不是正式訂單。</p></div><div class="review-layout"><div class="review-list"><article><span>品牌</span><strong>{{ brandName || '尚未命名' }}</strong><button type="button" @click="setStep('diagnosis_or_brief')">修改</button></article><article><span>網站架構</span><strong>{{ currentSiteType.label }} · {{ currentSiteType.pages.join('／') }}</strong><button type="button" @click="setStep('site_architecture')">修改</button></article><article><span>風格與功能</span><strong>{{ currentTheme.label }} · {{ selectedModuleLabels.join('、') || '尚未選擇模組' }}</strong><button type="button" @click="setStep('style_and_modules')">修改</button></article><article><span>動畫節奏</span><strong>{{ currentMotion.label }}</strong><button type="button" @click="setStep('style_and_modules')">修改</button></article><article v-if="styleDescription.trim()"><span>風格描述</span><strong class="review-style-description">{{ styleDescription }}</strong><button type="button" @click="setStep('style_and_modules')">修改</button></article><article><span>GEO 方案</span><strong>{{ currentPlan.label }}{{ plan !== 'launch' ? ` · 每 ${cadence} 天` : '' }}</strong><button type="button" @click="setStep('plan_and_cadence')">修改</button></article><article><span>網域方向</span><strong>{{ domainMode === 'new' ? '新網域規劃' : '使用現有網域' }} · {{ currentDomain }}</strong><button type="button" @click="setStep('domain_and_launch')">修改</button></article></div><aside class="review-price"><p>ESTIMATED PROJECT SUMMARY</p><h3>{{ brandName || '你的品牌' }}</h3><div><span>一次性網站建置預估</span><strong>NT$ {{ formatMoney(oneTimeEstimate) }}</strong></div><div v-if="monthlyEstimate"><span>每月 GEO 訂閱預估</span><strong>NT$ {{ formatMoney(monthlyEstimate) }}</strong></div><small>網域與人工串接另行報價；規劃中功能只記錄需求。以上均為示意或預估。</small><label><input v-model="reviewConfirmed" type="checkbox"> 我理解這是互動式預覽，不是已付款、已購買網域或已部署的正式成品。</label></aside></div><div class="ownership-note"><span>CLIENT OWNED DOMAIN</span><p>網域原則上歸客戶所有；DiscoveryStack 代管程式碼、部署與長期維護。V1 不提供完整原始碼下載。</p></div><div class="step-footer"><p>不會建立真實訂單，也不會呼叫付款、網域或部署服務。</p><button ref="reviewHandoffTrigger" class="builder-primary" type="button" :disabled="!reviewConfirmed" @click="submitReview">保存這份預覽，聯絡我們確認 <span>→</span></button></div></section>

        <section v-else class="builder-step handoff-step" aria-labelledby="handoff-step-title"><div class="handoff-success-mark" aria-hidden="true">✓</div><div class="step-heading"><p class="builder-eyebrow">PREVIEW HANDOFF</p><h2 id="handoff-step-title" tabindex="-1">網站方向已送出。</h2><p>我們已收到你送出當時的聯絡資料與預覽選擇，接下來可進入正式自助建站流程，建立工作階段並確認規格、費用與上線安排。</p></div><div class="handoff-next-grid"><article v-for="(item, index) in ['確認規格與付款', '重新確認網域與服務費', '完成授權後設定 DNS／SSL', '部署上線，依方案安排後續營運']" :key="item"><span>0{{ index + 1 }}</span><strong>{{ item }}</strong></article></div><div class="handoff-honesty"><span>REQUEST RECEIVED / NOT AN ORDER</span><p>已送出合作需求；目前尚未付款、購買網域或部署網站。正式自助流程會另行建立工作階段，此處的預覽不會自動成為訂單。</p></div><div class="step-footer"><button type="button" class="builder-secondary" @click="setStep('review_order')">返回摘要</button><a ref="handoffStepTrigger" class="builder-primary" data-managed-site-start :href="customerStartUrl">前往正式自助建站 <span>↗</span></a></div></section>
        </Transition>
        </div>
      </section>
      <aside v-if="showDirection" class="builder-direction" aria-label="即時品牌方向預覽">
        <div class="direction-label"><span>YOUR DIRECTION</span><span>↗</span></div>
        <div class="direction-browser" :style="themeStyle">
          <div class="direction-browser-bar"><i></i><i></i><i></i><span>{{ currentDomain }}</span></div>
          <div class="direction-site" :data-motion="motionPreference" :data-styles="selectedStyles.join(' ')" @pointermove="movePreview" @pointerleave="resetPreviewMotion">
            <div class="direction-site-nav"><strong>{{ brandName || 'YOUR BRAND' }}</strong><span>MENU +</span></div>
            <div class="direction-sculpture" aria-hidden="true"><span></span><span></span><span></span><i></i><i></i><i></i></div>
            <div class="direction-site-copy"><span>{{ siteType ? currentSiteType.eyebrow : 'A NEW PERSPECTIVE' }}</span><strong>{{ brandName || '留下，' }}<br><em>{{ brandName ? '你的第一印象。' : '更好的第一印象。' }}</em></strong><p>{{ businessBrief || '讓好的品牌，被好好看見。' }}</p><span class="direction-site-link">{{ desiredAction || 'DISCOVER MORE' }} <b>↗</b></span></div>
            <div class="direction-site-bottom"><span>EST. 2026</span><span>{{ currentTheme.descriptor }}</span></div>
          </div>
          <div class="direction-site-strip"><span>01 — {{ currentSiteType.label }}</span><span>{{ selectedModules.length }} 個功能模組</span></div>
        </div>
        <div class="direction-specs">
          <div><span>視覺氛圍</span><strong>{{ theme ? currentTheme.label : '等待你的選擇' }}</strong><span class="direction-colors"><i v-for="color in currentTheme.colors" :key="color" :style="{ background: color }"></i></span></div>
          <div><span>動畫節奏</span><strong class="motion-option-label">{{ currentMotion.label }}</strong></div>
          <div><span>排版偏好</span><strong>{{ selectedStyleLabels.join(' · ') || '自由探索' }}</strong></div>
          <div><span>網站結構</span><strong>{{ siteType ? currentSiteType.label : '從你的目標開始' }}</strong></div>
        </div>
        <p class="direction-caption">視覺方向示意，正式內容與功能由雙方確認。</p>
      </aside>
    </section>

    <BuilderServiceOverview />

    <div v-if="showHandoff" class="handoff-layer" role="presentation" @click.self="closeHandoff"><section ref="handoffDialog" class="handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title" tabindex="-1" @keydown.esc="closeHandoff" @keydown="trapHandoff"><button ref="handoffCloseButton" class="dialog-close" type="button" aria-label="關閉交接說明" @click="closeHandoff">×</button><p class="builder-eyebrow">PREVIEW HANDOFF</p><h2 id="handoff-dialog-title">讓這個方向成真。</h2><div class="handoff-dialog-path"><span>送出網站方向</span><i>→</i><span>確認規格</span><i>→</i><span>付款與授權</span><i>→</i><span>部署上線</span></div><p>留下聯絡方式，我們會連同你選好的頁面、風格與方案一起收到。送出需求不會建立訂單或扣款。</p><div v-if="handoffSaved" class="handoff-saved" role="status">網站方向與聯絡資料已送出。正式建站仍待規格、費用與授權確認。</div><form v-else class="handoff-contact" @submit.prevent="confirmHandoff"><div class="handoff-contact-grid"><label>姓名<input v-model="handoffContact.name" name="name" autocomplete="name" minlength="2" maxlength="120" required></label><label>工作 Email<input v-model="handoffContact.email" name="email" type="email" autocomplete="email" maxlength="320" required></label></div><div class="handoff-contact-grid"><label>公司／品牌<input v-model="handoffContact.company" name="company" autocomplete="organization" minlength="2" maxlength="160" required></label><label>現有網站（選填）<input v-model="handoffContact.website" name="website" type="url" inputmode="url" maxlength="2048" placeholder="https://"></label></div><label class="handoff-consent"><input v-model="handoffContact.privacyConsent" type="checkbox" required><span>我同意 DiscoveryStack 為回覆本次建站需求而處理這些資料。<a href="/zh-hant/privacy" target="_blank" rel="noopener noreferrer">閱讀隱私政策</a></span></label><label class="handoff-consent"><input v-model="handoffContact.recontactConsent" type="checkbox"><span>可在本次諮詢以外，寄送後續相關資訊給我（選填）。</span></label><div class="handoff-honeypot" aria-hidden="true"><label>公司傳真<input v-model="handoffContact.companyFax" tabindex="-1" autocomplete="off"></label></div><p v-if="handoffError" class="field-error" role="alert">{{ handoffError }}</p><div class="handoff-dialog-actions"><button type="button" class="builder-secondary" @click="closeHandoff">返回繼續調整</button><button type="submit" class="builder-primary" :disabled="handoffSubmitting">{{ handoffSubmitting ? '正在送出…' : '送出我的網站方向' }} <span>→</span></button></div></form><div v-if="handoffSaved" class="handoff-dialog-actions"><button type="button" class="builder-primary" @click="closeHandoff">完成 <span>→</span></button></div></section></div>
  </main>
</template>
