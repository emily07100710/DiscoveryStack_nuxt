import { getHeader, getMethod, getRequestIP, getRequestURL, readBody, setResponseHeaders, type H3Event } from 'h3'
import { resolveControlledOwnerDatabaseUserId } from '../../../audit/repository'
import { confirmManagedSiteContactInboxBinding, managedSiteContactInboxProjection, startManagedSiteContactInboxBinding } from '../../../managed-sites/contact-inbox/binding-service'
import { runFunnelBuild, runFunnelCheckout } from '../../../managed-sites/funnel/checkout-orchestrator'
import { projectFunnelQuote } from '../../../managed-sites/funnel/quote-projection'
import { generateFunnelPreviewDraft, type FunnelPreviewDraft } from '../../../managed-sites/funnel/preview-draft-service'
import { getFunnelSessionRepository } from '../../../managed-sites/funnel/session-repository'
import { createFunnelSession, loadFunnelSession, MANAGED_SITE_FUNNEL_CONSENT_VERSION, MANAGED_SITE_FUNNEL_TOTAL_STEPS, recordFunnelConsent, recordFunnelSiteAnalysis, saveFunnelStep, type FunnelAnswers } from '../../../managed-sites/funnel/session-service'
import { assertSameOriginManagedSiteMutation, strictManagedSiteBody } from '../../../managed-sites/live-connectors/http'
import { getManagedSiteLiveConnectorRepository } from '../../../managed-sites/live-connectors/repository'
import { getPreviewRepository } from '../../../managed-sites/ordering-repository'
import { parsePathId } from '../../../managed-sites/normalization'
import { analysePublicHomepage } from '../../../utils/publicSiteAnalysis'

const funnelPrefix = '/api/managed-sites/funnel'
const privateHeaders = { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' }
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT_MAX_MUTATIONS = 30
const RATE_LIMIT_MAX_BUCKETS = 10_000
export const MANAGED_SITE_FUNNEL_MAX_BODY_BYTES = 64 * 1024
const mutationBuckets = new Map<string, { startedAt: number; count: number }>()
const PREVIEW_DRAFT_WINDOW_MS = 10 * 60 * 1000
const PREVIEW_DRAFT_MAX_GENERATIONS = 5
const previewDraftBuckets = new Map<number, { startedAt: number; count: number }>()
const previewDraftReplay = new Map<number, { createdAt: number; draft: FunnelPreviewDraft }>()
const SITE_ANALYSIS_WINDOW_MS = 10 * 60 * 1000
const SITE_ANALYSIS_MAX_RUNS = 5
const siteAnalysisBuckets = new Map<number, { startedAt: number; count: number }>()

function checkRateLimit(event: H3Event, sessionId?: number): void {
  const now = Date.now()
  for (const [key, bucket] of mutationBuckets) if (bucket.startedAt + RATE_LIMIT_WINDOW_MS <= now) mutationBuckets.delete(key)
  if (mutationBuckets.size >= RATE_LIMIT_MAX_BUCKETS) mutationBuckets.delete(mutationBuckets.keys().next().value as string)
  const key = sessionId ? `session:${sessionId}` : `create:${getRequestIP(event, { xForwardedFor: false }) || 'unknown'}`
  const existing = mutationBuckets.get(key)
  const bucket = !existing || existing.startedAt + RATE_LIMIT_WINDOW_MS <= now ? { startedAt: now, count: 0 } : existing
  if (bucket.count >= RATE_LIMIT_MAX_MUTATIONS) throw createError({ statusCode: 429, statusMessage: 'Too many funnel requests. Please try again later.' })
  bucket.count += 1
  mutationBuckets.set(key, bucket)
}

function claimPreviewDraftGeneration(sessionId: number): boolean {
  const now = Date.now()
  for (const [id, bucket] of previewDraftBuckets) if (bucket.startedAt + PREVIEW_DRAFT_WINDOW_MS <= now) previewDraftBuckets.delete(id)
  for (const [id, cached] of previewDraftReplay) if (cached.createdAt + PREVIEW_DRAFT_WINDOW_MS <= now) previewDraftReplay.delete(id)
  const existing = previewDraftBuckets.get(sessionId)
  const bucket = !existing || existing.startedAt + PREVIEW_DRAFT_WINDOW_MS <= now ? { startedAt: now, count: 0 } : existing
  if (bucket.count >= PREVIEW_DRAFT_MAX_GENERATIONS) return false
  bucket.count += 1
  previewDraftBuckets.set(sessionId, bucket)
  return true
}

function claimSiteAnalysisRun(sessionId: number): boolean {
  const now = Date.now()
  for (const [id, bucket] of siteAnalysisBuckets) if (bucket.startedAt + SITE_ANALYSIS_WINDOW_MS <= now) siteAnalysisBuckets.delete(id)
  const existing = siteAnalysisBuckets.get(sessionId)
  const bucket = !existing || existing.startedAt + SITE_ANALYSIS_WINDOW_MS <= now ? { startedAt: now, count: 0 } : existing
  if (bucket.count >= SITE_ANALYSIS_MAX_RUNS) return false
  bucket.count += 1
  siteAnalysisBuckets.set(sessionId, bucket)
  return true
}

function containsClientAmount(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsClientAmount)
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => /(amount|price|total)/iu.test(key) || containsClientAmount(nested))
}

function oversizedFunnelBody(): never {
  throw createError({ statusCode: 413, statusMessage: '申請內容超過大小限制，請縮短後再試。' })
}

async function readBoundedFunnelBody(event: H3Event): Promise<void> {
  const announced = String(getHeader(event, 'content-length') || '').trim()
  if (/^\d+$/u.test(announced)) {
    const length = Number(announced)
    if (!Number.isSafeInteger(length) || length > MANAGED_SITE_FUNNEL_MAX_BODY_BYTES) oversizedFunnelBody()
  }
  const cached = event._requestBody
  if (typeof cached === 'string' || Buffer.isBuffer(cached) || cached instanceof Uint8Array || cached instanceof ArrayBuffer) {
    const bytes = Buffer.isBuffer(cached) ? cached : cached instanceof ArrayBuffer ? Buffer.from(new Uint8Array(cached)) : Buffer.from(cached)
    if (bytes.byteLength > MANAGED_SITE_FUNNEL_MAX_BODY_BYTES) oversizedFunnelBody()
    return
  }
  const webBody = event.web?.request?.body
  if (webBody) {
    const reader = webBody.getReader()
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.byteLength
      if (total > MANAGED_SITE_FUNNEL_MAX_BODY_BYTES) { await reader.cancel(); oversizedFunnelBody() }
      chunks.push(chunk)
    }
    event._requestBody = Buffer.concat(chunks, total)
    return
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of event.node.req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.byteLength
    if (total > MANAGED_SITE_FUNNEL_MAX_BODY_BYTES) { event.node.req.pause(); oversizedFunnelBody() }
    chunks.push(chunk)
  }
  event._requestBody = Buffer.concat(chunks, total)
}

async function strictFunnelBody(event: H3Event, allowedFields: readonly string[]): Promise<Record<string, unknown>> {
  await readBoundedFunnelBody(event)
  const candidate = await readBody(event)
  if (containsClientAmount(candidate)) throw createError({ statusCode: 400, statusMessage: 'Client-supplied prices or amounts are not allowed.' })
  return strictManagedSiteBody(event, allowedFields)
}

async function sessionProjection(session: Awaited<ReturnType<typeof loadFunnelSession>>) {
  return {
    status: session.status,
    currentStep: session.currentStep,
    answers: session.answers,
    consentSnapshot: session.consentSnapshot,
    previewUrl: session.builtPreviewUrl,
    checkoutUrl: session.checkoutUrl,
    consentVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION,
    expiresAt: session.expiresAt,
    totalSteps: MANAGED_SITE_FUNNEL_TOTAL_STEPS,
    contactInbox: await managedSiteContactInboxProjection(session.id),
  }
}

async function resolvePlatformOwnerUserId(): Promise<number> {
  const config = useRuntimeConfig()
  const ownerOpenId = String(config.ownerOpenId || process.env.OWNER_OPEN_ID || '').trim()
  if (!ownerOpenId) throw createError({ statusCode: 503, statusMessage: 'Platform owner authority is not configured.' })
  try { return await resolveControlledOwnerDatabaseUserId(ownerOpenId) } catch { throw createError({ statusCode: 503, statusMessage: 'Platform owner authority is not configured.' }) }
}

export default defineEventHandler(async event => {
  setResponseHeaders(event, privateHeaders)
  const pathname = getRequestURL(event).pathname
  if (!pathname.startsWith(funnelPrefix)) throw createError({ statusCode: 404, statusMessage: 'Managed-site funnel route was not found.' })
  const segments = pathname.slice(funnelPrefix.length).split('/').filter(Boolean)
  const subPath = `/${segments.join('/')}`
  const method = getMethod(event)
  const repository = getFunnelSessionRepository()

  if (segments.length === 1 && subPath === '/sessions') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event)
    await strictFunnelBody(event, [])
    const created = await createFunnelSession(repository)
    return { sessionId: created.sessionId, sessionToken: created.sessionToken, expiresAt: created.expiresAt, totalSteps: MANAGED_SITE_FUNNEL_TOTAL_STEPS }
  }

  if (segments.length < 2 || segments[0] !== 'sessions') throw createError({ statusCode: 404, statusMessage: 'Managed-site funnel route was not found.' })
  const sessionId = parsePathId(segments[1], 'Managed-site funnel session id')
  const sessionToken = String(getHeader(event, 'x-managed-site-funnel-token') || '')
  const authenticatedSession = await loadFunnelSession(sessionId, sessionToken, repository)

  if (segments.length === 2) {
    if (method === 'GET') return await sessionProjection(authenticatedSession)
    if (method !== 'PATCH') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    const body = await strictFunnelBody(event, ['step', 'answers', 'consent'])
    const session = await saveFunnelStep(sessionId, sessionToken, { step: body.step as number, answers: body.answers as Partial<FunnelAnswers>, ...(body.consent !== undefined ? { consent: body.consent as any } : {}) }, repository)
    return await sessionProjection(session)
  }

  if (segments.length === 3 && segments[2] === 'consent') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    const body = await strictFunnelBody(event, ['policyVersion', 'scrolledToBottom'])
    const session = await recordFunnelConsent(sessionId, sessionToken, { policyVersion: String(body.policyVersion || ''), scrolledToBottom: body.scrolledToBottom as true }, repository)
    return await sessionProjection(session)
  }

  if (segments.length === 3 && segments[2] === 'site-analysis') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    const body = await strictFunnelBody(event, ['url'])
    if (!claimSiteAnalysisRun(sessionId)) throw createError({ statusCode: 429, statusMessage: '網站檢查次數已達上限，請稍後再試。' })
    let analysis: Awaited<ReturnType<typeof analysePublicHomepage>>
    try {
      analysis = await analysePublicHomepage(String(body.url || ''))
    } catch (error) {
      const code = error instanceof Error ? error.message : 'analysis_failed'
      const normalizedCode = code.toLowerCase()
      if (
        code === 'private_network_target'
        || normalizedCode.includes('private')
        || normalizedCode.includes('local network')
        || normalizedCode.includes('link-local')
        || normalizedCode.includes('public website')
        || normalizedCode.includes('public http')
      ) throw createError({ statusCode: 422, statusMessage: '只能檢查公開的網站網址。' })
      if (code === 'unsupported_content_type') throw createError({ statusCode: 422, statusMessage: '這個網址不是一般網頁，無法檢查。' })
      if (code === 'response_too_large') throw createError({ statusCode: 413, statusMessage: '這個網頁太大，無法檢查。' })
      if (code === 'redirect_limit') throw createError({ statusCode: 422, statusMessage: '這個網址轉址太多次，無法檢查。' })
      throw createError({ statusCode: 502, statusMessage: '目前無法連到這個網站，請稍後再試。' })
    }
    const session = await recordFunnelSiteAnalysis(sessionId, sessionToken, {
      url: String(body.url || ''),
      snapshot: { analysedAt: analysis.analysedAt, analysisVersion: analysis.analysisVersion, snapshotFingerprint: analysis.snapshotFingerprint, scores: analysis.scores },
    }, repository)
    return { analysis, session: await sessionProjection(session) }
  }

  if (segments.length === 3 && segments[2] === 'inbox-binding') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    const body = await strictFunnelBody(event, ['email'])
    return startManagedSiteContactInboxBinding({ session: authenticatedSession, email: body.email })
  }

  if (segments.length === 3 && segments[2] === 'inbox-binding-confirm') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    const body = await strictFunnelBody(event, ['code'])
    return confirmManagedSiteContactInboxBinding({ session: authenticatedSession, code: body.code })
  }

  if (segments.length === 3 && segments[2] === 'quote') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    await strictFunnelBody(event, [])
    return projectFunnelQuote(authenticatedSession.answers as FunnelAnswers, authenticatedSession.id)
  }

  if (segments.length === 3 && segments[2] === 'preview-draft') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    await strictFunnelBody(event, [])
    if (!claimPreviewDraftGeneration(sessionId)) {
      const replay = previewDraftReplay.get(sessionId)
      if (replay) return replay.draft
      // The full document is intentionally never persisted. A cold process therefore regenerates one
      // deterministic-safe response rather than returning a false success or a paid-provider error.
      const draft = await generateFunnelPreviewDraft(authenticatedSession, { providerConfiguration: { configured: false, reason: 'endpoint-missing' } })
      previewDraftReplay.set(sessionId, { createdAt: Date.now(), draft })
      return draft
    }
    const draft = await generateFunnelPreviewDraft(authenticatedSession)
    await saveFunnelStep(sessionId, sessionToken, { step: 6, answers: { previewDraft: { generatedAt: draft.generatedAt, source: draft.source, headline: draft.headline, sections: draft.sections } } }, repository)
    previewDraftReplay.set(sessionId, { createdAt: Date.now(), draft })
    return draft
  }

  if (segments.length === 3 && segments[2] === 'build') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    await strictFunnelBody(event, [])
    return runFunnelBuild(sessionId, sessionToken)
  }

  if (segments.length === 3 && segments[2] === 'checkout') {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    assertSameOriginManagedSiteMutation(event); checkRateLimit(event, sessionId)
    await strictFunnelBody(event, [])
    return runFunnelCheckout(sessionId, sessionToken)
  }

  if (segments.length === 3 && segments[2] === 'status') {
    if (method !== 'GET') throw createError({ statusCode: 405, statusMessage: 'Managed-site funnel route method is not allowed.' })
    const session = authenticatedSession
    if (!session.draftOrderId && !session.releaseId) return { status: session.status, order: null, release: null, fulfilments: [], checkoutUrl: session.checkoutUrl }
    const ownerUserId = await resolvePlatformOwnerUserId()
    const ordering = getPreviewRepository()
    const [order, release, fulfilments] = await Promise.all([
      session.draftOrderId ? ordering.findDraftOrderById(session.draftOrderId) : null,
      session.releaseId ? getManagedSiteLiveConnectorRepository().findRelease(ownerUserId, session.releaseId) : null,
      session.draftOrderId ? ordering.listModuleFulfilmentsByDraftOrder(ownerUserId, session.draftOrderId) : [],
    ])
    return {
      status: session.status,
      order: order && order.ownerUserId === ownerUserId ? { status: order.status } : null,
      release: release ? { status: release.status, previewUrl: release.previewUrl } : null,
      fulfilments: order && order.ownerUserId === ownerUserId ? fulfilments.map(row => ({ draftOrderId: row.draftOrderId, moduleKey: row.moduleKey, mode: row.mode, status: row.status, billedMinor: row.billedMinor, customerVisibleStatus: row.customerVisibleStatus, ownerActionRequired: row.ownerActionRequired })) : [],
      checkoutUrl: session.checkoutUrl,
    }
  }

  throw createError({ statusCode: 404, statusMessage: 'Managed-site funnel route was not found.' })
})
