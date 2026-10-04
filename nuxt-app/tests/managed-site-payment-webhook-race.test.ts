import { createHmac, randomBytes } from 'node:crypto'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it, vi } from 'vitest'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook, type ManagedSiteJointTransaction } from '../server/managed-sites/live-connectors/payment-webhook'
import { makeManagedSiteLiveConnectorRepository } from '../server/managed-sites/live-connectors/repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow as now } from './fixtures/managed-site/live-connectors-application'

const inboxEventKey = 'managed_site_payment_inbox_provider_event_unique'
function duplicateQuery(key = inboxEventKey) {
  const cause = Object.assign(new Error(`Duplicate entry for key 'managedSitePaymentWebhookInbox.${key}'`), { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' })
  return new DrizzleQueryError('insert into managedSitePaymentWebhookInbox values (?)', [], cause)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function failingInboxRepository(error: unknown) {
  const insert = vi.fn(() => ({ values: vi.fn(async () => { throw error }) }))
  const select = vi.fn(() => { throw new Error('The failed transaction must not read its old snapshot.') })
  return { repository: makeManagedSiteLiveConnectorRepository({ insert, select }), insert, select }
}
async function signedSender(line: Awaited<ReturnType<typeof createAuthoritativeManagedSiteReleaseFixture>>) {
  const credential = randomBytes(32).toString('hex')
  const payload = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: 'race-same-event-001', eventType: 'checkout_succeeded' })
  const send = (transaction: ManagedSiteJointTransaction, event: Record<string, unknown> = payload, signatureOverride?: string) => {
    const rawBody = Buffer.from(JSON.stringify(event))
    const signatureHeader = signatureOverride || createHmac('sha256', credential).update(rawBody).digest('hex')
    return processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:race-test-only', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: transaction, credentialResolver: async () => ({ ok: true, value: credential }), clock: () => now })
  }
  return { payload, send }
}
function snapshot(line: Awaited<ReturnType<typeof createAuthoritativeManagedSiteReleaseFixture>>) {
  return structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
}

// Model two independent database transactions, not the fixture's serial transaction queue:
// both read an absent inbox, then MySQL waits for the winner to commit before rejecting
// the loser's insert. The loser has performed only reads when its transaction rolls back.
async function concurrentDelivery(options: { differentPayload?: boolean; beforeFreshRead?: (line: Awaited<ReturnType<typeof createAuthoritativeManagedSiteReleaseFixture>>) => void } = {}) {
  const line = await createAuthoritativeManagedSiteReleaseFixture()
  const signed = await signedSender(line)
  const bothRead = deferred(); const winnerCommitted = deferred(); let reads = 0; let loserRolledBack = false; let loserTransactions = 0
  const failed = failingInboxRepository(duplicateQuery())
  const readAbsent = async () => { reads++; if (reads === 2) bothRead.resolve(); await bothRead.promise; return null }
  const winnerTransaction: ManagedSiteJointTransaction = work => line.jointTransaction(repositories => work({ ...repositories, connector: { ...repositories.connector, findPaymentWebhookInbox: readAbsent } }))
  const loserTransaction: ManagedSiteJointTransaction = async work => {
    loserTransactions++
    if (loserTransactions > 1) {
      expect(loserRolledBack).toBe(true)
      options.beforeFreshRead?.(line)
      return line.jointTransaction(work)
    }
    try {
      return await work({ ordering: line.ordering.repository, managed: line.managed.repository, connector: { ...line.live.repository, findPaymentWebhookInbox: readAbsent, insertPaymentWebhookInbox: async input => { await winnerCommitted.promise; return failed.repository.insertPaymentWebhookInbox(input) } } })
    } catch (error) { loserRolledBack = true; throw error }
  }
  const winner = signed.send(winnerTransaction).finally(winnerCommitted.resolve)
  const loserPayload = options.differentPayload ? { ...signed.payload, exactResponseIdentity: 'payment-response:different-signed-payload' } : signed.payload
  const loser = signed.send(loserTransaction, loserPayload)
  // Attach both rejection handlers immediately so a failed regression cannot leak an unhandled rejection.
  const results = await Promise.allSettled([winner, loser])
  return { line, results, failed, loserTransactions, loserRolledBack, reads }
}

describe('managed-site webhook duplicate insert transaction recovery', () => {
  it('replays one exact signed concurrent winner after rollback without duplicate payment or entitlement writes', async () => {
    const race = await concurrentDelivery()
    expect(race.reads).toBe(2); expect(race.loserRolledBack).toBe(true); expect(race.loserTransactions).toBe(2)
    expect(race.results[0]).toMatchObject({ status: 'fulfilled', value: { replayed: false, effective: true } })
    expect(race.results[1]).toMatchObject({ status: 'fulfilled', value: { replayed: true, effective: true } })
    if (race.results[0]?.status !== 'fulfilled' || race.results[1]?.status !== 'fulfilled') throw new Error('Both deliveries must converge on the committed receipt.')
    expect(race.results[1].value.event).toEqual(race.results[0].value.event)
    expect(race.failed.insert).toHaveBeenCalledTimes(1); expect(race.failed.select).not.toHaveBeenCalled()
    expect(race.line.live.state.paymentWebhookInbox).toHaveLength(1)
    expect(race.line.ordering.state.paymentEvents).toHaveLength(1)
    expect(race.line.managed.state.subscriptions).toHaveLength(1)
    expect(race.line.live.state.attempts.filter(row => row.operation === 'payment_webhook_transition')).toHaveLength(1)
    for (const receiptType of ['checkout_succeeded', 'release_payment_bound', 'provisioning_armed']) expect(race.line.live.state.receipts.filter(row => row.receiptType === receiptType)).toHaveLength(1)
    expect(race.line.live.state.releases.find(row => row.id === race.line.release.release.id)?.status).toBe('payment_verified')
  })

  it('rejects a different correctly signed payload sharing the provider event id after the winner commits', async () => {
    const race = await concurrentDelivery({ differentPayload: true })
    expect(race.results[0]).toMatchObject({ status: 'fulfilled', value: { effective: true } })
    expect(race.results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } })
    expect(race.loserTransactions).toBe(2); expect(race.failed.select).not.toHaveBeenCalled()
    expect(race.line.live.state.paymentWebhookInbox).toHaveLength(1)
    expect(race.line.ordering.state.paymentEvents).toHaveLength(1)
    expect(race.line.managed.state.subscriptions).toHaveLength(1)
    expect(race.line.live.state.receipts.filter(row => row.receiptType === 'checkout_succeeded')).toHaveLength(1)
  })

  for (const corrupt of ['pending', 'missing-inbox', 'missing-receipt', 'receipt-payload', 'receipt-owner', 'receipt-status'] as const) {
    it(`fails closed on ${corrupt} in the fresh transaction and never continues payment writes`, async () => {
      let before: ReturnType<typeof snapshot> | undefined
      const race = await concurrentDelivery({ beforeFreshRead: line => {
        const inbox = line.live.state.paymentWebhookInbox[0]!
        const receipt = line.live.state.receipts.find(row => row.receiptType === 'checkout_succeeded')!
        if (corrupt === 'pending') inbox.processingStatus = 'processing'
        else if (corrupt === 'missing-inbox') line.live.state.paymentWebhookInbox.splice(0)
        else if (corrupt === 'missing-receipt') line.live.state.receipts.splice(line.live.state.receipts.indexOf(receipt), 1)
        else if (corrupt === 'receipt-payload') receipt.metadata = { ...receipt.metadata as Record<string, unknown>, eventIdentityFingerprint: 'f'.repeat(64) }
        else if (corrupt === 'receipt-owner') receipt.ownerUserId++
        else receipt.receiptStatus = 'ignored_out_of_order'
        before = snapshot(line)
      } })
      expect(race.results[0]).toMatchObject({ status: 'fulfilled', value: { effective: true } })
      expect(race.results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } })
      expect(race.loserTransactions).toBe(2)
      expect(snapshot(race.line)).toEqual(before)
    })
  }

  it('does not reinterpret a different unique constraint or a storage error as an inbox winner', async () => {
    for (const error of [duplicateQuery('managed_site_payment_inbox_event_fingerprint_unique'), new DrizzleQueryError('insert inbox', [], Object.assign(new Error('storage offline'), { code: 'ER_CONNECTION_LOST' }))]) {
      const line = await createAuthoritativeManagedSiteReleaseFixture(); const signed = await signedSender(line); const failed = failingInboxRepository(error)
      const transactionCalls = vi.fn()
      const transaction: ManagedSiteJointTransaction = work => { transactionCalls(); return line.jointTransaction(repositories => work({ ...repositories, connector: { ...repositories.connector, insertPaymentWebhookInbox: failed.repository.insertPaymentWebhookInbox } })) }
      const before = snapshot(line)
      await expect(signed.send(transaction)).rejects.toBe(error)
      expect(transactionCalls).toHaveBeenCalledTimes(1); expect(failed.select).not.toHaveBeenCalled(); expect(snapshot(line)).toEqual(before)
    }
  })

  it('keeps signature verification before any transaction or duplicate recovery', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture(); const signed = await signedSender(line)
    const transactionCalls = vi.fn()
    const transaction: ManagedSiteJointTransaction = () => { transactionCalls(); throw new Error('must not enter a transaction') }
    await expect(signed.send(transaction, signed.payload, '0'.repeat(64))).rejects.toMatchObject({ statusCode: 403 })
    expect(transactionCalls).not.toHaveBeenCalled()
  })
})
