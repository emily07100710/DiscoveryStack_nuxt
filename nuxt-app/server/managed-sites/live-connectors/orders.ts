import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { getManagedSiteLiveConnectorRepository } from './repository'
import type { ManagedSiteLiveConnectorRepository } from './types'

export async function getManagedSiteOrders(ownerUserId: number, dependencies: { orderingRepository?: PreviewRepository; repository?: ManagedSiteLiveConnectorRepository } = {}) {
  const ordering = dependencies.orderingRepository || getPreviewRepository()
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const orders = await ordering.listDraftOrders(ownerUserId, { limit: 100 })
  const releaseCache = new Map<number, Awaited<ReturnType<ManagedSiteLiveConnectorRepository['listReleases']>>>()
  return {
    orders: await Promise.all(orders.map(async order => {
      const quote = await ordering.findQuoteById(order.quoteId)
      let releases = order.projectId ? releaseCache.get(order.projectId) : undefined
      if (order.projectId && !releases) {
        releases = await repository.listReleases(ownerUserId, order.projectId)
        releaseCache.set(order.projectId, releases)
      }
      const release = releases?.find(candidate => candidate.draftOrderId === order.id) || null
      const receipts = await repository.listReceiptsByDraftOrder(ownerUserId, order.id)
      return {
        id: order.id,
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        quote: quote?.ownerUserId === ownerUserId ? { plan: quote.planKey, currency: quote.currency, totalMinor: quote.totalMinor, cadence: quote.cadenceDays } : null,
        release: release ? { id: release.id, status: release.status } : null,
        payments: receipts.filter(receipt => receipt.capability === 'payment').map(receipt => {
          const metadata = receipt.metadata && typeof receipt.metadata === 'object' && !Array.isArray(receipt.metadata) ? receipt.metadata as Record<string, unknown> : {}
          return {
            receiptType: receipt.receiptType,
            receiptStatus: receipt.receiptStatus,
            externalReference: receipt.externalReference,
            verifiedAt: receipt.verifiedAt,
            ...(receipt.receiptType === 'checkout_session_created' && typeof metadata.checkoutUrl === 'string' ? { checkoutUrl: metadata.checkoutUrl } : {}),
          }
        }),
      }
    })),
  }
}
