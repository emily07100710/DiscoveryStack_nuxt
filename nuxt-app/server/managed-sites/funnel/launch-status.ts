import type { ManagedSiteReleaseProjection } from '../../database/schema'
import type { PreviewRepository } from '../ordering-types'
import type { ManagedSiteLiveConnectorRepository } from '../live-connectors/types'

export function managedSiteLaunchAttention(reason: string | null) {
  if (reason === 'DOMAIN_PROCUREMENT_NOT_CONFIGURED') return '網域註冊服務正在調整，付款已保留，請聯絡客服確認處理進度。'
  if (reason === 'DOMAIN_DELEGATION_REVIEW_REQUIRED') return '所選網域的可註冊狀態、價格或註冊授權需要確認，尚未替換網域或加收費用，請聯絡客服。'
  if (reason === 'DNS_TLS_FAILED') return '網域連線暫時無法完成，請聯絡客服檢查設定；尚未顯示為已上線。'
  if (reason === 'DNS_PROPAGATION_TIMEOUT') return '網域與 HTTPS 尚未完成生效，請聯絡客服檢查設定。'
  return null
}

export async function projectManagedSiteLaunchStatus(ownerUserId: number, release: ManagedSiteReleaseProjection, repository: ManagedSiteLiveConnectorRepository, ordering: PreviewRepository) {
  const order = release.draftOrderId ? await ordering.findDraftOrderById(release.draftOrderId) : null
  if (!order || order.ownerUserId !== ownerUserId || order.projectId !== release.projectId || order.quoteId !== release.quoteId || order.previewId !== release.previewId) return null
  const active = order.status === 'payment_verified' && release.activeDeploymentReceiptFingerprint && ['live_verified', 'geo_active'].includes(release.status) ? await repository.findReceiptByFingerprint(ownerUserId, release.activeDeploymentReceiptFingerprint) : null
  const deployedUrl = (active?.metadata as any)?.deploymentUrl
  const liveUrl = active?.releaseId === release.id && active.projectId === release.projectId && active.receiptType === 'production_deployment_verified' && active.receiptStatus === 'verified' && active.contentHash === release.contentHash && active.canonicalDomain === release.canonicalDomain && deployedUrl === `https://${release.canonicalDomain}/` ? deployedUrl : null
  const fulfilments = await ordering.listModuleFulfilmentsByDraftOrder(ownerUserId, order.id)
  return {
    status: release.status,
    order: { status: order.status },
    release: { status: release.status, previewUrl: release.previewUrl, liveUrl },
    fulfilments: fulfilments.map(row => ({ moduleKey: row.moduleKey, mode: row.mode, status: row.status, customerVisibleStatus: row.customerVisibleStatus, ownerActionRequired: row.ownerActionRequired })),
    attention: managedSiteLaunchAttention(release.blockedReasonCode),
    checkoutUrl: null,
  }
}
