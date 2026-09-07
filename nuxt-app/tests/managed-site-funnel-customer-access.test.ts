import { describe, expect, it } from 'vitest'
import { claimFunnelCustomerAccess, type FunnelCustomerAccessDependencies } from '../server/managed-sites/funnel/customer-access'
import { createFunnelSession } from '../server/managed-sites/funnel/session-service'
import { tokenHash } from '../server/managed-sites/normalization'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'
import { processManagedSiteVerifiedPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'

async function paidLine() {
  const line = await createAuthoritativeManagedSiteReleaseFixture()
  const funnel = createFunnelSessionMemoryRepository()
  const created = await createFunnelSession(funnel.repository, () => managedSiteFixedNow)
  await funnel.repository.updateSession(created.sessionId, {
    status: 'checkout_pending', projectId: line.prePurchase.project.id, releaseId: line.release.release.id,
    draftOrderId: line.order.order.id, quoteId: line.quote.quote.quoteId, previewId: line.preview.preview.id,
    answers: { contact: { email: 'not-authority@example.invalid', contactName: 'Customer' } },
  })
  const event = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: 'paid-customer-access', eventType: 'checkout_succeeded' })
  await processManagedSiteVerifiedPaymentWebhook({ verifiedEvent: { ...event, canonicalPayloadHash: 'a'.repeat(64) } as any, executionMode: 'mocked' }, { jointTransaction: line.jointTransaction, clock: () => managedSiteFixedNow })
  const dependencies: FunnelCustomerAccessDependencies = {
    funnelRepository: funnel.repository, clock: () => managedSiteFixedNow,
    withTransaction: work => line.jointTransaction(scoped => work({ ordering: scoped.ordering, managed: scoped.managed, live: scoped.connector })),
  }
  const claim = () => claimFunnelCustomerAccess(line.ownerUserId, created.sessionId, created.sessionToken, dependencies)
  return { ...line, funnel, created, dependencies, claim }
}

describe('paid funnel customer access', () => {
  it('exchanges only verified paid authority for an editor session and replays without extending access', async () => {
    const line = await paidLine()
    const result = await line.claim()
    const member = line.managed.state.memberships.find(row => row.id === result.session.membershipId)!
    expect(member).toMatchObject({ ownerUserId: line.ownerUserId, projectId: line.prePurchase.project.id, role: 'editor', principalEmail: 'not-authority@example.invalid' })
    expect(result.session.sessionHash).toBe(tokenHash(result.sessionToken))
    expect(result.sessionToken).not.toBe(line.created.sessionToken)
    expect(result.session.expiresAt.getTime()).toBe(managedSiteFixedNow.getTime() + 8 * 60 * 60_000)
    const replay = await line.claim()
    expect(replay.sessionToken).toBe(result.sessionToken)
    expect(replay.replayed).toBe(true)
    expect(line.managed.state.sessions).toHaveLength(1)
    expect(JSON.stringify(line.managed.state)).not.toContain(line.created.sessionToken)
    expect(JSON.stringify(line.managed.state)).not.toContain(result.sessionToken)
  })

  it.each(['payment_pending', 'refunded', 'disputed'])('never grants access for a current %s order', async status => {
    const line = await paidLine()
    line.ordering.state.orders[0]!.status = status as any
    await expect(line.claim()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.managed.state.sessions).toHaveLength(0)
  })

  it('rejects missing payment proof even if the order projection says paid', async () => {
    const line = await paidLine()
    line.live.state.receipts = line.live.state.receipts.filter(row => row.receiptType !== 'checkout_succeeded')
    await expect(line.claim()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.managed.state.sessions).toHaveLength(0)
  })

  it('rejects cross-owner, wrong bearer, changed contact and mismatched release lineage', async () => {
    const line = await paidLine()
    await expect(claimFunnelCustomerAccess(line.ownerUserId + 1, line.created.sessionId, line.created.sessionToken, line.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    await expect(claimFunnelCustomerAccess(line.ownerUserId, line.created.sessionId, 'x'.repeat(43), line.dependencies)).rejects.toMatchObject({ statusCode: 404 })
    ;(line.funnel.state.sessions[0]!.answers as any).contact.email = 'attacker@example.test'
    await expect(line.claim()).rejects.toMatchObject({ statusCode: 409 })
    ;(line.funnel.state.sessions[0]!.answers as any).contact.email = 'not-authority@example.invalid'
    line.live.state.releases[0]!.quoteId = 999
    await expect(line.claim()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.managed.state.sessions).toHaveLength(0)
  })

  it('does not revive a revoked or expired issued session', async () => {
    const line = await paidLine()
    const result = await line.claim()
    result.session.revokedAt = managedSiteFixedNow
    await expect(line.claim()).rejects.toMatchObject({ statusCode: 409 })
    result.session.revokedAt = null
    result.session.expiresAt = managedSiteFixedNow
    await expect(line.claim()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.managed.state.sessions).toHaveLength(1)
  })

  it('never assumes an existing membership belongs to the paid funnel bearer', async () => {
    const line = await paidLine()
    await line.managed.repository.insertMembership({ ownerUserId: line.ownerUserId, projectId: line.prePurchase.project.id, principalEmail: 'not-authority@example.invalid', role: 'administrator', status: 'active', userId: null, invitedAt: managedSiteFixedNow, acceptedAt: managedSiteFixedNow, revokedAt: null })
    await expect(line.claim()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.managed.state.sessions).toHaveLength(0)
  })
})
