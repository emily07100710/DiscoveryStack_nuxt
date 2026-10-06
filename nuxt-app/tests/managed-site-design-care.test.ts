import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  changeManagedSiteDesignCareState,
  getManagedSiteDesignCare,
  requestManagedSiteDesignCare,
} from '../server/managed-sites/design-care'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'

const OWNER_ID = 1
const DELIVERED_AT = new Date('2030-01-01T00:00:00.000Z')

async function fixture() {
  const managed = createManagedSiteMemoryRepository()
  const live = createLiveConnectorMemoryRepository()
  const project = await managed.repository.insertProject({
    ownerUserId: OWNER_ID,
    canonicalClientIdentity: '設計保固測試品牌',
    canonicalWebsiteIdentity: 'care.example.test',
    contentOperationClientId: null,
    status: 'active',
    siteType: 'brand_blog',
    activeVersionId: null,
    catalogVersion: 'managed-site-catalog-v1',
    subscriptionReference: null,
    contactFormTokenVersion: 1,
    contactFormTokenHash: null,
    projectFingerprint: stableFingerprint({ project: 'care' }),
    creationIdempotencyKey: 'create-care-project',
    createdAt: new Date('2029-12-01T00:00:00.000Z'),
    updatedAt: new Date('2029-12-01T00:00:00.000Z'),
  } as any)
  const editor = await managed.repository.insertMembership({
    ownerUserId: OWNER_ID, projectId: project.id, principalEmail: 'editor@example.test', userId: null,
    role: 'editor', status: 'active', invitedAt: new Date('2029-12-01T00:00:00.000Z'),
    acceptedAt: new Date('2029-12-01T00:00:00.000Z'), revokedAt: null,
    updatedAt: new Date('2029-12-01T00:00:00.000Z'),
  } as any)
  const secondEditor = await managed.repository.insertMembership({
    ownerUserId: OWNER_ID, projectId: project.id, principalEmail: 'other@example.test', userId: null,
    role: 'editor', status: 'active', invitedAt: new Date('2029-12-01T00:00:00.000Z'),
    acceptedAt: new Date('2029-12-01T00:00:00.000Z'), revokedAt: null,
    updatedAt: new Date('2029-12-01T00:00:00.000Z'),
  } as any)
  const analyst = await managed.repository.insertMembership({
    ownerUserId: OWNER_ID, projectId: project.id, principalEmail: 'analyst@example.test', userId: null,
    role: 'analyst', status: 'active', invitedAt: new Date('2029-12-01T00:00:00.000Z'),
    acceptedAt: new Date('2029-12-01T00:00:00.000Z'), revokedAt: null,
    updatedAt: new Date('2029-12-01T00:00:00.000Z'),
  } as any)
  let now = new Date('2030-01-10T00:00:00.000Z')
  return {
    managed,
    live,
    project,
    editor,
    secondEditor,
    analyst,
    dependencies: { managedRepository: managed.repository, liveRepository: live.repository, clock: () => now },
    setNow(value: string) { now = new Date(value) },
  }
}

async function addVerifiedDelivery(f: Awaited<ReturnType<typeof fixture>>, input: { deliveredAt?: Date; suffix?: string } = {}) {
  const suffix = input.suffix || 'first'
  const deliveredAt = input.deliveredAt || DELIVERED_AT
  const contentHash = stableFingerprint({ content: suffix })
  const canonicalDomain = `${suffix}.care.example.test`
  const draftOrderId = suffix === 'first' ? 1001 : 1002
  const productionFingerprint = stableFingerprint({ receipt: `${suffix}:production` })
  const release = await f.live.repository.insertRelease({
    ownerUserId: OWNER_ID, projectId: f.project.id, generationCandidateId: null, versionId: 1,
    previewId: 1, quoteId: 1, draftOrderId, commerceSnapshotFingerprint: stableFingerprint({ commerce: suffix }),
    releaseKind: 'generated_site', targetKey: `production-${suffix}`, canonicalDomain, contentHash,
    status: 'live_verified', previewUrl: null, providerPreviewId: null, approvalFingerprint: null, approvedAt: deliveredAt,
    activeDeploymentReceiptFingerprint: productionFingerprint, rollbackFromReleaseId: null, blockedReasonCode: null,
    nextSafeAction: 'none', projectionFingerprint: stableFingerprint({ release: suffix }), idempotencyKey: `release-${suffix}`,
  } as any)
  const common = { ownerUserId: OWNER_ID, projectId: f.project.id, draftOrderId, releaseId: release.id, attemptId: null, contentHash, canonicalDomain, verifiedAt: deliveredAt }
  const paymentFingerprint = stableFingerprint({ receipt: `${suffix}:payment` })
  const boundFingerprint = stableFingerprint({ receipt: `${suffix}:bound` })
  const workspaceFingerprint = stableFingerprint({ receipt: `${suffix}:workspace` })
  const notificationFingerprint = stableFingerprint({ receipt: `${suffix}:notification` })
  await f.live.repository.insertReceipt({ ...common, capability: 'payment', providerKey: 'stripe', providerEventId: `${suffix}-payment`, receiptType: 'checkout_succeeded', receiptStatus: 'verified', externalReference: `${suffix}-payment-ref`, exactResponseIdentity: `${suffix}:payment`, requestFingerprint: stableFingerprint({ request: `${suffix}:payment` }), metadata: { effective: true }, receiptFingerprint: paymentFingerprint } as any)
  await f.live.repository.insertReceipt({ ...common, capability: 'payment', providerKey: 'discoverystack-payment-binding', providerEventId: `${suffix}-bound`, receiptType: 'release_payment_bound', receiptStatus: 'verified', externalReference: `${suffix}-bound-ref`, exactResponseIdentity: `${suffix}:bound`, requestFingerprint: stableFingerprint({ request: `${suffix}:bound` }), metadata: { paymentReceiptFingerprint: paymentFingerprint }, receiptFingerprint: boundFingerprint } as any)
  await f.live.repository.insertReceipt({ ...common, capability: 'deployment', providerKey: 'cloudflare-pages', providerEventId: `${suffix}-production`, receiptType: 'production_deployment_verified', receiptStatus: 'verified', externalReference: `${suffix}-deployment`, exactResponseIdentity: `${suffix}:production`, requestFingerprint: stableFingerprint({ request: `${suffix}:production` }), metadata: {}, receiptFingerprint: productionFingerprint } as any)
  await f.live.repository.insertReceipt({ ...common, capability: 'deployment', providerKey: 'discoverystack-customer-workspace', providerEventId: `${suffix}-workspace`, receiptType: 'customer_workspace_bootstrapped', receiptStatus: 'verified', externalReference: `managed-site-project:${f.project.id}`, exactResponseIdentity: `${suffix}:workspace`, requestFingerprint: stableFingerprint({ request: `${suffix}:workspace` }), metadata: { productionReceiptFingerprint: productionFingerprint }, receiptFingerprint: workspaceFingerprint } as any)
  await f.live.repository.insertReceipt({ ...common, capability: 'deployment', providerKey: 'discoverystack-customer-workspace', providerEventId: `${suffix}-notification`, receiptType: 'customer_workspace_notification_sent', receiptStatus: 'verified', externalReference: `managed-site-project:${f.project.id}`, exactResponseIdentity: `${suffix}:notification`, requestFingerprint: stableFingerprint({ request: `${suffix}:notification` }), metadata: { paymentReceiptFingerprint: paymentFingerprint, workspaceReceiptFingerprint: workspaceFingerprint, membershipId: f.editor.id, bearerIncluded: false }, receiptFingerprint: notificationFingerprint } as any)
  return { release, paymentFingerprint, boundFingerprint, workspaceFingerprint, productionFingerprint, notificationFingerprint }
}

const requestInput = (overrides: Record<string, unknown> = {}) => ({
  category: 'layout',
  description: '請調整首頁標題與圖片之間的留白。',
  pageReference: '首頁主視覺',
  scopeAcknowledged: true,
  idempotencyKey: 'care-request-0001',
  ...overrides,
})

describe('managed-site 30-day design care', () => {
  it('does not start without the exact notification, payment binding, workspace and production receipts', async () => {
    const f = await fixture()
    const beforeDelivery = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'customer', membershipId: f.editor.id }, f.dependencies)
    expect(beforeDelivery.window).toMatchObject({ status: 'not_started', startsAt: null, canSubmit: false, reason: 'verified_delivery_not_found' })
    await expect(requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput(), f.dependencies)).rejects.toMatchObject({ statusCode: 409 })

    const malformed = await addVerifiedDelivery(f)
    f.live.state.receipts.splice(f.live.state.receipts.findIndex(row => row.receiptFingerprint === malformed.workspaceFingerprint), 1)
    const missingWorkspace = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'owner' }, f.dependencies)
    expect(missingWorkspace.window.status).toBe('not_started')
  })

  it('anchors to the earliest exact delivery and a later redeploy never resets the 30-day deadline', async () => {
    const f = await fixture()
    await addVerifiedDelivery(f)
    await addVerifiedDelivery(f, { suffix: 'redeploy', deliveredAt: new Date('2030-01-20T00:00:00.000Z') })
    const care = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'customer', membershipId: f.editor.id }, f.dependencies)
    expect(care.window).toMatchObject({
      status: 'active',
      startsAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-31T00:00:00.000Z',
      remainingDays: 21,
      canSubmit: true,
    })
    expect(care.allowedCategories.map(item => item.key)).toEqual(['layout', 'color', 'typography', 'image_placement'])

    f.setNow('2030-01-31T00:00:00.000Z')
    const expired = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'customer', membershipId: f.editor.id }, f.dependencies)
    expect(expired.window).toMatchObject({ status: 'expired', remainingDays: 0, canSubmit: false, expiresAt: '2030-01-31T00:00:00.000Z' })
    await expect(requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput(), f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('records only design-scope requests and gives idempotent replay without leaking them to another membership', async () => {
    const f = await fixture()
    await addVerifiedDelivery(f)
    const first = await requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput(), f.dependencies)
    expect(first).toMatchObject({ replayed: false, request: { category: 'layout', state: 'submitted' } })
    const replay = await requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput(), f.dependencies)
    expect(replay).toMatchObject({ replayed: true, request: { id: first.request.id } })
    expect(f.managed.state.audits.filter(event => event.action === 'managed_site_design_care_requested')).toHaveLength(1)
    expect(JSON.stringify(f.managed.state.audits)).not.toContain('editor@example.test')

    await expect(requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput({ description: '換成另一個版面需求。' }), f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    await expect(requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput({ idempotencyKey: 'care-request-feature', description: '請新增會員登入功能。' }), f.dependencies)).rejects.toMatchObject({ statusCode: 422 })
    await expect(requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.analyst.id, requestInput({ idempotencyKey: 'care-request-analyst' }), f.dependencies)).rejects.toMatchObject({ statusCode: 403 })

    const otherMember = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'customer', membershipId: f.secondEditor.id }, f.dependencies)
    expect(otherMember.requests).toEqual([])
    const owner = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'owner' }, f.dependencies)
    expect(owner.requests).toEqual([expect.objectContaining({ id: first.request.id, submittedByMembershipId: f.editor.id })])
  })

  it('accepts visual changes on existing cart and checkout surfaces but blocks explicit builds and data migration', async () => {
    const f = await fixture()
    await addVerifiedDelivery(f)
    const cartColour = await requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput({
      category: 'color',
      description: '請把既有購物車按鈕改成品牌藍色，功能保持不變。',
      pageReference: '既有購物車頁',
      idempotencyKey: 'care-existing-cart-color',
    }), f.dependencies)
    const checkoutType = await requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput({
      category: 'typography',
      description: 'Please adjust the existing checkout page typography and spacing only.',
      pageReference: 'Existing checkout page',
      idempotencyKey: 'care-existing-checkout-type',
    }), f.dependencies)
    expect(cartColour.request).toMatchObject({ category: 'color', state: 'submitted' })
    expect(checkoutType.request).toMatchObject({ category: 'typography', state: 'submitted' })

    await expect(requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput({
      description: '請新增購物車功能，讓顧客能保存商品。',
      idempotencyKey: 'care-new-cart-function',
    }), f.dependencies)).rejects.toMatchObject({ statusCode: 422 })
    await expect(requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput({
      description: '請把舊平台的會員與訂單資料搬遷到新網站。',
      idempotencyKey: 'care-data-migration',
    }), f.dependencies)).rejects.toMatchObject({ statusCode: 422 })

    const owner = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'owner' }, f.dependencies)
    expect(owner.requests).toHaveLength(2)
  })

  it('persists owner state and reason as append-only events with transition and idempotency guards', async () => {
    const f = await fixture()
    await addVerifiedDelivery(f)
    const submitted = await requestManagedSiteDesignCare(OWNER_ID, f.project.id, f.editor.id, requestInput(), f.dependencies)
    const reviewing = await changeManagedSiteDesignCareState(OWNER_ID, f.project.id, OWNER_ID, {
      requestId: submitted.request.id,
      state: 'reviewing',
      reason: '已收到，正在確認首頁目前的版面版本。',
      idempotencyKey: 'care-state-reviewing',
    }, f.dependencies)
    expect(reviewing).toMatchObject({ replayed: false, request: { state: 'reviewing', ownerReason: '已收到，正在確認首頁目前的版面版本。' } })
    await expect(changeManagedSiteDesignCareState(OWNER_ID, f.project.id, OWNER_ID, {
      requestId: submitted.request.id,
      state: 'accepted',
      reason: '改用不同內容重播。',
      idempotencyKey: 'care-state-reviewing',
    }, f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    const completed = await changeManagedSiteDesignCareState(OWNER_ID, f.project.id, OWNER_ID, {
      requestId: submitted.request.id,
      state: 'completed',
      reason: '首頁留白已依需求調整完成。',
      idempotencyKey: 'care-state-completed',
    }, f.dependencies)
    expect(completed.request.state).toBe('completed')
    await expect(changeManagedSiteDesignCareState(OWNER_ID, f.project.id, OWNER_ID, {
      requestId: submitted.request.id,
      state: 'in_progress',
      reason: '不可重新開啟終態。',
      idempotencyKey: 'care-state-reopen',
    }, f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    expect(f.managed.state.audits.filter(event => event.action === 'managed_site_design_care_state_changed')).toHaveLength(2)
  })

  it('invalidates delivery authority after an effective refund and blocks suspended projects', async () => {
    const f = await fixture()
    const delivery = await addVerifiedDelivery(f)
    const payment = f.live.state.receipts.find(row => row.receiptFingerprint === delivery.paymentFingerprint)!
    f.live.state.receipts.push({ ...payment, id: 99_001, providerEventId: 'effective-refund', receiptType: 'payment_refunded', receiptFingerprint: stableFingerprint({ receipt: 'refund' }), metadata: { effective: true } })
    const refunded = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'customer', membershipId: f.editor.id }, f.dependencies)
    expect(refunded.window.status).toBe('not_started')

    f.live.state.receipts.pop()
    f.project.status = 'suspended'
    const suspended = await getManagedSiteDesignCare(OWNER_ID, f.project.id, { kind: 'customer', membershipId: f.editor.id }, f.dependencies)
    expect(suspended.window).toMatchObject({ status: 'active', canSubmit: false, reason: 'project_suspended' })
  })

  it('keeps both mutation routes same-origin, bounded and private, with truthful customer UI copy', () => {
    const customerPost = readFileSync(new URL('../server/api/managed-sites/customer/design-care.post.ts', import.meta.url), 'utf8')
    const ownerPost = readFileSync(new URL('../server/api/managed-sites/projects/[id]/design-care.post.ts', import.meta.url), 'utf8')
    const customerGet = readFileSync(new URL('../server/api/managed-sites/customer/design-care.get.ts', import.meta.url), 'utf8')
    const page = readFileSync(new URL('../pages/customer/managed-sites/design-care.vue', import.meta.url), 'utf8')
    for (const source of [customerPost, ownerPost]) {
      expect(source).toContain('privateManagedSiteHeaders(event)')
      expect(source).toContain('assertSameOriginManagedSiteMutation(event)')
      expect(source).toContain('readBoundedRequestBody(event')
      expect(source.indexOf('assertSameOriginManagedSiteMutation(event)')).toBeLessThan(source.indexOf('readBoundedRequestBody(event'))
    }
    expect(customerGet).toContain('requireManagedSiteCustomer(event)')
    expect(page).toContain('重新部署不會重算 30 天')
    expect(page).toContain('不包含新增功能')
  })
})
