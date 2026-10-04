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
  domainOptions: ('existing' | 'new' | 'assisted')[]
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
type SiteAnalysis = {
  analysedAt: string
  analysisVersion: string
  snapshotFingerprint: string
  scores: ScoreSet
  recommendationKeys: string[]
}
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
const loading = ref(true)
const bootstrapError = ref('')
const catalog = ref<PriceCatalog | null>(null)
const sessionId = ref<number | null>(null)
const sessionToken = ref('')
const sessionProjection = ref<SessionProjection | null>(null)
const currentStep = ref(1)
const saveStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')
const saveMessage = ref('')
const analysisResult = ref<SiteAnalysis | null>(null)
const analysisStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const analysisError = ref('')
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
const resendSeconds = computed(() => contactInbox.value.resendAvailableAt ? Math.max(0, Math.ceil((Date.parse(contactInbox.value.resendAvailableAt) - countdownNow.value) * 0.001)) : 0)
const inboxBusy = computed(() => inboxBindingStatus.value !== 'idle')
const scoreRows = [
  { key: 'overall', label: '整體清楚度', help: '綜合看網站是否容易理解與使用。' },
  { key: 'seo', label: '搜尋基本功', help: '檢查搜尋服務需要的基本頁面線索。' },
  { key: 'geo', label: '內容可理解度', help: '檢查內容是否容易被搜尋與問答服務理解。' },
  { key: 'brandContent', label: '品牌內容', help: '檢查品牌、服務與信任資訊是否說得清楚。' },
  { key: 'ux', label: '使用體驗', help: '檢查訪客是否容易找到下一步。' },
] as const
const recommendationCopy: Record<string, string> = {
  remove_noindex: '確認首頁沒有阻擋搜尋服務讀取。',
  clarify_page_topic: '把頁面主題與主要服務說得更清楚。',
  add_primary_action: '加上一個明確的聯絡、預約或購買入口。',
  improve_service_routing: '讓訪客更容易前往各項服務內容。',
  add_canonical: '補上首頁的正式網址標示。',
  add_structured_data: '補充能協助搜尋服務理解內容的標記。',
  add_trust_evidence: '加入案例、評價或其他可信的品牌證明。',
  add_answer_content: '補充客人常問問題的直接答案。',
  add_human_contact: '提供清楚的真人聯絡方式。',
  review_deeper_pages: '首頁基礎狀況良好，下一步可再檢查內頁。',
}
const domainOptionCopy: Record<'existing' | 'new' | 'assisted', { label: string; help: string }> = {
  existing: { label: '我有自己的網域', help: '結帳後協助把你現有的網址連到新網站。' },
  new: { label: '幫我註冊新網域', help: '先選想要的名稱與結尾，結帳後由我們代為註冊，並自動連接到建好的網站。' },
  assisted: { label: '請你們代辦', help: '由我們代為註冊與設定，另收設定費。' },
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
    analysisResult.value = null
    analysisStatus.value = 'idle'
  },
})

function selectHasSite(hasSite: boolean) {
  if (answers.value.existingSite?.hasSite === hasSite) return
  answers.value.existingSite = hasSite ? { hasSite: true, url: '' } : { hasSite: false }
  analysisResult.value = null
  analysisStatus.value = 'idle'
  analysisError.value = ''
}

function validHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

async function analyseSite() {
  const url = existingSiteUrl.value.trim()
  if (!validHttpsUrl(url)) {
    analysisStatus.value = 'error'
    analysisError.value = '請輸入完整的 https 網址。'
    return
  }
  analysisStatus.value = 'loading'
  analysisError.value = ''
  try {
    const result = await funnelFetch<{ analysis: SiteAnalysis; session: SessionProjection }>('/site-analysis', { method: 'POST', body: { url } })
    analysisResult.value = result.analysis
    answers.value.existingSite = result.session.answers.existingSite
    sessionProjection.value = result.session
    analysisStatus.value = 'success'
  } catch (error) {
    analysisStatus.value = 'error'
    analysisError.value = requestFailureMessage(error, '目前無法分析這個網站，請稍後再試。')
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

function selectDomainOption(option: 'existing' | 'new' | 'assisted') {
  if (answers.value.domain?.option === option) return
  answers.value.domain = option === 'new' ? { option, name: '', tld: catalog.value?.domainTlds[0]?.tld } : { option }
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

function formatDelta(value: number): string {
  return value > 0 ? `＋${value}` : String(value)
}

onMounted(() => {
  countdownTimer = setInterval(() => { countdownNow.value = Date.now() }, 1000)
  void bootstrap()
})
onBeforeUnmount(() => { if (countdownTimer) clearInterval(countdownTimer) })
</script>

<template>
  <main class="wizard" aria-labelledby="wizard-title">
    <header class="wizard__header" :class="{ 'wizard__header--compact': currentStep > 1 }">
      <div class="brand-mark" aria-hidden="true"><strong>DS</strong><small>WEB ATELIER</small></div>
      <div class="wizard__intro">
        <p class="eyebrow">DISCOVERYSTACK · 網站訂購禮賓</p>
        <h1 id="wizard-title">讓你的品牌，<br>優雅地上線。</h1>
        <p class="lede">從內容、設計、網域到付款，我們把複雜的建站過程整理成幾個簡單問題。每完成一步，進度就會為你保存。</p>
        <ul class="hero-promises" aria-label="流程特色">
          <li>一步一存</li>
          <li>付款前看清費用</li>
          <li>網域與網站一起完成</li>
        </ul>
      </div>
      <button type="button" class="text-button" :disabled="navigationBusy" @click="restart">重新開始</button>
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
        <div class="progress__intro" aria-hidden="true">
          <p>YOUR WEBSITE</p>
          <strong>建站進度</strong>
          <span>跟著九個步驟，完成你的品牌網站。</span>
        </div>
        <div class="progress__mobile">
          <p>第 {{ currentStep }} 步，共 9 步 · {{ currentStepMeta.title }}</p>
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
            <p class="eyebrow">第 {{ currentStep }} 步 · 共 9 步</p>
            <h2 :id="`step-title-${currentStep}`" ref="stepHeading" tabindex="-1">{{ currentStepMeta.title }}</h2>
            <p>{{ currentStepMeta.help }}</p>
          </div>
        </header>

        <div v-if="currentStep === 1" class="step-body">
          <fieldset>
            <legend>你目前有網站嗎？</legend>
            <div class="choice-row" role="radiogroup" aria-label="目前是否有網站">
              <button type="button" role="radio" :aria-checked="answers.existingSite?.hasSite === true" :class="{ selected: answers.existingSite?.hasSite === true }" @keydown.left.prevent="selectHasSite(true)" @keydown.up.prevent="selectHasSite(true)" @keydown.right.prevent="selectHasSite(false)" @keydown.down.prevent="selectHasSite(false)" @click="selectHasSite(true)">
                <span class="choice-card__mark" aria-hidden="true">↗</span><strong>有，我想先看看現況</strong><small>先分析舊網站，再決定要保留與更新的內容</small>
              </button>
              <button type="button" role="radio" :aria-checked="answers.existingSite?.hasSite === false" :class="{ selected: answers.existingSite?.hasSite === false }" @keydown.left.prevent="selectHasSite(true)" @keydown.up.prevent="selectHasSite(true)" @keydown.right.prevent="selectHasSite(false)" @keydown.down.prevent="selectHasSite(false)" @click="selectHasSite(false)">
                <span class="choice-card__mark" aria-hidden="true">＋</span><strong>沒有，從新網站開始</strong><small>從品牌內容、視覺風格到網址一起完成</small>
              </button>
            </div>
          </fieldset>
          <div v-if="answers.existingSite?.hasSite" class="field-group">
            <label for="existing-site-url">目前的網站網址</label>
            <input id="existing-site-url" v-model="existingSiteUrl" type="url" inputmode="url" autocomplete="url" maxlength="2048" placeholder="https://example.com">
            <button type="button" class="button button--secondary" :disabled="analysisStatus === 'loading'" @click="analyseSite">{{ analysisStatus === 'loading' ? '正在查看…' : '幫我看看目前的網站' }}</button>
            <p v-if="analysisError" class="inline-error" role="alert">{{ analysisError }}</p>
          </div>
          <section v-if="analysisResult" class="analysis" aria-labelledby="analysis-title">
            <h3 id="analysis-title">目前網站的首頁觀察</h3>
            <div v-for="row in scoreRows" :key="row.key" class="score-row">
              <div><strong>{{ row.label }}</strong><span>{{ analysisResult.scores[row.key] }}</span></div>
              <div class="score-bar" :aria-label="`${row.label} ${analysisResult.scores[row.key]} 分`"><span :style="{ width: `${analysisResult.scores[row.key]}%` }"></span></div>
              <p>{{ row.help }}</p>
            </div>
            <h3>建議先處理</h3>
            <ul><li v-for="key in analysisResult.recommendationKeys" :key="key">{{ recommendationCopy[key] || '建議再由專人檢查這個項目。' }}</li></ul>
          </section>
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
            <legend>選一種喜歡的風格</legend>
            <div class="preset-grid">
              <button v-for="preset in STYLE_PRESETS" :key="preset.key" type="button" role="radio" :aria-checked="answers.style.stylePreset === preset.key" :class="{ selected: answers.style.stylePreset === preset.key }" @click="answers.style.stylePreset = preset.key">
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
          <button type="button" class="button" :disabled="draftStatus === 'loading'" @click="generatePreview">{{ draftStatus === 'loading' ? '正在製作示意預覽…' : '幫我做一份示意預覽' }}</button>
          <section v-if="draft" class="preview-result" aria-labelledby="preview-result-title">
            <h3 id="preview-result-title">{{ draft.headline }}</h3>
            <p class="notice">{{ draft.sourceReason }}</p>
            <iframe sandbox="" referrerpolicy="no-referrer" title="示意預覽" :srcdoc="draft.html"></iframe>
            <div class="preview-sections">
              <article v-for="section in draft.sections" :key="section.heading"><h4>{{ section.heading }}</h4><p>{{ section.body }}</p></article>
            </div>
            <div v-if="draft.comparison" class="comparison">
              <h3>現有首頁與示意預覽比較</h3>
              <div class="table-wrap"><table><thead><tr><th>項目</th><th>目前</th><th>示意預覽</th><th>變化</th></tr></thead><tbody><tr v-for="row in scoreRows" :key="row.key"><th>{{ row.label }}</th><td>{{ draft.comparison.before.scores[row.key] }}</td><td>{{ draft.comparison.after.scores[row.key] }}</td><td>{{ formatDelta(draft.comparison.deltas[row.key]) }}</td></tr></tbody></table></div>
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
                <b v-if="option === 'assisted'">{{ formatTwd(catalog.assistedDomainSetupMinor) }}</b>
              </button>
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
            <section class="quote" aria-labelledby="quote-title">
              <h3 id="quote-title">費用明細</h3>
              <div v-for="group in [{ key: 'one_time' as const, label: '一次性建置費用' }, { key: 'monthly' as const, label: '每月服務費' }, { key: 'annual' as const, label: '網域年費' }]" :key="group.key" class="quote-group">
                <h4>{{ group.label }}</h4>
                <p v-if="!quoteLines(group.key).length" class="muted">這一類目前沒有費用。</p>
                <dl v-else><div v-for="line in quoteLines(group.key)" :key="line.lineKey"><dt>{{ line.description }}</dt><dd>{{ formatTwd(line.lineAmountMinor) }}</dd></div></dl>
              </div>
              <div class="quote-total"><span>今天要付</span><strong>{{ formatTwd(quote.totals.dueTodayMinor) }}</strong></div>
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
              <template v-if="!paymentVerified">
              <button type="button" class="button button--wide" :disabled="checkoutStatus === 'loading'" @click="startCheckout">{{ checkoutStatus === 'loading' ? '正在前往付款…' : '確認並付款' }}</button>
              <p v-if="checkoutError" class="inline-error" role="alert">{{ checkoutError }}</p>
              <p v-if="sessionProjection.testMode === true" class="notice">這是測試模式付款</p>
              <p v-if="quote.comingSoonModules.length" class="notice">你選擇的即將推出模組已登記需求，但本次不會開通，也未收取任何費用。</p>
              <p v-if="hasManualSetupModules" class="notice">你選擇的人工設定模組已列入費用，付款後由我們為你設定開通；完成前不會顯示為已開通。</p>
              <p v-if="contactModuleSelected && contactInbox.status !== 'bound'" class="notice">聯絡表單尚未綁定收信信箱；表單送出的資料仍會保存並可查看，但不會轉寄到信箱，你仍可完成結帳並於之後綁定。</p>
              <p v-else-if="contactModuleSelected" class="notice">聯絡表單送出的資料仍會保存並可查看；也會另外轉寄到已綁定的收信信箱 {{ contactInbox.maskedEmail }}，之後仍可換綁其他信箱。</p>
              <p v-if="answers.domain?.option === 'new'" class="notice">新網域結帳後由我們代為註冊，實際可註冊狀態會再確認。</p>
              <p v-else-if="answers.domain?.option === 'assisted'" class="notice">網域結帳後由我們代為註冊與設定，客服會與你確認需要的資料。</p>
              <p v-else class="notice">付款後會與你確認現有網域的連接方式。</p>
              </template>
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
:global(body) { margin: 0; background: #f7f5ef; }
.wizard,
.wizard * { box-sizing: border-box; }
.wizard {
  --accent: #4d5dad;
  --ink-strong: #17233b;
  --accent-mid: #6876bd;
  --accent-soft: #e4e7f6;
  --accent-deep: #39488c;
  --cream: #f7f5ef;
  --paper: #fffdf8;
  --blush: #f7f5ef;
  --ink: #1b2236;
  --muted: #5e6575;
  --line: #d9d5cc;
  --motion-fast: .16s;
  --motion-normal: .2s;
  --motion-ease: cubic-bezier(.22, .8, .24, 1);
  position: relative;
  min-height: 100vh;
  overflow-x: clip;
  overflow-y: visible;
  padding: clamp(1rem, 3vw, 2.75rem) clamp(1rem, 4vw, 3rem) 7.5rem;
  background: var(--cream);
  color: var(--ink);
  font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
}
.wizard::before {
  display: none;
}
.wizard > * { position: relative; z-index: 1; }
.wizard__header {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1.25rem;
  max-width: 78rem;
  min-height: 14rem;
  overflow: hidden;
  margin: 0 auto 1rem;
  padding: clamp(1.5rem, 5vw, 4rem);
  border: 1px solid var(--line);
  border-radius: .12rem;
  background: var(--paper);
  box-shadow: 0 .75rem 2.4rem rgba(23, 35, 59, .055);
  animation: cover-reveal .22s var(--motion-ease) both;
}
.wizard__header::after {
  position: absolute;
  right: clamp(1.5rem, 5vw, 4rem);
  bottom: 0;
  width: clamp(4rem, 10vw, 7rem);
  height: 2px;
  background: var(--accent);
  content: "";
}
.brand-mark {
  position: relative;
  display: grid;
  width: 4.6rem;
  height: 4.6rem;
  align-content: center;
  justify-items: center;
  border: 1px solid var(--ink-strong);
  background: var(--ink-strong);
  color: white;
  box-shadow: inset 0 0 0 .3rem rgba(255, 255, 255, .06), 0 .55rem 1.25rem rgba(23, 35, 59, .14);
}
.brand-mark::after { position: absolute; inset: .27rem; border: 1px solid rgba(255, 255, 255, .2); content: ""; }
.brand-mark strong {
  color: #f7f5ef;
  font: 500 1.65rem/1 "Noto Serif TC", "Songti TC", serif;
  letter-spacing: .08em;
}
.brand-mark small { margin-top: .35rem; font: 650 .42rem/1.2 "DM Mono", monospace; letter-spacing: .12em; }
.wizard__intro { max-width: 45rem; }
.wizard__header--compact {
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  min-height: 0;
  padding: .9rem 1rem;
  box-shadow: none;
}
.wizard__header--compact::after { display: none; }
.wizard__header--compact .brand-mark { width: 3.15rem; height: 3.15rem; box-shadow: none; }
.wizard__header--compact .brand-mark strong { font-size: 1.15rem; }
.wizard__header--compact .brand-mark small { display: none; }
.wizard__header--compact .eyebrow { margin: 0 0 .2rem; font-size: .62rem; }
.wizard__header--compact h1 { max-width: none; font-size: clamp(1.12rem, 2.4vw, 1.55rem); line-height: 1.35; letter-spacing: -.015em; }
.wizard__header--compact h1 br { display: none; }
.wizard__header--compact .lede,
.wizard__header--compact .hero-promises { display: none; }
.wizard__header--compact > .text-button { grid-column: auto; align-self: center; justify-self: end; min-width: auto; border: 0; padding: .7rem .4rem; text-decoration: underline; }
.eyebrow {
  margin: 0 0 .65rem;
  color: var(--accent);
  font: 750 .72rem/1.4 "DM Mono", "Noto Sans TC", monospace;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.wizard__header .eyebrow { color: var(--accent); }
h1, h2, h3, .quote-total strong { font-family: "Noto Serif TC", "Songti TC", serif; }
h1 {
  max-width: 10em;
  margin: 0;
  color: var(--ink-strong);
  font-size: clamp(2.25rem, 7vw, 4.75rem);
  font-weight: 600;
  line-height: 1.18;
  letter-spacing: -.045em;
}
h2 { margin: 0; font-size: clamp(1.75rem, 4vw, 2.6rem); font-weight: 650; line-height: 1.26; letter-spacing: -.025em; }
h3 { margin: 0 0 .8rem; font-size: 1.25rem; font-weight: 650; line-height: 1.4; }
h4 { margin: 0 0 .5rem; font-weight: 750; }
.lede {
  max-width: 39rem;
  margin: 1rem 0 0;
  color: var(--muted);
  font-size: .96rem;
  line-height: 1.8;
}
.hero-promises {
  display: flex;
  flex-wrap: wrap;
  gap: .55rem 1rem;
  padding: 0;
  margin: 1.4rem 0 0;
  color: var(--muted);
  font-size: .78rem;
  list-style: none;
}
.hero-promises li { display: flex; align-items: center; gap: .45rem; }
.hero-promises li::before { width: 1.15rem; height: 1px; background: #8993cd; content: ""; }
.text-button {
  min-height: 44px;
  border: 0;
  padding: .55rem;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-weight: 750;
  text-decoration: underline;
  text-underline-offset: .25rem;
}
.wizard__header > .text-button {
  grid-column: 1 / -1;
  justify-self: start;
  align-self: end;
  min-width: 7rem;
  border: 1px solid #cfc9bd;
  padding: .7rem 1rem;
  color: var(--accent);
  text-decoration: none;
}
.wizard__header button:focus-visible { outline-color: var(--accent); box-shadow: 0 0 0 4px rgba(77, 93, 173, .14); }
.progress button:focus-visible { outline-color: #f7f5ef; box-shadow: 0 0 0 2px var(--accent), 0 0 0 5px #c8cdec; }
.state {
  max-width: 78rem;
  margin: 1rem auto;
  padding: 1.25rem;
  border: 1px solid var(--line);
  border-radius: .12rem;
  background: var(--paper);
  box-shadow: 0 .75rem 2rem rgba(23, 35, 59, .055);
}
.state--error { border-color: #c98579; background: #fff2ed; color: #812e27; }
.wizard__workspace { display: grid; gap: 1rem; max-width: 78rem; margin: 0 auto; }
.wizard__stage { min-width: 0; }
.progress {
  margin: 0;
  padding: 1rem 1.1rem;
  border: 1px solid var(--line);
  border-radius: .12rem;
  background: var(--paper);
  box-shadow: 0 .5rem 1.5rem rgba(23, 35, 59, .045);
}
.progress__intro { display: none; }
.progress__mobile p { margin: 0 0 .65rem; color: var(--ink); font-size: .86rem; font-weight: 750; }
.progress__bar { height: .3rem; overflow: hidden; background: var(--accent-soft); }
.progress__bar span { display: block; height: 100%; background: var(--accent); transition: width var(--motion-normal) var(--motion-ease); }
.progress__steps { display: none; padding: 0; margin: 0; list-style: none; }
.step-card {
  position: relative;
  overflow: clip;
  border: 1px solid #e1ddd4;
  border-radius: .12rem;
  background: var(--paper);
  box-shadow: 0 .9rem 2.8rem rgba(23, 35, 59, .065);
  animation: paper-arrive .22s var(--motion-ease) both;
}
.step-card::after {
  display: none;
}
.step-card > * { position: relative; z-index: 1; }
.step-card__header {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1rem;
  padding: clamp(1.4rem, 4vw, 2.6rem);
  border-bottom: 1px solid #dfe1ed;
  background: #f1f2f7;
  color: var(--ink);
}
.step-card__number {
  min-width: 2.8rem;
  padding-top: .1rem;
  border-right: 1px solid rgba(77, 93, 173, .3);
  color: var(--ink-strong);
  font: 500 1.55rem/1 "DM Mono", monospace;
  letter-spacing: -.08em;
}
.step-card__header .eyebrow { margin-bottom: .45rem; color: var(--accent); }
.step-card__header h2:focus { outline: none; }
.step-card__header p:last-child { max-width: 42rem; margin: .7rem 0 0; color: var(--muted); line-height: 1.65; }
.step-body { display: grid; gap: 1.5rem; padding: clamp(1.35rem, 4vw, 2.6rem); }
.step-body > *, .preview-result > * { min-width: 0; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend, label { color: var(--ink); font-weight: 750; }
legend { margin-bottom: .8rem; font-size: 1rem; }
button, input, textarea, select { font: inherit; }
button { touch-action: manipulation; }
input:not([type="checkbox"]):not([type="radio"]), textarea, select {
  width: 100%;
  min-height: 48px;
  border: 0;
  border-bottom: 1px solid #aeb3c3;
  border-radius: 0;
  padding: .8rem .35rem;
  background: transparent;
  color: var(--ink);
  box-shadow: none;
  transition: color var(--motion-fast) ease, border-color var(--motion-fast) ease, background var(--motion-fast) ease;
}
textarea { min-height: 7.5rem; border: 1px solid #aeb3c3; padding: .9rem; resize: vertical; line-height: 1.7; }
input::placeholder, textarea::placeholder { color: #7d8492; opacity: .72; }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, .agreement__pane:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}
input:not([type="checkbox"]):not([type="radio"]):focus, textarea:focus, select:focus { border-color: var(--accent); background: rgba(228, 231, 246, .24); box-shadow: none; }
.field-group { display: grid; gap: .48rem; min-width: 0; }
.field-group label { transition: color var(--motion-fast) ease; }
.field-group:focus-within label { color: var(--accent-deep); }
.field-group small, .hint, .muted { color: var(--muted); }
.field-group > small { justify-self: end; }
.field-group__topline { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.field-group__topline small { flex: 0 0 auto; font-size: .72rem; font-variant-numeric: tabular-nums; }
.required-mark { margin-left: .25rem; color: var(--accent-deep); font-size: .68rem; font-weight: 800; letter-spacing: .05em; }
.optional-mark { margin-left: .25rem; color: var(--muted); font-size: .75rem; font-weight: 500; }
.field-hint { margin: -.2rem 0 .7rem; color: var(--muted); font-size: .8rem; line-height: 1.6; }
.choice-row { display: grid; grid-template-columns: 1fr; gap: .8rem; }
.chip-grid { display: flex; flex-wrap: wrap; gap: .55rem; }
.choice-row button, .chip-grid button, .preset-grid button, .option-card, .module-card {
  position: relative;
  min-height: 50px;
  border: 1px solid var(--line);
  border-radius: .12rem;
  padding: 1rem;
  background: #fbfaf7;
  color: var(--ink);
  cursor: pointer;
  text-align: left;
  transition: color var(--motion-fast) ease, background var(--motion-fast) ease, border-color var(--motion-fast) ease, transform var(--motion-fast) var(--motion-ease);
}
.choice-row button { display: grid; grid-template-columns: 2.6rem minmax(0, 1fr); gap: .2rem .8rem; align-items: center; min-height: 9rem; padding: 1.2rem; }
.choice-row button strong { grid-column: 2; font: 650 1.15rem/1.4 "Noto Serif TC", "Songti TC", serif; }
.choice-row button small { grid-column: 2; color: var(--muted); line-height: 1.55; }
.choice-card__mark { grid-row: 1 / 3; align-self: stretch; display: grid; place-items: center; border-right: 1px solid var(--line); color: var(--accent); font: 400 1.45rem/1 "DM Mono", monospace; }
.choice-row button.selected, .chip-grid button.selected, .preset-grid button.selected, .option-card.selected, .module-card.selected, .plan-card.selected {
  border-color: var(--accent);
  background: #eef0fb;
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--accent), 0 .45rem 1.1rem rgba(77, 93, 173, .1);
}
.choice-row button.selected::after, .preset-grid button.selected::after, .option-card.selected::after, .module-card.selected::after, .plan-card.selected::after {
  position: absolute;
  top: .65rem;
  right: .65rem;
  width: .28rem;
  height: 1.65rem;
  background: var(--accent);
  content: "";
}
.choice-row button.selected small, .preset-grid button.selected span, .option-card.selected span, .option-card.selected small, .module-card.selected > span, .plan-card.selected button > span { color: #51596f; }
.choice-row button.selected .choice-card__mark { border-color: rgba(77, 93, 173, .35); color: var(--accent); }
.chip-grid button {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: .5rem;
  min-height: 42px;
  border: 1px solid #aeb3c3;
  border-radius: .12rem;
  padding: .58rem .85rem;
  background: var(--paper);
  box-shadow: none;
}
.chip-grid__check { display: grid; flex: 0 0 auto; width: .95rem; height: .95rem; place-items: center; border: 1px solid var(--accent-mid); color: var(--paper); font-size: .62rem; line-height: 1; transition: color var(--motion-fast) ease, background var(--motion-fast) ease, border-color var(--motion-fast) ease, transform var(--motion-fast) var(--motion-ease); }
.chip-grid__check::after { content: ""; }
.chip-grid button.selected {
  border-color: var(--accent-deep);
  background: var(--accent-soft);
  color: var(--ink-strong);
  box-shadow: none;
}
.chip-grid button.selected .chip-grid__check { border-color: var(--accent-deep); background: var(--accent-deep); transform: scale(1.04); }
.chip-grid button.selected .chip-grid__check::after { content: "✓"; }
.button {
  position: relative;
  min-height: 48px;
  border: 1px solid var(--accent);
  border-radius: .08rem;
  padding: .82rem 1.25rem;
  background: var(--accent);
  color: var(--cream);
  cursor: pointer;
  font-weight: 800;
  letter-spacing: .02em;
  box-shadow: 0 .45rem 1.15rem rgba(23, 35, 59, .12);
  transition: color var(--motion-fast) ease, background var(--motion-fast) ease, border-color var(--motion-fast) ease, transform var(--motion-fast) var(--motion-ease), box-shadow var(--motion-fast) ease;
}
.button::before {
  display: none;
}
.button:active:not(:disabled) { transform: translateY(1px) scale(.992); box-shadow: 0 .25rem .7rem rgba(77, 93, 173, .14); }
.button:disabled, button:disabled { cursor: not-allowed; opacity: .52; transform: none; box-shadow: none; }
.button--secondary { border-color: var(--accent-mid); background: transparent; color: var(--ink); box-shadow: none; }
.button--wide { width: 100%; }
.checkout-action > .button--wide { border-color: var(--accent-deep); background: var(--accent-deep); color: white; box-shadow: 0 .65rem 1.5rem rgba(57, 72, 140, .18); }
.inline-error, .missing { margin: 0; color: #8c3028; line-height: 1.6; }
.missing { padding: 0 clamp(1.35rem, 4vw, 2.6rem) clamp(1.4rem, 4vw, 2.4rem); font-weight: 700; }
.fulfilment-panel, .analysis, .contact-block, .domain-builder, .agreement, .quote, .inbox-binding {
  padding: clamp(1rem, 3vw, 1.4rem);
  border: 1px solid var(--line);
  border-radius: .08rem;
  background: #fbfaf7;
}
.fulfilment-panel ul { display: grid; gap: .7rem; padding: 0; margin: 0; list-style: none; }
.fulfilment-panel li { display: flex; justify-content: space-between; gap: 1rem; }
.score-row { display: grid; gap: .35rem; margin-bottom: 1rem; }
.score-row > div:first-child { display: flex; justify-content: space-between; gap: 1rem; }
.score-row p { margin: 0; color: var(--muted); font-size: .88rem; }
.score-bar { height: .48rem; overflow: hidden; background: var(--accent-soft); }
.score-bar span { display: block; height: 100%; background: var(--accent); }
.contact-block { display: grid; gap: 1rem; padding-inline: 0; border-width: 1px 0; background: transparent; }
.contact-block h3 { display: flex; align-items: baseline; gap: 1rem; }
.step-body--company { display: block; padding-block: 0; }
.company-form-layout,
.company-form-column { min-width: 0; }
.company-section { padding: clamp(2rem, 4vw, 2.85rem) 0; border-bottom: 1px solid var(--line); }
.company-section:last-child { border-bottom: 0; }
.company-section__heading { display: grid; grid-template-columns: 2.15rem minmax(0, 1fr); gap: .7rem; align-items: baseline; margin-bottom: 1.65rem; }
.company-section__heading > span { color: var(--accent-mid); font: 500 .92rem/1 "Noto Serif TC", "Songti TC", serif; font-variant-numeric: tabular-nums; }
.company-section__heading h3 { margin: 0; color: var(--ink-strong); font-size: clamp(1.25rem, 2.4vw, 1.5rem); }
.company-section__body { display: grid; gap: 1.8rem; min-width: 0; }
.contact-grid { display: grid; grid-template-columns: 1fr; gap: 1.65rem 1.9rem; }
.contact-grid__wide { grid-column: 1 / -1; }
.company-completion { display: none; }
.preset-grid, .card-grid, .module-grid { display: grid; grid-template-columns: 1fr; gap: .85rem; }
.preset-grid button { display: grid; gap: .4rem; }
.preset-grid span, .option-card span, .module-card > span, .plan-card button > span { color: var(--muted); line-height: 1.55; }
.divider { display: flex; align-items: center; gap: .8rem; color: var(--muted); font-size: .84rem; }
.divider::before, .divider::after { flex: 1; height: 1px; background: var(--line); content: ""; }
.reference-list, .reference-row { display: grid; gap: .8rem; }
.reference-row { padding-bottom: .9rem; border-bottom: 1px solid var(--line); }
.reference-row .text-button { justify-self: start; }
.upsell { padding: 1.1rem 0; border: 1px solid var(--line); border-width: 1px 0; background: transparent; }
.toggle-line { display: grid; grid-template-columns: auto 1fr; gap: .75rem; align-items: start; cursor: pointer; }
.toggle-line input, .consent-check input { width: 1.35rem; height: 1.35rem; margin: .12rem 0 0; accent-color: var(--accent); }
.toggle-line span { display: grid; gap: .35rem; }
.toggle-line small { color: var(--muted); font-weight: 400; line-height: 1.55; }
.toggle-line b { grid-column: 2; color: var(--accent); }
.option-card { display: grid; gap: .6rem; width: 100%; }
.option-card__top, .module-card__heading, .module-card__prices { display: flex; justify-content: space-between; gap: .8rem; }
.option-card b, .module-card__prices, .plan-card b { color: var(--accent); }
.selected .option-card__top b, .module-card.selected .module-card__prices, .plan-card.selected b { color: var(--accent); }
.module-option { display: grid; align-content: start; gap: .8rem; }
.module-card { display: grid; gap: .7rem; width: 100%; }
.inbox-binding { display: grid; gap: .85rem; }
.inbox-binding p { margin: 0; line-height: 1.6; }
.inbox-binding__row { display: grid; gap: .75rem; }
.module-card em { color: #246448; font-size: .83rem; font-style: normal; font-weight: 800; }
.module-card em.manual { color: #805019; }
.coming-soon-badge, .manual-setup-badge { justify-self: start; padding: .35rem .65rem; font-size: .82rem; font-weight: 750; }
.coming-soon-badge { border: 1px solid #a14e42; background: #fff0e9; color: #842f29; }
.manual-setup-badge { border: 1px solid #a9792b; background: #fff4d9; color: #724613; }
.checkout-zero { color: #842f29; }
.preview-result { display: grid; gap: 1rem; }
.preview-result iframe { width: 100%; height: clamp(23rem, 58vh, 36rem); border: 1px solid var(--line); border-radius: .12rem; background: white; box-shadow: 0 .6rem 1.5rem rgba(23, 35, 59, .07); }
.notice, .success-panel { margin: 0; padding: .9rem 1rem; border-left: .24rem solid var(--accent); background: #f0f1f8; color: #384268; line-height: 1.6; }
.preview-sections { display: grid; gap: .75rem; }
.preview-sections article { padding: .9rem; border: 1px solid var(--line); background: #fffdf8; }
.preview-sections p { margin: 0; color: var(--muted); }
.table-wrap { overflow-x: auto; }
table { width: 100%; min-width: 30rem; border-collapse: collapse; }
th, td { padding: .72rem; border-bottom: 1px solid var(--line); text-align: left; }
.domain-builder { display: grid; gap: 1rem; }
.domain-fields { display: grid; gap: .85rem; }
.domain-builder strong, .domain-builder p, .success-panel a { overflow-wrap: anywhere; }
.agreement { display: grid; gap: .85rem; }
.agreement__pane { max-height: 18rem; overflow-y: auto; padding: 1rem; border: 1px solid #aeb3c3; background: #fffdf8; line-height: 1.75; }
.agreement__pane p:first-child { margin-top: 0; }
.agreement__pane p:last-child { margin-bottom: 0; padding-bottom: 1rem; }
.scroll-status { margin: 0; color: #744715; font-weight: 800; }
.scroll-status.done { color: #246448; }
.consent-check { display: flex; min-height: 44px; align-items: flex-start; gap: .7rem; cursor: pointer; line-height: 1.55; }
.plan-card { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: .08rem; background: #fbfaf7; transition: border-color .2s ease, background .2s ease, box-shadow .2s ease; }
.plan-card > button { display: grid; gap: .6rem; width: 100%; min-height: 50px; border: 0; padding: 1.1rem; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.plan-card fieldset { display: grid; gap: .5rem; padding: 0 1.1rem 1.1rem; color: inherit; }
.plan-card fieldset label { display: flex; min-height: 44px; align-items: center; gap: .6rem; color: inherit; }
.plan-card fieldset input { width: 1.2rem; height: 1.2rem; accent-color: var(--accent); }
.quote { display: grid; gap: 1.1rem; background: #fbfaf7; }
.quote h3 { padding-bottom: .75rem; border-bottom: 2px solid var(--ink); }
.quote-group { padding-bottom: .8rem; border-bottom: 1px solid var(--line); }
.quote-group dl, .future-charges { display: grid; gap: .6rem; margin: 0; }
.quote-group dl div, .future-charges div { display: flex; justify-content: space-between; gap: 1rem; }
.quote-group dd, .future-charges dd { margin: 0; font-weight: 800; text-align: right; white-space: nowrap; }
.quote-total { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 1rem 0 .2rem; }
.quote-total strong { color: var(--accent); font-size: clamp(1.8rem, 5vw, 2.55rem); font-weight: 650; line-height: 1; white-space: nowrap; }
.future-charges { padding: .9rem; background: var(--cream); }
.checkout-action { display: grid; gap: .85rem; }
.success-panel { border-color: #39775a; background: #e4efe5; color: #295a40; }
.step-footer {
  position: fixed;
  z-index: 10;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: .6rem;
  padding: .75rem max(1rem, env(safe-area-inset-right)) max(.75rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  border-top: 1px solid #d9d5cc;
  background: rgba(247, 245, 239, .96);
  box-shadow: 0 -.8rem 2rem rgba(23, 35, 59, .07);
}
.step-footer__status { min-width: 0; }
.save-state { min-width: 0; overflow-wrap: anywhere; color: var(--muted); font-size: .76rem; text-align: center; }
.save-state--success { color: #246448; }
.save-state--error { color: #8c3028; }
.step-footer__end { color: var(--accent); font-size: .78rem; font-weight: 800; letter-spacing: .06em; }
@media (hover: hover) and (pointer: fine) {
  .choice-row button:not(:disabled):hover, .preset-grid button:not(:disabled):hover, .option-card:not(:disabled):hover, .module-card:not(:disabled):hover, .plan-card:hover { transform: none; border-color: var(--accent); box-shadow: inset .22rem 0 0 var(--accent), 0 .35rem .9rem rgba(23, 35, 59, .07); }
  .chip-grid button:not(:disabled):hover { transform: translateY(-1px); border-color: var(--accent); color: var(--accent-deep); box-shadow: none; }
  .button:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 .55rem 1.25rem rgba(77, 93, 173, .18); }
  .text-button:not(:disabled):hover { color: var(--ink-strong); text-decoration-thickness: 2px; }
}
@media (min-width: 48rem) {
  .wizard { padding-bottom: 4rem; }
  .wizard__header { grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; }
  .wizard__header > .text-button { grid-column: auto; justify-self: end; }
  .choice-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .preset-grid, .card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .module-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .contact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .reference-row { grid-template-columns: 1fr auto; align-items: end; }
  .domain-fields { grid-template-columns: minmax(0, 1fr) minmax(12rem, .55fr); }
  .inbox-binding__row { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
  .step-footer { position: sticky; right: auto; bottom: .75rem; left: auto; z-index: 8; margin: 1rem 0 0; padding: .65rem; border: 1px solid var(--line); background: rgba(255, 253, 248, .97); box-shadow: 0 .7rem 2rem rgba(23, 35, 59, .09); }
}
@media (min-width: 64rem) {
  .wizard__workspace { grid-template-columns: 15rem minmax(0, 1fr); gap: 1.25rem; align-items: start; }
  .progress { position: sticky; top: 1.5rem; padding: 1.35rem 1.15rem 1.45rem; border-color: var(--line); background: var(--paper); color: var(--ink); box-shadow: 0 .75rem 2.25rem rgba(23, 35, 59, .055); }
  .progress__intro { display: grid; gap: .4rem; padding: .2rem .55rem 1.15rem; border-bottom: 1px solid var(--line); }
  .progress__intro p { margin: 0; color: var(--accent); font: 700 .62rem/1.4 "DM Mono", monospace; letter-spacing: .13em; }
  .progress__intro strong { color: var(--ink-strong); font: 600 1.4rem/1.3 "Noto Serif TC", "Songti TC", serif; }
  .progress__intro span { color: var(--muted); font-size: .76rem; line-height: 1.6; }
  .progress__mobile { display: none; }
  .progress__steps { position: relative; display: grid; gap: .1rem; margin-top: .7rem; }
  .progress__steps::before { position: absolute; top: 1.35rem; bottom: 1.35rem; left: 1.08rem; width: 1px; background: var(--line); content: ""; }
  .progress__steps button { position: relative; z-index: 1; display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: .65rem; align-items: center; width: 100%; min-height: 44px; border: 0; padding: .48rem .35rem; background: transparent; color: #858b98; cursor: pointer; text-align: left; transition: color var(--motion-fast) ease; }
  .progress__steps button span { display: grid; width: 1.55rem; height: 1.55rem; place-items: center; border: 1px solid #bfc3cd; border-radius: 50%; background: var(--paper); color: #737a89; font: 600 .62rem/1 "DM Mono", monospace; letter-spacing: -.02em; transition: color var(--motion-fast) ease, background var(--motion-fast) ease, border-color var(--motion-fast) ease; }
  .progress__steps button small { min-width: 0; overflow: hidden; font-size: .78rem; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }
  .progress__steps .is-complete button { color: #51596f; }
  .progress__steps .is-complete button span { border-color: var(--accent-mid); color: var(--accent); }
  .progress__steps .is-current button { color: var(--ink-strong); }
  .progress__steps .is-current button span { border-color: var(--ink-strong); background: var(--ink-strong); color: var(--paper); }
  .progress__steps button:disabled { cursor: default; opacity: 1; }
  .module-card:disabled.selected { opacity: 1; }
}
@media (min-width: 76rem) {
  .company-form-layout { display: grid; grid-template-columns: minmax(0, 1fr) 12.5rem; gap: clamp(2rem, 3.5vw, 3.25rem); align-items: start; }
  .company-completion { position: sticky; top: 1.5rem; display: block; align-self: start; margin-top: 2.7rem; padding-left: 1.35rem; border-left: 1px solid var(--line); }
  .company-completion > p { margin: 0 0 .5rem; color: var(--accent); font-size: .68rem; font-weight: 800; letter-spacing: .09em; }
  .company-completion > div { display: flex; align-items: baseline; gap: .35rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .company-completion > div strong { color: var(--ink-strong); font: 600 2rem/1 "Noto Serif TC", "Songti TC", serif; }
  .company-completion > div span { color: var(--muted); font-size: .7rem; }
  .company-completion ol { display: grid; gap: .72rem; padding: 1rem 0; margin: 0; border-bottom: 1px solid var(--line); list-style: none; }
  .company-completion li { position: relative; padding-left: 1.35rem; color: #858b98; font-size: .75rem; line-height: 1.35; transition: color var(--motion-fast) ease; }
  .company-completion li::before { position: absolute; top: .08rem; left: 0; display: grid; width: .86rem; height: .86rem; place-items: center; border: 1px solid #bfc3cd; color: transparent; content: "✓"; font-size: .58rem; line-height: 1; transition: color var(--motion-fast) ease, background var(--motion-fast) ease, border-color var(--motion-fast) ease; }
  .company-completion li.is-complete { color: var(--ink); }
  .company-completion li.is-complete::before { border-color: var(--accent); background: var(--accent); color: white; }
  .company-completion > small { display: block; margin-top: 1rem; color: var(--muted); font-size: .7rem; line-height: 1.65; }
}
@media (max-width: 30rem) {
  .wizard__header:not(.wizard__header--compact) { min-height: 16rem; }
  .wizard__header--compact { grid-template-columns: auto minmax(0, 1fr); padding: .72rem; }
  .wizard__header--compact > .text-button { display: none; }
  .brand-mark { width: 3.8rem; height: 3.8rem; }
  .wizard__header--compact .brand-mark { width: 2.7rem; height: 2.7rem; }
  .brand-mark small { display: none; }
  .hero-promises { display: grid; }
  .step-card__header { grid-template-columns: 1fr; padding-block: 1.15rem; }
  .step-card__number { display: none; }
  .step-footer .button { min-width: 5.2rem; padding-inline: .85rem; }
}
@media (prefers-reduced-motion: reduce) {
  .wizard__header, .step-card { animation: none; }
  .progress__bar span, .progress__steps button, .progress__steps button span, .choice-row button, .chip-grid button, .chip-grid__check, .preset-grid button, .option-card, .module-card, .plan-card, .button, .company-completion li, .company-completion li::before, input, textarea, select { transition: none; transform: none; }
}
@keyframes cover-reveal { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes paper-arrive { from { opacity: 0; transform: translateY(14px) scale(.992); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
