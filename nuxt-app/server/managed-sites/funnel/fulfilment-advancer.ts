import { stableFingerprint } from '../../seo-geo-core/repository'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { activateManagedSiteGeoOperations, deployManagedSiteProduction, type ManagedSiteProductionTransaction } from '../live-connectors/deployment-orchestrator'
import { executeManagedSiteDnsTls } from '../live-connectors/domain-connectors'
import { assertManagedSiteProductionPayment } from '../live-connectors/production-payment-authority'
import { getManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import { managedSiteLiveDeploymentAdapter, managedSiteLiveDnsTlsAdapter } from '../live-connectors/runtime-adapters'
import type { ManagedSiteCredentialResolver, ManagedSiteDeploymentAdapter, ManagedSiteDnsTlsAdapter, ManagedSiteDomainAdapter, ManagedSiteLiveConnectorRepository } from '../live-connectors/types'
import { getFunnelSessionRepository, type FunnelSessionRepository } from './session-repository'
import { purchaseFunnelDomain } from './domain-purchase-authority'
import { bootstrapManagedSiteCustomerWorkspace } from './customer-workspace-bootstrap'
import { notifyManagedSiteCustomerWorkspaceReady } from './customer-workspace-notification'

export type FunnelFulfilmentDependencies = {
  funnelRepository?: FunnelSessionRepository
  repository?: ManagedSiteLiveConnectorRepository
  orderingRepository?: PreviewRepository
  managedRepository?: ManagedSiteRepository
  productionTransaction?: ManagedSiteProductionTransaction
  deploymentAdapter?: (ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) => Promise<ManagedSiteDeploymentAdapter>
  dnsTlsAdapter?: (ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) => Promise<ManagedSiteDnsTlsAdapter>
  domainAdapter?: (ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) => Promise<ManagedSiteDomainAdapter>
  credentialResolver?: ManagedSiteCredentialResolver
  executionMode?: 'live' | 'mocked'
  clock?: () => Date
  activateGeoOperations?: typeof activateManagedSiteGeoOperations
  bootstrapCustomerWorkspace?: typeof bootstrapManagedSiteCustomerWorkspace
  notifyCustomerWorkspace?: typeof notifyManagedSiteCustomerWorkspaceReady
}

export function funnelFulfilmentKey(sessionId: number, releaseId: number, step: 'dns_tls' | 'production'): string {
  return stableFingerprint({ scope: 'managed-site-funnel-fulfilment-v1', sessionId, releaseId, step })
}

function eligibleAttempt(attempt: Awaited<ReturnType<ManagedSiteLiveConnectorRepository['findAttemptByIdempotency']>>, now: Date): boolean {
  if (!attempt) return true
  if (attempt.attemptNumber >= attempt.maxAttempts || ['blocked', 'failed', 'succeeded'].includes(attempt.status)) return false
  if (attempt.status === 'processing') return Boolean(attempt.leaseExpiresAt && attempt.leaseExpiresAt.getTime() <= now.getTime())
  return !attempt.retryEligibleAt || attempt.retryEligibleAt.getTime() <= now.getTime()
}

/** Durable orders/releases are the queue. Each invocation reads one bounded keyset page. */
export async function advancePaidManagedSiteFunnel(options: { afterId?: number; limit?: number } = {}, dependencies: FunnelFulfilmentDependencies = {}) {
  const afterId = Number.isSafeInteger(options.afterId) && options.afterId! >= 0 ? options.afterId! : 0
  const limit = Math.min(Math.max(Number.isSafeInteger(options.limit) ? options.limit! : 20, 1), 50)
  const summary = { scanned: 0, advanced: 0, waiting: 0, failed: 0, nextAfterId: afterId }
  const clock = dependencies.clock || (() => new Date())
  const executionMode = dependencies.executionMode || 'live'
  try {
    const funnel = dependencies.funnelRepository || getFunnelSessionRepository()
    const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
    const orderingRepository = dependencies.orderingRepository || getPreviewRepository()
    const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
    const sessions = await funnel.listPaidBuildsForFulfilment(afterId, limit)
    summary.scanned = sessions.length
    summary.nextAfterId = sessions.length < limit ? 0 : sessions[sessions.length - 1]!.id
    for (const session of sessions) {
      try {
        const release = session.releaseId ? await repository.findRelease(session.ownerUserId, session.releaseId) : null
        if (!release || release.ownerUserId !== session.ownerUserId || release.projectId !== session.projectId || release.draftOrderId !== session.draftOrderId || release.previewId !== session.previewId || release.quoteId !== session.quoteId || release.releaseKind !== 'generated_site' || !['payment_verified', 'provisioning', 'retry_wait', 'deployment_pending', 'live_verified', 'geo_active'].includes(release.status)) { summary.waiting++; continue }
        await assertManagedSiteProductionPayment(session.ownerUserId, release, repository, orderingRepository, managedRepository)
        let liveRelease = release
        if (!['live_verified', 'geo_active'].includes(release.status)) {
          let claim = await repository.findDomainClaim(release.canonicalDomain)
          if (!claim || claim.status === 'pending') {
            const storedSession = await funnel.findSession(session.id)
            if ((storedSession?.answers as any)?.domain?.option === 'new' && (storedSession?.consentSnapshot as any)?.domainRegistration?.delegated === true) {
              await purchaseFunnelDomain(session.ownerUserId, release.id, session.id, { ...dependencies, funnelRepository: funnel, repository, orderingRepository, managedRepository })
              claim = await repository.findDomainClaim(release.canonicalDomain)
            }
          }
          if (claim?.status !== 'verified' || claim.ownerUserId !== session.ownerUserId || claim.projectId !== release.projectId || claim.releaseId !== release.id || !claim.authorityReceiptFingerprint) { summary.waiting++; continue }
          const receipts = await repository.listReceipts(session.ownerUserId, release.projectId)
          const dns = receipts.find(receipt => receipt.releaseId === release.id && receipt.contentHash === release.contentHash && receipt.canonicalDomain === release.canonicalDomain && receipt.receiptType === 'dns_tls_verified' && receipt.receiptStatus === 'verified')
          if (!dns) {
            const idempotencyKey = funnelFulfilmentKey(session.id, release.id, 'dns_tls')
            if (!eligibleAttempt(await repository.findAttemptByIdempotency(session.ownerUserId, idempotencyKey), clock())) { summary.waiting++; continue }
            const adapter = await (dependencies.dnsTlsAdapter || managedSiteLiveDnsTlsAdapter)(session.ownerUserId, repository)
            const result = await executeManagedSiteDnsTls(session.ownerUserId, { projectId: release.projectId, releaseId: release.id, executionMode, idempotencyKey }, adapter, { repository, managedRepository, credentialResolver: dependencies.credentialResolver, clock })
            if (!result.ready) { summary.waiting++; continue }
          }
          // Recheck payment after DNS observation, before production acquires transport authority.
          await assertManagedSiteProductionPayment(session.ownerUserId, release, repository, orderingRepository, managedRepository)
          const idempotencyKey = funnelFulfilmentKey(session.id, release.id, 'production')
          if (!eligibleAttempt(await repository.findAttemptByIdempotency(session.ownerUserId, idempotencyKey), clock())) { summary.waiting++; continue }
          const adapter = await (dependencies.deploymentAdapter || managedSiteLiveDeploymentAdapter)(session.ownerUserId, repository)
          liveRelease = (await deployManagedSiteProduction(session.ownerUserId, { releaseId: release.id, executionMode, idempotencyKey }, adapter, { repository, orderingRepository, managedRepository, productionTransaction: dependencies.productionTransaction, credentialResolver: dependencies.credentialResolver, clock })).release
        }

        const quote = session.quoteId ? await orderingRepository.findQuoteById(session.quoteId) : null
        if (!quote || quote.ownerUserId !== session.ownerUserId || quote.projectId !== session.projectId || quote.status !== 'locked' || ![3, 7, 15, 30].includes(quote.cadenceDays)) { summary.waiting++; continue }
        if (quote.planKey !== 'site_only' && liveRelease.status === 'live_verified') {
          const activate = dependencies.activateGeoOperations || activateManagedSiteGeoOperations
          liveRelease = (await activate(session.ownerUserId, { releaseId: liveRelease.id, timeZone: 'Asia/Taipei', cadenceDays: quote.cadenceDays as 3 | 7 | 15 | 30, monthlyBudgetUnits: Math.max(1, Math.ceil(30 / quote.cadenceDays)), idempotencyKey: `managed-site-funnel-geo:${session.id}:${liveRelease.id}` }, { repository, managedRepository, clock })).release
        }
        const bootstrap = dependencies.bootstrapCustomerWorkspace || bootstrapManagedSiteCustomerWorkspace
        await bootstrap(session.ownerUserId, { releaseId: liveRelease.id, timeZone: 'Asia/Taipei', cadenceDays: quote.cadenceDays as 3 | 7 | 15 | 30, monthlyBudgetUnits: Math.max(1, Math.ceil(30 / quote.cadenceDays)) }, { liveRepository: repository, managedRepository, orderingRepository, clock })
        const notify = dependencies.notifyCustomerWorkspace || notifyManagedSiteCustomerWorkspaceReady
        const notification = await notify(session.ownerUserId, { releaseId: liveRelease.id }, { liveRepository: repository, managedRepository, orderingRepository, clock })
        if (!notification.sent) { summary.waiting++; continue }
        summary.advanced++
      } catch (error) {
        const failure = error as { statusCode?: number; data?: { code?: string } }
        if (failure.data?.code === 'FUNNEL_DOMAIN_WAITING') { summary.waiting++; continue }
        if (failure.data?.code === 'FUNNEL_DOMAIN_AUTHORITY_BLOCKED' && session.releaseId) {
          const current = await repository.findRelease(session.ownerUserId, session.releaseId).catch(() => null)
          if (current && ['payment_verified', 'retry_wait'].includes(current.status)) await repository.transitionRelease(session.ownerUserId, current.id, current.status, current.projectionFingerprint, { status: failure.statusCode === 503 ? current.status : 'blocked', blockedReasonCode: failure.statusCode === 503 ? 'DOMAIN_PROCUREMENT_NOT_CONFIGURED' : 'DOMAIN_DELEGATION_REVIEW_REQUIRED', nextSafeAction: failure.statusCode === 503 ? 'wait_for_domain_procurement_configuration' : 'review_domain_registration_authority', projectionFingerprint: stableFingerprint({ previous: current.projectionFingerprint, reason: failure.data.code, unavailable: failure.statusCode === 503 }) }).catch(() => null)
        }
        summary.failed++
      }
    }
  } catch { summary.failed++ }
  return summary
}
