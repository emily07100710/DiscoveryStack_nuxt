<script setup lang="ts">
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

useHead({ meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

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

type SessionProjection = {
  status: string
  currentStep: number
  answers: FunnelAnswersView
  consentSnapshot: null | { policyVersion: string; acceptedAt: string; scrolledToBottom: true }
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
const domainAvailabilityMessage = ref('')
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
const currentMissing = computed(() => stepCompletion(currentStep.value, answers.value, { accepted: currentStep.value === 7 ? consentGate.value.canSubmit : consentAccepted.value }).missing)
const nextDisabled = computed(() => saveStatus.value === 'saving' || !canAdvance(currentStep.value, answers.value, { accepted: currentStep.value === 7 ? consentGate.value.canSubmit : consentAccepted.value }))
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
  new: { label: '幫我註冊新網域', help: '先選想要的名稱與結尾，結帳後由我們代為註冊。' },
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
  return await $fetch<SessionProjection>(funnelSessionPath(), { method: 'GET', credentials: 'omit', headers: funnelHeaders() })
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
  contactInbox.value = projection.contactInbox
  inboxAwaitingConfirmation.value = projection.contactInbox.status === 'pending'
  inboxRebinding.value = false
  consentAccepted.value = Boolean(projection.consentSnapshot?.scrolledToBottom)
  consentScrolledToBottom.value = consentAccepted.value
  consentChecked.value = consentAccepted.value
  builtPreviewUrl.value = projection.previewUrl || ''
  currentStep.value = Math.min(Math.max(projection.currentStep || 1, 1), firstIncompleteStep(answers.value, { accepted: consentAccepted.value }))
  prepareStep(currentStep.value)
}

async function createFreshSession() {
  const created = await $fetch<{ sessionId: number; sessionToken: string }>('/api/managed-sites/funnel/sessions', { method: 'POST', body: {}, credentials: 'omit' })
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
    return await $fetch<T>(funnelSessionPath(suffix), { ...options, credentials: 'omit', headers: { ...(options?.headers || {}), ...funnelHeaders() } })
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
    catalog.value = await $fetch<PriceCatalog>('/api/managed-sites/price-catalog', { credentials: 'omit' })
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
  return step < firstIncomplete.value || step === currentStep.value
}

function goToStep(step: number) {
  if (!isStepClickable(step)) return
  currentStep.value = step
  saveStatus.value = 'idle'
  saveMessage.value = ''
  prepareStep(step)
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
      consentAccepted.value = true
    }
    sessionProjection.value = projection
    saveStatus.value = 'success'
    saveMessage.value = '進度已儲存'
    currentStep.value = Math.min(savingStep + 1, 9)
    prepareStep(currentStep.value)
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
  answers.value.domain = option === 'new' ? { option, name: '', tld: catalog.value?.domainTlds[0]?.tld } : { option }
  domainAvailabilityMessage.value = ''
}

const domainName = computed({
  get: () => answers.value.domain?.name || '',
  set: (name: string) => {
    if (answers.value.domain?.option === 'new') answers.value.domain = { ...answers.value.domain, name: name.toLowerCase() }
    domainAvailabilityMessage.value = ''
  },
})

const domainTld = computed({
  get: () => answers.value.domain?.tld || '',
  set: (tld: string) => {
    if (answers.value.domain?.option === 'new') answers.value.domain = { ...answers.value.domain, tld }
    domainAvailabilityMessage.value = ''
  },
})

function checkDomainAvailability() {
  if (!domainName.value || !domainTld.value) {
    domainAvailabilityMessage.value = '請先填寫網域名稱並選擇結尾。'
    return
  }
  domainAvailabilityMessage.value = '可註冊狀態將於結帳後由我們代為確認與註冊'
}

function selectPlan(key: 'site_only' | 'site_geo' | 'site_geo_autopost') {
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
    <header class="wizard__header">
      <div>
        <p class="eyebrow">網站訂購流程</p>
        <h1 id="wizard-title">一步一步建立你的網站</h1>
        <p class="lede">不用準備技術資料，照著問題回答即可；每一步都會儲存，重整後可以接著完成。</p>
      </div>
      <button type="button" class="text-button" @click="restart">重新開始</button>
    </header>

    <p v-if="loading" class="state" role="status">載入中…</p>
    <section v-else-if="bootstrapError" class="state state--error" role="alert">
      <h2>目前無法載入訂購流程</h2>
      <p>{{ bootstrapError }}</p>
      <button type="button" class="button" @click="bootstrap">再試一次</button>
    </section>

    <template v-else-if="catalog && sessionProjection">
      <nav class="progress" aria-label="訂購進度">
        <div class="progress__mobile">
          <p>第 {{ currentStep }} 步，共 9 步 · {{ currentStepMeta.title }}</p>
          <div class="progress__bar" role="progressbar" :aria-valuenow="currentStep" aria-valuemin="1" aria-valuemax="9">
            <span :style="{ width: progressWidths[currentStep - 1] }"></span>
          </div>
        </div>
        <ol class="progress__steps">
          <li v-for="item in FUNNEL_STEPS" :key="item.key" :class="{ 'is-current': item.step === currentStep, 'is-complete': item.step < firstIncomplete }">
            <button type="button" :disabled="!isStepClickable(item.step)" :aria-current="item.step === currentStep ? 'step' : undefined" @click="goToStep(item.step)">
              <span>{{ item.step }}</span><small>{{ item.title }}</small>
            </button>
          </li>
        </ol>
      </nav>

      <section class="step-card" :aria-labelledby="`step-title-${currentStep}`">
        <header class="step-card__header">
          <p class="eyebrow">第 {{ currentStep }} 步</p>
          <h2 :id="`step-title-${currentStep}`">{{ currentStepMeta.title }}</h2>
          <p>{{ currentStepMeta.help }}</p>
        </header>

        <div v-if="currentStep === 1" class="step-body">
          <fieldset>
            <legend>你目前有網站嗎？</legend>
            <div class="choice-row">
              <button type="button" role="radio" :aria-checked="answers.existingSite?.hasSite === true" :class="{ selected: answers.existingSite?.hasSite === true }" @click="selectHasSite(true)">有，我想先看看現況</button>
              <button type="button" role="radio" :aria-checked="answers.existingSite?.hasSite === false" :class="{ selected: answers.existingSite?.hasSite === false }" @click="selectHasSite(false)">沒有，從新網站開始</button>
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

        <div v-else-if="currentStep === 2" class="step-body">
          <div class="field-group">
            <label for="brand-name">品牌名稱</label>
            <input id="brand-name" v-model.trim="answers.company.brandName" maxlength="160" autocomplete="organization">
            <small>{{ answers.company.brandName.length }} / 160</small>
          </div>
          <div class="field-group">
            <label for="what-we-do">你在做什麼</label>
            <textarea id="what-we-do" v-model.trim="answers.company.whatWeDo" rows="5" maxlength="2000" placeholder="用平常向客人介紹的方式說明即可"></textarea>
            <small>{{ answers.company.whatWeDo.length }} / 2000</small>
          </div>
          <fieldset>
            <legend>想給人什麼感覺（可複選）</legend>
            <div class="chip-grid">
              <button v-for="option in FEELING_OPTIONS" :key="option.key" type="button" role="checkbox" :aria-checked="answers.company.feelings.includes(option.key)" :class="{ selected: answers.company.feelings.includes(option.key) }" @click="toggleList(answers.company.feelings, option.key)">{{ option.label }}</button>
            </div>
          </fieldset>
          <div class="field-group">
            <label for="main-offer">主要賣什麼</label>
            <textarea id="main-offer" v-model.trim="answers.company.mainOffer" rows="4" maxlength="1000"></textarea>
            <small>已輸入 {{ answers.company.mainOffer.length }} 字，上限 1000 字</small>
          </div>
          <fieldset>
            <legend>希望怎麼成交（可複選）</legend>
            <div class="chip-grid">
              <button v-for="option in CONVERSION_GOAL_OPTIONS" :key="option.key" type="button" role="checkbox" :aria-checked="answers.company.conversionGoals.includes(option.key)" :class="{ selected: answers.company.conversionGoals.includes(option.key) }" @click="toggleList(answers.company.conversionGoals, option.key)">{{ option.label }}</button>
            </div>
          </fieldset>
          <section class="contact-block" aria-labelledby="contact-title">
            <h3 id="contact-title">聯絡資料</h3>
            <div class="field-group">
              <label for="contact-name">聯絡人姓名</label>
              <input id="contact-name" v-model.trim="answers.contact.contactName" maxlength="120" autocomplete="name">
              <small>{{ answers.contact.contactName.length }} / 120</small>
            </div>
            <div class="field-group">
              <label for="contact-email">聯絡 Email</label>
              <input id="contact-email" v-model.trim="answers.contact.email" type="email" inputmode="email" autocomplete="email" maxlength="320" aria-describedby="contact-email-help">
              <small id="contact-email-help">付款與開站進度會寄到這個信箱</small>
              <p v-if="answers.contact.email && stepCompletion(2, answers, { accepted: consentAccepted }).missing.includes('聯絡 Email')" class="inline-error">請輸入完整且有效的 Email。</p>
            </div>
            <div class="field-group">
              <label for="contact-phone">聯絡電話（選填）</label>
              <input id="contact-phone" v-model.trim="answers.contact.phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40">
              <p v-if="answers.contact.phone && !/^[0-9+() -]+$/.test(answers.contact.phone)" class="inline-error">電話只能使用數字、空格、括號、加號或連字號。</p>
            </div>
          </section>
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
            <button type="button" class="button button--secondary" @click="checkDomainAvailability">查詢是否可註冊</button>
            <p v-if="domainAvailabilityMessage" class="notice" role="status">{{ domainAvailabilityMessage }}</p>
          </section>
          <section class="agreement" aria-labelledby="agreement-title">
            <h3 id="agreement-title">網站建置授權同意書</h3>
            <div ref="agreementPane" class="agreement__pane" tabindex="0" @scroll="handleAgreementScroll">
              <p><strong>請完整閱讀以下內容</strong></p>
              <p>我確認自己有權提供本流程中的品牌名稱、文字、圖片、網址、聯絡資料及其他內容，並授權網站建置團隊為製作示意預覽、建立網站、提供報價與安排付款而處理這些資料。</p>
              <p>我了解示意預覽只是討論方向的草稿，不代表最終交付內容；正式網站會依已確認的方案、功能與素材製作。若我提供第三方素材，我會先取得必要的使用權。</p>
              <p>我了解網站分析只檢查可公開讀取的首頁線索，不是完整稽核，也不保證搜尋排名、流量、詢問、成交或營收結果。</p>
              <p>我了解標示「付款後由我們為你設定開通」的人工設定模組會依報價收費，付款後由團隊安排設定，完成前不會顯示為已開通；標示「即將推出」的模組只登記需求，本次不開通也不收費。新網域會在結帳後由團隊確認可註冊狀態並代為註冊，不代表此刻已取得網域。</p>
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

        <p v-if="currentMissing.length && currentStep !== 6 && currentStep !== 9" class="missing" role="status">還需要：{{ currentMissing.join('、') }}</p>
      </section>

      <footer v-if="currentStep < 9" class="step-footer">
        <button type="button" class="button button--secondary" :disabled="currentStep === 1 || saveStatus === 'saving'" @click="goPrevious">上一步</button>
        <div class="save-state" :class="`save-state--${saveStatus}`" role="status">{{ saveMessage }}</div>
        <button type="button" class="button" :disabled="nextDisabled" @click="saveCurrentAndAdvance">{{ saveStatus === 'saving' ? '儲存中…' : '下一步' }}</button>
      </footer>
    </template>
  </main>
</template>

<style scoped>
.wizard { min-height: 100vh; padding: 1.25rem 1rem 7rem; background: #f7f5ef; color: #1b2236; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.wizard__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; max-width: 72rem; margin: 0 auto 1.2rem; }
.eyebrow { margin: 0 0 .55rem; color: #4d5dad; font: 700 .72rem/1.2 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; }
h1 { margin: 0; font: 900 clamp(2rem, 10vw, 3.2rem)/1.02 Georgia, serif; }
h2 { margin: 0; font: 800 1.8rem/1.1 Georgia, serif; }
h3 { margin: 0 0 .75rem; font: 700 1.2rem/1.25 Georgia, serif; }
h4 { margin: 0 0 .4rem; }
.lede, .step-card__header p { color: #5e6575; line-height: 1.65; }
.text-button { min-height: 44px; border: 0; padding: .55rem; background: transparent; color: #4d5dad; cursor: pointer; font-weight: 700; text-decoration: underline; text-underline-offset: .2rem; }
.state { max-width: 72rem; margin: 0 auto; padding: 1rem; border: 1px solid #e7e2d8; border-radius: .75rem; background: white; }
.state--error { color: #8a2b24; border-color: #edb3ab; background: #fff8f6; }
.progress { max-width: 72rem; margin: 0 auto 1rem; }
.progress__mobile p { margin: 0 0 .55rem; font-weight: 800; }
.progress__bar { height: .42rem; overflow: hidden; border-radius: 999px; background: #e7e2d8; }
.progress__bar span { display: block; height: 100%; border-radius: inherit; background: #4d5dad; }
.progress__steps { display: none; list-style: none; padding: 0; margin: 0; }
.step-card { max-width: 52rem; margin: 0 auto; border: 1px solid #e7e2d8; border-radius: .9rem; background: white; box-shadow: 0 1rem 2.5rem rgba(45, 51, 72, .06); }
.step-card__header { padding: 1.25rem; border-bottom: 1px solid #e7e2d8; }
.step-card__header p:last-child { margin-bottom: 0; }
.step-body { display: grid; gap: 1.35rem; padding: 1.25rem; }
/* Grid items default to min-width:auto, so a wide child (the comparison table) stretches the whole card and makes the page scroll sideways on phones. */
.step-body > *, .preview-result > * { min-width: 0; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend, label { font-weight: 750; }
legend { margin-bottom: .65rem; }
button, input, textarea, select { font: inherit; }
button { touch-action: manipulation; }
input:not([type="checkbox"]):not([type="radio"]), textarea, select { width: 100%; min-height: 44px; box-sizing: border-box; border: 1px solid #cfc9bd; border-radius: .55rem; padding: .72rem .8rem; background: white; color: #1b2236; }
textarea { min-height: 7rem; resize: vertical; }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, .agreement__pane:focus-visible { outline: 3px solid rgba(77, 93, 173, .3); outline-offset: 2px; }
.field-group { display: grid; gap: .42rem; min-width: 0; }
.field-group small, .hint, .muted { color: #777d8b; }
.field-group > small { justify-self: end; }
.choice-row, .chip-grid { display: grid; grid-template-columns: 1fr; gap: .65rem; }
.choice-row button, .chip-grid button, .preset-grid button, .option-card, .module-card { min-height: 44px; border: 1px solid #e7e2d8; border-radius: .7rem; padding: .85rem; background: #fbfaf7; color: #1b2236; cursor: pointer; text-align: left; }
.choice-row button.selected, .chip-grid button.selected, .preset-grid button.selected, .option-card.selected, .module-card.selected, .plan-card.selected { border-color: #4d5dad; background: #eef0fb; box-shadow: inset 0 0 0 1px #4d5dad; }
.button { min-height: 44px; border: 0; border-radius: .6rem; padding: .8rem 1.1rem; background: #4d5dad; color: white; cursor: pointer; font-weight: 800; }
.button:disabled, button:disabled { cursor: not-allowed; opacity: .55; }
.button--secondary { border: 1px solid #d5d0c5; background: white; color: #17233b; }
.button--wide { width: 100%; }
.inline-error, .missing { margin: 0; color: #9b3128; line-height: 1.5; }
.fulfilment-panel { padding: 1rem; border: 1px solid #d9d2c3; border-radius: .7rem; background: #fffdf7; }
.fulfilment-panel ul { display: grid; gap: .6rem; padding: 0; margin: 0; list-style: none; }
.fulfilment-panel li { display: flex; justify-content: space-between; gap: 1rem; }
.analysis, .contact-block, .domain-builder, .agreement, .quote { padding: 1rem; border: 1px solid #e7e2d8; border-radius: .7rem; background: #fbfaf7; }
.score-row { display: grid; gap: .3rem; margin-bottom: .9rem; }
.score-row > div:first-child { display: flex; justify-content: space-between; gap: 1rem; }
.score-row p { margin: 0; color: #777d8b; font-size: .88rem; }
.score-bar { height: .55rem; overflow: hidden; border-radius: 999px; background: #e7e2d8; }
.score-bar span { display: block; height: 100%; background: #4d5dad; }
.contact-block { display: grid; gap: 1rem; }
.preset-grid, .card-grid, .module-grid { display: grid; grid-template-columns: 1fr; gap: .75rem; }
.preset-grid button { display: grid; gap: .35rem; }
.preset-grid span, .option-card span, .module-card > span, .plan-card button > span { color: #5e6575; line-height: 1.5; }
.divider { display: flex; align-items: center; gap: .7rem; color: #777d8b; }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #e7e2d8; }
.reference-list, .reference-row { display: grid; gap: .75rem; }
.reference-row { padding-bottom: .8rem; border-bottom: 1px solid #eeeae2; }
.reference-row .text-button { justify-self: start; }
.upsell { padding: 1rem; border: 1px solid #e7e2d8; border-radius: .7rem; }
.toggle-line { display: grid; grid-template-columns: auto 1fr; gap: .7rem; align-items: start; cursor: pointer; }
.toggle-line input, .consent-check input { width: 1.35rem; height: 1.35rem; margin: .12rem 0 0; }
.toggle-line span { display: grid; gap: .3rem; }
.toggle-line small { color: #777d8b; font-weight: 400; line-height: 1.5; }
.toggle-line b { grid-column: 2; color: #4d5dad; }
.option-card { display: grid; gap: .55rem; width: 100%; }
.option-card__top, .module-card__heading, .module-card__prices { display: flex; justify-content: space-between; gap: .8rem; }
.option-card b, .module-card__prices, .plan-card b { color: #4d5dad; }
.module-option { display: grid; align-content: start; gap: .75rem; }
.module-card { display: grid; gap: .65rem; width: 100%; }
.inbox-binding { display: grid; gap: .8rem; padding: 1rem; border: 1px solid #cfc9bd; border-radius: .7rem; background: #fffdf7; }
.inbox-binding p { margin: 0; line-height: 1.55; }
.inbox-binding__row { display: grid; gap: .7rem; }
.module-card em { color: #286845; font-size: .83rem; font-style: normal; font-weight: 750; }
.module-card em.manual { color: #875215; }
.coming-soon-badge { justify-self: start; border: 2px solid #9b3128; border-radius: 999px; padding: .3rem .6rem; background: #fff1ee; color: #8a2b24; font-size: .85rem; }
.manual-setup-badge { justify-self: start; border: 2px solid #9a671e; border-radius: 999px; padding: .3rem .6rem; background: #fff8e8; color: #875215; font-size: .85rem; }
.checkout-zero { color: #8a2b24; }
.preview-result { display: grid; gap: 1rem; }
.preview-result iframe { width: 100%; height: 32rem; box-sizing: border-box; border: 1px solid #e7e2d8; border-radius: .7rem; background: white; }
.notice, .success-panel { margin: 0; padding: .8rem; border-radius: .55rem; background: #f0f1f8; color: #384268; line-height: 1.55; }
.preview-sections { display: grid; gap: .7rem; }
.preview-sections article { padding: .8rem; border: 1px solid #eeeae2; border-radius: .55rem; }
.preview-sections p { margin: 0; color: #5e6575; }
.table-wrap { overflow-x: auto; }
table { width: 100%; min-width: 30rem; border-collapse: collapse; }
th, td { padding: .65rem; border-bottom: 1px solid #e7e2d8; text-align: left; }
.domain-builder { display: grid; gap: 1rem; }
.domain-fields { display: grid; gap: .8rem; }
.agreement { display: grid; gap: .8rem; }
.agreement__pane { max-height: 18rem; overflow-y: auto; padding: 1rem; border: 1px solid #cfc9bd; border-radius: .55rem; background: white; line-height: 1.7; }
.agreement__pane p:first-child { margin-top: 0; }
.agreement__pane p:last-child { margin-bottom: 0; padding-bottom: 1rem; }
.scroll-status { margin: 0; color: #875215; font-weight: 750; }
.scroll-status.done { color: #286845; }
.consent-check { display: flex; min-height: 44px; align-items: center; gap: .65rem; cursor: pointer; }
.plan-card { overflow: hidden; border: 1px solid #e7e2d8; border-radius: .7rem; background: #fbfaf7; }
.plan-card > button { display: grid; gap: .55rem; width: 100%; min-height: 44px; border: 0; padding: 1rem; background: transparent; color: #1b2236; cursor: pointer; text-align: left; }
.plan-card fieldset { display: grid; gap: .45rem; padding: 0 1rem 1rem; }
.plan-card fieldset label { display: flex; min-height: 44px; align-items: center; gap: .55rem; }
.plan-card fieldset input { width: 1.2rem; height: 1.2rem; }
.quote { display: grid; gap: 1rem; }
.quote-group { padding-bottom: .7rem; border-bottom: 1px solid #e7e2d8; }
.quote-group dl, .future-charges { display: grid; gap: .55rem; margin: 0; }
.quote-group dl div, .future-charges div { display: flex; justify-content: space-between; gap: 1rem; }
.quote-group dd, .future-charges dd { margin: 0; font-weight: 750; text-align: right; }
.quote-total { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding-top: .4rem; }
.quote-total strong { color: #17233b; font: 800 1.7rem/1 Georgia, serif; }
.future-charges { padding: .8rem; border-radius: .55rem; background: white; }
.checkout-action { display: grid; gap: .8rem; }
.success-panel { background: #edf6ef; color: #236241; }
.missing { padding: 0 1.25rem 1.25rem; }
.step-footer { position: fixed; z-index: 10; right: 0; bottom: 0; left: 0; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .55rem; padding: .7rem max(1rem, env(safe-area-inset-right)) max(.7rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); border-top: 1px solid #e7e2d8; background: rgba(247, 245, 239, .97); }
.save-state { min-width: 0; color: #777d8b; font-size: .75rem; text-align: center; }
.save-state--success { color: #286845; }
.save-state--error { color: #9b3128; }
@media (min-width: 48rem) { .wizard { padding: 3rem 2rem 5rem; } .wizard__header { align-items: flex-end; margin-bottom: 2rem; } .progress { margin-bottom: 1.5rem; } .progress__mobile { display: none; } .progress__steps { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: .4rem; } .progress__steps li { min-width: 0; } .progress__steps button { display: grid; justify-items: center; gap: .35rem; width: 100%; min-height: 62px; border: 0; border-top: .3rem solid #d9d5cc; padding: .55rem .15rem; background: transparent; color: #777d8b; cursor: pointer; } .progress__steps .is-complete button { border-color: #4d5dad; color: #4d5dad; } .progress__steps .is-current button { border-color: #17233b; color: #17233b; } .progress__steps small { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; } .step-card__header, .step-body { padding: 2rem; } .choice-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } .chip-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .preset-grid, .card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .module-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .reference-row { grid-template-columns: 1fr auto; align-items: end; } .domain-fields { grid-template-columns: minmax(0, 1fr) minmax(12rem, .55fr); } .step-footer { position: static; max-width: 52rem; margin: 1rem auto 0; padding: 0; border: 0; background: transparent; } .missing { padding: 0 2rem 2rem; } }
</style>
