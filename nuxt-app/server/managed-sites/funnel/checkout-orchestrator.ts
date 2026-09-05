import { createError } from 'h3'
import { resolveControlledOwnerDatabaseUserId } from '../../audit/repository'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { claimManagedSiteCheckout } from '../checkout-claim-service'
import { databaseExistingSiteDiagnosisResolver, type ExistingSiteDiagnosisResolver } from '../diagnosis-binding'
import { createManagedSiteDraftOrder, createManagedSiteLeadIntent, createManagedSitePreview, createManagedSiteQuote, MANAGED_SITE_QUOTE_TTL_MS } from '../ordering-service'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { convertClaimedManagedSitePrePurchase, getManagedSitePrePurchaseRepositories } from '../prepurchase-service'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { createGeneratedManagedSiteRelease, approveManagedSitePreview, buildManagedSitePreview } from '../live-connectors/deployment-orchestrator'
import { generateManagedSiteCandidate, type ManagedSiteArtifactVault } from '../live-connectors/generation-service'
import { getManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import { managedSiteLiveCheckoutAdapter, managedSiteLiveDeploymentAdapter, managedSiteLiveGenerationAdapter } from '../live-connectors/runtime-adapters'
import { createS3ManagedSiteArtifactVault } from '../live-connectors/s3-vault'
import { createManagedSiteCheckoutSession } from '../live-connectors/checkout-session'
import type { ManagedSiteCheckoutSessionAdapter, ManagedSiteDeploymentAdapter, ManagedSiteGenerationAdapter, ManagedSiteLiveConnectorRepository } from '../live-connectors/types'
import { tokenHash } from '../normalization'
import { getFunnelSessionRepository, type FunnelSessionRepository } from './session-repository'
import { loadFunnelSession, type FunnelAnswers, type FunnelConsentSnapshot } from './session-service'
import { funnelCatalogQuoteInput, funnelPreviewInput, projectFunnelQuote } from './quote-projection'

export type ManagedSiteFunnelOrchestratorDependencies = {
  funnelRepository?: FunnelSessionRepository
  orderingRepository?: PreviewRepository
  managedRepository?: ManagedSiteRepository
  connectorRepository?: ManagedSiteLiveConnectorRepository
  generationAdapter?: ManagedSiteGenerationAdapter
  artifactVault?: ManagedSiteArtifactVault
  deploymentAdapter?: ManagedSiteDeploymentAdapter
  checkoutAdapter?: ManagedSiteCheckoutSessionAdapter
  diagnosisResolver?: ExistingSiteDiagnosisResolver
  executionMode?: 'mocked' | 'live'
  clock?: () => Date
  resolveOwnerUserId?: () => Promise<number>
}

export const MANAGED_SITE_FUNNEL_BUILD_STALE_MS = 30 * 60_000
export const MANAGED_SITE_FUNNEL_CHECKOUT_SESSION_TTL_MS = 24 * 60 * 60_000

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function providerUnavailable(): never {
  throw createError({ statusCode: 503, statusMessage: '網站建置暫時未完成，請稍後再試。' })
}

async function platformOwnerUserId(dependencies: ManagedSiteFunnelOrchestratorDependencies): Promise<number> {
  if (dependencies.resolveOwnerUserId) {
    try {
      const ownerUserId = await dependencies.resolveOwnerUserId()
      if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) throw new Error('invalid platform owner')
      return ownerUserId
    } catch {
      throw createError({ statusCode: 503, statusMessage: 'Platform owner authority is not configured.' })
    }
  }
  const config = useRuntimeConfig()
  const ownerOpenId = String(config.ownerOpenId || process.env.OWNER_OPEN_ID || '').trim()
  if (!ownerOpenId) throw createError({ statusCode: 503, statusMessage: 'Platform owner authority is not configured.' })
  try {
    return await resolveControlledOwnerDatabaseUserId(ownerOpenId)
  } catch {
    throw createError({ statusCode: 503, statusMessage: 'Platform owner authority is not configured.' })
  }
}

function key(sessionId: number, step: string): string {
  return stableFingerprint({ scope: 'funnel-build', sessionId, step })
}

function answersFor(session: { answers: unknown }): FunnelAnswers {
  return session.answers && typeof session.answers === 'object' && !Array.isArray(session.answers) ? session.answers as FunnelAnswers : {}
}

function consentFor(session: { consentSnapshot: unknown }): FunnelConsentSnapshot | null {
  const value = session.consentSnapshot
  return value && typeof value === 'object' && !Array.isArray(value) && (value as any).scrolledToBottom === true ? value as FunnelConsentSnapshot : null
}

function assertBuildAnswers(answers: FunnelAnswers): void {
  if (!answers.company) conflict('Company details are required before building the website.')
  if (!answers.contact) conflict('Contact details are required before building the website.')
  if (!answers.style) conflict('Style choices are required before building the website.')
  if (!answers.siteType) conflict('Site type is required before building the website.')
  if (!answers.plan) conflict('Plan selection is required before building the website.')
  if (!answers.domain) conflict('Domain selection is required before building the website.')
}

function canonicalDomain(answers: FunnelAnswers, sessionId: number): string {
  if (answers.domain?.option === 'new') return `${answers.domain.name}.${answers.domain.tld}`
  return `funnel-${sessionId}.discoverystack.dev`
}

function providerError(error: unknown): never {
  // The customer only ever sees the generic 503, so without this line a failed build leaves no
  // trace at all — the cause has to stay in the server log to be diagnosable.
  const detail = error as { statusCode?: unknown; code?: unknown; statusMessage?: unknown; message?: unknown }
  const cause = (error as { cause?: { code?: unknown; errno?: unknown; sqlMessage?: unknown; message?: unknown } })?.cause
  console.warn('[managed-site-funnel] build failed', { statusCode: detail?.statusCode, code: detail?.code, message: String(detail?.statusMessage || detail?.message || error).slice(0, 300), cause: cause ? { code: cause.code, errno: cause.errno, sqlMessage: String(cause.sqlMessage || cause.message || '').slice(0, 300) } : undefined })
  providerUnavailable()
}

function previewAccessToken(sessionId: number, sessionToken: string): string {
  return stableFingerprint({ scope: 'funnel-preview-access', sessionId, sessionToken })
}

function isStaleBuild(session: { updatedAt: Date }, now: Date): boolean {
  return Number.isFinite(session.updatedAt.getTime()) && session.updatedAt.getTime() + MANAGED_SITE_FUNNEL_BUILD_STALE_MS <= now.getTime()
}

async function acquireBuild(session: Awaited<ReturnType<typeof loadFunnelSession>>, repository: FunnelSessionRepository, now: Date): Promise<void> {
  if (session.status === 'building') {
    if (!isStaleBuild(session, now)) conflict('網站正在建置中，請稍候再試。')
    const recovered = await repository.transitionSession(session.id, 'building', { status: 'active' })
    if (!recovered) conflict('網站正在建置中，請稍候再試。')
  } else if (session.status !== 'active') {
    conflict('此申請目前無法開始網站建置。')
  }
  const building = await repository.transitionSession(session.id, 'active', { status: 'building' })
  if (!building) conflict('網站正在建置中，請稍候再試。')
}

async function restoreRetryableBuild(sessionId: number, repository: FunnelSessionRepository): Promise<void> {
  await repository.transitionSession(sessionId, 'building', { status: 'active' }).catch(() => null)
}

export async function runFunnelBuild(sessionId: number, sessionToken: string, dependencies: ManagedSiteFunnelOrchestratorDependencies = {}) {
  const clock = dependencies.clock || (() => new Date())
  const funnelRepository = dependencies.funnelRepository || getFunnelSessionRepository()
  const ordering = dependencies.orderingRepository || getPreviewRepository()
  const managed = dependencies.managedRepository || getManagedSiteRepository()
  const live = dependencies.connectorRepository || getManagedSiteLiveConnectorRepository()
  const session = await loadFunnelSession(sessionId, sessionToken, funnelRepository, clock)
  const answers = answersFor(session)
  if (session.releaseId && session.builtPreviewUrl) {
    return { previewUrl: session.builtPreviewUrl, releaseId: session.releaseId, quote: projectFunnelQuote(answers, session.id) }
  }
  assertBuildAnswers(answers)
  if (!consentFor(session)) conflict('Consent is required before building the website.')
  const ownerUserId = await platformOwnerUserId(dependencies)
  const executionMode = dependencies.executionMode || 'live'
  let generationAdapter: ManagedSiteGenerationAdapter | undefined
  let artifactVault: ManagedSiteArtifactVault | undefined
  let deploymentAdapter: ManagedSiteDeploymentAdapter | undefined
  try {
    generationAdapter = dependencies.generationAdapter || (executionMode === 'live' ? await managedSiteLiveGenerationAdapter(ownerUserId, live) : undefined)
    artifactVault = dependencies.artifactVault || (executionMode === 'live' ? createS3ManagedSiteArtifactVault() : undefined)
    deploymentAdapter = dependencies.deploymentAdapter || (executionMode === 'live' ? await managedSiteLiveDeploymentAdapter(ownerUserId, live) : undefined)
    if (!generationAdapter || !artifactVault || !deploymentAdapter) providerUnavailable()
  } catch (error) {
    providerError(error)
  }
  await acquireBuild(session, funnelRepository, clock())
  const quoteInput = funnelCatalogQuoteInput(answers, session.id)
  const previewInput = funnelPreviewInput(answers, session.id)
  const consent = consentFor(session)!
  const domain = canonicalDomain(answers, session.id)
  try {
    if (session.releaseId) {
      const release = await live.findRelease(ownerUserId, session.releaseId)
      if (!release || release.projectId !== session.projectId || release.previewId !== session.previewId || release.quoteId !== session.quoteId || release.draftOrderId !== session.draftOrderId) conflict('先前的網站建置資料不完整，請聯絡客服協助。')
      const built = await buildManagedSitePreview(ownerUserId, { releaseId: release.id, executionMode, idempotencyKey: key(session.id, 'preview-build') }, deploymentAdapter!, { repository: live, clock })
      const previewUrl = built.release.previewUrl
      if (!previewUrl) conflict('網站預覽尚未完成，請稍後再試。')
      const updated = await funnelRepository.transitionSession(session.id, 'building', { status: 'checkout_pending', builtPreviewUrl: previewUrl })
      if (!updated) conflict('網站建置結果暫時無法記錄，請稍後再試。')
      return { previewUrl, releaseId: release.id, quote: projectFunnelQuote(answers, session.id) }
    }
    // Keep the preview fingerprint stable across retries: style-reference capture time is part of SiteSpec identity.
    const preview = await createManagedSitePreview(null, previewInput, ordering, () => session.createdAt, dependencies.diagnosisResolver || databaseExistingSiteDiagnosisResolver)
    const accessToken = previewAccessToken(session.id, sessionToken)
    const now = clock()
    const usableUntil = new Date(now.getTime() + MANAGED_SITE_QUOTE_TTL_MS)
    const refreshedPreview = await ordering.updatePreview(preview.preview.id, { accessTokenHash: tokenHash(accessToken), ...(preview.preview.expiresAt.getTime() <= now.getTime() ? { expiresAt: usableUntil } : {}), updatedAt: now } as any)
    if (!refreshedPreview) conflict('網站預覽授權暫時無法記錄，請稍後再試。')
    await funnelRepository.updateSession(session.id, { previewId: preview.preview.id, previewAccessTokenHash: tokenHash(accessToken) })
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: accessToken, planKey: quoteInput.planKey, cadenceDays: quoteInput.cadenceDays, domainOption: quoteInput.domainOption, designTier: quoteInput.designTier, domainTld: quoteInput.domainTld, moduleKeys: quoteInput.moduleKeys, idempotencyKey: key(session.id, 'quote') }, ordering, clock)
    const storedQuote = await ordering.findQuoteById(quote.quote.quoteId)
    if (!storedQuote) conflict('網站報價暫時無法讀取，請稍後再試。')
    if (storedQuote.expiresAt.getTime() <= now.getTime()) await ordering.updateQuote(storedQuote.id, { expiresAt: usableUntil, updatedAt: now } as any)
    await funnelRepository.updateSession(session.id, { quoteId: quote.quote.quoteId })
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: accessToken, quoteId: quote.quote.quoteId, name: answers.contact!.contactName, email: answers.contact!.email, company: answers.company!.brandName, website: answers.existingSite?.hasSite ? answers.existingSite.url : `https://${domain}`, message: answers.company!.mainOffer, privacyConsent: consent.scrolledToBottom, recontactConsent: false, idempotencyKey: key(session.id, 'lead') }, ordering, clock)
    await funnelRepository.updateSession(session.id, { leadIntentId: lead.leadIntent.id })
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: accessToken, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: key(session.id, 'draft-order') }, ordering, clock)
    await funnelRepository.updateSession(session.id, { draftOrderId: order.order.id })
    await claimManagedSiteCheckout(ownerUserId, { previewId: preview.preview.id, previewAccessToken: accessToken, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id }, ordering, clock)
    const prePurchaseRepositories = dependencies.orderingRepository || dependencies.managedRepository || dependencies.connectorRepository
      ? { ordering, managed, live }
      : getManagedSitePrePurchaseRepositories()
    const prePurchase = await convertClaimedManagedSitePrePurchase(ownerUserId, { previewId: preview.preview.id, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id, idempotencyKey: key(session.id, 'prepurchase') }, prePurchaseRepositories, clock)
    await funnelRepository.updateSession(session.id, { projectId: prePurchase.project.id })
    const generation = await generateManagedSiteCandidate(ownerUserId, { projectId: prePurchase.project.id, sourceVersionId: prePurchase.version.id, templateIntent: 'astro', executionMode, idempotencyKey: key(session.id, 'generation') }, { adapter: generationAdapter, vault: artifactVault, repository: live, managedRepository: managed, clock })
    if (!generation.candidate) conflict('Website generation did not produce a governed candidate.')
    const release = await createGeneratedManagedSiteRelease(ownerUserId, { projectId: prePurchase.project.id, generationCandidateId: generation.candidate.id, canonicalDomain: domain, targetKey: 'production-primary', idempotencyKey: key(session.id, 'release') }, { repository: live, managedRepository: managed })
    await funnelRepository.updateSession(session.id, { releaseId: release.release.id })
    const built = await buildManagedSitePreview(ownerUserId, { releaseId: release.release.id, executionMode, idempotencyKey: key(session.id, 'preview-build') }, deploymentAdapter!, { repository: live, clock })
    const previewUrl = built.release.previewUrl
    if (!previewUrl) conflict('Website preview build completed without a verified preview URL.')
    const updated = await funnelRepository.transitionSession(session.id, 'building', { status: 'checkout_pending', previewId: preview.preview.id, previewAccessTokenHash: tokenHash(accessToken), quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id, projectId: prePurchase.project.id, releaseId: release.release.id, builtPreviewUrl: previewUrl })
    if (!updated) conflict('The completed funnel build could not be recorded.')
    return { previewUrl, releaseId: release.release.id, quote: projectFunnelQuote(answers, session.id) }
  } catch (error) {
    await restoreRetryableBuild(session.id, funnelRepository)
    providerError(error)
  }
}

export async function runFunnelCheckout(sessionId: number, sessionToken: string, dependencies: ManagedSiteFunnelOrchestratorDependencies = {}) {
  const clock = dependencies.clock || (() => new Date())
  const funnelRepository = dependencies.funnelRepository || getFunnelSessionRepository()
  const ordering = dependencies.orderingRepository || getPreviewRepository()
  const live = dependencies.connectorRepository || getManagedSiteLiveConnectorRepository()
  const session = await loadFunnelSession(sessionId, sessionToken, funnelRepository, clock)
  if (!consentFor(session)) conflict('Consent is required before checkout can start.')
  if (session.status !== 'checkout_pending' || !session.releaseId || !session.builtPreviewUrl || !session.draftOrderId || !session.previewId || !session.previewAccessTokenHash) conflict('A verified built preview is required before checkout can start.')
  const order = await ordering.findDraftOrderById(session.draftOrderId)
  if (!order) conflict('付款資料暫時無法讀取，請稍後再試。')
  if (order.status === 'payment_verified') conflict('這筆訂單已完成付款，無需再次結帳。')
  if (order.status !== 'payment_pending') conflict('這筆訂單目前無法再次結帳，請聯絡客服協助。')
  const preview = await ordering.findPreviewById(session.previewId)
  if (!preview || preview.accessTokenHash !== session.previewAccessTokenHash) conflict('The funnel preview authority no longer matches the built release.')
  const ownerUserId = await platformOwnerUserId(dependencies)
  if (order.ownerUserId !== ownerUserId) conflict('付款資料暫時無法讀取，請稍後再試。')
  const receipts = await live.listReceiptsByDraftOrder(ownerUserId, order.id)
  if (receipts.some(receipt => receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified')) conflict('這筆訂單已完成付款，無需再次結帳。')
  const checkoutReceipts = receipts
    .filter(receipt => receipt.releaseId === session.releaseId && receipt.receiptType === 'checkout_session_created' && receipt.receiptStatus === 'verified' && typeof (receipt.metadata as any)?.checkoutUrl === 'string')
    .sort((left, right) => right.verifiedAt.getTime() - left.verifiedAt.getTime() || right.id - left.id)
  const latestCheckout = checkoutReceipts[0]
  const latestUrl = latestCheckout ? String((latestCheckout.metadata as any).checkoutUrl) : null
  const staleStripeCheckout = latestCheckout?.providerKey === 'stripe' && latestCheckout.verifiedAt.getTime() + MANAGED_SITE_FUNNEL_CHECKOUT_SESSION_TTL_MS <= clock().getTime()
  if (latestCheckout && latestUrl && !staleStripeCheckout) {
    if (session.checkoutUrl !== latestUrl) await funnelRepository.updateSession(session.id, { checkoutUrl: latestUrl })
    return { checkoutUrl: latestUrl }
  }
  const executionMode = dependencies.executionMode || 'live'
  const checkoutAdapter = dependencies.checkoutAdapter || (executionMode === 'live' ? await managedSiteLiveCheckoutAdapter(ownerUserId, live) : undefined)
  if (!checkoutAdapter) throw createError({ statusCode: 503, statusMessage: 'Managed-site checkout provider is not configured.' })
  let release = await live.findRelease(ownerUserId, session.releaseId)
  if (!release) conflict('付款資料暫時無法讀取，請稍後再試。')
  let checkoutKey = key(session.id, 'checkout')
  if (latestCheckout) {
    if (!staleStripeCheckout) conflict('付款頁面目前無法確認，請稍後再試。')
    checkoutKey = key(session.id, `checkout-refresh-${latestCheckout.id}`)
    if (release.status === 'checkout_pending') {
      const refreshRelease = release
      const observedAt = clock()
      const refreshApprovalFingerprint = stableFingerprint({ authority: 'funnel_checkout_refresh', previousApprovalFingerprint: refreshRelease.approvalFingerprint, expiredCheckoutReceiptFingerprint: latestCheckout.receiptFingerprint, checkoutKey })
      const refreshReceiptFingerprint = stableFingerprint({ ownerUserId, releaseId: refreshRelease.id, refreshApprovalFingerprint })
      const reopened = await live.transaction(async transaction => {
        await transaction.insertReceipt({ ownerUserId, projectId: refreshRelease.projectId, draftOrderId: order.id, releaseId: refreshRelease.id, attemptId: null, capability: 'payment', providerKey: 'discoverystack-owner-authority', providerEventId: `checkout-refresh-${refreshReceiptFingerprint.slice(0, 48)}`, receiptType: 'checkout_refresh_authorized', receiptStatus: 'verified', externalReference: latestCheckout.externalReference, exactResponseIdentity: `checkout-refresh:${refreshReceiptFingerprint.slice(0, 48)}`, requestFingerprint: refreshApprovalFingerprint, contentHash: refreshRelease.contentHash, canonicalDomain: refreshRelease.canonicalDomain, metadata: { expiredCheckoutReceiptFingerprint: latestCheckout.receiptFingerprint, previousApprovalFingerprint: refreshRelease.approvalFingerprint, commercialSnapshotUnchanged: true }, receiptFingerprint: refreshReceiptFingerprint, verifiedAt: observedAt } as any)
        return transaction.transitionRelease(ownerUserId, refreshRelease.id, 'checkout_pending', refreshRelease.projectionFingerprint, { status: 'approved', approvalFingerprint: refreshApprovalFingerprint, blockedReasonCode: null, nextSafeAction: 'create_checkout_session', projectionFingerprint: stableFingerprint({ previous: refreshRelease.projectionFingerprint, refreshReceiptFingerprint }) })
      })
      if (!reopened) {
        const currentOrder = await ordering.findDraftOrderById(order.id)
        if (currentOrder?.status === 'payment_verified') conflict('這筆訂單已完成付款，無需再次結帳。')
        conflict('付款狀態正在更新，請稍後再試。')
      }
      release = reopened
    }
    if (release.status !== 'approved') conflict('這筆訂單目前無法建立新的付款頁面，請聯絡客服協助。')
    const quote = await ordering.findQuoteById(order.quoteId)
    if (!quote || quote.ownerUserId !== ownerUserId || quote.id !== release.quoteId) conflict('付款報價資料不完整，請聯絡客服協助。')
    if (quote.expiresAt.getTime() <= clock().getTime()) {
      const renewed = await ordering.updateQuote(quote.id, { expiresAt: new Date(clock().getTime() + MANAGED_SITE_QUOTE_TTL_MS), updatedAt: clock() } as any)
      if (!renewed) conflict('付款報價暫時無法更新，請稍後再試。')
    }
  } else if (release.status === 'preview_ready') {
    // approveManagedSitePreview has no metadata input. The governed receipt remains unchanged;
    // the self-serve reviewer context stays bound to the tokenized funnel session row.
    release = (await approveManagedSitePreview(ownerUserId, { releaseId: session.releaseId, idempotencyKey: key(session.id, 'approval') }, live, clock)).release
  } else if (release.status !== 'approved') {
    conflict('付款資料不完整，請稍後再試。')
  }
  const checkout = await createManagedSiteCheckoutSession(ownerUserId, { releaseId: release.id, draftOrderId: session.draftOrderId, executionMode, idempotencyKey: checkoutKey }, checkoutAdapter, { connectorRepository: live, orderingRepository: ordering, clock })
  const checkoutUrl = checkout.checkout.url
  const updated = await funnelRepository.updateSession(session.id, { checkoutUrl })
  if (!updated) conflict('The checkout session URL could not be recorded.')
  return { checkoutUrl }
}
