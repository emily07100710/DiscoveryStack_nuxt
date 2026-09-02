import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getManagedSiteOrders } from '../server/managed-sites/live-connectors/orders'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

describe('managed-site owner orders surface', () => {
  it('lists only the owner orders and allowlists checkoutUrl without leaking other receipt metadata', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ ownerUserId: 1, canonicalDomain: 'orders-owner.acme.taipei' })
    const other = await createAuthoritativeManagedSiteReleaseFixture({ ownerUserId: 2, canonicalDomain: 'orders-other.acme.taipei' })
    const foreignOrder = { ...structuredClone(other.order.order), id: line.order.order.id + 10_000 }
    line.ordering.state.orders.push(foreignOrder)
    const checkout = line.live.state.receipts.find(receipt => receipt.receiptType === 'checkout_session_created')!
    checkout.metadata = { ...(checkout.metadata as Record<string, unknown>), internalOnly: 'must-not-leak', credentialReference: 'vault:must-not-leak' }
    const result = await getManagedSiteOrders(1, { orderingRepository: line.ordering.repository, repository: line.live.repository })
    expect(result.orders.map(order => order.id)).toEqual([line.order.order.id])
    expect(result.orders[0]).toMatchObject({ id: line.order.order.id, quote: { plan: line.quote.quote.planKey, currency: line.quote.quote.currency, totalMinor: line.quote.quote.totalMinor }, release: { id: line.release.release.id }, payments: expect.arrayContaining([expect.objectContaining({ receiptType: 'checkout_session_created', checkoutUrl: (checkout.metadata as any).checkoutUrl })]) })
    expect(JSON.stringify(result)).not.toMatch(/internalOnly|must-not-leak|credentialReference/u)
  })

  it('keeps the flat owner page wired to orders, checkout URL capture, and reconciliation controls', () => {
    const source = readFileSync(new URL('../pages/audit-lab/managed-sites.vue', import.meta.url), 'utf8')
    expect(source).toContain("'/api/managed-sites/payments/orders'")
    expect(source).toContain("{ server: false, default: () => ({ orders: [] }) }")
    expect(source).toContain('產生付款連結')
    expect(source).toContain('向 Stripe 核對')
    expect(source).toContain('result.checkout?.url')
    expect(source).toContain('caught?.data?.message')
    expect(source).toContain('crypto.randomUUID()')
    expect(source).toContain('await refresh()')
  })
})
