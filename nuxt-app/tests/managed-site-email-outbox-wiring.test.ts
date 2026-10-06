import { afterEach, describe, expect, it } from 'vitest'
import type { ManagedSiteEmailOutboxClaim, ManagedSiteEmailOutboxInsert, ManagedSiteEmailOutboxItem, ManagedSiteEmailOutboxRepository } from '../server/managed-sites/email-outbox/types'
import { setManagedSiteEmailOutboxRuntimeForTests } from '../server/managed-sites/email-outbox/runtime'
import { startManagedSiteContactInboxBinding, type ManagedSiteContactInboxBindingDependencies } from '../server/managed-sites/contact-inbox/binding-service'
import { createContactInboxBindingMemoryRepository } from './fixtures/managed-site/contact-inbox-binding-repository'
import { inviteAndDeliverManagedSiteMember } from '../server/managed-sites/member-invitation-delivery'
import { requestManagedSiteReaccess } from '../server/managed-sites/reaccess-service'
import { ingestManagedSiteContactForm } from '../server/managed-sites/contact-form/ingest-service'
import { createManagedSiteContactFormRateLimiter } from '../server/managed-sites/contact-form/ingest-service'
import { notifyManagedSiteCustomerWorkspaceReady } from '../server/managed-sites/funnel/customer-workspace-notification'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createManagedSiteProject, inviteManagedSiteMember } from '../server/managed-sites/service'
import type { ManagedSiteContactInboxBindingRepository } from '../server/managed-sites/contact-inbox/binding-repository'
import type { ManagedSiteRepository } from '../server/managed-sites/types'
import type { ManagedSiteContactFormRepository } from '../server/managed-sites/contact-form/repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'
import { createHmac } from 'node:crypto'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { stableFingerprint } from '../server/seo-geo-core/repository'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const SECRET = 'independent-test-encryption-secret-32-bytes-minimum'
const CONFIG = 'a'.repeat(64)
const PORTAL = 'https://portal.example.test'
const OWNER = 71
const WEBHOOK_SECRET = 'workspace-wiring-webhook-secret'
const savedOutboxKey = process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY

afterEach(() => {
  setManagedSiteEmailOutboxRuntimeForTests(null)
  if (savedOutboxKey === undefined) delete process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY
  else process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY = savedOutboxKey
})

function setRuntime(outbox: ReturnType<typeof memoryOutbox>, options: { authorityDependencies?: any; afterAccept?: (context: any) => Promise<void>; beforeProviderAccept?: () => void; clock?: () => Date; providerSend?: () => Promise<{ delivered: true; providerMessageId: string }> } = {}) {
  const authorityOverride = options.afterAccept
    ? { resolveAuthority: async (context: any) => ({ current: true, afterAccept: () => options.afterAccept!(context) }) }
    : options.authorityDependencies ? {} : { resolveAuthority: async () => ({ current: true }) }
  setManagedSiteEmailOutboxRuntimeForTests({
    repository: outbox.repo,
    encryptionSecret: SECRET,
    providerConfigurationFingerprint: CONFIG,
    transport: { configured: true, async send() { options.beforeProviderAccept?.(); return options.providerSend ? options.providerSend() : { delivered: true, providerMessageId: UUID } } },
    authorityDependencies: options.authorityDependencies,
    ...authorityOverride,
    clock: options.clock || (() => new Date()),
    executionEnabled: true,
  })
}

async function liveWorkspaceFixture() {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'ready.acme.taipei' })
  const event = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: 'outbox-wiring-payment', eventType: 'checkout_succeeded' })
  const rawBody = Buffer.from(JSON.stringify(event))
  await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader: createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex'), credentialReference: 'vault:outbox-wiring-webhook', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true, value: WEBHOOK_SECRET }), clock: () => managedSiteFixedNow })
  const release = line.live.state.releases[0]!
  const productionReceiptFingerprint = stableFingerprint({ scope: 'workspace-wiring-production', releaseId: release.id })
  await line.live.repository.insertReceipt({
    ownerUserId: line.ownerUserId, projectId: release.projectId, draftOrderId: release.draftOrderId, releaseId: release.id,
    attemptId: null, capability: 'deployment', providerKey: 'mock-deployment', providerEventId: 'outbox-wiring-production',
    receiptType: 'production_deployment_verified', receiptStatus: 'verified', externalReference: 'mock-production-1', exactResponseIdentity: 'workspace-wiring-production:1',
    requestFingerprint: stableFingerprint({ scope: 'workspace-wiring-production-request', releaseId: release.id }), contentHash: release.contentHash, canonicalDomain: release.canonicalDomain,
    metadata: {}, receiptFingerprint: productionReceiptFingerprint, verifiedAt: managedSiteFixedNow,
  })
  release.status = 'live_verified'; release.activeDeploymentReceiptFingerprint = productionReceiptFingerprint
  const workspaceReceiptFingerprint = stableFingerprint({ scope: 'workspace-wiring-bootstrap', releaseId: release.id })
  await line.live.repository.insertReceipt({
    ownerUserId: line.ownerUserId, projectId: release.projectId, draftOrderId: release.draftOrderId, releaseId: release.id,
    attemptId: null, capability: 'deployment', providerKey: 'discoverystack-customer-workspace', providerEventId: 'outbox-wiring-bootstrap',
    receiptType: 'customer_workspace_bootstrapped', receiptStatus: 'verified', externalReference: `managed-site-project:${release.projectId}`, exactResponseIdentity: 'outbox-wiring-bootstrap:1',
    requestFingerprint: stableFingerprint({ scope: 'workspace-wiring-bootstrap-request', releaseId: release.id }), contentHash: release.contentHash, canonicalDomain: release.canonicalDomain,
    metadata: { productionReceiptFingerprint }, receiptFingerprint: workspaceReceiptFingerprint, verifiedAt: managedSiteFixedNow,
  })
  return { line, release }
}

function memoryOutbox() {
  const rows = new Map<string, ManagedSiteEmailOutboxItem>()
  const keys = new Map<string, string>()
  const repo: ManagedSiteEmailOutboxRepository = {
    async insertOrGet(input: ManagedSiteEmailOutboxInsert) {
      const key = `${input.purpose}:${input.idempotencyKey}`
      const previous = keys.get(key)
      if (previous) return rows.get(previous)!
      const row: ManagedSiteEmailOutboxItem = { ...input, status: 'queued', attemptCount: 0, firstAttemptAt: null, leaseToken: null, leaseExpiresAt: null, safeCode: null, providerReceiptId: null, acceptedAt: null, createdAt: new Date(), updatedAt: new Date() }
      rows.set(input.id, row); keys.set(key, input.id); return row
    },
    async getById(id) { return rows.get(id) || null },
    async listSafeMetadata() { return [] },
    async cancelExpired() { return 0 },
    async claimOne(input) {
      const row = [...rows.values()].find(candidate => (!input.id || candidate.id === input.id) && candidate.status === 'queued' && candidate.nextAttemptAt <= input.now && candidate.attemptCount < input.maxAttempts)
      if (!row) return null
      row.status = 'processing'; row.leaseToken = input.leaseToken; row.leaseExpiresAt = input.leaseExpiresAt
      return { item: row, leaseToken: input.leaseToken } satisfies ManagedSiteEmailOutboxClaim
    },
    async beginAttempt(input) { const row = rows.get(input.id); if (!row || row.status !== 'processing' || row.leaseToken !== input.leaseToken) return null; row.attemptCount++; row.firstAttemptAt ||= input.now; return row },
    async renew(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken) return false; row.leaseExpiresAt = input.leaseExpiresAt; return true },
    async accepted(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken) return false; row.status = 'reconcile_pending'; row.providerReceiptId = input.providerReceiptId; row.acceptedAt = input.now; return true },
    async reconciliationComplete(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken) return false; row.status = 'accepted'; row.encryptedPayload = null; row.leaseToken = null; row.leaseExpiresAt = null; return true },
    async retry(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken) return false; row.status = row.acceptedAt ? 'reconcile_pending' : 'queued'; row.nextAttemptAt = input.nextAttemptAt; row.safeCode = input.safeCode; row.leaseToken = null; row.leaseExpiresAt = null; return true },
    async finish(input) { const row = rows.get(input.id); if (!row || row.leaseToken !== input.leaseToken) return false; row.status = input.status; row.encryptedPayload = null; row.safeCode = input.safeCode; row.leaseToken = null; row.leaseExpiresAt = null; return true },
  }
  return { repo, rows }
}

describe('managed-site email outbox caller wiring', () => {
  it('routes the default inbox-verification business call through an atomic queue and serializes concurrent first issuance', async () => {
    const memory = createContactInboxBindingMemoryRepository()
    const outbox = memoryOutbox()
    const original = memory.repository
    const repository = {
      ...original,
      async transactionWithEmailOutbox<T>(work: (repository: ManagedSiteContactInboxBindingRepository, outbox: ManagedSiteEmailOutboxRepository) => Promise<T>): Promise<T> {
        return original.transaction(tx => work({ ...tx, async lockSessionForEmailIssuance() {} }, outbox.repo))
      },
    }
    let accepted = 0
    setManagedSiteEmailOutboxRuntimeForTests({
      repository: outbox.repo,
      encryptionSecret: SECRET,
      providerConfigurationFingerprint: CONFIG,
      transport: { configured: true, async send(input) { accepted++; expect(input.to).toBe('hello@example.com'); return { delivered: true, providerMessageId: UUID } } },
      resolveAuthority: async (context, message) => ({
        current: true,
        afterAccept: async () => {
          if (context.purpose !== 'inbox_verification') return
          const row = memory.state.bindings.find(candidate => candidate.id === context.authority.bindingId)
          if (row) { row.lastSentAt = new Date(); row.sendCount = 1 }
          expect(message.text).toMatch(/\d{6}/u)
        },
      }),
      clock: () => new Date(),
      executionEnabled: true,
    })
    try {
      const dependencies: ManagedSiteContactInboxBindingDependencies = {
        repository,
        transport: { configured: true, async send() { throw new Error('raw caller transport must not be used') } },
        pepper: 'independent-verification-pepper-for-wiring-test',
        clock: () => new Date(),
        durableOutbox: true,
      }
      const session: any = { id: 41, projectId: null, status: 'active', expiresAt: new Date(Date.now() + 86_400_000) }
      const replies = await Promise.allSettled([
        startManagedSiteContactInboxBinding({ session, email: 'hello@example.com' }, dependencies),
        startManagedSiteContactInboxBinding({ session, email: 'hello@example.com' }, dependencies),
      ])
      expect(replies.filter(reply => reply.status === 'fulfilled')).toHaveLength(1)
      expect(replies.filter(reply => reply.status === 'rejected')).toHaveLength(1)
      expect((replies.find(reply => reply.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ statusCode: 429 })
      expect(memory.state.bindings).toHaveLength(1)
      expect(outbox.rows.size).toBe(1)
      expect(accepted).toBe(1)
      expect([...outbox.rows.values()][0]?.status).toBe('accepted')
    } finally {
      setManagedSiteEmailOutboxRuntimeForTests(null)
    }
  })

  it('rolls back a pending verification binding when an idempotency collision returns an item id', async () => {
    const memory = createContactInboxBindingMemoryRepository()
    const outbox = memoryOutbox()
    const collisionRepository: ManagedSiteEmailOutboxRepository = {
      ...outbox.repo,
      async insertOrGet(input) { return { ...await outbox.repo.insertOrGet(input), payloadFingerprint: 'f'.repeat(64) } },
    }
    let providerCalls = 0
    const repository: any = {
      ...memory.repository,
      async transactionWithEmailOutbox<T>(work: (repository: ManagedSiteContactInboxBindingRepository, queue: ManagedSiteEmailOutboxRepository) => Promise<T>): Promise<T> {
        return memory.repository.transaction(tx => work({ ...tx, async lockSessionForEmailIssuance() {} }, collisionRepository))
      },
    }
    setManagedSiteEmailOutboxRuntimeForTests({ repository: outbox.repo, encryptionSecret: SECRET, providerConfigurationFingerprint: CONFIG,
      transport: { configured: true, async send() { providerCalls++; return { delivered: true, providerMessageId: UUID } } },
      resolveAuthority: async () => ({ current: true }), clock: () => new Date(), executionEnabled: true })
    const dependencies: ManagedSiteContactInboxBindingDependencies = {
      repository, transport: { configured: true, async send() { throw new Error('raw caller transport must not be used') } },
      pepper: 'independent-verification-pepper-for-wiring-test', clock: () => new Date(), durableOutbox: true,
    }
    await expect(startManagedSiteContactInboxBinding({ session: { id: 42, projectId: null, status: 'active', expiresAt: new Date(Date.now() + 86_400_000) } as any, email: 'hello@example.com' }, dependencies)).rejects.toMatchObject({ statusCode: 502 })
    expect(memory.state.bindings).toHaveLength(0)
    expect(outbox.rows.size).toBe(1)
    expect(providerCalls).toBe(0)
  })

  it('queues member invitation payload in the source invitation transaction before provider delivery', async () => {
    process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY = SECRET
    const managed = createManagedSiteMemoryRepository()
    const actor: any = { ownerUserId: OWNER, actorUserId: OWNER, authority: 'owner_session', role: 'owner', principal: `owner-${OWNER}@internal.invalid` }
    const created = await createManagedSiteProject(OWNER, actor, { canonicalClientIdentity: 'Acme', canonicalWebsiteIdentity: 'acme.example', siteType: 'one_page', idempotencyKey: 'outbox-wiring-invite-project' }, managed.repository)
    const outbox = memoryOutbox()
    const repository: any = managed.repository
    repository.transactionWithEmailOutbox = <T>(work: (tx: ManagedSiteRepository, queue: ManagedSiteEmailOutboxRepository) => Promise<T>): Promise<T> => managed.repository.transaction(tx => work(tx, outbox.repo))
    setRuntime(outbox)
    const result = await inviteAndDeliverManagedSiteMember(OWNER, created.project.id, actor, { email: 'member@example.com', role: 'editor', idempotencyKey: 'outbox-wiring-invite' }, {
      repository, emailTransport: { configured: true, async send() { throw new Error('raw invitation transport must not be used') } }, portalOrigin: PORTAL, nodeEnv: 'production', durableOutbox: true,
    })
    expect(result).toMatchObject({ invitationToken: null, invitationUrl: null, delivery: { status: 'sent' } })
    expect(managed.state.invitations).toHaveLength(1)
    expect(outbox.rows.size).toBe(1)
    expect([...outbox.rows.values()][0]?.status).toBe('accepted')
  })

  it('queues all re-access invitation links atomically and leaves them durable after accepted delivery', async () => {
    process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY = SECRET
    const managed = createManagedSiteMemoryRepository()
    const actor: any = { ownerUserId: OWNER, actorUserId: OWNER, authority: 'owner_session', role: 'owner', principal: `owner-${OWNER}@internal.invalid` }
    const created = await createManagedSiteProject(OWNER, actor, { canonicalClientIdentity: 'Acme', canonicalWebsiteIdentity: 'acme.example', siteType: 'one_page', idempotencyKey: 'outbox-wiring-reaccess-project' }, managed.repository)
    created.project.status = 'active'
    const persistedProject = await managed.repository.findProject(OWNER, created.project.id)
    if (!persistedProject) throw new Error('persisted project fixture was not found')
    persistedProject.status = 'active'
    await inviteManagedSiteMember(OWNER, created.project.id, actor, { email: 'member@example.com', role: 'editor', idempotencyKey: 'outbox-wiring-reaccess-membership' }, managed.repository)
    managed.state.invitations.length = 0
    expect(managed.state.memberships.some(row => row.ownerUserId === OWNER && row.projectId === created.project.id && row.principalEmail === 'member@example.com' && row.status === 'active')).toBe(true)
    expect(await managed.repository.listActiveMembershipsByEmail(OWNER, 'member@example.com')).toHaveLength(1)
    const outbox = memoryOutbox()
    const repository: any = managed.repository
    const activeMemberships = await repository.listActiveMembershipsByEmail(OWNER, 'member@example.com')
    repository.listActiveMembershipsByEmail = async () => activeMemberships
    const currentMember = activeMemberships[0]
    expect(currentMember).toMatchObject({ role: 'editor', status: 'active', projectId: created.project.id, principalEmail: 'member@example.com' })
    expect(created.project.status).toBe('active')
    repository.transactionWithEmailOutbox = <T>(work: (tx: ManagedSiteRepository, queue: ManagedSiteEmailOutboxRepository) => Promise<T>): Promise<T> => managed.repository.transaction(tx => work({ ...tx, async findProject() { return persistedProject }, async findMembership() { return currentMember } }, outbox.repo))
    setRuntime(outbox)
    const result = await requestManagedSiteReaccess('member@example.com', {
      repository, resolveOwnerUserId: async () => OWNER, emailTransport: { configured: true, async send() { throw new Error('raw re-access transport must not be used') } },
      portalOrigin: PORTAL, nodeEnv: 'production', clock: () => new Date('2034-02-03T04:05:06.000Z'), durableOutbox: true,
    })
    expect(result).toMatchObject({ acknowledged: true, diagnostics: { outcome: 'sent', issued: 1 } })
    expect(managed.state.invitations).toHaveLength(1)
    expect(outbox.rows.size).toBe(1)
    expect([...outbox.rows.values()][0]?.status).toBe('accepted')
  })

  it('stores contact submissions and forwards only through the queue-backed current inbox', async () => {
    const formToken = 'f'.repeat(64)
    const formHash = (await import('node:crypto')).createHash('sha256').update(formToken).digest('hex')
    const project: any = { id: 71, ownerUserId: OWNER, status: 'active', canonicalClientIdentity: 'Acme', canonicalWebsiteIdentity: 'https://customer.example', contactFormTokenHash: formHash }
    const binding: any = { id: 9, projectId: project.id, email: 'bound@example.com', status: 'bound' }
    const state: any = { submissions: [], nextId: 1 }
    const repository: any = {
      async findProjectByTokenHash(hash: string) { return hash === formHash ? project : null },
      async findBoundInbox() { return binding },
      async findRecentDuplicate() { return null },
      async insertSubmission(input: any) { const row = { ...input, id: state.nextId++, createdAt: new Date('2034-02-03T04:05:06.000Z') }; state.submissions.push(row); return row },
      async findSubmission(id: number) { return state.submissions.find((row: any) => row.id === id) || null },
      async updateSubmission(id: number, patch: any) { const row = state.submissions.find((item: any) => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
      async transactionWithEmailOutbox<T>(work: (tx: ManagedSiteContactFormRepository, queue: ManagedSiteEmailOutboxRepository) => Promise<T>): Promise<T> { return work(repository, outbox.repo) },
    }
    const outbox = memoryOutbox()
    let accepted = 0
    setManagedSiteEmailOutboxRuntimeForTests({
      repository: outbox.repo, encryptionSecret: SECRET, providerConfigurationFingerprint: CONFIG,
      transport: { configured: true, async send() { accepted++; return { delivered: true, providerMessageId: UUID } } },
      resolveAuthority: async (_context, message) => ({ current: true, afterAccept: async () => { Object.assign(state.submissions[0], { status: 'forwarded', forwardedAt: new Date(), forwardTargetEmail: message.to, forwardErrorCode: null }) } }),
      clock: () => new Date('2034-02-03T04:05:06.000Z'), executionEnabled: true,
    })
    const body = Buffer.from(new URLSearchParams({ name: 'Visitor', email: 'visitor@example.com', phone: '', message: 'Hello', companyFax: '' }).toString())
    const result = await ingestManagedSiteContactForm({ context: { clientAddress: '127.0.0.1' }, node: { req: { headers: { 'user-agent': 'outbox-test', 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } } } } as any, formToken, body, {
      repository, transport: { configured: true, async send() { throw new Error('raw contact transport must not be used') } }, rateLimiter: createManagedSiteContactFormRateLimiter(), clock: () => new Date('2034-02-03T04:05:06.000Z'), durableOutbox: true,
    })
    expect(result.status).toBe(303)
    expect(state.submissions[0]).toMatchObject({ status: 'forwarded', forwardTargetEmail: 'bound@example.com' })
    expect(outbox.rows.size).toBe(1)
    expect(accepted).toBe(1)
  })

  it('does not write workspace-delivered truth until the queue-backed provider acceptance callback', async () => {
    process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY = SECRET
    const { line, release } = await liveWorkspaceFixture()
    const outbox = memoryOutbox()
    let now = new Date(managedSiteFixedNow)
    let providerAcceptances = 0
    setRuntime(outbox, { authorityDependencies: {
      liveRepository: line.live.repository,
      orderingRepository: line.ordering.repository,
      managedRepository: line.managed.repository,
      portalOrigin: PORTAL,
      nodeEnv: 'production',
      clock: () => new Date(now),
    }, clock: () => new Date(now), providerSend: async () => {
      providerAcceptances += 1
      expect(line.live.state.receipts.filter(row => row.receiptType === 'customer_workspace_notification_sent')).toHaveLength(0)
      if (providerAcceptances === 1) throw new Error('synthetic retryable provider failure')
      return { delivered: true, providerMessageId: UUID }
    } })
    const dependencies = {
      liveRepository: line.live.repository,
      orderingRepository: line.ordering.repository,
      managedRepository: line.managed.repository,
      emailTransport: { configured: true, async send() { throw new Error('raw workspace transport must not be used') } },
      portalOrigin: PORTAL,
      nodeEnv: 'production',
      clock: () => new Date(now),
      durableOutbox: true,
    }
    const first = await notifyManagedSiteCustomerWorkspaceReady(line.ownerUserId, { releaseId: release.id }, dependencies)
    expect(first).toMatchObject({ sent: false, replayed: false, retryable: true, reason: 'email_delivery_failed' })
    expect(outbox.rows.size).toBe(1)
    expect([...outbox.rows.values()][0]?.status).toBe('queued')
    expect(line.live.state.receipts.filter(row => row.receiptType === 'customer_workspace_notification_sent')).toHaveLength(0)
    const originalItem = [...outbox.rows.values()][0]!
    const originalExpiry = originalItem.expiresAt.getTime()
    now = new Date(now.getTime() + 31_000)
    await expect(notifyManagedSiteCustomerWorkspaceReady(line.ownerUserId, { releaseId: release.id }, dependencies)).resolves.toMatchObject({ sent: true, replayed: false })
    expect(outbox.rows.size).toBe(1)
    expect([...outbox.rows.values()][0]?.id).toBe(originalItem.id)
    expect([...outbox.rows.values()][0]?.expiresAt.getTime()).toBe(originalExpiry)
    expect([...outbox.rows.values()][0]?.status).toBe('accepted')
    expect([...outbox.rows.values()][0]?.attemptCount).toBe(2)
    expect(providerAcceptances).toBe(2)
    expect(line.live.state.receipts.filter(row => row.receiptType === 'customer_workspace_notification_sent')).toHaveLength(1)
    await expect(notifyManagedSiteCustomerWorkspaceReady(line.ownerUserId, { releaseId: release.id }, dependencies)).resolves.toMatchObject({ sent: true, replayed: true })
    expect(providerAcceptances).toBe(2)
    expect([...outbox.rows.values()][0]?.attemptCount).toBe(2)
  })

  it.each([
    ['future', () => new Date(managedSiteFixedNow.getTime() + 1_000)],
    ['older than the 30-day window', () => new Date(managedSiteFixedNow.getTime() - 30 * 24 * 60 * 60_000)],
  ])('does not enqueue workspace-ready email for a %s persisted receipt timestamp', async (_label, receiptTime) => {
    process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY = SECRET
    const { line, release } = await liveWorkspaceFixture()
    const workspaceReceipt = line.live.state.receipts.find(row => row.receiptType === 'customer_workspace_bootstrapped')!
    workspaceReceipt.verifiedAt = receiptTime()
    const outbox = memoryOutbox()
    let providerCalls = 0
    setRuntime(outbox, {
      authorityDependencies: {
        liveRepository: line.live.repository,
        orderingRepository: line.ordering.repository,
        managedRepository: line.managed.repository,
        portalOrigin: PORTAL,
        nodeEnv: 'production',
        clock: () => managedSiteFixedNow,
      },
      clock: () => managedSiteFixedNow,
      providerSend: async () => { providerCalls += 1; return { delivered: true, providerMessageId: UUID } },
    })
    const result = await notifyManagedSiteCustomerWorkspaceReady(line.ownerUserId, { releaseId: release.id }, {
      liveRepository: line.live.repository,
      orderingRepository: line.ordering.repository,
      managedRepository: line.managed.repository,
      emailTransport: { configured: true, async send() { throw new Error('raw workspace transport must not be used') } },
      portalOrigin: PORTAL,
      nodeEnv: 'production',
      clock: () => managedSiteFixedNow,
      durableOutbox: true,
    })
    expect(result).toEqual({ sent: false, replayed: false, retryable: true, reason: 'email_delivery_failed' })
    expect(outbox.rows.size).toBe(0)
    expect(providerCalls).toBe(0)
    expect(line.live.state.receipts.filter(row => row.receiptType === 'customer_workspace_notification_sent')).toHaveLength(0)
  })
})
