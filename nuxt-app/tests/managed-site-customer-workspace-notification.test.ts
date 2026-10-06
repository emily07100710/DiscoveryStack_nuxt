import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createRecordingManagedSiteEmailTransport, type ManagedSiteEmailTransport } from '../server/managed-sites/contact-inbox/email-transport'
import { notifyManagedSiteCustomerWorkspaceReady } from '../server/managed-sites/funnel/customer-workspace-notification'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const SECRET = 'workspace-ready-test-webhook'
const PORTAL_ORIGIN = 'https://portal.example.test'

async function fixture() {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'ready.acme.taipei' })
  const event = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: 'workspace-ready-payment', eventType: 'checkout_succeeded' })
  const rawBody = Buffer.from(JSON.stringify(event))
  await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader: createHmac('sha256', SECRET).update(rawBody).digest('hex'), credentialReference: 'vault:workspace-ready-webhook', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true, value: SECRET }), clock: () => managedSiteFixedNow })

  const release = line.live.state.releases[0]!
  const productionReceiptFingerprint = stableFingerprint({ scope: 'workspace-ready-production', releaseId: release.id })
  await line.live.repository.insertReceipt({
    ownerUserId: line.ownerUserId,
    projectId: release.projectId,
    draftOrderId: release.draftOrderId,
    releaseId: release.id,
    attemptId: null,
    capability: 'deployment',
    providerKey: 'mock-deployment',
    providerEventId: 'workspace-ready-production',
    receiptType: 'production_deployment_verified',
    receiptStatus: 'verified',
    externalReference: 'mock-production-1',
    exactResponseIdentity: 'workspace-ready-production:1',
    requestFingerprint: stableFingerprint({ scope: 'workspace-ready-production-request', releaseId: release.id }),
    contentHash: release.contentHash,
    canonicalDomain: release.canonicalDomain,
    metadata: {},
    receiptFingerprint: productionReceiptFingerprint,
    verifiedAt: managedSiteFixedNow,
  })
  release.status = 'live_verified'
  release.activeDeploymentReceiptFingerprint = productionReceiptFingerprint
  const workspaceReceiptFingerprint = stableFingerprint({ scope: 'workspace-ready-bootstrap', releaseId: release.id })
  await line.live.repository.insertReceipt({
    ownerUserId: line.ownerUserId,
    projectId: release.projectId,
    draftOrderId: release.draftOrderId,
    releaseId: release.id,
    attemptId: null,
    capability: 'deployment',
    providerKey: 'discoverystack-customer-workspace',
    providerEventId: 'workspace-ready-bootstrap',
    receiptType: 'customer_workspace_bootstrapped',
    receiptStatus: 'verified',
    externalReference: `managed-site-project:${release.projectId}`,
    exactResponseIdentity: 'workspace-ready-bootstrap:1',
    requestFingerprint: stableFingerprint({ scope: 'workspace-ready-bootstrap-request', releaseId: release.id }),
    contentHash: release.contentHash,
    canonicalDomain: release.canonicalDomain,
    metadata: { productionReceiptFingerprint },
    receiptFingerprint: workspaceReceiptFingerprint,
    verifiedAt: managedSiteFixedNow,
  })
  return { line, release }
}

describe('paid customer workspace-ready notification', () => {
  it('emails only the public site and re-access entrance, then replays from a privacy-safe receipt', async () => {
    const f = await fixture()
    const transport = createRecordingManagedSiteEmailTransport()
    const dependencies = { liveRepository: f.line.live.repository, orderingRepository: f.line.ordering.repository, managedRepository: f.line.managed.repository, emailTransport: transport, portalOrigin: PORTAL_ORIGIN, nodeEnv: 'production', clock: () => managedSiteFixedNow }
    await expect(notifyManagedSiteCustomerWorkspaceReady(f.line.ownerUserId, { releaseId: f.release.id }, dependencies)).resolves.toMatchObject({ sent: true, replayed: false, receiptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(transport.messages).toHaveLength(1)
    expect(transport.messages[0]).toMatchObject({
      to: 'not-authority@example.invalid',
      subject: '您的網站已經上線',
      idempotencyKey: expect.stringMatching(/^managed-site-workspace-ready:[a-f0-9]{64}$/u),
    })
    expect(transport.messages[0]!.text).toContain('https://ready.acme.taipei')
    expect(transport.messages[0]!.text).toContain(`${PORTAL_ORIGIN}/managed-site-access`)
    expect(transport.messages[0]!.text).toContain('請透過 DiscoveryStack 官方網站的聯絡入口通知我們')
    expect(transport.messages[0]!.text).toContain('正式交付後 30 天內')
    expect(transport.messages[0]!.text).toContain('免費美術調整')
    expect(transport.messages[0]!.text).not.toContain('回覆本信')
    expect(transport.messages[0]!.text).not.toContain('?token=')

    const receipt = f.line.live.state.receipts.find(row => row.receiptType === 'customer_workspace_notification_sent')!
    expect(receipt).toMatchObject({ receiptStatus: 'verified', externalReference: `managed-site-project:${f.release.projectId}`, metadata: expect.objectContaining({ portalPath: '/managed-site-access', bearerIncluded: false, providerMessageFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) }) })
    const durable = JSON.stringify(receipt)
    expect(durable).not.toContain('not-authority@example.invalid')
    expect(durable).not.toContain('recorded-1')
    expect(durable).not.toContain('您的網站已經上線')
    expect(durable).not.toContain('?token=')

    await expect(notifyManagedSiteCustomerWorkspaceReady(f.line.ownerUserId, { releaseId: f.release.id }, dependencies)).resolves.toMatchObject({ sent: true, replayed: true, receiptFingerprint: receipt.receiptFingerprint })
    expect(transport.messages).toHaveLength(1)
  })

  it('keeps a live website delivered and retryable when email transport fails', async () => {
    const f = await fixture()
    const failingTransport: ManagedSiteEmailTransport = { configured: true, async send() { throw new Error('temporary provider failure') } }
    const base = { liveRepository: f.line.live.repository, orderingRepository: f.line.ordering.repository, managedRepository: f.line.managed.repository, portalOrigin: PORTAL_ORIGIN, nodeEnv: 'production', clock: () => managedSiteFixedNow }
    await expect(notifyManagedSiteCustomerWorkspaceReady(f.line.ownerUserId, { releaseId: f.release.id }, { ...base, emailTransport: failingTransport })).resolves.toEqual({ sent: false, replayed: false, retryable: true, reason: 'email_delivery_failed' })
    expect(f.release.status).toBe('live_verified')
    expect(f.line.live.state.receipts.some(row => row.receiptType === 'customer_workspace_notification_sent')).toBe(false)

    const retryTransport = createRecordingManagedSiteEmailTransport()
    await expect(notifyManagedSiteCustomerWorkspaceReady(f.line.ownerUserId, { releaseId: f.release.id }, { ...base, emailTransport: retryTransport })).resolves.toMatchObject({ sent: true, replayed: false })
    expect(retryTransport.messages).toHaveLength(1)
  })

  it('does not send after an effective refund invalidates production payment authority', async () => {
    const f = await fixture()
    const payment = f.line.live.state.receipts.find(row => row.receiptType === 'checkout_succeeded')!
    f.line.live.state.receipts.push({ ...payment, id: 90_001, providerEventId: 'workspace-ready-refund', receiptType: 'payment_refunded', receiptFingerprint: stableFingerprint({ scope: 'workspace-ready-refund' }), metadata: { effective: true } })
    const transport = createRecordingManagedSiteEmailTransport()
    await expect(notifyManagedSiteCustomerWorkspaceReady(f.line.ownerUserId, { releaseId: f.release.id }, { liveRepository: f.line.live.repository, orderingRepository: f.line.ordering.repository, managedRepository: f.line.managed.repository, emailTransport: transport, portalOrigin: PORTAL_ORIGIN, nodeEnv: 'production', clock: () => managedSiteFixedNow })).rejects.toMatchObject({ statusCode: 409 })
    expect(transport.messages).toHaveLength(0)
  })
})
