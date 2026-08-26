import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { getPreviewRepository } from './ordering-repository'
import { assertExistingSiteUrl, buildPreviewProjection, buildSiteSpec, BUSINESS_GOALS, SITE_MODULES, type SiteBriefInput, type SiteModule, type SiteSpec } from './site-spec'
import { FAIL_CLOSED_EXISTING_SITE_DIAGNOSIS_RESOLVER, type ExistingSiteDiagnosisResolver } from './diagnosis-binding'
import { normalizeRecipientEmail, tokenHash } from './normalization'
import type { ManagedSiteDraftOrder, ManagedSiteLeadIntent, ManagedSitePaymentEvent, ManagedSitePreview, ManagedSiteQuote, ManagedSiteQuoteLine, ManagedSiteSubscriptionIntent } from '../database/schema'
import type { DraftOrderInput, LeadInput, ManagedSiteCheckoutAuthority, ManagedSiteCheckoutAuthorityInput, ManagedSiteCheckoutAuthorityResolver, PaymentEventVerifier, PreviewGenerationResult, PreviewRepository, QuoteInput } from './ordering-types'

export const MANAGED_SITE_PRICE_CATALOG_VERSION = 'managed-site-pricing-v1'
export const MANAGED_SITE_TERM_MONTHS = 12
export const MANAGED_SITE_QUOTE_TTL_MS = 1000 * 60 * 60 * 24

const PLAN_CATALOG = {
  basic: { siteBuildMinor: 9900, geoSubscriptionMinor: 9900, description: 'Basic managed site + GEO subscription' },
  business: { siteBuildMinor: 19900, geoSubscriptionMinor: 19900, description: 'Business managed site + GEO subscription' },
} as const

const CADENCE_CATALOG: Record<3 | 7 | 15 | 30, number> = { 3: 4900, 7: 2900, 15: 1900, 30: 990 }

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
    limitations: ['Tax is not calculated in V1.', 'Payment, domain purchase, DNS, TLS and deployment are not executed by this contract until separately authorized and configured.', 'AI visibility, ranking, traffic, conversion and revenue are not guaranteed.'],
  }
}

export function getManagedSitePriceCatalog() {
  return {
    version: MANAGED_SITE_PRICE_CATALOG_VERSION,
    currency: 'USD' as const,
    termMonths: MANAGED_SITE_TERM_MONTHS,
    plans: Object.entries(PLAN_CATALOG).map(([key, value]) => ({ key, siteBuildMinor: value.siteBuildMinor, geoSubscriptionMinor: value.geoSubscriptionMinor, description: value.description })),
    cadence: Object.entries(CADENCE_CATALOG).map(([days, amount]) => ({ days: Number(days), monthlyMinor: amount })),
    domainOptions: ['existing', 'new', 'assisted'] as const,
    modules: SITE_MODULES,
  }
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
  if (!['basic', 'business'].includes(input.planKey)) invalid('Plan is not available in V1.')
  if (![3, 7, 15, 30].includes(input.cadenceDays)) invalid('GEO cadence is not available in V1.')
  if (!['existing', 'new', 'assisted'].includes(input.domainOption)) invalid('Domain option is not available in V1.')
  const preview = await repository.findPreviewById(input.previewId)
  if (!preview) notFound('Managed site preview was not found.')
  assertPreviewAccess(preview, input.previewAccessToken)
  assertPreviewUsable(preview, clock())
  const spec = preview.siteSpecSnapshot as unknown as SiteSpec
  const selectedModules = input.moduleKeys ? [...new Set(input.moduleKeys)] : spec.selectedModules
  if (selectedModules.length > SITE_MODULES.length || selectedModules.some(module => !(SITE_MODULES as readonly string[]).includes(module))) invalid('Selected module is not available in V1.')
  if (spec.siteType === 'simple_commerce' && !selectedModules.includes('shopify_commerce')) invalid('Simple commerce requires Shopify commerce in V1.')
  const idempotencyKey = stringField(input.idempotencyKey, 'Quote idempotency key', 128)!
  const quoteFingerprint = stableFingerprint({ previewFingerprint: preview.previewFingerprint, planKey: input.planKey, cadenceDays: input.cadenceDays, domainOption: input.domainOption, selectedModules: [...selectedModules].sort(), catalogVersion: MANAGED_SITE_PRICE_CATALOG_VERSION })
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
  const plan = PLAN_CATALOG[input.planKey]
  const lines: QuoteLineInput[] = [
    { lineKey: 'site-build', description: plan.description, quantity: 1, unitAmountMinor: plan.siteBuildMinor },
    { lineKey: `geo-${input.cadenceDays}d`, description: `GEO content subscription · every ${input.cadenceDays} days`, quantity: 1, unitAmountMinor: plan.geoSubscriptionMinor + CADENCE_CATALOG[input.cadenceDays] },
  ]
  if (input.domainOption === 'new') lines.push({ lineKey: 'domain-registration-intent', description: 'Domain registration intent (provider confirmation required)', quantity: 1, unitAmountMinor: 1200 })
  if (input.domainOption === 'assisted') lines.push({ lineKey: 'domain-assisted-setup', description: 'Domain setup assistance', quantity: 1, unitAmountMinor: 2500 })
  if (selectedModules.includes('bounded_ai_assistant')) lines.push({ lineKey: 'bounded-ai-assistant', description: 'Bounded AI assistant module', quantity: 1, unitAmountMinor: 4900 })
  const totalMinor = lines.reduce((total, line) => total + line.quantity * line.unitAmountMinor, 0)
  const quote = await repository.transaction(async transaction => {
      const created = await transaction.insertQuote({ ownerUserId: preview.ownerUserId, previewId: preview.id, projectId: null, quoteVersion: MANAGED_SITE_PRICE_CATALOG_VERSION, idempotencyKey, planKey: input.planKey, currency: 'USD', totalMinor, taxStatus: 'not_calculated', moduleSnapshot: selectedModules, cadenceDays: input.cadenceDays, domainOption: input.domainOption, siteSpecFingerprint: spec.deterministicFingerprint, quoteFingerprint, status: 'quoted', expiresAt, lockedAt: null, createdAt, updatedAt: createdAt } as any)
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

export function createManagedSiteCheckoutAuthorityResolver(repository: PreviewRepository): ManagedSiteCheckoutAuthorityResolver {
  return {
    async resolve(input: ManagedSiteCheckoutAuthorityInput): Promise<ManagedSiteCheckoutAuthority | null> {
      const knownOwners = [input.preview.ownerUserId, input.quote.ownerUserId, input.leadIntent.ownerUserId, input.draftOrder.ownerUserId, input.subscriptionIntent?.ownerUserId ?? null].filter((value): value is number => value !== null)
      if (knownOwners.length > 0 && knownOwners.every(value => value === knownOwners[0])) return { ownerUserId: knownOwners[0]!, source: 'existing_lineage' }
      if (knownOwners.length > 0) return null
      const lead = await repository.findLeadById(input.leadIntent.leadId)
      if (!lead) return null
      const ownerUserId = await repository.findUserIdByEmail(lead.email)
      if (!ownerUserId || !Number.isSafeInteger(ownerUserId) || ownerUserId < 1) return null
      return { ownerUserId, source: 'existing_account_email' }
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

export async function recordVerifiedPaymentEvent(input: unknown, verifier: PaymentEventVerifier = FAIL_CLOSED_PAYMENT_EVENT_VERIFIER, repository = getPreviewRepository(), clock: () => Date = () => new Date(), authorityResolver: ManagedSiteCheckoutAuthorityResolver = createManagedSiteCheckoutAuthorityResolver(repository)) {
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
