import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import type { ManagedSiteFunnelSession } from '../../database/schema'
import { normalizeRecipientEmail } from '../normalization'
import { getManagedSitePriceCatalog } from '../ordering-service'
import { tokenHash } from '../normalization'
import { BUSINESS_GOALS, SITE_MODULES } from '../site-spec'
import { MANAGED_SITE_TYPES } from '../types'
import { getFunnelSessionRepository, type FunnelSessionRepository } from './session-repository'

export const MANAGED_SITE_FUNNEL_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14
export const MANAGED_SITE_FUNNEL_TOTAL_STEPS = 9
export const MANAGED_SITE_FUNNEL_CONSENT_VERSION = 'managed-site-funnel-consent-v1'

type ExistingSiteSnapshot = {
  analysedAt: string
  analysisVersion: string
  snapshotFingerprint: string
  scores: { overall: number; seo: number; geo: number; brandContent: number; ux: number }
}

export type FunnelAnswers = {
  existingSite?: {
    hasSite: boolean
    url?: string
    diagnosisId?: number | null
    snapshot?: ExistingSiteSnapshot
  }
  company?: { brandName: string; whatWeDo: string; feelings: string[]; mainOffer: string; conversionGoals: string[] }
  contact?: { email: string; contactName: string; phone?: string }
  style?: { referenceUrls: string[]; stylePreset?: 'minimal' | 'business' | 'premium' | 'warm' | 'lively' | 'tech'; designTier: 'template' | 'designer' }
  siteType?: 'one_page' | 'brand_blog' | 'simple_commerce'
  modules?: string[]
  previewDraft?: { generatedAt: string; source: 'llm' | 'template'; headline: string; sections: { heading: string; body: string }[] }
  domain?: { option: 'existing' | 'new' | 'assisted'; tld?: string; name?: string }
  plan?: { planKey: string; cadenceDays?: 3 | 7 | 15 | 30 }
}

export type FunnelConsentSnapshot = {
  policyVersion: string
  acceptedAt: string
  scrolledToBottom: true
}

type ConsentInput = { policyVersion: string; scrolledToBottom: true }

const ANSWER_KEYS = ['existingSite', 'company', 'contact', 'style', 'siteType', 'modules', 'previewDraft', 'domain', 'plan'] as const
const STYLE_PRESETS = ['minimal', 'business', 'premium', 'warm', 'lively', 'tech'] as const

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function notFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Managed site funnel session was not found.' })
}

function exactObject(value: unknown, keys: readonly string[], label: string, statusCode = 422): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) throw createError({ statusCode, statusMessage: `${label} is invalid.` })
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`${label} is invalid.`)
  return value.trim()
}

function stringArray(value: unknown, label: string, options: { maxItems: number; maxLength: number }): string[] {
  if (!Array.isArray(value) || value.length > options.maxItems || value.some(item => typeof item !== 'string' || !item.trim() || item.trim().length > options.maxLength)) invalid(`${label} is invalid.`)
  const normalized = value.map(item => String(item).trim())
  if (new Set(normalized).size !== normalized.length) invalid(`${label} must not contain duplicates.`)
  return normalized
}

function httpsUrl(value: unknown, label: string, max = 512): string {
  const text = requiredString(value, label, max)
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) invalid(`${label} must be an absolute HTTPS URL.`)
    return parsed.toString()
  } catch (error) {
    if ((error as any)?.statusCode) throw error
    invalid(`${label} must be an absolute HTTPS URL.`)
  }
}

function scoreSnapshot(value: unknown): ExistingSiteSnapshot {
  const snapshot = exactObject(value, ['analysedAt', 'analysisVersion', 'snapshotFingerprint', 'scores'], 'Existing-site snapshot')
  const analysedAt = requiredString(snapshot.analysedAt, 'Existing-site snapshot time', 64)
  if (!Number.isFinite(new Date(analysedAt).getTime())) invalid('Existing-site snapshot time is invalid.')
  const analysisVersion = requiredString(snapshot.analysisVersion, 'Existing-site analysis version', 128)
  const snapshotFingerprint = requiredString(snapshot.snapshotFingerprint, 'Existing-site snapshot fingerprint', 128)
  if (!/^[a-f0-9]{64}$/u.test(snapshotFingerprint)) invalid('Existing-site snapshot fingerprint is invalid.')
  const scores = exactObject(snapshot.scores, ['overall', 'seo', 'geo', 'brandContent', 'ux'], 'Existing-site snapshot scores')
  const normalizedScores = Object.fromEntries(Object.entries(scores).map(([key, score]) => {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) invalid(`Existing-site ${key} score is invalid.`)
    return [key, score]
  })) as ExistingSiteSnapshot['scores']
  return { analysedAt: new Date(analysedAt).toISOString(), analysisVersion, snapshotFingerprint, scores: normalizedScores }
}

function validateAnswers(input: unknown): Partial<FunnelAnswers> {
  const candidate = exactObject(input, ANSWER_KEYS, 'Funnel answers')
  const output: Partial<FunnelAnswers> = {}
  if ('existingSite' in candidate) {
    const value = exactObject(candidate.existingSite, ['hasSite', 'url', 'diagnosisId'], 'Existing-site answer', 400)
    if (typeof value.hasSite !== 'boolean') invalid('Existing-site selection is invalid.')
    const url = value.url === undefined ? undefined : httpsUrl(value.url, 'Existing-site URL', 2048)
    let diagnosisId: number | null | undefined
    if (value.diagnosisId === undefined || value.diagnosisId === null) diagnosisId = value.diagnosisId
    else {
      if (typeof value.diagnosisId !== 'number' || !Number.isSafeInteger(value.diagnosisId) || value.diagnosisId < 1) invalid('Existing-site Diagnosis ID is invalid.')
      diagnosisId = value.diagnosisId
    }
    if (value.hasSite && !url) invalid('Existing-site URL is required when an existing site is selected.')
    if (!value.hasSite && (url || diagnosisId !== undefined && diagnosisId !== null)) invalid('Existing-site details require an existing site selection.')
    output.existingSite = { hasSite: value.hasSite, ...(url ? { url } : {}), ...(diagnosisId !== undefined ? { diagnosisId } : {}) }
  }
  if ('company' in candidate) {
    const value = exactObject(candidate.company, ['brandName', 'whatWeDo', 'feelings', 'mainOffer', 'conversionGoals'], 'Company answer')
    const conversionGoals = stringArray(value.conversionGoals, 'Conversion goals', { maxItems: BUSINESS_GOALS.length, maxLength: 80 })
    if (!conversionGoals.length || !conversionGoals.every(goal => (BUSINESS_GOALS as readonly string[]).includes(goal))) invalid('Conversion goals contain an unsupported value.')
    output.company = {
      brandName: requiredString(value.brandName, 'Brand name', 160),
      whatWeDo: requiredString(value.whatWeDo, 'Company description', 2000),
      feelings: stringArray(value.feelings, 'Brand feelings', { maxItems: 12, maxLength: 120 }),
      mainOffer: requiredString(value.mainOffer, 'Main offer', 1000),
      conversionGoals,
    }
  }
  if ('contact' in candidate) {
    const value = exactObject(candidate.contact, ['email', 'contactName', 'phone'], 'Contact answer')
    const email = normalizeRecipientEmail(requiredString(value.email, 'Contact email', 320))
    const contactName = requiredString(value.contactName, 'Contact name', 120)
    const phone = value.phone === undefined ? undefined : requiredString(value.phone, 'Contact phone', 40)
    if (phone !== undefined && !/^[0-9+() -]+$/u.test(phone)) invalid('Contact phone is invalid.')
    output.contact = { email, contactName, ...(phone ? { phone } : {}) }
  }
  if ('style' in candidate) {
    const value = exactObject(candidate.style, ['referenceUrls', 'stylePreset', 'designTier'], 'Style answer')
    if (!Array.isArray(value.referenceUrls) || value.referenceUrls.length > 3) invalid('At most three style reference URLs are allowed.')
    const referenceUrls = value.referenceUrls.map((url, index) => httpsUrl(url, `Style reference ${index + 1}`, 512))
    if (new Set(referenceUrls).size !== referenceUrls.length) invalid('Style reference URLs must not contain duplicates.')
    const stylePreset = value.stylePreset === undefined ? undefined : requiredString(value.stylePreset, 'Style preset', 32)
    if (stylePreset && !(STYLE_PRESETS as readonly string[]).includes(stylePreset)) invalid('Style preset is not supported.')
    if (!getManagedSitePriceCatalog().designTiers.some(tier => tier.key === value.designTier)) invalid('Design tier is not supported.')
    output.style = { referenceUrls, ...(stylePreset ? { stylePreset: stylePreset as NonNullable<FunnelAnswers['style']>['stylePreset'] } : {}), designTier: value.designTier as 'template' | 'designer' }
  }
  if ('siteType' in candidate) {
    if (!(MANAGED_SITE_TYPES as readonly unknown[]).includes(candidate.siteType)) invalid('Site type is not supported.')
    output.siteType = candidate.siteType as FunnelAnswers['siteType']
  }
  if ('modules' in candidate) {
    const modules = stringArray(candidate.modules, 'Site modules', { maxItems: SITE_MODULES.length, maxLength: 96 })
    if (!modules.every(module => (SITE_MODULES as readonly string[]).includes(module))) invalid('Site modules contain an unsupported value.')
    output.modules = modules
  }
  if ('previewDraft' in candidate) {
    const value = exactObject(candidate.previewDraft, ['generatedAt', 'source', 'headline', 'sections'], 'Preview draft')
    const generatedAt = requiredString(value.generatedAt, 'Preview generated time', 64)
    if (!Number.isFinite(new Date(generatedAt).getTime())) invalid('Preview generated time is invalid.')
    if (!['llm', 'template'].includes(String(value.source || ''))) invalid('Preview source is invalid.')
    if (!Array.isArray(value.sections) || value.sections.length > 30) invalid('Preview sections are invalid.')
    const sections = value.sections.map((section, index) => {
      const item = exactObject(section, ['heading', 'body'], `Preview section ${index + 1}`)
      return { heading: requiredString(item.heading, `Preview section ${index + 1} heading`, 300), body: requiredString(item.body, `Preview section ${index + 1} body`, 2_000) }
    })
    output.previewDraft = { generatedAt: new Date(generatedAt).toISOString(), source: value.source as 'llm' | 'template', headline: requiredString(value.headline, 'Preview headline', 300), sections }
  }
  if ('domain' in candidate) {
    const value = exactObject(candidate.domain, ['option', 'tld', 'name'], 'Domain answer')
    const catalog = getManagedSitePriceCatalog()
    if (!(catalog.domainOptions as readonly string[]).includes(String(value.option || ''))) invalid('Domain option is not supported.')
    const tld = value.tld === undefined ? undefined : requiredString(value.tld, 'Domain TLD', 32).toLowerCase()
    if (tld && !catalog.domainTlds.some(item => item.tld === tld)) invalid('Domain TLD is not supported.')
    const name = value.name === undefined ? undefined : requiredString(value.name, 'Domain name', 253).toLowerCase()
    if (value.option === 'new') {
      if (!tld || !name || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name)) invalid('A valid requested domain name and TLD are required.')
    } else if (tld !== undefined) invalid('Domain TLD is only available for a new domain.')
    output.domain = { option: value.option as NonNullable<FunnelAnswers['domain']>['option'], ...(tld ? { tld } : {}), ...(name ? { name } : {}) }
  }
  if ('plan' in candidate) {
    const value = exactObject(candidate.plan, ['planKey', 'cadenceDays'], 'Plan answer')
    const catalog = getManagedSitePriceCatalog()
    const planKey = requiredString(value.planKey, 'Plan key', 96)
    if (!catalog.plans.some(plan => plan.key === planKey)) invalid('Plan key is not supported.')
    const cadenceDays = value.cadenceDays === undefined ? undefined : value.cadenceDays
    if (cadenceDays !== undefined && !catalog.cadence.some(item => item.days === cadenceDays)) invalid('Plan cadence is not supported.')
    output.plan = { planKey, ...(cadenceDays !== undefined ? { cadenceDays: cadenceDays as 3 | 7 | 15 | 30 } : {}) }
  }
  return output
}

function consentSnapshot(input: unknown, clock: () => Date): FunnelConsentSnapshot {
  const candidate = exactObject(input, ['policyVersion', 'scrolledToBottom'], 'Funnel consent')
  if (candidate.scrolledToBottom !== true) throw createError({ statusCode: 400, statusMessage: 'Consent requires reading the full agreement.' })
  if (candidate.policyVersion !== MANAGED_SITE_FUNNEL_CONSENT_VERSION) throw createError({ statusCode: 400, statusMessage: 'Consent policy version is invalid.' })
  const acceptedAt = clock()
  if (!Number.isFinite(acceptedAt.getTime())) invalid('Funnel consent clock is invalid.')
  return { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, acceptedAt: acceptedAt.toISOString(), scrolledToBottom: true }
}

function mergeAnswers(existing: unknown, patch: Partial<FunnelAnswers>): FunnelAnswers {
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as FunnelAnswers : {}
  const merged: FunnelAnswers = { ...current }
  for (const key of ANSWER_KEYS) {
    if (!(key in patch)) continue
    const next = patch[key]
    if (key === 'existingSite' && (next as FunnelAnswers['existingSite'])?.hasSite === false) {
      merged.existingSite = { hasSite: false }
      continue
    }
    const previous = current[key]
    ;(merged as any)[key] = next && previous && typeof next === 'object' && typeof previous === 'object' && !Array.isArray(next) && !Array.isArray(previous) ? { ...previous, ...next } : next
  }
  return merged
}

export async function createFunnelSession(repository: FunnelSessionRepository = getFunnelSessionRepository(), clock: () => Date = () => new Date()) {
  const createdAt = clock()
  if (!Number.isFinite(createdAt.getTime())) invalid('Funnel session clock is invalid.')
  const sessionToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(createdAt.getTime() + MANAGED_SITE_FUNNEL_SESSION_TTL_MS)
  const session = await repository.insertSession({ sessionTokenHash: tokenHash(sessionToken), status: 'active', currentStep: 1, answers: {}, consentSnapshot: null, previewId: null, previewAccessTokenHash: null, quoteId: null, leadIntentId: null, draftOrderId: null, projectId: null, releaseId: null, builtPreviewUrl: null, checkoutUrl: null, expiresAt } as any)
  return { sessionId: session.id, sessionToken, expiresAt, session }
}

export async function loadFunnelSession(sessionId: number, sessionToken: string, repository: FunnelSessionRepository = getFunnelSessionRepository(), clock: () => Date = () => new Date()): Promise<ManagedSiteFunnelSession> {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1 || typeof sessionToken !== 'string' || sessionToken.length < 32 || sessionToken.length > 256) notFound()
  const session = await repository.findSessionByToken(sessionId, tokenHash(sessionToken))
  const now = clock()
  if (!session || !Number.isFinite(now.getTime()) || session.expiresAt.getTime() <= now.getTime() || session.status === 'expired') notFound()
  return session
}

export async function saveFunnelStep(sessionId: number, sessionToken: string, input: { step: number; answers: Partial<FunnelAnswers>; consent?: ConsentInput }, repository: FunnelSessionRepository = getFunnelSessionRepository(), clock: () => Date = () => new Date()) {
  const session = await loadFunnelSession(sessionId, sessionToken, repository, clock)
  if (!Number.isSafeInteger(input?.step) || input.step < 1 || input.step > MANAGED_SITE_FUNNEL_TOTAL_STEPS) invalid('Funnel step must be between 1 and 9.')
  if (session.status !== 'active') throw createError({ statusCode: 409, statusMessage: 'This funnel session can no longer be changed.' })
  const answers = mergeAnswers(session.answers, validateAnswers(input?.answers))
  const consent = input.consent === undefined ? session.consentSnapshot : consentSnapshot(input.consent, clock)
  const currentStep = Math.min(MANAGED_SITE_FUNNEL_TOTAL_STEPS, Math.max(session.currentStep, input.step + 1))
  const updated = await repository.updateSession(session.id, { answers, consentSnapshot: consent, currentStep } as any)
  if (!updated) notFound()
  return updated
}

export async function recordFunnelConsent(sessionId: number, sessionToken: string, input: ConsentInput, repository: FunnelSessionRepository = getFunnelSessionRepository(), clock: () => Date = () => new Date()) {
  const session = await loadFunnelSession(sessionId, sessionToken, repository, clock)
  if (session.status !== 'active') throw createError({ statusCode: 409, statusMessage: 'This funnel session can no longer be changed.' })
  const updated = await repository.updateSession(session.id, { consentSnapshot: consentSnapshot(input, clock) } as any)
  if (!updated) notFound()
  return updated
}

export async function recordFunnelSiteAnalysis(
  sessionId: number,
  sessionToken: string,
  input: { url: string; snapshot: unknown },
  repository: FunnelSessionRepository = getFunnelSessionRepository(),
  clock: () => Date = () => new Date(),
) {
  const session = await loadFunnelSession(sessionId, sessionToken, repository, clock)
  if (session.status !== 'active') throw createError({ statusCode: 409, statusMessage: 'This funnel session can no longer be changed.' })
  const url = httpsUrl(input.url, 'Existing-site URL', 2048)
  const snapshot = scoreSnapshot(input.snapshot)
  const answers = mergeAnswers(session.answers, { existingSite: { hasSite: true, url, snapshot } })
  const currentStep = Math.min(MANAGED_SITE_FUNNEL_TOTAL_STEPS, Math.max(session.currentStep, 2))
  const updated = await repository.updateSession(session.id, { answers, currentStep } as any)
  if (!updated) notFound()
  return updated
}
