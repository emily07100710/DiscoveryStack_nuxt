<script setup lang="ts">
type FunnelRequestFetch = <T = unknown>(path: string, options?: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; credentials?: 'omit'; headers?: Record<string, string> }) => Promise<T>
// Preserve the original Nuxt fetch and local response DTOs.
const fetchFunnel = $fetch as unknown as FunnelRequestFetch
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import {
  CONVERSION_GOAL_OPTIONS,
  FEELING_OPTIONS,
  FUNNEL_STEPS,
  MODULE_HELP,
  PLAN_HELP,
  SITE_TYPE_HELP,
  STYLE_PRESETS,
  canAdvance,
  consentGateState,
  firstIncompleteStep,
  formatTwd,
  isScrolledToBottom,
  missingRequiredModulesForSiteType,
  normalizedModulesForSiteType,
  requiredModulesForSiteType,
  stepCompletion,
  type FunnelAnswersView,
} from '../../../utils/managedSiteFunnel'

useHead({
  title: '建立你的品牌網站｜DiscoveryStack',
  htmlAttrs: { lang: 'zh-Hant' },
  meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }],
})

type PriceCatalog = {
  version: string
  currency: 'TWD'
  siteTypes: { key: 'one_page' | 'brand_blog' | 'simple_commerce'; buildMinor: number; labelZh: string; descriptionZh: string }[]
  designTiers: { key: 'template' | 'designer'; oneTimeMinor: number; labelZh: string; descriptionZh: string }[]
  modules: { key: string; buildMinor: number; monthlyMinor: number; activation: 'automatic' | 'manual_service'; readiness: 'available' | 'manual_setup' | 'coming_soon'; labelZh: string; descriptionZh: string }[]
  plans: { key: 'site_only' | 'site_geo' | 'site_geo_autopost'; monthlyMinor: number | null; labelZh: string; descriptionZh: string }[]
  cadence: { days: 3 | 7 | 15 | 30; monthlyMinor: number }[]
  domainOptions: 'new'[]
  domainTlds: { tld: string; annualMinor: number }[]
  assistedDomainSetupMinor: number
}

type DomainAvailability = { available: true; canonicalDomain: string; quoteFingerprint: string; expiresAt: string; customerPrice: { amountMinor: number; currency: 'TWD' } }
type DomainRegistrant = { firstName: string; lastName: string; organization: string; address1: string; city: string; state: string; postalCode: string; country: string; phoneCountryCode: string; phone: string; email: string }

type SessionProjection = {
  status: string
  currentStep: number
  answers: FunnelAnswersView
  consentSnapshot: null | { policyVersion: string; acceptedAt: string; scrolledToBottom: true }
  domainAvailability: DomainAvailability | null
  domainRegistration: null | { delegated: true; canonicalDomain: string; registrant: DomainRegistrant; termsVersion: string }
  domainDelegationTerms: string
  domainDelegationVersion: string
  consentVersion: string
  previewUrl: string | null
  checkoutUrl: string | null
  expiresAt: string
  totalSteps: number
  contactInbox: ContactInboxProjection
  testMode?: boolean
}

type ContactInboxProjection = {
  status: 'unbound' | 'pending' | 'bound' | 'locked'
  maskedEmail: string | null
  resendAvailableAt: string | null
  transportConfigured: boolean
}

type ScoreSet = { overall: number; seo: number; geo: number; brandContent: number; ux: number }
type PreviewDraft = {
  source: 'llm' | 'template'
  sourceReason: string
  generatedAt: string
  headline: string
  sections: { heading: string; body: string }[]
  html: string
  scores: ScoreSet
  comparison: null | { before: { url: string; analysedAt: string; scores: ScoreSet }; after: { scores: ScoreSet }; deltas: ScoreSet }
}
type FunnelQuote = {
  lines: { lineKey: string; description: string; quantity: number; unitAmountMinor: number; lineAmountMinor: number; billing: 'one_time' | 'monthly' | 'annual' }[]
  totals: { oneTimeMinor: number; firstMonthMinor: number; domainFirstYearMinor: number; dueTodayMinor: number; recurringMonthlyMinor: number; domainRenewalAnnualMinor: number }
  currency: 'TWD'
  manualServiceModules: string[]
  manualSetupModules: string[]
  comingSoonModules: string[]
}
type ModuleFulfilment = { draftOrderId: number; moduleKey: string; mode: 'automatic' | 'manual_service'; status: 'automatic' | 'pending_manual_setup' | 'manual_setup_completed' | 'recorded_intent_unbilled' | 'cancelled'; billedMinor: number; customerVisibleStatus: string; ownerActionRequired: boolean }
type FunnelStatus = { order: null | { status: string }; fulfilments: ModuleFulfilment[] }

type WizardAnswers = FunnelAnswersView & {
  company: NonNullable<FunnelAnswersView['company']>
  contact: NonNullable<FunnelAnswersView['contact']>
  style: NonNullable<FunnelAnswersView['style']>
}

const STORAGE_KEY = 'discoverystack.managed-site-funnel'
const runtimeConfig = useRuntimeConfig()

function publicFitReviewUrl(rawOrigin: unknown): string {
  try {
    const url = new URL('/zh-hant', String(rawOrigin || '').trim())
    const isLocalDevelopment = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    const isPlaceholder = url.hostname === 'example.com' || url.hostname.endsWith('.example.com') || url.hostname.endsWith('.test')
    if ((!isLocalDevelopment && url.protocol !== 'https:') || url.username || url.password || isPlaceholder) return ''
    url.hash = 'fit'
    return url.toString()
  } catch {
    return ''
  }
}

const manualEnquiryUrl = publicFitReviewUrl(runtimeConfig.public.discoveryStackPublicSiteOrigin)
const loading = ref(true)
const bootstrapError = ref('')
const catalog = ref<PriceCatalog | null>(null)
const sessionId = ref<number | null>(null)
const sessionToken = ref('')
const sessionProjection = ref<SessionProjection | null>(null)
const currentStep = ref(1)
const saveStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const saveMessage = ref('')
const draft = ref<PreviewDraft | null>(null)
const draftStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const draftError = ref('')
const quote = ref<FunnelQuote | null>(null)
const quoteStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const quoteError = ref('')
const buildStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const buildError = ref('')
const checkoutStatus = ref<'idle' | 'loading' | 'error'>('idle')
const checkoutError = ref('')
const builtPreviewUrl = ref('')
const moduleFulfilments = ref<ModuleFulfilment[]>([])
const paymentVerified = ref(false)
const consentScrolledToBottom = ref(false)
const consentChecked = ref(false)
const consentAccepted = ref(false)
const agreementPane = ref<HTMLElement | null>(null)
const stepHeading = ref<HTMLElement | null>(null)
const domainAvailabilityMessage = ref('')
const domainAvailability = ref<DomainAvailability | null>(null)
const domainChecking = ref(false)
const domainDelegated = ref(false)
const domainRegistrant = ref<DomainRegistrant>({ firstName: '', lastName: '', organization: '', address1: '', city: '', state: '', postalCode: '', country: 'TW', phoneCountryCode: '886', phone: '', email: '' })
const contactInbox = ref<ContactInboxProjection>({ status: 'unbound', maskedEmail: null, resendAvailableAt: null, transportConfigured: false })
const inboxEmail = ref('')
const inboxVerificationCode = ref('')
const inboxBindingStatus = ref<'idle' | 'sending' | 'confirming'>('idle')
const inboxBindingError = ref('')
const inboxAwaitingConfirmation = ref(false)
const inboxRebinding = ref(false)
const countdownNow = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | null = null

function initialAnswers(): WizardAnswers {
  return {
    company: { brandName: '', whatWeDo: '', feelings: [], mainOffer: '', conversionGoals: [] },
    contact: { contactName: '', email: '', phone: '' },
    style: { referenceUrls: [], designTier: 'template' },
  }
}

const answers = ref<WizardAnswers>(initialAnswers())
const progressWidths = ['11.111%', '22.222%', '33.333%', '44.444%', '55.556%', '66.667%', '77.778%', '88.889%', '100%']
const currentStepMeta = computed(() => FUNNEL_STEPS[currentStep.value - 1]!)
const consentGate = computed(() => consentGateState({ scrolledToBottom: consentScrolledToBottom.value, checked: consentChecked.value }))
const firstIncomplete = computed(() => firstIncompleteStep(answers.value, { accepted: consentAccepted.value }))
const domainRegistrantValid = computed(() => ['firstName', 'address1', 'city', 'postalCode', 'country', 'phoneCountryCode', 'phone', 'email'].every(key => domainRegistrant.value[key as keyof DomainRegistrant].trim()) && /^[A-Z]{2}$/.test(domainRegistrant.value.country) && /^\d{1,4}$/.test(domainRegistrant.value.phoneCountryCode) && /^\d{4,15}$/.test(domainRegistrant.value.phone) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(domainRegistrant.value.email))
const domainAvailabilityCurrent = computed(() => Boolean(domainAvailability.value?.canonicalDomain === `${domainName.value}.${domainTld.value}` && Date.parse(domainAvailability.value.expiresAt) > countdownNow.value))
const domainReady = computed(() => answers.value.domain?.option !== 'new' || Boolean(domainAvailabilityCurrent.value && domainDelegated.value && domainRegistrantValid.value))
const currentMissing = computed(() => {
  const missing = [...stepCompletion(currentStep.value, answers.value, { accepted: currentStep.value === 7 ? consentGate.value.canSubmit : consentAccepted.value }).missing]
  if (currentStep.value === 7 && answers.value.domain?.option === 'new') {
    if (!domainAvailabilityCurrent.value) missing.push('確認可註冊的網域')
    if (!domainRegistrantValid.value) missing.push('完整的網域持有人資料')
    if (!domainDelegated.value) missing.push('網域代註冊授權')
  }
  return [...new Set(missing)]
})
const COMPANY_COMPLETION_ITEMS = [
  { missingLabel: '品牌名稱', label: '品牌名稱' },
  { missingLabel: '你在做什麼', label: '公司介紹' },
  { missingLabel: '主要賣什麼', label: '商品或服務' },
  { missingLabel: '希望怎麼成交', label: '成交目標' },
  { missingLabel: '聯絡人姓名', label: '聯絡人' },
  { missingLabel: '聯絡 Email', label: '有效 Email' },
] as const
const companyMissing = computed(() => stepCompletion(2, answers.value, { accepted: consentAccepted.value }).missing)
const companyCompleteCount = computed(() => COMPANY_COMPLETION_ITEMS.filter(item => !companyMissing.value.includes(item.missingLabel)).length)
const nextDisabled = computed(() => saveStatus.value === 'saving' || (currentStep.value === 7 && (!domainReady.value || domainChecking.value)) || !canAdvance(currentStep.value, answers.value, { accepted: currentStep.value === 7 ? consentGate.value.canSubmit : consentAccepted.value }))
const navigationBusy = computed(() => saveStatus.value === 'saving' || buildStatus.value === 'loading' || checkoutStatus.value === 'loading')
const designerTier = computed(() => catalog.value?.designTiers.find(item => item.key === 'designer'))
const hasManualSetupModules = computed(() => Boolean(quote.value?.manualSetupModules.length))
const contactModuleSelected = computed(() => (answers.value.modules || []).includes('contact_lead_capture'))
const selfServeDomainSupported = computed(() => answers.value.domain?.option === 'new')
const resendSeconds = computed(() => contactInbox.value.resendAvailableAt ? Math.max(0, Math.ceil((Date.parse(contactInbox.value.resendAvailableAt) - countdownNow.value) * 0.001)) : 0)
const inboxBusy = computed(() => inboxBindingStatus.value !== 'idle')
const domainOptionCopy: Record<'new', { label: string; help: string }> = {
  new: { label: '幫我註冊新網域', help: '先選想要的名稱與結尾，結帳後由我們代為註冊，並自動連接到建好的網站。' },
}

function requestFailureMessage(error: any, fallback: string): string {
  return error?.data?.statusMessage || error?.data?.message || error?.statusMessage || error?.message || fallback
}

function isExpiredSession(error: any): boolean {
  return [404, 410].includes(Number(error?.statusCode || error?.status || error?.response?.status))
}

function clearStoredSession() {
  localStorage.removeItem(STORAGE_KEY)
  sessionId.value = null
  sessionToken.value = ''
}

function funnelSessionPath(suffix = ''): string {
  return `/api/managed-sites/funnel/sessions/${sessionId.value}${suffix}`
}

function funnelHeaders(): Record<string, string> {
  return { 'x-managed-site-funnel-token': sessionToken.value }
}

async function getSessionProjection(): Promise<SessionProjection> {
  return await fetchFunnel<SessionProjection>(funnelSessionPath(), { method: 'GET', credentials: 'omit', headers: funnelHeaders() })
}

async function loadFunnelStatus(): Promise<void> {
  const projection = await funnelFetch<FunnelStatus>('/status', { method: 'GET' })
  paymentVerified.value = projection.order?.status === 'payment_verified'
  moduleFulfilments.value = projection.order?.status === 'payment_verified' ? projection.fulfilments : []
}

function restoreProjection(projection: SessionProjection) {
  const defaults = initialAnswers()
  answers.value = {
    ...defaults,
    ...projection.answers,
    company: { ...defaults.company, ...(projection.answers.company || {}) },
    contact: { ...defaults.contact, ...(projection.answers.contact || {}) },
    style: { ...defaults.style, ...(projection.answers.style || {}) },
  }
  answers.value.modules = normalizedModulesForSiteType(answers.value.siteType, answers.value.modules)
  sessionProjection.value = projection
  domainAvailability.value = projection.domainAvailability
  domainDelegated.value = Boolean(projection.domainRegistration?.delegated)
  if (projection.domainRegistration) domainRegistrant.value = { ...projection.domainRegistration.registrant }
  else { domainRegistrant.value.firstName = answers.value.contact.contactName; domainRegistrant.value.email = answers.value.contact.email }
  contactInbox.value = projection.contactInbox
  inboxAwaitingConfirmation.value = projection.contactInbox.status === 'pending'
  inboxRebinding.value = false
  consentAccepted.value = Boolean(projection.consentSnapshot?.scrolledToBottom)
  consentScrolledToBottom.value = consentAccepted.value
  consentChecked.value = consentAccepted.value
  builtPreviewUrl.value = projection.previewUrl || ''
  currentStep.value = Math.min(Math.max(projection.currentStep || 1, 1), firstIncompleteStep(answers.value, { accepted: consentAccepted.value }))
  if (projection.status === 'active' && currentStep.value > 7 && !domainReady.value) currentStep.value = 7
  prepareStep(currentStep.value)
}

async function createFreshSession() {
  const created = await fetchFunnel<{ sessionId: number; sessionToken: string }>('/api/managed-sites/funnel/sessions', { method: 'POST', body: {}, credentials: 'omit' })
  sessionId.value = created.sessionId
  sessionToken.value = created.sessionToken
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: created.sessionId, sessionToken: created.sessionToken }))
  answers.value = initialAnswers()
  consentScrolledToBottom.value = false
  consentChecked.value = false
  consentAccepted.value = false
  draft.value = null
  quote.value = null
  builtPreviewUrl.value = ''
  moduleFulfilments.value = []
  paymentVerified.value = false
  contactInbox.value = { status: 'unbound', maskedEmail: null, resendAvailableAt: null, transportConfigured: false }
  inboxEmail.value = ''
  inboxVerificationCode.value = ''
  inboxBindingError.value = ''
  inboxAwaitingConfirmation.value = false
  inboxRebinding.value = false
  const projection = await getSessionProjection()
  restoreProjection(projection)
}

async function funnelFetch<T>(suffix: string, options: any): Promise<T> {
  try {
    return await fetchFunnel<T>(funnelSessionPath(suffix), { ...options, credentials: 'omit', headers: { ...(options?.headers || {}), ...funnelHeaders() } })
  } catch (error) {
    if (isExpiredSession(error)) {
      clearStoredSession()
      await createFreshSession()
      throw new Error('原工作階段已失效，已為你重新開始，請重新填寫。')
    }
    throw error
  }
}

async function bootstrap() {
  loading.value = true
  bootstrapError.value = ''
  try {
    catalog.value = await fetchFunnel<PriceCatalog>('/api/managed-sites/price-catalog', { credentials: 'omit' })
    let stored: { sessionId: number; sessionToken: string } | null = null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      if (Number.isSafeInteger(parsed?.sessionId) && parsed.sessionId > 0 && typeof parsed.sessionToken === 'string') stored = parsed
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
    if (stored) {
      sessionId.value = stored.sessionId
      sessionToken.value = stored.sessionToken
      try {
        restoreProjection(await getSessionProjection())
      } catch (error) {
        if (isExpiredSession(error)) {
          clearStoredSession()
          await createFreshSession()
        } else {
          bootstrapError.value = '暫時讀不到你的進度，請稍後再試'
        }
      }
    } else {
      await createFreshSession()
    }
    if (currentStep.value === 9) {
      await loadQuote()
      await loadFunnelStatus()
    }
  } catch (error) {
    bootstrapError.value = requestFailureMessage(error, '目前無法建立訂購工作階段，請稍後再試。')
  } finally {
    loading.value = false
  }
}

async function restart() {
  if (!window.confirm('要清除目前進度並重新開始嗎？')) return
  loading.value = true
  bootstrapError.value = ''
  try {
    clearStoredSession()
    await createFreshSession()
  } catch (error) {
    bootstrapError.value = requestFailureMessage(error, '目前無法重新開始，請稍後再試。')
  } finally {
    loading.value = false
  }
}

function prepareStep(step: number) {
  if (step === 5) answers.value.modules = normalizedModulesForSiteType(answers.value.siteType, answers.value.modules)
  if (step === 7) setTimeout(updateShortAgreementState, 0)
}

function isStepClickable(step: number): boolean {
  if (navigationBusy.value) return false
  return step < firstIncomplete.value || step === currentStep.value
}

function presentCurrentStep() {
  setTimeout(() => {
    if (typeof window === 'undefined' || !stepHeading.value) return
    stepHeading.value.focus({ preventScroll: true })
    stepHeading.value.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, 0)
}

function goToStep(step: number) {
  if (!isStepClickable(step)) return
  currentStep.value = step
  saveStatus.value = 'idle'
  saveMessage.value = ''
  prepareStep(step)
  presentCurrentStep()
}

function goPrevious() {
  if (currentStep.value > 1) goToStep(currentStep.value - 1)
}

function currentStepAnswers(): Partial<FunnelAnswersView> {
  if (currentStep.value === 1) {
    const existingSite = answers.value.existingSite
    return { existingSite: existingSite ? { hasSite: existingSite.hasSite, ...(existingSite.url ? { url: existingSite.url } : {}), ...(existingSite.diagnosisId !== undefined ? { diagnosisId: existingSite.diagnosisId } : {}) } : undefined }
  }
  if (currentStep.value === 2) return { company: answers.value.company, contact: { ...answers.value.contact, ...(answers.value.contact.phone?.trim() ? {} : { phone: undefined }) } }
  if (currentStep.value === 3) return { style: { ...answers.value.style, referenceUrls: answers.value.style.referenceUrls.map(url => url.trim()).filter(Boolean) } }
  if (currentStep.value === 4) return { siteType: answers.value.siteType }
  if (currentStep.value === 5) return { modules: normalizedModulesForSiteType(answers.value.siteType, answers.value.modules) }
  if (currentStep.value === 6) return answers.value.previewDraft ? { previewDraft: answers.value.previewDraft } : {}
  if (currentStep.value === 7) return { domain: answers.value.domain }
  if (currentStep.value === 8) return { plan: answers.value.plan }
  return {}
}

async function saveCurrentAndAdvance() {
  if (nextDisabled.value || currentStep.value >= 9) return
  saveStatus.value = 'saving'
  saveMessage.value = '正在儲存進度…'
  const savingStep = currentStep.value
  try {
    let projection = await funnelFetch<SessionProjection>('', { method: 'PATCH', body: { step: savingStep, answers: currentStepAnswers() } })
    if (savingStep === 7) {
      if (!projection.consentVersion) throw new Error('伺服器未提供目前的授權版本，暫時無法送出同意。')
      projection = await funnelFetch<SessionProjection>('/consent', { method: 'POST', body: { policyVersion: projection.consentVersion, scrolledToBottom: true } })
      if (answers.value.domain?.option === 'new') {
        if (!domainReady.value || !domainAvailability.value) throw new Error('請重新查詢網域並確認代註冊授權。')
        projection = await funnelFetch<SessionProjection>('/domain-delegation', { method: 'POST', body: { delegated: true, registrant: domainRegistrant.value, quoteFingerprint: domainAvailability.value.quoteFingerprint, termsVersion: projection.domainDelegationVersion } })
      }
      consentAccepted.value = true
    }
    sessionProjection.value = projection
    saveStatus.value = 'success'
    saveMessage.value = '進度已儲存'
    currentStep.value = Math.min(savingStep + 1, 9)
    prepareStep(currentStep.value)
    presentCurrentStep()
    if (currentStep.value === 9) await loadQuote()
  } catch (error) {
    saveStatus.value = 'error'
    saveMessage.value = requestFailureMessage(error, '進度儲存失敗，尚未前往下一步。')
  }
}

const existingSiteUrl = computed({
  get: () => answers.value.existingSite?.url || '',
  set: (url: string) => {
    answers.value.existingSite = { hasSite: true, url }
  },
})

function selectHasSite(hasSite: boolean) {
  if (answers.value.existingSite?.hasSite === hasSite) return
  answers.value.existingSite = hasSite ? { hasSite: true, url: '' } : { hasSite: false }
}

function validHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function toggleList(list: string[], key: string) {
  const index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else list.push(key)
}

function addReference() {
  if (answers.value.style.referenceUrls.length < 3) answers.value.style.referenceUrls.push('')
}

function removeReference(index: number) {
  answers.value.style.referenceUrls.splice(index, 1)
}

function referenceError(url: string, index: number): string {
  if (url.trim() && !validHttpsUrl(url.trim())) return '請輸入完整的 https 網址。'
  if (url.trim()) {
    const normalized = new URL(url.trim()).toString()
    const duplicate = answers.value.style.referenceUrls.some((candidate, candidateIndex) => candidateIndex !== index && validHttpsUrl(candidate.trim()) && new URL(candidate.trim()).toString() === normalized)
    if (duplicate) return '這個參考網址已經填過了。'
  }
  return ''
}

function selectSiteType(key: 'one_page' | 'brand_blog' | 'simple_commerce') {
  answers.value.siteType = key
  answers.value.modules = normalizedModulesForSiteType(key, answers.value.modules)
}

function toggleModule(key: string) {
  if (answers.value.siteType === 'simple_commerce' && key === 'shopify_commerce') return
  const selected = answers.value.modules || []
  toggleList(selected, key)
  answers.value.modules = selected
}

function moduleCopy(item: PriceCatalog['modules'][number]) {
  if (item.key === 'contact_lead_capture') return { label: '聯絡表單／名單收集', plain: '訪客送出的資料一定會保存並可查看；只有完成收信信箱綁定後，才會另外寄到該信箱。' }
  return MODULE_HELP[item.key] || { label: item.labelZh, plain: item.descriptionZh }
}

function restartInboxBinding() {
  inboxRebinding.value = true
  inboxAwaitingConfirmation.value = false
  inboxEmail.value = ''
  inboxVerificationCode.value = ''
  inboxBindingError.value = ''
}

async function sendInboxVerificationCode() {
  if (inboxBusy.value || !contactInbox.value.transportConfigured || resendSeconds.value > 0 || !inboxEmail.value.trim()) return
  inboxBindingStatus.value = 'sending'
  inboxBindingError.value = ''
  try {
    const result = await funnelFetch<{ status: 'pending'; maskedEmail: string; expiresAt: string; resendAvailableAt: string }>('/inbox-binding', { method: 'POST', body: { email: inboxEmail.value.trim() } })
    const priorBound = contactInbox.value.status === 'bound' ? contactInbox.value : null
    contactInbox.value = priorBound
      ? { ...priorBound, resendAvailableAt: result.resendAvailableAt }
      : { status: 'pending', maskedEmail: result.maskedEmail, resendAvailableAt: result.resendAvailableAt, transportConfigured: true }
    inboxAwaitingConfirmation.value = true
    inboxVerificationCode.value = ''
  } catch (error) {
    inboxBindingError.value = requestFailureMessage(error, '驗證碼寄送失敗，尚未綁定收信信箱。')
  } finally {
    inboxBindingStatus.value = 'idle'
  }
}

async function confirmInboxBinding() {
  if (inboxBusy.value || !/^\d{6}$/u.test(inboxVerificationCode.value)) return
  inboxBindingStatus.value = 'confirming'
  inboxBindingError.value = ''
  try {
    const result = await funnelFetch<{ status: 'bound'; maskedEmail: string }>('/inbox-binding-confirm', { method: 'POST', body: { code: inboxVerificationCode.value } })
    contactInbox.value = { status: 'bound', maskedEmail: result.maskedEmail, resendAvailableAt: null, transportConfigured: true }
    inboxVerificationCode.value = ''
    inboxAwaitingConfirmation.value = false
    inboxRebinding.value = false
  } catch (error) {
    inboxBindingError.value = requestFailureMessage(error, '驗證碼確認失敗，收信信箱尚未綁定。')
    if (inboxBindingError.value.includes('驗證次數過多')) {
      contactInbox.value = { ...contactInbox.value, status: 'locked' }
      inboxAwaitingConfirmation.value = false
    }
  } finally {
    inboxBindingStatus.value = 'idle'
  }
}

async function generatePreview() {
  draftStatus.value = 'loading'
  draftError.value = ''
  try {
    const result = await funnelFetch<PreviewDraft>('/preview-draft', { method: 'POST', body: {} })
    draft.value = result
    answers.value.previewDraft = { generatedAt: result.generatedAt, source: result.source, headline: result.headline, sections: result.sections }
    draftStatus.value = 'success'
  } catch (error) {
    draftStatus.value = 'error'
    draftError.value = requestFailureMessage(error, '目前無法產生示意預覽，你仍可繼續下一步。')
  }
}

function handleAgreementScroll(event: Event) {
  const target = event.target as HTMLElement
  if (isScrolledToBottom(target)) consentScrolledToBottom.value = true
}

function updateShortAgreementState() {
  if (agreementPane.value && isScrolledToBottom(agreementPane.value)) consentScrolledToBottom.value = true
}

function selectDomainOption(option: 'new') {
  if (answers.value.domain?.option === option) return
  answers.value.domain = { option, name: '', tld: catalog.value?.domainTlds[0]?.tld }
  resetDomainAvailability()
  if (!domainRegistrant.value.firstName) domainRegistrant.value.firstName = answers.value.contact.contactName
  if (!domainRegistrant.value.email) domainRegistrant.value.email = answers.value.contact.email
}

function resetDomainAvailability() {
  domainAvailabilityMessage.value = ''
  domainAvailability.value = null
  domainDelegated.value = false
}

const domainName = computed({
  get: () => answers.value.domain?.name || '',
  set: (name: string) => {
    if (answers.value.domain?.option === 'new') answers.value.domain = { ...answers.value.domain, name: name.toLowerCase() }
    resetDomainAvailability()
  },
})

const domainTld = computed({
  get: () => answers.value.domain?.tld || '',
  set: (tld: string) => {
    if (answers.value.domain?.option === 'new') answers.value.domain = { ...answers.value.domain, tld }
    resetDomainAvailability()
  },
})

async function checkDomainAvailability() {
  if (domainChecking.value) return
  if (!domainName.value || !domainTld.value) {
    domainAvailabilityMessage.value = '請先填寫網域名稱並選擇結尾。'
    return
  }
  const queriedDomain = `${domainName.value}.${domainTld.value}`
  resetDomainAvailability()
  domainChecking.value = true
  try {
    const result = await funnelFetch<DomainAvailability | { available: false; messageZh: string }>('/domain-availability', { method: 'POST', body: { name: domainName.value, tld: domainTld.value } })
    if (queriedDomain !== `${domainName.value}.${domainTld.value}` || answers.value.domain?.option !== 'new') return
    if (result.available) {
      domainAvailability.value = result
      domainAvailabilityMessage.value = `${result.canonicalDomain} 目前可以註冊，第一年 ${formatTwd(result.customerPrice.amountMinor)}。此查詢不會保留網域，付款後會再次確認並自動註冊。`
    } else domainAvailabilityMessage.value = result.messageZh
  } catch (error) {
    if (queriedDomain === `${domainName.value}.${domainTld.value}`) domainAvailabilityMessage.value = requestFailureMessage(error, '目前無法查詢網域，請稍後再試。')
  } finally { domainChecking.value = false }
}

function selectPlan(key: 'site_only' | 'site_geo' | 'site_geo_autopost') {
  if (answers.value.plan?.planKey === key) return
  answers.value.plan = key === 'site_geo_autopost' ? { planKey: key } : { planKey: key }
}

function quoteLines(billing: 'one_time' | 'monthly' | 'annual') {
  return quote.value?.lines.filter(line => line.billing === billing) || []
}

async function loadQuote() {
  if (!canAdvance(9, answers.value, { accepted: consentAccepted.value })) {
    quoteStatus.value = 'error'
    quoteError.value = '前面的必填資料尚未完成，請返回補齊後再確認報價。'
    return
  }
  quoteStatus.value = 'loading'
  quoteError.value = ''
  try {
    quote.value = await funnelFetch<FunnelQuote>('/quote', { method: 'POST', body: {} })
    quoteStatus.value = 'success'
  } catch (error) {
    quoteStatus.value = 'error'
    quoteError.value = requestFailureMessage(error, '目前無法取得報價，請稍後重試。')
  }
}

async function startBuild() {
  const missingModules = missingRequiredModulesForSiteType(answers.value.siteType, answers.value.modules)
  if (missingModules.length) {
    buildStatus.value = 'error'
    buildError.value = `請先選擇必需功能：${missingModules.map(module => MODULE_HELP[module]?.label || module).join('、')}`
    return
  }
  buildStatus.value = 'loading'
  buildError.value = ''
  try {
    const result = await funnelFetch<{ previewUrl: string; releaseId: number; quote: FunnelQuote }>('/build', { method: 'POST', body: {} })
    builtPreviewUrl.value = result.previewUrl
    quote.value = result.quote
    buildStatus.value = 'success'
    await loadFunnelStatus()
  } catch (error) {
    buildStatus.value = 'error'
    buildError.value = requestFailureMessage(error, '網站建置服務尚未設定，請稍後再試或聯絡客服。')
  }
}

async function startCheckout() {
  checkoutStatus.value = 'loading'
  checkoutError.value = ''
  try {
    const result = await funnelFetch<{ checkoutUrl: string }>('/checkout', { method: 'POST', body: {} })
    window.location.href = result.checkoutUrl
  } catch (error) {
    checkoutStatus.value = 'error'
    checkoutError.value = requestFailureMessage(error, '目前無法前往付款，請稍後再試。')
  }
}

onMounted(() => {
  countdownTimer = setInterval(() => { countdownNow.value = Date.now() }, 1000)
  void bootstrap()
})
onBeforeUnmount(() => { if (countdownTimer) clearInterval(countdownTimer) })
</script>

<template>
  <main class="wizard" aria-labelledby="wizard-title">
    <nav class="studio-nav" aria-label="網站建立導覽">
      <span class="studio-nav__brand" aria-label="DiscoveryStack">
        <svg class="brand-mark" viewBox="0 0 24 28" fill="none" aria-hidden="true"><path d="M2 23V16H7V23H2ZM10 23V10H15V23H10ZM18 23V4H23V23H18Z" fill="currentColor" /></svg>
        <span>DiscoveryStack</span>
      </span>
      <span class="studio-nav__label">WEBSITE STUDIO</span>
      <button type="button" class="text-button" :disabled="navigationBusy" @click="restart">重新開始 <span aria-hidden="true">↻</span></button>
    </nav>
    <header class="wizard__header" :class="{ 'wizard__header--compact': currentStep > 1 }">
      <div class="wizard__intro">
        <p class="eyebrow">YOUR BRAND. A NEW BEGINNING.</p>
        <h1 id="wizard-title">你的品牌，<br>值得一個好網站。</h1>
        <p class="lede">說說你的品牌，選一種喜歡的風格。<br>從第一份草稿，到正式上線。</p>
        <ul class="hero-promises" aria-label="流程特色">
          <li>進度隨步保存</li>
          <li>付款前確認費用</li>
        </ul>
      </div>
      <div class="studio-object" aria-hidden="true">
        <div class="studio-object__orbit"></div>
        <div class="studio-object__window">
          <div class="studio-object__bar"><span></span><span></span><span></span><small>YOUR BRAND</small></div>
          <div class="studio-object__cover"><span class="studio-object__caption">A DIGITAL<br>PRESENCE,<br>WITH PURPOSE.</span><span class="studio-object__sphere"></span></div>
          <div class="studio-object__baseline"><span></span><span></span><span></span></div>
        </div>
        <span class="studio-object__note">VISUAL DIRECTION / 排版示意</span>
      </div>
    </header>

    <p v-if="loading" class="state" role="status">載入中…</p>
    <section v-else-if="bootstrapError" class="state state--error" role="alert">
      <h2>目前無法載入訂購流程</h2>
      <p>{{ bootstrapError }}</p>
      <button type="button" class="button" @click="bootstrap">再試一次</button>
    </section>

    <template v-else-if="catalog && sessionProjection">
      <div class="wizard__workspace">
      <nav class="progress" aria-label="訂購進度">
        <div class="progress__mobile">
          <p><span>{{ currentStepMeta.title }}</span><span>0{{ currentStep }} / 09</span></p>
          <div class="progress__bar" role="progressbar" aria-label="網站建立進度" :aria-valuenow="currentStep" :aria-valuetext="`第 ${currentStep} 步，共 9 步：${currentStepMeta.title}`" aria-valuemin="1" aria-valuemax="9">
            <span :style="{ width: progressWidths[currentStep - 1] }"></span>
          </div>
        </div>
        <ol class="progress__steps">
          <li v-for="item in FUNNEL_STEPS" :key="item.key" :class="{ 'is-current': item.step === currentStep, 'is-complete': item.step < firstIncomplete }">
            <button type="button" :disabled="!isStepClickable(item.step)" :aria-current="item.step === currentStep ? 'step' : undefined" @click="goToStep(item.step)">
              <span aria-hidden="true">0{{ item.step }}</span><small>{{ item.title }}</small>
            </button>
          </li>
        </ol>
      </nav>

      <div class="wizard__stage">
      <section :key="currentStep" class="step-card" :class="{ 'step-card--company': currentStep === 2 }" :aria-labelledby="`step-title-${currentStep}`">
        <header class="step-card__header">
          <div class="step-card__number" aria-hidden="true">0{{ currentStep }}</div>
          <div>
            <p class="eyebrow">YOUR WEBSITE · STEP 0{{ currentStep }}</p>
            <h2 :id="`step-title-${currentStep}`" ref="stepHeading" tabindex="-1">{{ currentStepMeta.title }}</h2>
            <p>{{ currentStepMeta.help }}</p>
          </div>
        </header>

        <div v-if="currentStep === 1" class="step-body">
          <fieldset>
            <legend>你目前有網站嗎？</legend>
            <div class="choice-row" role="radiogroup" aria-label="目前是否有網站">
              <button type="button" role="radio" :aria-checked="answers.existingSite?.hasSite === true" :class="{ selected: answers.existingSite?.hasSite === true }" @keydown.left.prevent="selectHasSite(true)" @keydown.up.prevent="selectHasSite(true)" @keydown.right.prevent="selectHasSite(false)" @keydown.down.prevent="selectHasSite(false)" @click="selectHasSite(true)">
                <span class="choice-card__mark" aria-hidden="true">↗</span><strong>為現有網站，翻開新一頁。</strong><small>填入網址作為設計參考。網站診斷可在官網首頁使用。</small>
              </button>
              <button type="button" role="radio" :aria-checked="answers.existingSite?.hasSite === false" :class="{ selected: answers.existingSite?.hasSite === false }" @keydown.left.prevent="selectHasSite(true)" @keydown.up.prevent="selectHasSite(true)" @keydown.right.prevent="selectHasSite(false)" @keydown.down.prevent="selectHasSite(false)" @click="selectHasSite(false)">
                <span class="choice-card__mark" aria-hidden="true">＋</span><strong>從零開始，建立品牌網站。</strong><small>一起整理內容、風格與網站需求。</small>
              </button>
            </div>
          </fieldset>
          <div v-if="answers.existingSite?.hasSite" class="field-group">
            <label for="existing-site-url">目前的網站網址</label>
            <input id="existing-site-url" v-model="existingSiteUrl" type="url" inputmode="url" autocomplete="url" maxlength="2048" placeholder="https://example.com" :aria-invalid="Boolean(existingSiteUrl && !validHttpsUrl(existingSiteUrl))" aria-describedby="existing-site-url-error">
            <p v-if="existingSiteUrl && !validHttpsUrl(existingSiteUrl)" id="existing-site-url-error" class="inline-error" role="alert">請輸入完整的 https 網址。</p>
          </div>
        </div>

        <div v-else-if="currentStep === 2" class="step-body step-body--company">
          <div class="company-form-layout">
            <div class="company-form-column">
              <section class="company-section" aria-labelledby="company-profile-title">
                <header class="company-section__heading">
                  <span aria-hidden="true">01</span>
                  <h3 id="company-profile-title">品牌輪廓</h3>
                </header>
                <div class="company-section__body">
                  <div class="field-group">
                    <div class="field-group__topline">
                      <label for="brand-name">品牌名稱 <span class="required-mark">必填</span></label>
                      <small>{{ answers.company.brandName.length }} ／ 160</small>
                    </div>
                    <input id="brand-name" v-model.trim="answers.company.brandName" maxlength="160" autocomplete="organization" aria-required="true">
                  </div>
                  <div class="field-group">
                    <div class="field-group__topline">
                      <label for="what-we-do">你在做什麼 <span class="required-mark">必填</span></label>
                      <small>{{ answers.company.whatWeDo.length }} ／ 2000</small>
                    </div>
                    <textarea id="what-we-do" v-model.trim="answers.company.whatWeDo" rows="5" maxlength="2000" placeholder="用平常向客人介紹的方式說明即可" aria-required="true"></textarea>
                  </div>
                </div>
              </section>

              <section class="company-section" aria-labelledby="company-feeling-title">
                <header class="company-section__heading">
                  <span aria-hidden="true">02</span>
                  <h3 id="company-feeling-title">品牌給人的感覺</h3>
                </header>
                <fieldset class="company-section__body">
                  <legend>想給人什麼感覺（可複選）</legend>
                  <p class="field-hint">選擇最接近你的詞，之後仍可調整。</p>
                  <div class="chip-grid">
                    <button v-for="option in FEELING_OPTIONS" :key="option.key" type="button" role="checkbox" :aria-checked="answers.company.feelings.includes(option.key)" :class="{ selected: answers.company.feelings.includes(option.key) }" @click="toggleList(answers.company.feelings, option.key)">
                      <span class="chip-grid__check" aria-hidden="true"></span><span>{{ option.label }}</span>
                    </button>
                  </div>
                </fieldset>
              </section>

              <section class="company-section" aria-labelledby="company-offer-title">
                <header class="company-section__heading">
                  <span aria-hidden="true">03</span>
                  <h3 id="company-offer-title">商品與成交方式</h3>
                </header>
                <div class="company-section__body">
                  <div class="field-group">
                    <div class="field-group__topline">
                      <label for="main-offer">主要賣什麼 <span class="required-mark">必填</span></label>
                      <small>{{ answers.company.mainOffer.length }} ／ 1000</small>
                    </div>
                    <textarea id="main-offer" v-model.trim="answers.company.mainOffer" rows="4" maxlength="1000" aria-required="true"></textarea>
                  </div>
                  <fieldset aria-describedby="conversion-goals-help">
                    <legend>希望怎麼成交（可複選） <span class="required-mark">至少一項</span></legend>
                    <p id="conversion-goals-help" class="field-hint">我們會依照你的目標安排網站動線。</p>
                    <div class="chip-grid">
                      <button v-for="option in CONVERSION_GOAL_OPTIONS" :key="option.key" type="button" role="checkbox" :aria-checked="answers.company.conversionGoals.includes(option.key)" :class="{ selected: answers.company.conversionGoals.includes(option.key) }" @click="toggleList(answers.company.conversionGoals, option.key)">
                        <span class="chip-grid__check" aria-hidden="true"></span><span>{{ option.label }}</span>
                      </button>
                    </div>
                  </fieldset>
                </div>
              </section>

              <section class="company-section" aria-labelledby="contact-title">
                <header class="company-section__heading">
                  <span aria-hidden="true">04</span>
                  <h3 id="contact-title">聯絡資料</h3>
                </header>
                <div class="company-section__body contact-grid">
                  <div class="field-group">
                    <div class="field-group__topline">
                      <label for="contact-name">聯絡人姓名 <span class="required-mark">必填</span></label>
                      <small>{{ answers.contact.contactName.length }} ／ 120</small>
                    </div>
                    <input id="contact-name" v-model.trim="answers.contact.contactName" maxlength="120" autocomplete="name" aria-required="true">
                  </div>
                  <div class="field-group">
                    <label for="contact-phone">聯絡電話 <span class="optional-mark">選填</span></label>
                    <input id="contact-phone" v-model.trim="answers.contact.phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" :aria-invalid="Boolean(answers.contact.phone && !/^[0-9+() -]+$/.test(answers.contact.phone))" aria-describedby="contact-phone-error">
                    <p v-if="answers.contact.phone && !/^[0-9+() -]+$/.test(answers.contact.phone)" id="contact-phone-error" class="inline-error">電話只能使用數字、空格、括號、加號或連字號。</p>
                  </div>
                  <div class="field-group contact-grid__wide">
                    <label for="contact-email">聯絡 Email <span class="required-mark">必填</span></label>
                    <small id="contact-email-help" class="field-hint">付款與開站進度會寄到這個信箱</small>
                    <input id="contact-email" v-model.trim="answers.contact.email" type="email" inputmode="email" autocomplete="email" maxlength="320" aria-required="true" :aria-invalid="Boolean(answers.contact.email && companyMissing.includes('聯絡 Email'))" aria-describedby="contact-email-help contact-email-error">
                    <p v-if="answers.contact.email && companyMissing.includes('聯絡 Email')" id="contact-email-error" class="inline-error">請輸入完整且有效的 Email。</p>
                  </div>
                </div>
              </section>
            </div>

            <aside class="company-completion" aria-label="本步完成度">
              <p>本步完成度</p>
              <div><strong>{{ companyCompleteCount }}</strong><span>／ {{ COMPANY_COMPLETION_ITEMS.length }} 項必填</span></div>
              <ol>
                <li v-for="item in COMPANY_COMPLETION_ITEMS" :key="item.missingLabel" :class="{ 'is-complete': !companyMissing.includes(item.missingLabel) }">{{ item.label }}</li>
              </ol>
              <small>不必一次寫得完美。先用你平常會說的話，之後每一步都能回來修改。</small>
            </aside>
          </div>
        </div>

        <div v-else-if="currentStep === 3" class="step-body">
          <fieldset>
            <legend>品牌版型方向</legend>
            <p>先挑選喜歡的視覺方向；商品、文章與預約內容會換成你的品牌資料，不會複製示範品牌。</p>
            <div class="preset-grid">
              <button v-for="preset in [{ key: 'atelier', label: '精品選品', help: '酒紅、米白、編輯式留白，適合精緻電商。' }, { key: 'bloom', label: '溫柔生活', help: '柔粉、霧白、親近的商品與故事編排。' }, { key: 'alignment', label: '安靜練習', help: '深綠、瓷白、服務預約與長文閱讀。' }]" :key="preset.key" type="button" :aria-pressed="answers.style.customerSitePreset === preset.key" :class="{ selected: answers.style.customerSitePreset === preset.key }" @click="answers.style.customerSitePreset = preset.key as 'atelier' | 'bloom' | 'alignment'">
                <strong>{{ preset.label }}</strong><span>{{ preset.help }}</span>
              </button>
            </div>
            <small>正式交付後 30 天，原功能範圍內的排版、色彩、字體與圖片配置調整免費。新增功能、資料搬遷、新串接與第三方費用另行確認。</small>
          </fieldset>
          <fieldset>
            <legend>選一種喜歡的風格</legend>
            <div class="preset-grid">
              <button v-for="preset in STYLE_PRESETS" :key="preset.key" type="button" role="radio" :aria-checked="answers.style.stylePreset === preset.key" :class="{ selected: answers.style.stylePreset === preset.key }" @click="answers.style.stylePreset = preset.key">
                <span class="preset-art" :class="`preset-art--${preset.key}`" aria-hidden="true"><span class="preset-art__nav"></span><span class="preset-art__title"></span><span class="preset-art__line"></span><span class="preset-art__shape"></span><span class="preset-art__action"></span></span>
                <strong>{{ preset.label }}</strong><span>{{ preset.help }}</span>
              </button>
            </div>
          </fieldset>
          <div class="divider"><span>或提供參考網站</span></div>
          <div class="reference-list">
            <div v-for="(_, index) in answers.style.referenceUrls" :key="index" class="reference-row">
              <div class="field-group">
                <label :for="`reference-${index}`">參考網站 {{ index + 1 }}</label>
                <input :id="`reference-${index}`" v-model.trim="answers.style.referenceUrls[index]" type="url" inputmode="url" autocomplete="url" maxlength="512" placeholder="https://example.com">
                <p v-if="referenceError(answers.style.referenceUrls[index] || '', index)" class="inline-error">{{ referenceError(answers.style.referenceUrls[index] || '', index) }}</p>
              </div>
              <button type="button" class="text-button" @click="removeReference(index)">移除</button>
            </div>
            <button v-if="answers.style.referenceUrls.length < 3" type="button" class="button button--secondary" @click="addReference">新增參考網址</button>
          </div>
          <fieldset class="upsell">
            <legend>設計方式</legend>
            <label class="toggle-line">
              <input v-model="answers.style.designTier" type="checkbox" true-value="designer" false-value="template">
              <span><strong>升級設計師款</strong><small>客製不套版：由設計師依你的品牌內容調整版面、色彩與細節，不直接套用固定成品。</small></span>
              <b v-if="designerTier">{{ formatTwd(designerTier.oneTimeMinor) }}</b>
            </label>
          </fieldset>
        </div>

        <div v-else-if="currentStep === 4" class="step-body card-grid">
          <button v-for="siteType in catalog.siteTypes" :key="siteType.key" type="button" role="radio" :aria-checked="answers.siteType === siteType.key" class="option-card" :class="{ selected: answers.siteType === siteType.key }" @click="selectSiteType(siteType.key)">
            <span class="option-card__top"><strong>{{ SITE_TYPE_HELP[siteType.key].label }}</strong><b>{{ formatTwd(siteType.buildMinor) }}</b></span>
            <span>{{ SITE_TYPE_HELP[siteType.key].difference }}</span>
            <small>{{ SITE_TYPE_HELP[siteType.key].whenToPick }}</small>
          </button>
        </div>

        <div v-else-if="currentStep === 5" class="step-body module-grid">
          <div v-for="module in catalog.modules" :key="module.key" class="module-option">
            <button type="button" role="checkbox" :aria-checked="(answers.modules || []).includes(module.key)" :disabled="requiredModulesForSiteType(answers.siteType).includes(module.key)" class="module-card" :class="{ selected: (answers.modules || []).includes(module.key) }" @click="toggleModule(module.key)">
              <span class="module-card__heading"><strong>{{ moduleCopy(module).label }}</strong><span>{{ requiredModulesForSiteType(answers.siteType).includes(module.key) ? '必選功能（已啟用）' : (answers.modules || []).includes(module.key) ? '已選擇' : '未選擇' }}</span></span>
              <span>{{ moduleCopy(module).plain }}</span>
              <span class="module-card__prices"><small>定價建置費 {{ formatTwd(module.buildMinor) }}</small><small>定價月費 {{ formatTwd(module.monthlyMinor) }}</small></span>
              <template v-if="module.readiness === 'coming_soon'">
                <strong class="coming-soon-badge">即將推出・本次不收費</strong>
                <b class="checkout-zero">本次結帳 {{ formatTwd(0) }}</b>
              </template>
              <strong v-else-if="module.readiness === 'manual_setup'" class="manual-setup-badge">需人工設定・付款後由我們為你設定開通</strong>
              <em v-else>付款後由系統處理</em>
              <small v-if="requiredModulesForSiteType(answers.siteType).includes(module.key)">簡易電商網站需要此功能，無法取消</small>
            </button>
            <section v-if="module.key === 'contact_lead_capture' && contactModuleSelected" class="inbox-binding" aria-labelledby="inbox-binding-title">
              <h3 id="inbox-binding-title">綁定收信信箱</h3>
              <p>尚未綁定時，表單送出的資料仍會保存並可查看，但不會轉寄到信箱。綁定不會阻擋你繼續下一步或完成結帳。</p>
              <p v-if="!contactInbox.transportConfigured" class="notice">寄信服務尚未開通，這個模組會先記錄你的信箱需求，上線後我們會協助綁定</p>
              <template v-if="contactInbox.status === 'bound' && !inboxRebinding && !inboxAwaitingConfirmation">
                <p class="success-panel">已綁定 {{ contactInbox.maskedEmail }}</p>
                <button type="button" class="text-button" @click="restartInboxBinding">換綁其他信箱</button>
              </template>
              <template v-else>
                <p v-if="contactInbox.status === 'locked'" class="inline-error">驗證次數過多，請重新寄送驗證碼</p>
                <div class="inbox-binding__row">
                  <div class="field-group"><label for="contact-inbox-email">可收信的電子信箱</label><input id="contact-inbox-email" v-model="inboxEmail" type="email" inputmode="email" autocomplete="email" maxlength="320"></div>
                  <button type="button" class="button button--secondary" :disabled="inboxBusy || !contactInbox.transportConfigured || !inboxEmail.trim() || resendSeconds > 0" @click="sendInboxVerificationCode">{{ inboxBindingStatus === 'sending' ? '寄送中…' : '寄出驗證碼' }}</button>
                </div>
                <p v-if="resendSeconds > 0" class="hint">{{ resendSeconds }} 秒後可重新寄送</p>
                <template v-if="inboxAwaitingConfirmation">
                  <div class="inbox-binding__row">
                    <div class="field-group"><label for="contact-inbox-code">6 位數驗證碼</label><input id="contact-inbox-code" v-model="inboxVerificationCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*"></div>
                    <button type="button" class="button" :disabled="inboxBusy || inboxVerificationCode.length !== 6" @click="confirmInboxBinding">{{ inboxBindingStatus === 'confirming' ? '確認中…' : '確認綁定' }}</button>
                  </div>
                </template>
              </template>
              <p v-if="inboxBindingError" class="inline-error" role="alert">{{ inboxBindingError }}</p>
            </section>
          </div>
        </div>

        <div v-else-if="currentStep === 6" class="step-body">
          <div v-if="!draft && !answers.previewDraft" class="preview-invitation">
            <span aria-hidden="true">↗</span><h3>讓品牌輪廓，變成第一個畫面。</h3><p>依照前面選擇的內容與風格，製作一份示意草稿。</p>
          </div>
          <button type="button" class="button" :disabled="draftStatus === 'loading'" @click="generatePreview">{{ draftStatus === 'loading' ? '正在製作示意預覽…' : '製作我的示意預覽' }}</button>
          <section v-if="draft" class="preview-result" aria-labelledby="preview-result-title">
            <h3 id="preview-result-title">{{ draft.headline }}</h3>
            <p class="notice">{{ draft.sourceReason }}</p>
            <iframe sandbox="" referrerpolicy="no-referrer" title="示意預覽" :srcdoc="draft.html"></iframe>
            <div class="preview-sections">
              <article v-for="section in draft.sections" :key="section.heading"><h4>{{ section.heading }}</h4><p>{{ section.body }}</p></article>
            </div>
          </section>
          <section v-else-if="answers.previewDraft" class="notice">
            <h3>{{ answers.previewDraft.headline }}</h3>
            <p>先前的示意草稿摘要已保留；如要再次查看完整畫面，請重新產生預覽。</p>
            <article v-for="section in answers.previewDraft.sections" :key="section.heading"><h4>{{ section.heading }}</h4><p>{{ section.body }}</p></article>
          </section>
          <section v-if="draftError" class="state state--error" role="alert"><p>{{ draftError }}</p><button type="button" class="button button--secondary" @click="generatePreview">再試一次</button><small>示意預覽不是必填，你仍可繼續下一步。</small></section>
        </div>

        <div v-else-if="currentStep === 7" class="step-body">
          <fieldset>
            <legend>網域要怎麼處理？</legend>
            <div class="card-grid">
              <button v-for="option in catalog.domainOptions" :key="option" type="button" role="radio" :aria-checked="answers.domain?.option === option" class="option-card" :class="{ selected: answers.domain?.option === option }" @click="selectDomainOption(option)">
                <strong>{{ domainOptionCopy[option].label }}</strong><span>{{ domainOptionCopy[option].help }}</span>
              </button>
              <article class="manual-domain-card">
                <strong>我有自己的網域</strong>
                <span>需要先確認網域擁有權與 DNS 連接方式，目前不提供自助付款。</span>
                <a v-if="manualEnquiryUrl" class="manual-domain-card__link" :href="manualEnquiryUrl" target="_blank" rel="noopener noreferrer">前往合作諮詢表單 <span aria-hidden="true">↗</span></a>
                <small v-else>合作諮詢網址尚未設定，請由 DiscoveryStack 公開官網的「開始對話」聯絡我們。</small>
              </article>
              <article class="manual-domain-card">
                <strong>需要人工代辦</strong>
                <span>團隊會先確認名稱、註冊資料與實際費用，目前不在這裡選擇或付款。</span>
                <a v-if="manualEnquiryUrl" class="manual-domain-card__link" :href="manualEnquiryUrl" target="_blank" rel="noopener noreferrer">前往合作諮詢表單 <span aria-hidden="true">↗</span></a>
                <small v-else>合作諮詢網址尚未設定，請由 DiscoveryStack 公開官網的「開始對話」聯絡我們。</small>
              </article>
            </div>
          </fieldset>
          <section v-if="answers.domain?.option === 'new'" class="domain-builder" aria-labelledby="new-domain-title">
            <h3 id="new-domain-title">想要的新網域</h3>
            <div class="domain-fields">
              <div class="field-group"><label for="domain-name">網域名稱</label><input id="domain-name" v-model.trim="domainName" inputmode="url" autocomplete="off" maxlength="63" placeholder="my-brand"><small>只輸入英文字母、數字或連字號。</small></div>
              <div class="field-group"><label for="domain-tld">網域結尾</label><select id="domain-tld" v-model="domainTld"><option v-for="item in catalog.domainTlds" :key="item.tld" :value="item.tld">.{{ item.tld }} · {{ formatTwd(item.annualMinor) }}／年</option></select></div>
            </div>
            <button type="button" class="button button--secondary" :disabled="domainChecking" @click="checkDomainAvailability">{{ domainChecking ? '正在查詢…' : '查詢是否可註冊' }}</button>
            <p v-if="domainAvailabilityMessage" class="notice" role="status">{{ domainAvailabilityMessage }}</p>
            <p v-if="domainAvailability && Date.parse(domainAvailability.expiresAt) <= countdownNow" class="inline-error">查詢報價已過期，請重新查詢後再確認。</p>
            <fieldset v-if="domainAvailability" class="domain-registrant">
              <legend>網域持有人的註冊資料</legend>
              <p class="hint">網域會透過平台帳戶管理，持有人資料登記為你提供的聯絡人。請提供真實完整資料，並留意註冊商寄送的驗證信。</p>
              <div class="domain-fields">
                <div class="field-group"><label for="registrant-first">姓名／名</label><input id="registrant-first" v-model.trim="domainRegistrant.firstName" autocomplete="given-name" maxlength="100"></div>
                <div class="field-group"><label for="registrant-last">姓（可留空）</label><input id="registrant-last" v-model.trim="domainRegistrant.lastName" autocomplete="family-name" maxlength="100"></div>
                <div class="field-group"><label for="registrant-org">公司名稱（選填）</label><input id="registrant-org" v-model.trim="domainRegistrant.organization" autocomplete="organization" maxlength="200"></div>
                <div class="field-group"><label for="registrant-email">註冊 Email</label><input id="registrant-email" v-model.trim="domainRegistrant.email" type="email" autocomplete="email" maxlength="254"></div>
                <div class="field-group"><label for="registrant-country">國家代碼</label><input id="registrant-country" v-model.trim="domainRegistrant.country" autocomplete="country" maxlength="2" placeholder="TW"><small>兩碼英文，例如 TW、US。</small></div>
                <div class="field-group"><label for="registrant-state">縣市／州（選填）</label><input id="registrant-state" v-model.trim="domainRegistrant.state" autocomplete="address-level1" maxlength="100"></div>
                <div class="field-group"><label for="registrant-city">城市</label><input id="registrant-city" v-model.trim="domainRegistrant.city" autocomplete="address-level2" maxlength="100"></div>
                <div class="field-group"><label for="registrant-postal">郵遞區號</label><input id="registrant-postal" v-model.trim="domainRegistrant.postalCode" autocomplete="postal-code" maxlength="32"></div>
                <div class="field-group"><label for="registrant-address">完整街道地址</label><input id="registrant-address" v-model.trim="domainRegistrant.address1" autocomplete="address-line1" maxlength="255"></div>
                <div class="field-group"><label for="registrant-phone-country">電話國碼</label><input id="registrant-phone-country" v-model.trim="domainRegistrant.phoneCountryCode" inputmode="numeric" maxlength="4" placeholder="886"></div>
                <div class="field-group"><label for="registrant-phone">電話號碼</label><input id="registrant-phone" v-model.trim="domainRegistrant.phone" inputmode="tel" maxlength="15"><small>只填數字，不含國碼。</small></div>
              </div>
              <label class="consent-check"><input v-model="domainDelegated" type="checkbox"><span>{{ sessionProjection.domainDelegationTerms }}</span></label>
            </fieldset>
          </section>
          <section class="agreement" aria-labelledby="agreement-title">
            <h3 id="agreement-title">網站建置授權同意書</h3>
            <div ref="agreementPane" class="agreement__pane" tabindex="0" @scroll="handleAgreementScroll">
              <p><strong>請完整閱讀以下內容</strong></p>
              <p>我確認自己有權提供本流程中的品牌名稱、文字、圖片、網址、聯絡資料及其他內容，並授權網站建置團隊為製作示意預覽、建立網站、提供報價與安排付款而處理這些資料。</p>
              <p>我了解示意預覽只是討論方向的草稿，不代表最終交付內容；正式網站會依已確認的方案、功能與素材製作。若我提供第三方素材，我會先取得必要的使用權。</p>
              <p>我了解網站分析只檢查可公開讀取的首頁線索，不是完整稽核，也不保證搜尋排名、流量、詢問、成交或營收結果。</p>
              <p>我了解標示「付款後由我們為你設定開通」的人工設定模組會依報價收費，付款後由團隊安排設定，完成前不會顯示為已開通；標示「即將推出」的模組只登記需求，本次不開通也不收費。新網域會在付款確認後再次確認可註冊狀態，自動代為註冊、連接網站並設定 HTTPS；付款前的查詢不代表已取得網域。若網域已被他人註冊或價格超出同意範圍，會停止採購並顯示待處理狀態，不會替換名稱或自行加價。</p>
              <p>我同意團隊可使用我提供的聯絡 Email 傳送付款、網站建置進度及必要的服務通知。未經另行同意，不會把這項授權解讀為接收其他行銷訊息的同意。</p>
              <p>我會在付款前再次確認伺服器提供的費用明細、每月費用、網域年費與後續收費方式。如資料或需求有變，我會在確認付款前提出。</p>
              <p><strong>閱讀完畢後，請捲到這一段的最底部，再勾選下方同意框。</strong></p>
            </div>
            <p class="scroll-status" :class="{ done: consentScrolledToBottom }">{{ consentScrolledToBottom ? '✓ 已捲到底，可以勾選同意' : '↓ 請繼續往下捲到最後' }}</p>
            <label class="consent-check"><input v-model="consentChecked" type="checkbox" :disabled="!consentGate.canTick"><span>我已閱讀並同意以上授權內容</span></label>
            <p v-if="consentGate.reason" class="hint">{{ consentGate.reason }}</p>
          </section>
        </div>

        <div v-else-if="currentStep === 8" class="step-body card-grid">
          <article v-for="plan in catalog.plans" :key="plan.key" class="plan-card" :class="{ selected: answers.plan?.planKey === plan.key }">
            <button type="button" role="radio" :aria-checked="answers.plan?.planKey === plan.key" @click="selectPlan(plan.key)">
              <strong>{{ PLAN_HELP[plan.key].label }}</strong><span>{{ PLAN_HELP[plan.key].plain }}</span>
              <b v-if="plan.monthlyMinor !== null">{{ formatTwd(plan.monthlyMinor) }}／月</b><b v-else>依發文頻率計價</b>
            </button>
            <fieldset v-if="plan.key === 'site_geo_autopost' && answers.plan?.planKey === plan.key">
              <legend>多久發一篇內容？</legend>
              <label v-for="item in catalog.cadence" :key="item.days"><input v-model="answers.plan.cadenceDays" type="radio" name="cadence" :value="item.days"><span>每 {{ item.days }} 天 · {{ formatTwd(item.monthlyMinor) }}／月</span></label>
            </fieldset>
          </article>
        </div>

        <div v-else class="step-body checkout-step">
          <p v-if="quoteStatus === 'loading'" class="state" role="status">正在向伺服器取得最新報價…</p>
          <section v-else-if="quoteError" class="state state--error" role="alert"><p>{{ quoteError }}</p><button type="button" class="button button--secondary" @click="loadQuote">重新取得報價</button></section>
          <template v-else-if="quote">
            <p v-if="!selfServeDomainSupported" class="notice" role="status">這個網域方案需要團隊先人工確認；以下僅保留先前的估價，不會建立付款頁面。</p>
            <section class="quote" aria-labelledby="quote-title">
              <h3 id="quote-title">費用明細</h3>
              <div v-for="group in [{ key: 'one_time' as const, label: '一次性建置費用' }, { key: 'monthly' as const, label: '每月服務費' }, { key: 'annual' as const, label: '網域年費' }]" :key="group.key" class="quote-group">
                <h4>{{ group.label }}</h4>
                <p v-if="!quoteLines(group.key).length" class="muted">這一類目前沒有費用。</p>
                <dl v-else><div v-for="line in quoteLines(group.key)" :key="line.lineKey"><dt>{{ line.description }}</dt><dd>{{ formatTwd(line.lineAmountMinor) }}</dd></div></dl>
              </div>
              <div class="quote-total"><span>{{ selfServeDomainSupported ? '今天要付' : '先前估算' }}</span><strong>{{ formatTwd(quote.totals.dueTodayMinor) }}</strong></div>
              <dl class="future-charges"><div><dt>之後每月費用</dt><dd>{{ formatTwd(quote.totals.recurringMonthlyMinor) }}</dd></div><div><dt>網域每年續用費</dt><dd>{{ formatTwd(quote.totals.domainRenewalAnnualMinor) }}</dd></div></dl>
            </section>
            <section v-if="!builtPreviewUrl" class="checkout-action">
              <button type="button" class="button button--wide" :disabled="buildStatus === 'loading'" @click="startBuild">{{ buildStatus === 'loading' ? '正在開始建置…' : '開始建置我的網站' }}</button>
              <p v-if="buildError" class="inline-error" role="alert">{{ buildError }}</p>
            </section>
            <section v-else class="checkout-action">
              <p class="success-panel">網站預覽已建立：<a :href="builtPreviewUrl" target="_blank" rel="noopener noreferrer">開啟真正的預覽網址</a></p>
              <section v-if="moduleFulfilments.length" class="fulfilment-panel" aria-labelledby="fulfilment-title">
                <h3 id="fulfilment-title">模組處理進度</h3>
                <ul><li v-for="row in moduleFulfilments" :key="`${row.draftOrderId}:${row.moduleKey}`"><strong>{{ MODULE_HELP[row.moduleKey]?.label || row.moduleKey }}</strong><span>{{ row.customerVisibleStatus }}</span></li></ul>
                <p v-if="moduleFulfilments.some(row => row.status === 'recorded_intent_unbilled')" class="notice">即將推出模組只記錄需求，尚未開通，本次也沒有收費。</p>
                <p v-if="moduleFulfilments.some(row => row.status === 'pending_manual_setup')" class="notice">已付款的人工設定模組仍待我們為你設定，完成前不會顯示為已開通。</p>
              </section>
              <template v-if="!paymentVerified && selfServeDomainSupported">
              <button type="button" class="button button--wide" :disabled="checkoutStatus === 'loading'" @click="startCheckout">{{ checkoutStatus === 'loading' ? '正在前往付款…' : '確認並付款' }}</button>
              <p v-if="checkoutError" class="inline-error" role="alert">{{ checkoutError }}</p>
              <p v-if="sessionProjection.testMode === true" class="notice">這是測試模式付款</p>
              <p v-if="quote.comingSoonModules.length" class="notice">你選擇的即將推出模組已登記需求，但本次不會開通，也未收取任何費用。</p>
              <p v-if="hasManualSetupModules" class="notice">你選擇的人工設定模組已列入費用，付款後由我們為你設定開通；完成前不會顯示為已開通。</p>
              <p v-if="contactModuleSelected && contactInbox.status !== 'bound'" class="notice">聯絡表單尚未綁定收信信箱；表單送出的資料仍會保存並可查看，但不會轉寄到信箱，你仍可完成結帳並於之後綁定。</p>
              <p v-else-if="contactModuleSelected" class="notice">聯絡表單送出的資料仍會保存並可查看；也會另外轉寄到已綁定的收信信箱 {{ contactInbox.maskedEmail }}，之後仍可換綁其他信箱。</p>
              <p class="notice">新網域結帳後由我們代為註冊，實際可註冊狀態會再確認。</p>
              </template>
              <section v-else-if="!paymentVerified" class="manual-domain-handoff" aria-labelledby="manual-domain-handoff-title">
                <h3 id="manual-domain-handoff-title">改由團隊確認下一步</h3>
                <p>現有網域與人工代辦尚未開放自助付款。預覽會保留，我們不會為這個工作階段建立付款頁面。</p>
                <div class="manual-domain-handoff__actions">
                  <a v-if="manualEnquiryUrl" class="button" :href="manualEnquiryUrl" target="_blank" rel="noopener noreferrer">前往合作諮詢表單</a>
                  <button type="button" class="button button--secondary" @click="goToStep(7)">改用新網域</button>
                </div>
                <small v-if="!manualEnquiryUrl">合作諮詢網址尚未設定，請由 DiscoveryStack 公開官網的「開始對話」聯絡我們。</small>
              </section>
              <p v-else class="success-panel" role="status">付款已確認，我們會依上方「模組處理進度」為你開通，不需要再次付款。</p>
            </section>
          </template>
        </div>

        <p v-if="currentMissing.length && currentStep !== 6 && currentStep !== 9" id="step-missing" class="missing" role="status">還需要：{{ currentMissing.join('、') }}</p>
      </section>

      <footer class="step-footer">
        <button type="button" class="button button--secondary" :disabled="currentStep === 1 || saveStatus === 'saving'" @click="goPrevious">上一步</button>
        <div class="step-footer__status">
          <div class="save-state" :class="`save-state--${saveStatus}`" role="status">{{ saveMessage || (currentMissing.length ? `尚有 ${currentMissing.length} 項必填內容` : '變更會自動保存') }}</div>
        </div>
        <button v-if="currentStep < 9" type="button" class="button" :disabled="nextDisabled" :aria-describedby="currentMissing.length && currentStep !== 6 ? 'step-missing' : undefined" @click="saveCurrentAndAdvance">{{ saveStatus === 'saving' ? '儲存中…' : '下一步' }}</button>
        <span v-else class="step-footer__end">最後確認</span>
      </footer>
      </div>
      </div>
    </template>
  </main>
</template>

<style scoped>
:global(body) { margin: 0; background: #eee9df; }
.wizard, .wizard * { box-sizing: border-box; }
.wizard {
  --navy: #171a32;
  --navy-deep: #101326;
  --khaki: #b7a88f;
  --ivory: #eee9df;
  --paper: #f8f5ef;
  --ink: #171a32;
  --muted: #696961;
  --line: #d5cfc3;
  --accent: #171a32;
  --accent-soft: #e7dfd0;
  --motion-ease: cubic-bezier(.22, .8, .24, 1);
  min-height: 100vh;
  overflow-x: clip;
  padding: 0 clamp(1rem, 4.5vw, 4.5rem) 7rem;
  background: var(--ivory);
  color: var(--ink);
  font-family: "Inter", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.studio-nav, .wizard__header {
  max-width: 78rem;
  margin: 0 auto;
  background: var(--navy-deep);
  box-shadow: 0 0 0 100vmax var(--navy-deep);
  clip-path: inset(0 -100vmax);
  color: var(--ivory);
}
.studio-nav { position: relative; z-index: 2; display: flex; min-height: 5.5rem; align-items: center; gap: 1.5rem; border-bottom: 1px solid rgba(183, 168, 143, .18); }
.studio-nav__brand { display: inline-flex; align-items: center; gap: .75rem; color: var(--ivory); font-size: 1rem; letter-spacing: -.025em; text-decoration: none; }
.brand-mark { display: block; width: 23px; height: 27px; flex-shrink: 0; }
.brand-mark > span { padding-inline: .12rem; color: var(--khaki); }
.studio-nav__label { margin-left: auto; color: var(--khaki); font: 400 .6rem/1.2 monospace; letter-spacing: .16em; }
.studio-nav .text-button { padding-right: 0; color: #c7bba7; font-size: .74rem; font-weight: 400; text-decoration: none; }
.studio-nav .text-button span { margin-left: .5rem; }
.wizard__header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .85fr); min-height: 27rem; align-items: center; gap: 3rem; padding: 3.5rem 0 4rem; }
.wizard__intro { position: relative; z-index: 1; }
.eyebrow { margin: 0 0 1.2rem; color: var(--muted); font: 400 .65rem/1.5 monospace; letter-spacing: .16em; }
.wizard__header .eyebrow { color: var(--khaki); }
h1, h2, h3, h4, p { overflow-wrap: break-word; }
h1 { margin: 0; font-size: clamp(2.2rem, 4.7vw, 4.15rem); font-weight: 400; line-height: 1.4; letter-spacing: -.07em; }
h2 { margin: 0; font-size: clamp(1.8rem, 3vw, 2.7rem); font-weight: 400; line-height: 1.4; letter-spacing: -.045em; }
h3 { margin: 0 0 .85rem; font-size: 1.12rem; font-weight: 500; line-height: 1.5; letter-spacing: -.02em; }
h4 { margin: 0 0 .5rem; font-size: .9rem; font-weight: 600; }
.lede { margin: 1.4rem 0 0; color: #b8b7c1; font-size: .9rem; line-height: 1.85; font-weight: 300; }
.hero-promises { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 2.1rem 0 0; padding: 0; color: #bcb4a8; font-size: .66rem; list-style: none; }
.hero-promises li { display: inline-flex; align-items: center; gap: .5rem; }
.hero-promises li::before { width: .25rem; height: .25rem; border-radius: 50%; background: var(--khaki); content: ""; }
.studio-object { position: relative; display: grid; min-height: 22rem; align-content: center; perspective: 900px; }
.studio-object__orbit { position: absolute; top: 0; left: 15%; width: 17rem; height: 22rem; border: 1px solid rgba(183, 168, 143, .18); border-radius: 50%; transform: rotate(52deg); }
.studio-object__orbit::after { position: absolute; top: 2rem; left: 1.9rem; width: .45rem; height: .45rem; border-radius: 50%; background: var(--khaki); box-shadow: 0 0 1rem rgba(183, 168, 143, .5); content: ""; }
.studio-object__window { position: relative; z-index: 1; width: 100%; overflow: hidden; border: 1px solid rgba(183, 168, 143, .4); background: #e6dfd1; box-shadow: 2rem 3rem 3rem rgba(0, 0, 0, .3); transform: rotateY(-12deg) rotateX(5deg) rotate(-3deg); animation: studio-arrive 1s var(--motion-ease) both; }
.studio-object__bar { display: flex; height: 1.9rem; align-items: center; gap: .24rem; padding: 0 .75rem; background: #eeeadf; }
.studio-object__bar > span { width: .22rem; height: .22rem; border-radius: 50%; background: #aea591; }
.studio-object__bar small { margin-left: auto; color: #5e5d56; font: .42rem/1 monospace; letter-spacing: .13em; }
.studio-object__cover { position: relative; display: flex; min-height: 14rem; align-items: center; padding: 1.75rem; overflow: hidden; background: var(--navy); }
.studio-object__caption { position: relative; z-index: 2; color: #e6dfd1; font: 400 clamp(.9rem, 1.8vw, 1.55rem)/1.45 Georgia, serif; letter-spacing: -.025em; }
.studio-object__sphere { position: absolute; right: -1rem; top: 2rem; width: 11.5rem; height: 11.5rem; border-radius: 50%; background: radial-gradient(circle at 30% 25%, #e8e0cf 0, #c4b39a 20%, #847860 52%, #211e29 81%); box-shadow: inset -.5rem -.6rem 1.5rem #151527, 0 1rem 2rem rgba(0, 0, 0, .3); }
.studio-object__sphere::after { position: absolute; inset: 0; border: 1px solid rgba(238, 233, 223, .3); border-radius: 50%; background: repeating-linear-gradient(118deg, transparent 0 2px, rgba(255, 255, 255, .09) 2px 3px); content: ""; }
.studio-object__baseline { display: flex; gap: 1rem; min-height: 2.4rem; align-items: center; padding: 0 1.75rem; }
.studio-object__baseline span { width: 25%; height: .15rem; background: #bdb4a4; }
.studio-object__baseline span:last-child { width: 13%; margin-left: auto; }
.studio-object__note { position: relative; z-index: 1; margin-top: 1.6rem; color: #8f8d99; font: 400 .52rem/1.5 monospace; letter-spacing: .14em; text-align: right; }
.wizard__header--compact { display: block; min-height: 0; padding: 1.5rem 0 2rem; }
.wizard__header--compact .eyebrow { display: none; }
.wizard__header--compact h1 { font-size: 1.15rem; line-height: 1.5; letter-spacing: -.025em; }
.wizard__header--compact h1 br { display: none; }
.wizard__header--compact .lede, .wizard__header--compact .hero-promises, .wizard__header--compact .studio-object { display: none; }
.wizard__workspace { display: grid; gap: 1.75rem; max-width: 78rem; margin: 0 auto; }
.wizard__stage { min-width: 0; }
.progress { min-width: 0; padding: 1.75rem 0 0; }
.progress__mobile p { display: flex; justify-content: space-between; gap: 1rem; margin: 0 0 .75rem; color: var(--muted); font-size: .73rem; }
.progress__mobile p span:last-child { font-family: monospace; }
.progress__bar { height: 2px; overflow: hidden; background: var(--line); }
.progress__bar span { display: block; height: 100%; background: var(--navy); transition: width .4s var(--motion-ease); }
.progress__steps { display: none; }
.step-card { position: relative; min-width: 0; border: 1px solid var(--line); background: var(--paper); animation: paper-arrive .35s var(--motion-ease) both; }
.step-card__header { display: flex; gap: 1.5rem; padding: clamp(1.5rem, 4vw, 3.5rem) clamp(1.4rem, 5vw, 4.5rem) 0; }
.step-card__number { min-width: 2.2rem; margin-top: 2.35rem; color: #aa9c85; font: italic 400 1.5rem/1 Georgia, serif; }
.step-card__header .eyebrow { margin-bottom: .65rem; color: #8b806c; font-size: .57rem; }
.step-card__header h2 { scroll-margin-top: 1.5rem; }
.step-card__header h2:focus { outline: none; }
.step-card__header p:last-child { max-width: 38rem; margin: .75rem 0 0; color: var(--muted); font-size: .85rem; line-height: 1.75; }
.step-body { display: grid; gap: 1.8rem; padding: clamp(1.75rem, 4vw, 3rem) clamp(1.4rem, 5vw, 4.5rem) clamp(1.75rem, 4vw, 3.5rem); }
.step-body > *, .preview-result > * { min-width: 0; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend, label { color: var(--ink); font-size: .9rem; font-weight: 500; }
legend { margin-bottom: 1rem; }
button, input, textarea, select { font: inherit; }
button { touch-action: manipulation; }
button, a, input, textarea, select { -webkit-tap-highlight-color: rgba(183, 168, 143, .18); }
input:not([type="checkbox"]):not([type="radio"]), textarea, select { width: 100%; min-height: 50px; border: 1px solid var(--line); border-radius: 0; padding: .85rem 1rem; background: #fcfaf5; color: var(--ink); font-size: .95rem; transition: border-color .2s ease, background .2s ease; }
textarea { min-height: 7rem; resize: vertical; line-height: 1.7; }
input::placeholder, textarea::placeholder { color: #929087; opacity: 1; }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible, .agreement__pane:focus-visible { outline: 2px solid #817252; outline-offset: 4px; }
.studio-nav a:focus-visible, .studio-nav button:focus-visible { outline-color: var(--khaki); }
input:not([type="checkbox"]):not([type="radio"]):focus, textarea:focus, select:focus { border-color: #817252; background: white; }
.field-group { display: grid; gap: .65rem; min-width: 0; }
.field-group small, .hint, .muted { color: var(--muted); font-size: .78rem; line-height: 1.7; }
.field-group__topline { display: flex; justify-content: space-between; gap: .8rem; align-items: baseline; }
.field-group__topline small { color: #99958b; font-size: .62rem; }
.required-mark, .optional-mark { display: inline-block; margin-left: .35rem; color: #8b806b; font-size: .62rem; font-weight: 400; }
.required-mark { border-bottom: 1px solid #c1b398; }
.field-hint { margin: 0 0 .9rem; color: var(--muted); font-size: .8rem; line-height: 1.7; }
.choice-row { display: grid; gap: 1rem; }
.choice-row button, .preset-grid button, .option-card, .module-card, .chip-grid button { position: relative; min-height: 48px; border: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--ink); cursor: pointer; text-align: left; transition: border-color .22s ease, background .22s ease, transform .3s var(--motion-ease); }
.choice-row button { display: grid; grid-template-columns: 1fr auto; gap: .65rem; min-height: 12.5rem; align-content: end; padding: 1.6rem; }
.choice-row button strong { grid-column: 1 / -1; font-size: 1rem; font-weight: 500; line-height: 1.6; }
.choice-row button small { grid-column: 1 / -1; color: var(--muted); font-size: .78rem; line-height: 1.7; }
.choice-card__mark { grid-column: 2; grid-row: 1; align-self: start; margin-bottom: 1.65rem; color: #8b806b; font-size: 1.65rem; font-weight: 300; }
.choice-row button.selected, .preset-grid button.selected, .option-card.selected, .module-card.selected, .plan-card.selected { border-color: var(--navy); background: #eee8dd; }
.choice-row button.selected::before, .preset-grid button.selected::before, .option-card.selected::before, .module-card.selected::before, .plan-card.selected::before { position: absolute; top: 1rem; left: 1rem; width: .32rem; height: .32rem; border-radius: 50%; background: var(--navy); content: ""; }
.chip-grid { display: flex; flex-wrap: wrap; gap: .65rem; }
.chip-grid button { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; padding: .6rem .9rem; font-size: .78rem; }
.chip-grid__check { display: grid; flex: 0 0 auto; width: .8rem; height: .8rem; place-items: center; border: 1px solid #b5ad9f; color: var(--ivory); font-size: .55rem; }
.chip-grid button.selected { border-color: var(--navy); background: var(--navy); color: var(--ivory); }
.chip-grid button.selected .chip-grid__check { border-color: var(--khaki); background: transparent; }
.chip-grid button.selected .chip-grid__check::after { content: "✓"; }
.button { display: inline-flex; min-height: 48px; align-items: center; justify-content: center; gap: .7rem; border: 1px solid var(--navy); border-radius: 0; padding: .9rem 1.4rem; background: var(--navy); color: var(--ivory); cursor: pointer; font-size: .85rem; font-weight: 500; transition: color .2s ease, background .2s ease, transform .2s ease; }
.button--secondary { border-color: #b4aa98; background: transparent; color: var(--ink); }
.button--wide { width: 100%; }
.button:disabled, button:disabled { cursor: not-allowed; opacity: .45; }
.text-button { min-height: 44px; border: 0; padding: .6rem .3rem; background: transparent; color: #756852; cursor: pointer; font-size: .8rem; text-decoration: underline; text-underline-offset: .3rem; }
.state { max-width: 78rem; margin: 2rem auto; padding: 1.5rem; border: 1px solid var(--line); background: var(--paper); line-height: 1.7; }
.state--error { border-color: #bc8b7e; background: #f8ece6; color: #7f342b; }
.inline-error, .missing { margin: 0; color: #863d31; font-size: .8rem; line-height: 1.7; }
.missing { padding: 0 clamp(1.4rem, 5vw, 4.5rem) 1.5rem; }
.fulfilment-panel, .domain-builder, .agreement, .quote, .inbox-binding { padding: clamp(1rem, 3vw, 1.6rem); border: 1px solid var(--line); background: #f1ece3; }
.fulfilment-panel ul { display: grid; gap: .7rem; padding: 0; margin: 0; list-style: none; }
.fulfilment-panel li { display: flex; justify-content: space-between; gap: 1rem; font-size: .85rem; }
.step-body--company { display: block; padding-block: 0 1rem; }
.company-form-layout, .company-form-column { min-width: 0; }
.company-section { padding: 2.4rem 0; border-bottom: 1px solid var(--line); }
.company-section:last-child { border-bottom: 0; }
.company-section__heading { display: flex; align-items: baseline; gap: 1rem; margin-bottom: 1.5rem; }
.company-section__heading > span { color: #a2947d; font: italic 400 .85rem/1 Georgia, serif; }
.company-section__heading h3 { margin: 0; font-weight: 400; font-size: 1.25rem; }
.company-section__body { display: grid; gap: 1.6rem; min-width: 0; }
.contact-grid { display: grid; gap: 1.6rem; }
.contact-grid__wide { grid-column: 1 / -1; }
.company-completion { display: none; }
.preset-grid, .card-grid, .module-grid { display: grid; gap: 1rem; }
.preset-grid button { display: grid; align-content: start; gap: .5rem; overflow: hidden; padding: .8rem .8rem 1.3rem; }
.preset-grid button > strong { padding: .35rem .35rem 0; font-size: .9rem; font-weight: 500; }
.preset-grid button > span:not(.preset-art) { padding: 0 .35rem; color: var(--muted); font-size: .75rem; line-height: 1.7; }
.preset-art { --swatch-bg: #e8e6df; --swatch-ink: #4e504b; --swatch-shape: #c1c0b4; position: relative; display: block; width: 100%; aspect-ratio: 1.75; overflow: hidden; background: var(--swatch-bg); }
.preset-art__nav { position: absolute; top: 10%; left: 8%; width: 14%; height: 3%; background: var(--swatch-ink); }
.preset-art__title { position: absolute; top: 38%; left: 8%; width: 37%; height: 7%; background: var(--swatch-ink); }
.preset-art__line { position: absolute; top: 49%; left: 8%; width: 28%; height: 2%; background: var(--swatch-ink); opacity: .45; }
.preset-art__action { position: absolute; top: 65%; left: 8%; width: 18%; height: 8%; border: 1px solid var(--swatch-ink); }
.preset-art__shape { position: absolute; right: 8%; top: 24%; width: 36%; height: 57%; background: var(--swatch-shape); }
.preset-art--business { --swatch-bg: #dddfe2; --swatch-ink: #2d3949; --swatch-shape: #727e8b; }
.preset-art--premium { --swatch-bg: #262526; --swatch-ink: #ded4be; --swatch-shape: #b8a585; }
.preset-art--premium .preset-art__shape { border-radius: 48% 48% 0 0; }
.preset-art--warm { --swatch-bg: #e9d7c3; --swatch-ink: #6a4c3d; --swatch-shape: #af7c61; }
.preset-art--warm .preset-art__shape { border-radius: 50%; }
.preset-art--lively { --swatch-bg: #dae2c6; --swatch-ink: #35452f; --swatch-shape: #889961; }
.preset-art--lively .preset-art__shape { transform: rotate(-14deg); border-radius: 12%; }
.preset-art--tech { --swatch-bg: #171a32; --swatch-ink: #d4c6ac; --swatch-shape: #b7a88f; }
.preset-art--tech .preset-art__shape { width: 32%; aspect-ratio: 1; height: auto; border: 1px solid var(--khaki); border-radius: 50%; background: radial-gradient(circle at 30% 25%, #dcd1bd, #b7a88f 26%, #171a32 80%); }
.divider { display: flex; align-items: center; gap: 1rem; color: #8c8578; font-size: .72rem; }
.divider::before, .divider::after { flex: 1; height: 1px; background: var(--line); content: ""; }
.reference-list, .reference-row { display: grid; gap: 1rem; }
.reference-row .text-button { justify-self: start; }
.upsell { padding: 1.5rem; border: 1px solid var(--line); background: #eee8dd; }
.toggle-line { display: grid; grid-template-columns: auto 1fr; gap: .8rem; align-items: start; cursor: pointer; }
.toggle-line input, .consent-check input { flex: 0 0 auto; width: 1.2rem; height: 1.2rem; margin: .12rem 0 0; accent-color: var(--navy); }
.toggle-line span { display: grid; gap: .5rem; }
.toggle-line strong { font-weight: 500; }
.toggle-line small { color: var(--muted); font-size: .78rem; font-weight: 400; line-height: 1.75; }
.toggle-line b { grid-column: 2; font-size: .9rem; font-weight: 500; }
.option-card { display: grid; align-content: start; gap: 1rem; width: 100%; padding: 1.8rem 1.3rem 1.4rem; }
.manual-domain-card { display: grid; align-content: start; gap: 1rem; width: 100%; padding: 1.8rem 1.3rem 1.4rem; border: 1px solid var(--line); background: #f1ece3; }
.manual-domain-card strong { font-size: 1rem; font-weight: 500; }
.manual-domain-card > span { color: var(--muted); font-size: .8rem; line-height: 1.75; }
.manual-domain-card small, .manual-domain-handoff small { color: #8a8172; font-size: .73rem; line-height: 1.7; }
.manual-domain-card__link { align-self: end; color: #756852; font-size: .78rem; line-height: 1.7; text-underline-offset: .25rem; }
.option-card__top { display: grid; gap: .7rem; }
.option-card__top strong, .option-card > strong { font-size: 1rem; font-weight: 500; }
.option-card > span:not(.option-card__top), .module-card > span:not(.module-card__heading):not(.module-card__prices), .plan-card button > span { color: var(--muted); font-size: .8rem; line-height: 1.75; }
.option-card small { color: #8a8172; font-size: .73rem; line-height: 1.7; }
.option-card b, .plan-card b { font-size: .85rem; font-weight: 500; }
.module-option { display: grid; align-content: start; gap: .8rem; }
.module-card { display: grid; gap: .85rem; width: 100%; padding: 1.8rem 1.3rem 1.4rem; }
.module-card__heading { display: grid; gap: .5rem; }
.module-card__heading strong { font-size: .95rem; font-weight: 500; }
.module-card__heading > span { color: #8c806b; font-size: .65rem; }
.module-card__prices { display: flex; flex-wrap: wrap; gap: .6rem 1rem; color: var(--muted); }
.module-card__prices small { font-size: .66rem; }
.module-card em { color: #536648; font-size: .72rem; font-style: normal; }
.module-card:disabled.selected { opacity: 1; }
.coming-soon-badge, .manual-setup-badge { justify-self: start; padding: .3rem .5rem; font-size: .68rem; font-weight: 500; }
.coming-soon-badge { border: 1px solid #c7ad9c; background: #f0e1d5; color: #765443; }
.manual-setup-badge { border: 1px solid #c5b594; background: #eee3cb; color: #705b34; }
.checkout-zero { color: #765443; font-size: .78rem; font-weight: 500; }
.inbox-binding { display: grid; gap: .85rem; }
.inbox-binding p { margin: 0; font-size: .78rem; line-height: 1.75; }
.inbox-binding__row { display: grid; gap: .85rem; }
.preview-invitation { display: grid; justify-items: center; padding: 3rem 1.5rem; border: 1px solid var(--line); background: var(--ivory); text-align: center; }
.preview-invitation > span { display: grid; width: 3.5rem; height: 3.5rem; place-items: center; margin-bottom: 1.5rem; border: 1px solid #b4a58b; border-radius: 50%; color: #8a7a5f; font-size: 1.5rem; }
.preview-invitation h3 { font-size: 1.2rem; font-weight: 400; }
.preview-invitation p { margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.8; }
.preview-result { display: grid; gap: 1.25rem; }
.preview-result iframe { width: 100%; height: clamp(23rem, 58vh, 36rem); border: 1px solid var(--line); background: white; }
.notice, .success-panel { margin: 0; padding: .9rem 1rem; border-left: 2px solid #a6977e; background: #eae3d7; color: #615848; font-size: .78rem; line-height: 1.75; }
.preview-sections { display: grid; gap: .8rem; }
.preview-sections article { padding: 1rem; border-bottom: 1px solid var(--line); }
.preview-sections p { margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.75; }
.domain-builder, .agreement { display: grid; gap: 1.15rem; }
.domain-fields { display: grid; gap: 1rem; }
.domain-builder p, .success-panel a { overflow-wrap: anywhere; }
.domain-registrant { display: grid; gap: 1rem; padding-top: 1.25rem; border-top: 1px solid var(--line); }
.domain-registrant legend { float: left; width: 100%; margin-bottom: 0; }
.agreement__pane { max-height: 18rem; overflow-y: auto; overscroll-behavior: contain; padding: 1.25rem; border: 1px solid #bdb4a3; background: var(--paper); font-size: .85rem; line-height: 1.9; }
.agreement__pane p:first-child { margin-top: 0; }
.agreement__pane p:last-child { margin-bottom: 0; padding-bottom: 1rem; }
.scroll-status { margin: 0; color: #826640; font-size: .78rem; }
.scroll-status.done { color: #4b654b; }
.consent-check { display: flex; min-height: 44px; align-items: flex-start; gap: .8rem; cursor: pointer; font-size: .85rem; line-height: 1.75; }
.plan-card { position: relative; overflow: hidden; border: 1px solid var(--line); background: transparent; transition: border-color .2s ease, background .2s ease; }
.plan-card > button { display: grid; gap: 1rem; width: 100%; min-height: 50px; border: 0; padding: 1.8rem 1.3rem 1.4rem; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.plan-card > button strong { font-size: .95rem; font-weight: 500; line-height: 1.7; }
.plan-card fieldset { display: grid; gap: .5rem; padding: 0 1.3rem 1.4rem; }
.plan-card fieldset label { display: flex; min-height: 44px; align-items: center; gap: .6rem; font-size: .75rem; }
.plan-card fieldset input { width: 1.1rem; height: 1.1rem; accent-color: var(--navy); }
.quote { display: grid; gap: 1.25rem; background: transparent; }
.quote h3 { padding-bottom: .9rem; border-bottom: 1px solid var(--navy); }
.quote-group { padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
.quote-group h4 { color: #8b7c65; font-size: .72rem; font-weight: 400; }
.quote-group dl, .future-charges { display: grid; gap: .75rem; margin: .8rem 0 0; font-size: .85rem; line-height: 1.7; }
.quote-group dl div, .future-charges div { display: flex; justify-content: space-between; gap: 1rem; }
.quote-group dd, .future-charges dd { margin: 0; text-align: right; white-space: nowrap; }
.quote-total { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 1rem 0 .2rem; }
.quote-total > span { font-size: .9rem; }
.quote-total strong { font: 400 clamp(1.75rem, 4vw, 2.55rem)/1 Georgia, serif; white-space: nowrap; }
.future-charges { padding: 1rem; background: var(--ivory); color: var(--muted); font-size: .78rem; }
.checkout-action { display: grid; gap: 1rem; }
.manual-domain-handoff { display: grid; gap: 1rem; padding: 1.25rem; border: 1px solid #bcae95; background: #f1ece3; }
.manual-domain-handoff h3, .manual-domain-handoff p { margin: 0; }
.manual-domain-handoff p { color: var(--muted); font-size: .8rem; line-height: 1.75; }
.manual-domain-handoff__actions { display: flex; flex-wrap: wrap; gap: .75rem; }
.success-panel { border-color: #7c9272; background: #e6eadf; color: #4a6046; }
.step-footer { position: fixed; z-index: 10; right: 0; bottom: 0; left: 0; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .7rem; padding: .85rem max(1rem, env(safe-area-inset-right)) max(.85rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); border-top: 1px solid var(--line); background: rgba(238, 233, 223, .98); }
.step-footer__status { min-width: 0; }
.save-state { overflow-wrap: anywhere; color: #8a8378; font-size: .68rem; line-height: 1.6; text-align: center; }
.save-state--success { color: #536c4c; }
.save-state--error { color: #863d31; }
.step-footer__end { color: var(--muted); font-size: .75rem; }
@media (hover: hover) and (pointer: fine) {
  .choice-row button:not(:disabled):hover, .preset-grid button:not(:disabled):hover, .option-card:not(:disabled):hover, .module-card:not(:disabled):hover, .plan-card:hover { border-color: #8e7d61; background: #efe8dc; transform: translateY(-3px); }
  .chip-grid button:not(:disabled):hover { border-color: var(--navy); }
  .button:not(:disabled):hover { background: #2b304e; transform: translateY(-1px); }
  .button--secondary:not(:disabled):hover { background: var(--accent-soft); }
  .text-button:not(:disabled):hover { color: #9b886a; }
}
@media (min-width: 48rem) {
  .wizard { padding-bottom: 3rem; }
  .choice-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .preset-grid, .card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .module-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .contact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .reference-row { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
  .domain-fields { grid-template-columns: minmax(0, 1fr) minmax(12rem, .7fr); }
  .inbox-binding__row { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
  .step-footer { position: sticky; right: auto; bottom: 0; left: auto; margin: 1rem 0 0; padding: 1.1rem 0; background: rgba(238, 233, 223, .98); }
  .step-footer .button { min-width: 8rem; }
}
@media (min-width: 64rem) {
  .progress__mobile p { display: none; }
  .progress__steps { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: .4rem; padding: 1rem 0 0; margin: 0; list-style: none; }
  .progress__steps button { display: flex; width: 100%; min-height: 44px; align-items: center; gap: .45rem; border: 0; padding: .4rem 0; background: transparent; color: #9a9386; cursor: pointer; text-align: left; }
  .progress__steps button span { color: #a49780; font: .58rem/1 monospace; }
  .progress__steps button small { font-size: .72rem; font-weight: 400; }
  .progress__steps .is-complete button { color: #6e675b; }
  .progress__steps .is-current button { color: var(--navy); }
  .progress__steps .is-current button small { font-weight: 600; }
  .progress__steps .is-current button span { color: var(--navy); }
  .progress__steps button:disabled { opacity: 1; cursor: default; }
}
@media (min-width: 76rem) {
  .company-form-layout { display: grid; grid-template-columns: minmax(0, 1fr) 11rem; gap: 3rem; align-items: start; }
  .company-completion { position: sticky; top: 2rem; display: block; margin-top: 2.5rem; padding-left: 1.5rem; border-left: 1px solid var(--line); }
  .company-completion > p { margin: 0 0 .75rem; color: #8b806b; font-size: .68rem; }
  .company-completion > div { display: flex; align-items: baseline; gap: .3rem; margin-bottom: 1.25rem; }
  .company-completion > div strong { font: 400 2rem/1 Georgia, serif; }
  .company-completion > div span { color: var(--muted); font-size: .62rem; }
  .company-completion ol { display: grid; gap: .8rem; padding: 0 0 1.3rem; margin: 0; border-bottom: 1px solid var(--line); list-style: none; }
  .company-completion li { position: relative; padding-left: 1.25rem; color: #a49b8c; font-size: .73rem; line-height: 1.5; }
  .company-completion li::before { position: absolute; top: .1rem; left: 0; color: #c4bcae; content: "○"; }
  .company-completion li.is-complete { color: var(--ink); }
  .company-completion li.is-complete::before { color: #7b8867; content: "✓"; }
  .company-completion > small { display: block; margin-top: 1rem; color: var(--muted); font-size: .68rem; line-height: 1.85; }
}
@media (max-width: 47.99rem) {
  .studio-nav { min-height: 4.5rem; gap: .8rem; }
  .studio-nav__brand { gap: .4rem; font-size: .9rem; }
  .studio-nav__label { display: none; }
  .studio-nav .text-button { margin-left: auto; font-size: .68rem; }
  .wizard__header { grid-template-columns: 1fr; min-height: 0; gap: 1.5rem; padding: 2rem 0; }
  .wizard__header h1 { font-size: clamp(2.2rem, 8vw, 3.4rem); }
  .wizard__header .eyebrow { font-size: .55rem; letter-spacing: .14em; }
  .studio-object { display: none; }
  .wizard__header--compact { padding: 1.2rem 0 1.5rem; }
  .wizard__header--compact h1 { font-size: 1rem; }
  .wizard__workspace { gap: 1.1rem; }
  .progress { padding-top: 1.4rem; }
  .step-card__number { display: none; }
  .step-card__header .eyebrow { font-size: .5rem; }
  .step-card__header p:last-child { font-size: .8rem; }
  .choice-row button { min-height: 10rem; }
  .preset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
  .preset-grid button { padding: .5rem .5rem 1rem; }
  .preset-grid button > span:not(.preset-art) { font-size: .67rem; }
  .preset-grid button > strong { font-size: .78rem; }
  .step-footer .button { min-width: 5rem; min-height: 44px; padding: .7rem .9rem; font-size: .78rem; }
}
@media (max-width: 23rem) {
  .studio-nav__brand { font-size: .8rem; }
  .brand-mark { width: 20px; }
  .step-footer { gap: .4rem; }
  .save-state { font-size: .6rem; }
  .quote-total { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  .step-card, .studio-object__window { animation: none; }
  .wizard *, .wizard *::before, .wizard *::after { transition: none !important; }
  .choice-row button:not(:disabled):hover, .preset-grid button:not(:disabled):hover, .option-card:not(:disabled):hover, .module-card:not(:disabled):hover, .plan-card:hover, .button:not(:disabled):hover { transform: none; }
}
@keyframes studio-arrive { from { opacity: 0; transform: rotateY(-12deg) rotateX(5deg) rotate(-3deg) translateY(1rem); } to { opacity: 1; transform: rotateY(-12deg) rotateX(5deg) rotate(-3deg) translateY(0); } }
@keyframes paper-arrive { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
</style>
