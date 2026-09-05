import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { getPreviewRepository } from './ordering-repository'
import { assertExistingSiteUrl, buildPreviewProjection, buildSiteSpec, BUSINESS_GOALS, SITE_MODULE_LABELS_ZH, SITE_MODULES, type SiteBriefInput, type SiteModule, type SiteSpec } from './site-spec'
import { FAIL_CLOSED_EXISTING_SITE_DIAGNOSIS_RESOLVER, type ExistingSiteDiagnosisResolver } from './diagnosis-binding'
import { normalizeRecipientEmail, tokenHash } from './normalization'
import type { ManagedSiteDraftOrder, ManagedSiteLeadIntent, ManagedSitePaymentEvent, ManagedSitePreview, ManagedSiteQuote, ManagedSiteQuoteLine, ManagedSiteSubscriptionIntent } from '../database/schema'
import type { DraftOrderInput, LeadInput, ManagedSiteCheckoutAuthority, ManagedSiteCheckoutAuthorityInput, ManagedSiteCheckoutAuthorityResolver, PaymentEventVerifier, PreviewGenerationResult, PreviewRepository, QuoteInput } from './ordering-types'
import { MANAGED_SITE_TYPES, type ManagedSiteType } from './types'
import { createPaidManagedSiteModuleFulfilments } from './funnel/module-fulfilment'

export const MANAGED_SITE_PRICE_CATALOG_VERSION = 'managed-site-pricing-twd-v6'
export const MANAGED_SITE_CURRENCY = 'TWD' as const
export const MANAGED_SITE_TERM_MONTHS = 12
export const MANAGED_SITE_QUOTE_TTL_MS = 1000 * 60 * 60 * 24

const SITE_BUILD_CATALOG: Record<ManagedSiteType, { buildMinor: number; labelZh: string; descriptionZh: string }> = {
  one_page: { buildMinor: 12000, labelZh: '一頁式網站', descriptionZh: '適合用一個頁面清楚介紹品牌與服務。' },
  brand_blog: { buildMinor: 18000, labelZh: '品牌內容網站', descriptionZh: '適合持續發布品牌內容與案例。' },
  simple_commerce: { buildMinor: 30000, labelZh: '簡易電商網站', descriptionZh: '適合展示商品並建立基本線上銷售流程。' },
}

const DESIGN_TIER_CATALOG = {
  template: { oneTimeMinor: 0, labelZh: '模板設計', descriptionZh: '使用既有設計系統完成網站視覺。' },
  designer: { oneTimeMinor: 15000, labelZh: '設計師客製', descriptionZh: '由設計師依品牌需求調整網站視覺。' },
} as const

export const MODULE_CATALOG: Record<SiteModule, { buildMinor: number; monthlyMinor: number; activation: 'automatic' | 'manual_service'; readiness: 'available' | 'manual_setup' | 'coming_soon'; labelZh: string; descriptionZh: string }> = {
  stripe_payment: { buildMinor: 3000, monthlyMinor: 0, activation: 'manual_service', readiness: 'manual_setup', labelZh: SITE_MODULE_LABELS_ZH.stripe_payment, descriptionZh: '串接 Stripe 以收取線上付款。' },
  newebpay_payment: { buildMinor: 3000, monthlyMinor: 0, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.newebpay_payment, descriptionZh: '串接藍新金流以收取線上付款。' },
  ecpay_payment: { buildMinor: 3000, monthlyMinor: 0, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.ecpay_payment, descriptionZh: '串接綠界金流以收取線上付款。' },
  einvoice: { buildMinor: 4000, monthlyMinor: 200, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.einvoice, descriptionZh: '提供電子發票開立與管理功能。' },
  logistics: { buildMinor: 3000, monthlyMinor: 0, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.logistics, descriptionZh: '串接出貨與物流處理流程。' },
  erp_crm_backoffice: { buildMinor: 8000, monthlyMinor: 500, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.erp_crm_backoffice, descriptionZh: '整合訂單、客戶與營運管理後台。' },
  bounded_ai_assistant: { buildMinor: 6000, monthlyMinor: 800, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.bounded_ai_assistant, descriptionZh: '提供受控範圍內的網站訪客問答協助。' },
  line_assisted_integration: { buildMinor: 3000, monthlyMinor: 300, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.line_assisted_integration, descriptionZh: '付款後由客服協助串接 LINE 官方帳號。' },
  google_booking_assisted_integration: { buildMinor: 4000, monthlyMinor: 0, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.google_booking_assisted_integration, descriptionZh: '連結 Google 預約服務，方便客戶安排時段。' },
  managed_content_admin: { buildMinor: 0, monthlyMinor: 0, activation: 'automatic', readiness: 'available', labelZh: SITE_MODULE_LABELS_ZH.managed_content_admin, descriptionZh: '讓你自行管理網站的文字與內容。' },
  contact_lead_capture: { buildMinor: 0, monthlyMinor: 0, activation: 'automatic', readiness: 'available', labelZh: SITE_MODULE_LABELS_ZH.contact_lead_capture, descriptionZh: '網站訪客留下姓名、Email 與訊息，直接寄到你綁定的收信信箱。' },
  shopify_commerce: { buildMinor: 0, monthlyMinor: 0, activation: 'manual_service', readiness: 'manual_setup', labelZh: SITE_MODULE_LABELS_ZH.shopify_commerce, descriptionZh: '連結 Shopify 商品與電商流程。' },
  geo_content_subscription: { buildMinor: 0, monthlyMinor: 0, activation: 'automatic', readiness: 'available', labelZh: SITE_MODULE_LABELS_ZH.geo_content_subscription, descriptionZh: '提供網站內容的 GEO 規劃支援。' },
  geo_measurement_dashboard: { buildMinor: 0, monthlyMinor: 0, activation: 'automatic', readiness: 'available', labelZh: SITE_MODULE_LABELS_ZH.geo_measurement_dashboard, descriptionZh: '集中查看 GEO 相關追蹤資訊。' },
  pwa_reference_only: { buildMinor: 0, monthlyMinor: 0, activation: 'manual_service', readiness: 'coming_soon', labelZh: SITE_MODULE_LABELS_ZH.pwa_reference_only, descriptionZh: '提供 PWA 規劃參考，不包含上架服務。' },
}

const PLAN_CATALOG = {
  site_only: { monthlyMinor: 500, geoTracking: false, autoPosting: false, labelZh: '網站維護', descriptionZh: '提供網站基本維護與持續服務。' },
  site_geo: { monthlyMinor: 2500, geoTracking: true, autoPosting: false, labelZh: '網站＋GEO 追蹤', descriptionZh: '提供網站維護與 GEO 追蹤服務。' },
  site_geo_autopost: { monthlyMinor: null, geoTracking: true, autoPosting: true, labelZh: '網站＋GEO 追蹤＋自動發文', descriptionZh: '提供網站維護、GEO 追蹤與定期自動發文。' },
} as const

// Only "30 天 = 5,000" comes from the owner's price list ("5,000 起"); the 15/7/3-day steps are a placeholder ladder.
const CADENCE_CATALOG: Record<3 | 7 | 15 | 30, number> = { 3: 12000, 7: 8500, 15: 6500, 30: 5000 }

const DOMAIN_TLD_CATALOG = {
  com: 600,
  'com.tw': 800,
  tw: 900,
  shop: 1200,
  store: 1400,
} as const

const ASSISTED_DOMAIN_SETUP_MINOR = 2000

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function notFound(message: string): never {
  throw createError({ statusCode: 404, statusMessage: message })
}

function ensureFiniteDate(date: Date, label: string): Date {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) invalid(`${label} is invalid.`)
  return date
}

function stringField(value: unknown, label: string, max: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) invalid(`${label} is required.`)
    return null
  }
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) invalid(`${label} is invalid.`)
  return value.trim()
}

function assertPreviewUsable(preview: ManagedSitePreview, nowDate: Date) {
  if (preview.status === 'expired' || preview.expiresAt.getTime() <= nowDate.getTime()) throw createError({ statusCode: 410, statusMessage: 'This preview has expired and must be regenerated.' })
  if (!['draft', 'generated', 'saved'].includes(preview.status)) throw createError({ statusCode: 409, statusMessage: 'This preview is no longer available for ordering.' })
}

function assertPreviewAccess(preview: ManagedSitePreview, accessToken: unknown) {
  if (typeof accessToken !== 'string' || accessToken.length < 32 || accessToken.length > 256 || tokenHash(accessToken) !== preview.accessTokenHash) throw createError({ statusCode: 404, statusMessage: 'Managed site preview was not found.' })
}

function quoteProjection(quote: ManagedSiteQuote, lines: ManagedSiteQuoteLine[]) {
  const selectedModules = Array.isArray(quote.moduleSnapshot) ? quote.moduleSnapshot as SiteModule[] : []
  const manualServiceModules = selectedModules.filter(module => MODULE_CATALOG[module]?.activation === 'manual_service')
  const manualSetupModules = selectedModules.filter(module => MODULE_CATALOG[module]?.readiness === 'manual_setup')
  const comingSoonModules = selectedModules.filter(module => MODULE_CATALOG[module]?.readiness === 'coming_soon')
  return {
    quoteId: quote.id,
    status: quote.status,
    quoteVersion: quote.quoteVersion,
    planKey: quote.planKey,
    currency: quote.currency,
    totalMinor: quote.totalMinor,
    taxStatus: quote.taxStatus,
    cadenceDays: quote.cadenceDays,
    domainOption: quote.domainOption,
    siteSpecFingerprint: quote.siteSpecFingerprint,
    quoteFingerprint: quote.quoteFingerprint,
    expiresAt: quote.expiresAt,
    lockedAt: quote.lockedAt,
    lines: lines.map(line => ({ lineKey: line.lineKey, description: line.description, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, catalogVersion: line.catalogVersion })),
    totals: managedSiteQuoteTotals(lines, quote.totalMinor),
    manualServiceModules,
    manualSetupModules,
    comingSoonModules,
    limitations: [
      '目前報價未計算稅金。',
      '付款、網域購買、DNS、TLS 與部署，須在另行授權與完成設定後才會執行。',
      '不保證 AI 能見度、排名、流量、轉換或營收成果。',
      '月費自第二個月起收取，今日僅收首月。',
      ...(manualSetupModules.length ? ['所選的人工設定模組會依報價收費；付款後由我們為你設定開通，完成前不會顯示為已開通。'] : []),
      ...(comingSoonModules.length ? ['即將推出模組只登記需求，本次不開通，也不收取建置費或月費。'] : []),
    ],
  }
}

export function getManagedSitePriceCatalog() {
  return {
    version: MANAGED_SITE_PRICE_CATALOG_VERSION,
    currency: MANAGED_SITE_CURRENCY,
    termMonths: MANAGED_SITE_TERM_MONTHS,
    siteTypes: Object.entries(SITE_BUILD_CATALOG).map(([key, value]) => ({ key, ...value })),
    designTiers: Object.entries(DESIGN_TIER_CATALOG).map(([key, value]) => ({ key, ...value })),
    modules: SITE_MODULES.map(key => ({ key, ...MODULE_CATALOG[key] })),
    plans: Object.entries(PLAN_CATALOG).map(([key, value]) => ({ key, ...value })),
    cadence: Object.entries(CADENCE_CATALOG).map(([days, amount]) => ({ days: Number(days), monthlyMinor: amount })),
    domainOptions: ['existing', 'new', 'assisted'] as const,
    domainTlds: Object.entries(DOMAIN_TLD_CATALOG).map(([tld, annualMinor]) => ({ tld, annualMinor })),
    assistedDomainSetupMinor: ASSISTED_DOMAIN_SETUP_MINOR,
  }
}

type ManagedSiteCatalogQuoteInput = {
  siteType: ManagedSiteType
  planKey: QuoteInput['planKey']
  cadenceDays?: QuoteInput['cadenceDays']
  domainOption: QuoteInput['domainOption']
  designTier?: QuoteInput['designTier']
  domainTld?: QuoteInput['domainTld']
  moduleKeys: string[]
}

function managedSiteQuoteTotals(lines: Array<Pick<ManagedSiteQuoteLine, 'lineKey' | 'lineAmountMinor'>>, dueTodayMinor: number) {
  const amountFor = (predicate: (line: Pick<ManagedSiteQuoteLine, 'lineKey' | 'lineAmountMinor'>) => boolean) => lines.filter(predicate).reduce((sum, line) => sum + line.lineAmountMinor, 0)
  const isDomainYearOne = (lineKey: string) => /^domain-[a-z0-9-]+-year1$/u.test(lineKey)
  // Assisted setup is a one-time service fee, not a domain annual fee, so it must not appear under the domain bucket.
  const oneTimeMinor = amountFor(line => line.lineKey.startsWith('build-') || line.lineKey.startsWith('design-') || (line.lineKey.startsWith('module-') && line.lineKey.endsWith('-setup')) || line.lineKey === 'domain-assisted-setup')
  const firstMonthMinor = amountFor(line => line.lineKey.startsWith('monthly-'))
  const domainFirstYearMinor = amountFor(line => isDomainYearOne(line.lineKey))
  return { oneTimeMinor, firstMonthMinor, domainFirstYearMinor, dueTodayMinor, recurringMonthlyMinor: firstMonthMinor, domainRenewalAnnualMinor: domainFirstYearMinor }
}

/** Pure Phase-A catalog projection used by both persisted quotes and pre-checkout funnel display. */
export function projectManagedSiteCatalogQuote(input: ManagedSiteCatalogQuoteInput) {
  if (!(MANAGED_SITE_TYPES as readonly string[]).includes(input.siteType)) invalid('Site type is not available in V1.')
  if (!Object.hasOwn(PLAN_CATALOG, input.planKey)) invalid('Plan is not available in V1.')
  if (!['existing', 'new', 'assisted'].includes(input.domainOption)) invalid('Domain option is not available in V1.')
  const designTier = input.designTier === undefined ? 'template' : input.designTier
  if (!Object.hasOwn(DESIGN_TIER_CATALOG, designTier)) invalid('Design tier is not available in V1.')
  if (input.domainOption === 'new' && (!input.domainTld || !Object.hasOwn(DOMAIN_TLD_CATALOG, input.domainTld))) invalid('Domain TLD is required for a new domain.')
  if (input.domainOption !== 'new' && input.domainTld !== undefined) invalid('Domain TLD is only available for a new domain.')
  const cadenceDays: 3 | 7 | 15 | 30 = input.planKey === 'site_geo_autopost'
    ? (input.cadenceDays !== undefined && Object.hasOwn(CADENCE_CATALOG, input.cadenceDays) ? input.cadenceDays : invalid('GEO cadence is not available in V1.'))
    : 30
  const selectedModules = [...new Set(input.moduleKeys)]
  if (selectedModules.length > SITE_MODULES.length || selectedModules.some(module => !Object.hasOwn(MODULE_CATALOG, module))) invalid('Selected module is not available in V1.')
  if (input.siteType === 'simple_commerce' && !selectedModules.includes('shopify_commerce')) invalid('簡易電商網站必須選擇 Shopify 電商模組，請返回模組步驟勾選後再繼續。')
  const plan = PLAN_CATALOG[input.planKey]
  const siteBuild = SITE_BUILD_CATALOG[input.siteType]
  const lines: QuoteLineInput[] = [{ lineKey: `build-${input.siteType}`, description: `${siteBuild.labelZh}建置費`, quantity: 1, unitAmountMinor: siteBuild.buildMinor }]
  const design = DESIGN_TIER_CATALOG[designTier]
  if (design.oneTimeMinor > 0) lines.push({ lineKey: `design-${designTier}`, description: `${design.labelZh}費`, quantity: 1, unitAmountMinor: design.oneTimeMinor })
  for (const module of selectedModules) {
    const item = MODULE_CATALOG[module as SiteModule]
    if (item.readiness === 'coming_soon') {
      lines.push({ lineKey: `module-${module}-intent`, description: `${item.labelZh}（即將推出・本次不收費）`, quantity: 1, unitAmountMinor: 0 })
      continue
    }
    if (item.buildMinor > 0) lines.push({ lineKey: `module-${module}-setup`, description: `${item.labelZh}建置費${item.readiness === 'manual_setup' ? '・需人工設定' : ''}`, quantity: 1, unitAmountMinor: item.buildMinor })
  }
  const planMonthlyMinor = input.planKey === 'site_geo_autopost' ? CADENCE_CATALOG[cadenceDays] : plan.monthlyMinor!
  lines.push({ lineKey: `monthly-plan-${input.planKey}`, description: `月費・${plan.labelZh}（首月）`, quantity: 1, unitAmountMinor: planMonthlyMinor })
  for (const module of selectedModules) {
    const item = MODULE_CATALOG[module as SiteModule]
    if (item.readiness === 'coming_soon') continue
    if (item.monthlyMinor > 0) lines.push({ lineKey: `monthly-module-${module}`, description: `${item.labelZh}（首月${item.readiness === 'manual_setup' ? '・需人工設定' : ''}）`, quantity: 1, unitAmountMinor: item.monthlyMinor })
  }
  if (input.domainOption === 'new') {
    const domainTld = input.domainTld!
    lines.push({ lineKey: `domain-${domainTld.replaceAll('.', '-')}-year1`, description: `網域 ${domainTld} 第一年註冊費`, quantity: 1, unitAmountMinor: DOMAIN_TLD_CATALOG[domainTld] })
  }
  if (input.domainOption === 'assisted') lines.push({ lineKey: 'domain-assisted-setup', description: '網域人工協助設定費', quantity: 1, unitAmountMinor: ASSISTED_DOMAIN_SETUP_MINOR })
  const projectedLines = lines.map(line => ({ ...line, lineAmountMinor: line.quantity * line.unitAmountMinor }))
  const totalMinor = projectedLines.reduce((total, line) => total + line.lineAmountMinor, 0)
  if (projectedLines.some(line => !Number.isSafeInteger(line.unitAmountMinor) || line.unitAmountMinor < 0 || !Number.isSafeInteger(line.lineAmountMinor) || line.lineAmountMinor < 0) || !Number.isSafeInteger(totalMinor) || totalMinor < 0) invalid('報價金額無效，請重新整理後再試。')
  return { lines: projectedLines, totalMinor, totals: managedSiteQuoteTotals(projectedLines as any, totalMinor), currency: MANAGED_SITE_CURRENCY, cadenceDays, designTier, selectedModules, manualServiceModules: selectedModules.filter(module => MODULE_CATALOG[module as SiteModule].activation === 'manual_service') as SiteModule[], manualSetupModules: selectedModules.filter(module => MODULE_CATALOG[module as SiteModule].readiness === 'manual_setup') as SiteModule[], comingSoonModules: selectedModules.filter(module => MODULE_CATALOG[module as SiteModule].readiness === 'coming_soon') as SiteModule[] }
}

export async function createManagedSitePreview(ownerUserId: number | null, input: unknown, repository = getPreviewRepository(), clock: () => Date = () => new Date(), diagnosisResolver: ExistingSiteDiagnosisResolver = FAIL_CLOSED_EXISTING_SITE_DIAGNOSIS_RESOLVER): Promise<PreviewGenerationResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Site brief is invalid.')
  const candidate = input as Record<string, unknown>
  const isExistingSite = typeof candidate.existingSiteUrl === 'string'
  let specInput: Record<string, unknown> = { ...candidate }
  if (isExistingSite) {
    if (ownerUserId === null) throw createError({ statusCode: 401, statusMessage: 'Existing-site generation requires an owner-scoped Diagnosis session.' })
    if (candidate.diagnosisProjection || candidate.approvedEvidenceReferences || candidate.resolvedEvidenceSnapshotHash) throw createError({ statusCode: 422, statusMessage: 'Existing-site Diagnosis and evidence must be resolved by the server.' })
    const normalizedExistingSiteUrl = assertExistingSiteUrl(candidate.existingSiteUrl as string)
    const diagnosisId = Number(candidate.diagnosisId)
    if (!Number.isSafeInteger(diagnosisId) || diagnosisId < 1) invalid('Existing-site Diagnosis ID is required.')
    const diagnosis = await diagnosisResolver.resolve(ownerUserId, { existingSiteUrl: normalizedExistingSiteUrl, diagnosisId, findingIds: candidate.diagnosisFindingIds as string[] | undefined })
    specInput = {
      ...candidate,
      existingSiteUrl: diagnosis.normalizedSiteUrl,
      diagnosisBinding: { diagnosisId: diagnosis.diagnosisId, findingIds: diagnosis.findings.map(finding => finding.id).sort() },
      diagnosisProjection: { issueKeys: diagnosis.findings.map(finding => finding.issueCode), limitations: diagnosis.limitations },
      approvedEvidenceReferences: diagnosis.evidenceSnapshot.refs.map(reference => ({ sourceId: reference.sourceId, artifactId: reference.artifactId ?? null, locator: reference.locator, artifactHash: reference.artifactHash, approvedAt: reference.approvedAt, purpose: 'content_draft' as const })),
      resolvedEvidenceSnapshotHash: diagnosis.evidenceSnapshot.hash,
    }
  } else {
    if (candidate.diagnosisProjection || candidate.approvedEvidenceReferences || candidate.diagnosisId || candidate.diagnosisFindingIds || candidate.resolvedEvidenceSnapshotHash) throw createError({ statusCode: 422, statusMessage: 'Diagnosis and evidence inputs are server-resolved only.' })
    specInput = { ...candidate, approvedEvidenceReferences: [] }
  }
  const spec = buildSiteSpec(specInput, clock())
  const existing = await repository.findPreviewByDraftKey(spec.draftIdentity)
  if (existing) {
    if (existing.previewFingerprint !== stableFingerprint({ draftIdentity: spec.draftIdentity, specFingerprint: spec.deterministicFingerprint })) throw createError({ statusCode: 409, statusMessage: 'Draft identity is already used by a different preview.' })
    const expiresAt = existing.expiresAt
    return { preview: existing, projection: buildPreviewProjection(spec, String(existing.id), expiresAt), spec, accessToken: null, replayed: true }
  }
  const createdAt = clock()
  ensureFiniteDate(createdAt, 'Preview clock')
  const expiresAt = new Date(createdAt.getTime() + 1000 * 60 * 60 * 24)
  const previewFingerprint = stableFingerprint({ draftIdentity: spec.draftIdentity, specFingerprint: spec.deterministicFingerprint })
  const duplicate = await repository.findPreviewByFingerprint(previewFingerprint)
  if (duplicate) return { preview: duplicate, projection: buildPreviewProjection(spec, String(duplicate.id), duplicate.expiresAt), spec, accessToken: null, replayed: true }
  const accessToken = randomBytes(32).toString('base64url')
  const preview = await repository.insertPreview({
    ownerUserId,
    draftKey: spec.draftIdentity,
    accessTokenHash: tokenHash(accessToken),
    sourceMode: isExistingSite ? 'existing_site' : 'new_site',
    existingSiteUrl: isExistingSite ? specInput.existingSiteUrl as string : null,
    brief: spec.businessIdentity.brief,
    businessGoals: spec.businessGoals,
    styleProfile: spec.styleReferenceProfile || {},
    siteSpecSnapshot: spec,
    designTokenSnapshot: spec.designTokens,
    selectedModuleSnapshot: spec.selectedModules,
    previewFingerprint,
    status: 'generated',
    expiresAt,
    createdAt,
    updatedAt: createdAt,
  } as any)
  return { preview, projection: buildPreviewProjection(spec, String(preview.id), expiresAt), spec, accessToken, replayed: false }
}

export async function getManagedSitePublicPreview(previewId: number, accessToken: string, repository = getPreviewRepository(), clock: () => Date = () => new Date()) {
  const preview = await repository.findPreviewById(previewId)
  if (!preview) notFound('Managed site preview was not found.')
  assertPreviewAccess(preview, accessToken)
  assertPreviewUsable(preview, clock())
  const spec = preview.siteSpecSnapshot as unknown as SiteSpec
  return { previewId: preview.id, previewOnly: true as const, status: preview.status, projection: buildPreviewProjection(spec, String(preview.id), preview.expiresAt), spec, accessTokenRequired: true as const }
}

export async function saveManagedSitePreview(ownerUserId: number | null, previewId: number, repository = getPreviewRepository(), clock: () => Date = () => new Date()) {
  const preview = await repository.findPreviewById(previewId)
  if (!preview || (ownerUserId !== null && preview.ownerUserId !== ownerUserId)) notFound('Managed site preview was not found.')
  assertPreviewUsable(preview, clock())
  const updated = await repository.updatePreview(previewId, { status: 'saved', updatedAt: clock() } as any)
  if (!updated) notFound('Managed site preview was not found.')
  return { preview: updated, saved: true }
}

export async function createManagedSiteQuote(input: QuoteInput, repository = getPreviewRepository(), clock: () => Date = () => new Date()) {
  if (!Number.isSafeInteger(input.previewId) || input.previewId < 1) invalid('Preview id is invalid.')
  if (!Object.hasOwn(PLAN_CATALOG, input.planKey)) invalid('Plan is not available in V1.')
  if (!['existing', 'new', 'assisted'].includes(input.domainOption)) invalid('Domain option is not available in V1.')
  const designTier = input.designTier === undefined ? 'template' : input.designTier
  if (!Object.hasOwn(DESIGN_TIER_CATALOG, designTier)) invalid('Design tier is not available in V1.')
  if (input.domainOption === 'new' && (!input.domainTld || !Object.hasOwn(DOMAIN_TLD_CATALOG, input.domainTld))) invalid('Domain TLD is required for a new domain.')
  if (input.domainOption !== 'new' && input.domainTld !== undefined) invalid('Domain TLD is only available for a new domain.')
  const cadenceDays: 3 | 7 | 15 | 30 = input.planKey === 'site_geo_autopost'
    ? (input.cadenceDays !== undefined && Object.hasOwn(CADENCE_CATALOG, input.cadenceDays) ? input.cadenceDays : invalid('GEO cadence is not available in V1.'))
    : 30
  const preview = await repository.findPreviewById(input.previewId)
  if (!preview) notFound('Managed site preview was not found.')
  assertPreviewAccess(preview, input.previewAccessToken)
  assertPreviewUsable(preview, clock())
  const spec = preview.siteSpecSnapshot as unknown as SiteSpec
  const selectedModules = input.moduleKeys ? [...new Set(input.moduleKeys)] : spec.selectedModules
  if (selectedModules.length > SITE_MODULES.length || selectedModules.some(module => !Object.hasOwn(MODULE_CATALOG, module))) invalid('Selected module is not available in V1.')
  if (spec.siteType === 'simple_commerce' && !selectedModules.includes('shopify_commerce')) invalid('簡易電商網站必須選擇 Shopify 電商模組，請返回模組步驟勾選後再繼續。')
  const idempotencyKey = stringField(input.idempotencyKey, 'Quote idempotency key', 128)!
  const quoteFingerprint = stableFingerprint({ previewFingerprint: preview.previewFingerprint, planKey: input.planKey, cadenceDays, domainOption: input.domainOption, domainTld: input.domainTld, designTier, selectedModules: [...selectedModules].sort(), catalogVersion: MANAGED_SITE_PRICE_CATALOG_VERSION })
  const replayByKey = await repository.findQuoteByIdempotency(preview.id, idempotencyKey)
  if (replayByKey) {
    if (replayByKey.quoteFingerprint !== quoteFingerprint) throw createError({ statusCode: 409, statusMessage: 'Quote idempotency key was already used for a different request.' })
    return { quote: quoteProjection(replayByKey, await repository.listQuoteLines(replayByKey.id)), replayed: true }
  }
  const replay = await repository.findQuoteByFingerprint(quoteFingerprint)
  if (replay) {
    if (replay.idempotencyKey !== idempotencyKey) throw createError({ statusCode: 409, statusMessage: 'Quote request already exists under a different idempotency key.' })
    return { quote: quoteProjection(replay, await repository.listQuoteLines(replay.id)), replayed: true }
  }
  const createdAt = clock()
  const expiresAt = new Date(createdAt.getTime() + MANAGED_SITE_QUOTE_TTL_MS)
  const catalogProjection = projectManagedSiteCatalogQuote({ siteType: spec.siteType, planKey: input.planKey, cadenceDays, domainOption: input.domainOption, designTier, domainTld: input.domainTld, moduleKeys: selectedModules })
  const { lines, totalMinor } = catalogProjection
  const quote = await repository.transaction(async transaction => {
      const created = await transaction.insertQuote({ ownerUserId: preview.ownerUserId, previewId: preview.id, projectId: null, quoteVersion: MANAGED_SITE_PRICE_CATALOG_VERSION, idempotencyKey, planKey: input.planKey, currency: MANAGED_SITE_CURRENCY, totalMinor, taxStatus: 'not_calculated', moduleSnapshot: selectedModules, cadenceDays, domainOption: input.domainOption, siteSpecFingerprint: spec.deterministicFingerprint, quoteFingerprint, status: 'quoted', expiresAt, lockedAt: null, createdAt, updatedAt: createdAt } as any)
    for (const line of lines) await transaction.insertQuoteLine({ quoteId: created.id, lineKey: line.lineKey, description: line.description, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.quantity * line.unitAmountMinor, catalogVersion: MANAGED_SITE_PRICE_CATALOG_VERSION, lineFingerprint: stableFingerprint({ quoteId: created.id, ...line, catalogVersion: MANAGED_SITE_PRICE_CATALOG_VERSION }) } as any)
    await transaction.updatePreview(preview.id, { status: 'saved', updatedAt: createdAt } as any)
    return created
  })
  return { quote: quoteProjection(quote, await repository.listQuoteLines(quote.id)), replayed: false }
}

type QuoteLineInput = { lineKey: string; description: string; quantity: number; unitAmountMinor: number }

export async function createManagedSiteLeadIntent(input: unknown, repository = getPreviewRepository(), clock: () => Date = () => new Date()) {
  if (!input || typeof input !== 'object') invalid('Lead input is invalid.')
  const candidate = input as Partial<LeadInput>
  const previewId = Number(candidate.previewId)
  if (!Number.isSafeInteger(previewId) || previewId < 1) invalid('Preview id is invalid.')
  const name = stringField(candidate.name, 'Lead name', 120)!
  const email = normalizeRecipientEmail(String(candidate.email || ''))
  const company = stringField(candidate.company, 'Company', 160)!
  const website = stringField(candidate.website, 'Website', 2048, false)
  const message = stringField(candidate.message, 'Message', 4000, false)
  if (candidate.privacyConsent !== true) invalid('Privacy consent is required.')
  const quoteId = candidate.quoteId === null || candidate.quoteId === undefined ? null : Number(candidate.quoteId)
  if (quoteId !== null && (!Number.isSafeInteger(quoteId) || quoteId < 1)) invalid('Quote id is invalid.')
  const idempotencyKey = stringField(candidate.idempotencyKey, 'Lead idempotency key', 128)!
  const preview = await repository.findPreviewById(previewId)
  if (!preview) notFound('Managed site preview was not found.')
  assertPreviewAccess(preview, candidate.previewAccessToken)
  assertPreviewUsable(preview, clock())
  const quote = quoteId === null ? null : await repository.findQuoteById(quoteId)
  if (quote && quote.previewId !== preview.id) throw createError({ statusCode: 409, statusMessage: 'Quote does not belong to the preview.' })
  if (candidate.recontactConsent !== undefined && typeof candidate.recontactConsent !== 'boolean') invalid('Recontact consent must be a boolean when provided.')
  const recontactConsent = candidate.recontactConsent === true
  const requestFingerprint = stableFingerprint({ previewId, quoteId, name, email, company, website, message, privacyConsent: true, recontactConsent })
  const replay = await repository.findLeadIntentByIdempotency(preview.id, idempotencyKey)
  if (replay) {
    if (replay.requestFingerprint !== requestFingerprint) throw createError({ statusCode: 409, statusMessage: 'Lead idempotency key was already used for a different request.' })
    return { leadIntent: replay, replayed: true }
  }
  const existing = await repository.findLeadIntentByFingerprint(requestFingerprint)
  if (existing) {
    if (existing.idempotencyKey !== idempotencyKey) throw createError({ statusCode: 409, statusMessage: 'Lead request already exists under a different idempotency key.' })
    return { leadIntent: existing, replayed: true }
  }
  const createdAt = clock()
  return repository.transaction(async transaction => {
    const existingLead = await transaction.findLeadByFingerprint(requestFingerprint)
    const lead = existingLead || await transaction.insertLead({ name, email, company, website, message, packageInterest: 'grow', language: 'zh-hant', privacyConsent: true, recontactConsent, dedupeKey: stableFingerprint({ email, company }).slice(0, 64), requestFingerprint })
    const intent = await transaction.insertLeadIntent({ ownerUserId: preview.ownerUserId, previewId: preview.id, quoteId, leadId: lead.id, requestFingerprint, idempotencyKey, createdAt } as any)
    return { leadIntent: intent, replayed: false }
  })
}

export async function createManagedSiteDraftOrder(input: DraftOrderInput, repository = getPreviewRepository(), clock: () => Date = () => new Date()) {
  const idempotencyKey = stringField(input.idempotencyKey, 'Draft order idempotency key', 128)!
  const preview = await repository.findPreviewById(input.previewId)
  const quote = await repository.findQuoteById(input.quoteId)
  if (!preview || !quote || quote.previewId !== preview.id) notFound('Preview or quote was not found.')
  assertPreviewAccess(preview, input.previewAccessToken)
  assertPreviewUsable(preview, clock())
  if (quote.status !== 'quoted' || quote.expiresAt.getTime() <= clock().getTime()) throw createError({ statusCode: 410, statusMessage: 'Quote has expired and must be recalculated.' })
  const directLeadIntent = await repository.findLeadIntentById(input.leadIntentId)
  if (!directLeadIntent || directLeadIntent.previewId !== preview.id || directLeadIntent.quoteId !== quote.id) throw createError({ statusCode: 409, statusMessage: 'A matching lead is required before creating a draft order.' })
  const requestFingerprint = stableFingerprint({ previewId: preview.id, quoteId: quote.id, leadIntentId: directLeadIntent.id })
  const replay = await repository.findDraftOrderByIdempotency(preview.id, idempotencyKey)
  if (replay) {
    if (replay.requestFingerprint !== requestFingerprint) throw createError({ statusCode: 409, statusMessage: 'Draft order idempotency key was already used for a different request.' })
    return { order: replay, replayed: true }
  }
  const existing = await repository.findDraftOrderByFingerprint(requestFingerprint)
  if (existing) {
    if (existing.idempotencyKey !== idempotencyKey) throw createError({ statusCode: 409, statusMessage: 'Draft order already exists under a different idempotency key.' })
    return { order: existing, replayed: true }
  }
  const createdAt = clock()
  const order = await repository.transaction(async transaction => {
    const created = await transaction.insertDraftOrder({ ownerUserId: preview.ownerUserId, previewId: preview.id, quoteId: quote.id, projectId: null, leadId: directLeadIntent.leadId, status: 'payment_pending', requestFingerprint, idempotencyKey, paymentIntentReference: null, createdAt, updatedAt: createdAt } as any)
    const existingIntent = await transaction.findSubscriptionIntentByQuote(quote.id)
    if (!existingIntent) await transaction.insertSubscriptionIntent({ ownerUserId: preview.ownerUserId, projectId: null, quoteId: quote.id, planKey: quote.planKey, cadenceDays: quote.cadenceDays, termMonths: MANAGED_SITE_TERM_MONTHS, status: 'draft', intentFingerprint: stableFingerprint({ quoteId: quote.id, planKey: quote.planKey, cadenceDays: quote.cadenceDays, termMonths: MANAGED_SITE_TERM_MONTHS }), createdAt, updatedAt: createdAt } as any)
    return created
  })
  return { order, replayed: false, payment: { status: 'payment_pending' as const, providerConfigured: false, requiresVerifiedProviderEvent: true } }
}

export const FAIL_CLOSED_PAYMENT_EVENT_VERIFIER: PaymentEventVerifier = {
  async verify() { return false },
}

export const FAIL_CLOSED_MANAGED_SITE_CHECKOUT_AUTHORITY_RESOLVER: ManagedSiteCheckoutAuthorityResolver = {
  async resolve() { return null },
}

export function createManagedSiteCheckoutAuthorityResolver(): ManagedSiteCheckoutAuthorityResolver {
  return {
    async resolve(input: ManagedSiteCheckoutAuthorityInput): Promise<ManagedSiteCheckoutAuthority | null> {
      const lineageOwners = [input.preview.ownerUserId, input.quote.ownerUserId, input.leadIntent.ownerUserId, input.draftOrder.ownerUserId, input.subscriptionIntent?.ownerUserId ?? null]
      if (lineageOwners.some(value => value === null || value === undefined)) return null
      const ownerUserId = lineageOwners[0]
      if (typeof ownerUserId !== 'number' || !Number.isSafeInteger(ownerUserId) || ownerUserId < 1) return null
      if (!lineageOwners.every(value => value === ownerUserId)) return null
      return { ownerUserId, source: 'existing_lineage' }
    },
  }
}

async function resolveManagedSiteCheckoutAuthority(
  repository: PreviewRepository,
  input: ManagedSiteCheckoutAuthorityInput,
  resolver: ManagedSiteCheckoutAuthorityResolver,
): Promise<{ authority: ManagedSiteCheckoutAuthority; lineage: ManagedSiteCheckoutAuthorityInput }> {
  const authority = await resolver.resolve(input)
  if (!authority || !Number.isSafeInteger(authority.ownerUserId) || authority.ownerUserId < 1) throw createError({ statusCode: 409, statusMessage: 'A server-owned checkout authority could not be resolved.' })
  const owners = [input.preview.ownerUserId, input.quote.ownerUserId, input.leadIntent.ownerUserId, input.draftOrder.ownerUserId, input.subscriptionIntent?.ownerUserId ?? null].filter((value): value is number => value !== null)
  if (owners.some(value => value !== authority.ownerUserId)) throw createError({ statusCode: 409, statusMessage: 'Checkout lineage is already bound to a different owner.' })
  return { authority, lineage: input }
}

function paymentString(value: unknown, label: string, max: number): string {
  return stringField(value, label, max)!
}

function paymentCurrency(value: unknown): string {
  const currency = paymentString(value, 'Payment currency', 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) invalid('Payment currency is invalid.')
  return currency
}

function paymentAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid('Payment amount is invalid.')
  return value
}

export async function recordVerifiedPaymentEvent(input: unknown, verifier: PaymentEventVerifier = FAIL_CLOSED_PAYMENT_EVENT_VERIFIER, repository = getPreviewRepository(), clock: () => Date = () => new Date(), authorityResolver: ManagedSiteCheckoutAuthorityResolver = createManagedSiteCheckoutAuthorityResolver()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Payment event is invalid.')
  const candidate = input as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(candidate, 'verified')) throw createError({ statusCode: 422, statusMessage: 'Caller-controlled payment verification is not accepted.' })
  const orderId = Number(candidate.draftOrderId)
  if (!Number.isSafeInteger(orderId) || orderId < 1) invalid('Draft order id is invalid.')
  if (candidate.eventType !== 'payment_succeeded') throw createError({ statusCode: 422, statusMessage: 'Payment event type is not supported.' })
  const providerKey = paymentString(candidate.providerKey, 'Payment provider key', 96)
  const eventId = paymentString(candidate.eventId, 'Payment event id', 160)
  const providerReference = paymentString(candidate.providerReference, 'Payment provider reference', 160)
  const amountMinor = paymentAmount(candidate.amountMinor)
  const currency = paymentCurrency(candidate.currency)
  const canonicalPayloadHash = paymentString(candidate.canonicalPayloadHash, 'Payment canonical payload hash', 128)
  if (!/^[a-f0-9]{64}$/i.test(canonicalPayloadHash)) invalid('Payment canonical payload hash is invalid.')
  const receivedAt = ensureFiniteDate(clock(), 'Payment receivedAt')
  const order = await repository.findDraftOrderById(orderId)
  if (!order) notFound('Draft order was not found.')
  const preview = await repository.findPreviewById(order.previewId)
  const quote = await repository.findQuoteById(order.quoteId)
  const leadIntent = await repository.findLeadIntentByLineage(order.previewId, order.quoteId, order.leadId)
  const subscriptionIntent = await repository.findSubscriptionIntentByQuote(order.quoteId)
  if (!preview || !quote || !leadIntent || !subscriptionIntent || quote.previewId !== preview.id || quote.totalMinor !== amountMinor || quote.currency !== currency || leadIntent.previewId !== preview.id || leadIntent.quoteId !== quote.id || subscriptionIntent.quoteId !== quote.id) throw createError({ statusCode: 409, statusMessage: 'Payment event lineage or amount does not match the draft order.' })
  const authorityResult = await resolveManagedSiteCheckoutAuthority(repository, { preview, quote, leadIntent, draftOrder: order, subscriptionIntent }, authorityResolver)
  const authority = authorityResult.authority
  const lineage = authorityResult.lineage
  const verificationRequest = { providerKey, eventId, draftOrderId: lineage.draftOrder.id, amountMinor, currency, eventType: 'payment_succeeded' as const, providerReference, canonicalPayloadHash, receivedAt }
  const verificationResult = await verifier.verify(verificationRequest)
  if (verificationResult !== true) throw createError({ statusCode: 403, statusMessage: 'Payment provider verification did not return the exact boolean true.' })
  const eventFingerprint = stableFingerprint({ ownerUserId: authority.ownerUserId, providerKey, eventId, draftOrderId: lineage.draftOrder.id, previewId: lineage.preview.id, quoteId: lineage.quote.id, amountMinor, currency, eventType: 'payment_succeeded', providerReference, canonicalPayloadHash })
  const replay = await repository.findPaymentEvent(authority.ownerUserId, providerKey, eventId)
  if (replay) {
    if (replay.eventFingerprint !== eventFingerprint || replay.draftOrderId !== lineage.draftOrder.id || replay.previewId !== lineage.preview.id || replay.quoteId !== lineage.quote.id) throw createError({ statusCode: 409, statusMessage: 'Payment event identity was already used for a different order or payload.' })
    return { paymentEvent: replay, order: lineage.draftOrder, replayed: true, authority }
  }
  const fingerprintReplay = await repository.findPaymentEventByFingerprint(authority.ownerUserId, eventFingerprint)
  if (fingerprintReplay) return { paymentEvent: fingerprintReplay, order: lineage.draftOrder, replayed: true, authority }
  if (lineage.draftOrder.status !== 'payment_pending') throw createError({ statusCode: 409, statusMessage: 'Draft order is not awaiting payment.' })
  const updated = await repository.transaction(async transaction => {
    const currentPreview = await transaction.findPreviewById(lineage.preview.id)
    const currentQuote = await transaction.findQuoteById(lineage.quote.id)
    const currentLeadIntent = await transaction.findLeadIntentByLineage(lineage.preview.id, lineage.quote.id, lineage.draftOrder.leadId)
    const currentOrderLineage = await transaction.findDraftOrderById(lineage.draftOrder.id)
    const currentSubscriptionIntent = await transaction.findSubscriptionIntentByQuote(lineage.quote.id)
    if (!currentPreview || !currentQuote || !currentLeadIntent || !currentOrderLineage || !currentSubscriptionIntent) throw createError({ statusCode: 409, statusMessage: 'Checkout lineage disappeared during authority binding.' })
    const currentOwners = [currentPreview.ownerUserId, currentQuote.ownerUserId, currentLeadIntent.ownerUserId, currentOrderLineage.ownerUserId, currentSubscriptionIntent.ownerUserId]
    if (currentOwners.some(value => value !== null && value !== authority.ownerUserId)) throw createError({ statusCode: 409, statusMessage: 'Checkout lineage is already bound to a different owner.' })
    const boundAt = receivedAt
    const boundPreview = await transaction.updatePreview(currentPreview.id, { ownerUserId: authority.ownerUserId, updatedAt: boundAt } as any)
    const boundQuoteRecord = await transaction.updateQuote(currentQuote.id, { ownerUserId: authority.ownerUserId, updatedAt: boundAt } as any)
    const boundLeadIntent = await transaction.updateLeadIntent(currentLeadIntent.id, { ownerUserId: authority.ownerUserId } as any)
    const boundDraftOrder = await transaction.updateDraftOrder(currentOrderLineage.id, { ownerUserId: authority.ownerUserId, updatedAt: boundAt } as any)
    const boundSubscriptionIntent = await transaction.updateSubscriptionIntent(currentSubscriptionIntent.quoteId, { ownerUserId: authority.ownerUserId, updatedAt: boundAt } as any)
    if (!boundPreview || !boundQuoteRecord || !boundLeadIntent || !boundDraftOrder || !boundSubscriptionIntent) throw createError({ statusCode: 409, statusMessage: 'Checkout lineage could not be atomically bound to one owner.' })
    const boundLineage = { preview: boundPreview, quote: boundQuoteRecord, leadIntent: boundLeadIntent, draftOrder: boundDraftOrder, subscriptionIntent: boundSubscriptionIntent }
    const raceReplay = await transaction.findPaymentEvent(authority.ownerUserId, providerKey, eventId)
    if (raceReplay) {
      if (raceReplay.eventFingerprint !== eventFingerprint || raceReplay.draftOrderId !== lineage.draftOrder.id) throw createError({ statusCode: 409, statusMessage: 'Payment event identity was already used for a different order or payload.' })
      const replayOrder = await transaction.findDraftOrderById(lineage.draftOrder.id)
      if (!replayOrder) notFound('Draft order was not found.')
      return { event: raceReplay, changed: replayOrder, replayed: true }
    }
    const currentOrder = boundLineage.draftOrder
    const boundQuote = boundLineage.quote
    if (currentOrder.status !== 'payment_pending' || boundQuote.totalMinor !== amountMinor || boundQuote.currency !== currency) throw createError({ statusCode: 409, statusMessage: 'Payment order changed while verification was in progress.' })
    const event = await transaction.insertPaymentEvent({ ownerUserId: authority.ownerUserId, draftOrderId: boundLineage.draftOrder.id, previewId: boundLineage.preview.id, quoteId: boundQuote.id, providerKey, eventId, providerReference, eventType: 'payment_succeeded', amountMinor, currency, canonicalPayloadHash, verificationStatus: 'verified', eventFingerprint, receivedAt } as any)
    await createPaidManagedSiteModuleFulfilments(authority.ownerUserId, boundLineage.draftOrder.id, boundQuote, await transaction.listQuoteLines(boundQuote.id), transaction)
    const changed = await transaction.updateDraftOrder(boundLineage.draftOrder.id, { status: 'payment_verified', paymentIntentReference: providerReference, updatedAt: receivedAt } as any)
    if (!changed) notFound('Draft order was not found.')
    await transaction.updateQuote(boundQuote.id, { status: 'locked', lockedAt: receivedAt, updatedAt: receivedAt } as any)
    await transaction.updateSubscriptionIntent(boundQuote.id, { status: 'entitled', updatedAt: receivedAt } as any)
    return { event, changed, replayed: false }
  })
  if (!updated.changed) notFound('Draft order was not found.')
  return { paymentEvent: updated.event, order: updated.changed, replayed: updated.replayed, authority }
}

export type { ManagedSiteDraftOrder, ManagedSiteLeadIntent, ManagedSitePaymentEvent, ManagedSitePreview, ManagedSiteQuote, ManagedSiteQuoteLine, ManagedSiteSubscriptionIntent }
