import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { managedSiteEmailTransportFromEnv, type ManagedSiteEmailTransport } from '../contact-inbox/email-transport'
import { assertManagedSiteProductionPayment } from '../live-connectors/production-payment-authority'
import { getManagedSiteLiveConnectorRepository } from '../live-connectors/repository'
import type { ManagedSiteLiveConnectorRepository } from '../live-connectors/types'
import { normalizeRecipientEmail } from '../normalization'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { resolveManagedSiteReaccessOrigin } from '../reaccess-service'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { ensurePaidFunnelCustomerMembership } from './paid-customer-membership'
import { getManagedSiteEmailOutboxRuntime } from '../email-outbox/runtime'

export const CUSTOMER_WORKSPACE_NOTIFICATION_RECEIPT_TYPE = 'customer_workspace_notification_sent' as const
const WORKSPACE_READY_OUTBOX_TTL_MS = 30 * 24 * 60 * 60_000

type NotificationInput = {
  releaseId: number
}

type NotificationDependencies = {
  liveRepository?: ManagedSiteLiveConnectorRepository
  orderingRepository?: PreviewRepository
  managedRepository?: ManagedSiteRepository
  emailTransport?: ManagedSiteEmailTransport
  portalOrigin?: string
  nodeEnv?: string
  clock?: () => Date
  assertProductionPayment?: typeof assertManagedSiteProductionPayment
  ensurePaidMembership?: typeof ensurePaidFunnelCustomerMembership
  durableOutbox?: boolean
}

type NotificationResult =
  | { sent: true; replayed: boolean; receiptFingerprint: string }
  | { sent: false; replayed: false; retryable: true; reason: 'portal_origin_not_configured' | 'email_transport_not_configured' | 'email_delivery_failed' }

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function resolveTransport(dependencies: NotificationDependencies): ManagedSiteEmailTransport | null {
  if (dependencies.emailTransport) return dependencies.emailTransport.configured ? dependencies.emailTransport : null
  try {
    const transport = managedSiteEmailTransportFromEnv()
    return transport.configured ? transport : null
  } catch {
    return null
  }
}

function composeReadyEmail(input: { customerName: string; siteLabel: string; publicUrl: string; reaccessUrl: string }) {
  const greeting = input.customerName ? `${input.customerName} 您好，` : '您好，'
  return {
    subject: '您的網站已經上線',
    text: [
      greeting,
      '',
      `${input.siteLabel} 已完成建立並通過正式上線確認：`,
      input.publicUrl,
      '',
      '要修改文字、圖片或頁面時，請從這裡重新取得安全登入連結：',
      input.reaccessUrl,
      '',
      '為了保護您的帳號，這封信不附登入權杖。進入上方入口後，請輸入本信收件信箱，我們會另外寄出一次性的登入連結。',
      '',
      '正式交付後 30 天內，原功能範圍的排版、色彩、字體與圖片安排免費調整。登入網站工作區後，請從「免費美術調整」提交需求並查看進度。新增功能、資料搬遷、新串接及第三方費用另行確認。',
      '',
      '如果您沒有購買這個網站，請透過 DiscoveryStack 官方網站的聯絡入口通知我們。',
    ].join('\n'),
  }
}

/**
 * Sends the delivery notice only after the exact paid release is live and its
 * customer editor workspace exists. The durable receipt contains fingerprints,
 * never the recipient address, message body, provider message id, or a bearer.
 */
export async function notifyManagedSiteCustomerWorkspaceReady(ownerUserId: number, input: NotificationInput, dependencies: NotificationDependencies = {}): Promise<NotificationResult> {
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || !Number.isSafeInteger(input.releaseId) || input.releaseId < 1) conflict('Customer workspace notification authority is invalid.')
  const liveRepository = dependencies.liveRepository || getManagedSiteLiveConnectorRepository()
  const orderingRepository = dependencies.orderingRepository || getPreviewRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const clock = dependencies.clock || (() => new Date())
  const release = await liveRepository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.ownerUserId !== ownerUserId || release.releaseKind !== 'generated_site' || !['live_verified', 'geo_active'].includes(release.status) || !release.draftOrderId || !release.activeDeploymentReceiptFingerprint) conflict('Customer workspace notification requires an exact verified generated-site release.')

  const assertPayment = dependencies.assertProductionPayment || assertManagedSiteProductionPayment
  await assertPayment(ownerUserId, release, liveRepository, orderingRepository, managedRepository)
  const [order, project, receipts, deploymentReceipt] = await Promise.all([
    orderingRepository.findDraftOrderById(release.draftOrderId),
    managedRepository.findProject(ownerUserId, release.projectId),
    liveRepository.listReceiptsByDraftOrder(ownerUserId, release.draftOrderId),
    liveRepository.findReceiptByFingerprint(ownerUserId, release.activeDeploymentReceiptFingerprint),
  ])
  if (!order || order.ownerUserId !== ownerUserId || order.projectId !== release.projectId || order.previewId !== release.previewId || order.quoteId !== release.quoteId || order.status !== 'payment_verified' || !project || project.ownerUserId !== ownerUserId || project.status === 'suspended') conflict('Customer workspace notification order authority is stale or mismatched.')
  if (!deploymentReceipt || deploymentReceipt.releaseId !== release.id || deploymentReceipt.projectId !== release.projectId || deploymentReceipt.contentHash !== release.contentHash || deploymentReceipt.canonicalDomain !== release.canonicalDomain || deploymentReceipt.receiptType !== 'production_deployment_verified' || deploymentReceipt.receiptStatus !== 'verified') conflict('Customer workspace notification production authority is stale or mismatched.')
  const lead = await orderingRepository.findLeadById(order.leadId)
  if (!lead) conflict('Customer workspace notification recipient authority is unavailable.')
  const email = normalizeRecipientEmail(lead.email)
  const recipientFingerprint = stableFingerprint({ recipientEmail: email })

  const bound = receipts.find(receipt => receipt.releaseId === release.id && receipt.projectId === release.projectId && receipt.contentHash === release.contentHash && receipt.canonicalDomain === release.canonicalDomain && receipt.receiptType === 'release_payment_bound' && receipt.receiptStatus === 'verified')
  const paymentReceiptFingerprint = String((bound?.metadata as Record<string, unknown> | undefined)?.paymentReceiptFingerprint || (bound?.metadata as Record<string, unknown> | undefined)?.checkoutReceiptFingerprint || '')
  const payment = receipts.find(receipt => receipt.receiptFingerprint === paymentReceiptFingerprint && receipt.releaseId === release.id && receipt.projectId === release.projectId && receipt.contentHash === release.contentHash && receipt.canonicalDomain === release.canonicalDomain && receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified' && (receipt.metadata as Record<string, unknown>)?.effective === true)
  const workspace = receipts.find(receipt => receipt.releaseId === release.id && receipt.projectId === release.projectId && receipt.contentHash === release.contentHash && receipt.canonicalDomain === release.canonicalDomain && receipt.receiptType === 'customer_workspace_bootstrapped' && receipt.receiptStatus === 'verified' && (receipt.metadata as Record<string, unknown>)?.productionReceiptFingerprint === release.activeDeploymentReceiptFingerprint)
  if (!payment || !workspace || !/^[a-f0-9]{64}$/u.test(payment.receiptFingerprint) || !/^[a-f0-9]{64}$/u.test(workspace.receiptFingerprint)) conflict('Customer workspace notification payment or workspace authority is incomplete.')

  const ensureMembership = dependencies.ensurePaidMembership || ensurePaidFunnelCustomerMembership
  const grant = await ensureMembership({ ownerUserId, projectId: release.projectId, draftOrderId: order.id, releaseId: release.id, paymentReceiptFingerprint: payment.receiptFingerprint, email, allowExistingMembership: false }, managedRepository, clock)
  const requestFingerprint = stableFingerprint({
    scope: 'managed-site-customer-workspace-notification-v1',
    ownerUserId,
    projectId: release.projectId,
    draftOrderId: order.id,
    releaseId: release.id,
    contentHash: release.contentHash,
    canonicalDomain: release.canonicalDomain,
    paymentReceiptFingerprint: payment.receiptFingerprint,
    workspaceReceiptFingerprint: workspace.receiptFingerprint,
    recipientFingerprint,
    membershipId: grant.membership.id,
  })
  const receiptFingerprint = stableFingerprint({ requestFingerprint, delivered: true })
  const existing = receipts.find(receipt => receipt.releaseId === release.id && receipt.projectId === release.projectId && receipt.contentHash === release.contentHash && receipt.canonicalDomain === release.canonicalDomain && receipt.receiptType === CUSTOMER_WORKSPACE_NOTIFICATION_RECEIPT_TYPE && receipt.receiptStatus === 'verified')
  if (existing) {
    const metadata = existing.metadata as Record<string, unknown>
    if (existing.requestFingerprint !== requestFingerprint || existing.receiptFingerprint !== receiptFingerprint || metadata.paymentReceiptFingerprint !== payment.receiptFingerprint || metadata.workspaceReceiptFingerprint !== workspace.receiptFingerprint || metadata.recipientFingerprint !== recipientFingerprint || metadata.membershipId !== grant.membership.id) conflict('Customer workspace notification receipt is stale or mismatched.')
    return { sent: true, replayed: true, receiptFingerprint: existing.receiptFingerprint }
  }

  const portalOrigin = resolveManagedSiteReaccessOrigin({ portalOrigin: dependencies.portalOrigin, nodeEnv: dependencies.nodeEnv })
  if (!portalOrigin) return { sent: false, replayed: false, retryable: true, reason: 'portal_origin_not_configured' }
  const transport = resolveTransport(dependencies)
  if (!transport) return { sent: false, replayed: false, retryable: true, reason: 'email_transport_not_configured' }
  const durableOutbox = dependencies.durableOutbox ?? process.env.NODE_ENV !== 'test'

  const reaccessUrl = `${portalOrigin}/managed-site-access`
  const publicUrl = `https://${release.canonicalDomain}`
  const message = composeReadyEmail({ customerName: lead.name.normalize('NFC').trim().slice(0, 160), siteLabel: project.canonicalClientIdentity, publicUrl, reaccessUrl })
  if (durableOutbox) {
    const queuedAt = clock()
    const workspaceVerifiedAt = workspace.verifiedAt
    if (!Number.isFinite(workspaceVerifiedAt.getTime()) || workspaceVerifiedAt.getTime() > queuedAt.getTime()) return { sent: false, replayed: false, retryable: true, reason: 'email_delivery_failed' }
    const expiresAt = new Date(workspaceVerifiedAt.getTime() + WORKSPACE_READY_OUTBOX_TTL_MS)
    if (expiresAt.getTime() <= queuedAt.getTime()) return { sent: false, replayed: false, retryable: true, reason: 'email_delivery_failed' }
    const context = {
      purpose: 'workspace_ready' as const,
      ownerUserId,
      projectId: release.projectId,
      authority: {
        releaseId: release.id,
        draftOrderId: order.id,
        membershipId: grant.membership.id,
        paymentReceiptFingerprint: payment.receiptFingerprint,
        workspaceReceiptFingerprint: workspace.receiptFingerprint,
        productionReceiptFingerprint: release.activeDeploymentReceiptFingerprint,
        requestFingerprint,
      },
      // Queue replay must retain the same immutable envelope. Anchor its TTL to
      // the persisted workspace-ready receipt, never to the retry attempt time.
      expiresAt,
    }
    const idempotencyKey = `managed-site-workspace-ready:${requestFingerprint}`
    const queued = await getManagedSiteEmailOutboxRuntime().enqueueAndAttempt({ idempotencyKey, context, message: { to: email, subject: message.subject, text: message.text } })
    if (!queued.accepted) return { sent: false, replayed: false, retryable: true, reason: 'email_delivery_failed' }
    return { sent: true, replayed: false, receiptFingerprint }
  }
  let providerMessageId: string
  try {
    providerMessageId = (await transport.send({ to: email, subject: message.subject, text: message.text, idempotencyKey: `managed-site-workspace-ready:${requestFingerprint}` })).providerMessageId
  } catch {
    return { sent: false, replayed: false, retryable: true, reason: 'email_delivery_failed' }
  }

  const notificationReceipt = await liveRepository.insertReceipt({
    ownerUserId,
    projectId: release.projectId,
    draftOrderId: order.id,
    releaseId: release.id,
    attemptId: null,
    capability: 'deployment',
    providerKey: 'discoverystack-customer-workspace',
    providerEventId: `workspace-ready-${receiptFingerprint.slice(0, 32)}`,
    receiptType: CUSTOMER_WORKSPACE_NOTIFICATION_RECEIPT_TYPE,
    receiptStatus: 'verified',
    externalReference: `managed-site-project:${release.projectId}`,
    exactResponseIdentity: `workspace-ready:${receiptFingerprint.slice(0, 48)}`,
    requestFingerprint,
    contentHash: release.contentHash,
    canonicalDomain: release.canonicalDomain,
    metadata: {
      paymentReceiptFingerprint: payment.receiptFingerprint,
      workspaceReceiptFingerprint: workspace.receiptFingerprint,
      recipientFingerprint,
      membershipId: grant.membership.id,
      portalPath: '/managed-site-access',
      providerMessageFingerprint: stableFingerprint({ providerMessageId }),
      bearerIncluded: false,
    },
    receiptFingerprint,
    verifiedAt: clock(),
  } as any)
  if (notificationReceipt.receiptFingerprint !== receiptFingerprint) conflict('Customer workspace notification receipt collided with another delivery.')
  return { sent: true, replayed: false, receiptFingerprint }
}
