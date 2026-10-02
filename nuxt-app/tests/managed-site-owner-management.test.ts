import { createApp, createError, createRouter, defineEventHandler, getHeader, send, setResponseStatus, toWebHandler } from 'h3'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createPaidManagedSiteModuleFulfilments, resolveManagedSiteManualModuleFulfilment } from '../server/managed-sites/funnel/module-fulfilment'
import { listManagedSiteAuditEvents } from '../server/managed-sites/service'
import type { ManagedSiteJointTransaction } from '../server/managed-sites/live-connectors/payment-webhook'
import { setManagedSiteRouteDependencyFactoryForTests } from '../server/managed-sites/live-connectors/http'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

let paymentsHandler: any
const savedPrivateOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
beforeAll(async () => {
  ;(globalThis as any).defineEventHandler = defineEventHandler
  ;(globalThis as any).createError = createError
  paymentsHandler = (await import('../server/api/managed-sites/payments/[...path]')).default
})
afterEach(() => { setManagedSiteRouteDependencyFactoryForTests(null); if (savedPrivateOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN; else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedPrivateOrigin })

async function managementLine() {
  process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://management.test'
  const line = await createAuthoritativeManagedSiteReleaseFixture({ ownerUserId: 1, canonicalDomain: `management-${Math.random().toString(36).slice(2)}.acme.taipei`, selectedModules: ['stripe_payment'], buildPreview: false })
  const fulfilment = await line.ordering.repository.insertModuleFulfilment({ ownerUserId: 1, draftOrderId: line.order.order.id, quoteId: line.order.order.quoteId, moduleKey: 'stripe_payment', mode: 'manual_service', status: 'pending_manual_setup', billedMinor: 3000, customerVisibleStatus: '已付款・待我們為你設定開通', ownerActionRequired: true, completedAt: null })
  setManagedSiteRouteDependencyFactoryForTests(event => {
    const session = getHeader(event, 'x-test-owner-session')
    if (!session) throw createError({ statusCode: 401, statusMessage: 'Owner session is required.' })
    if (!['owner-1', 'owner-2'].includes(session)) throw createError({ statusCode: 403, statusMessage: 'Owner session is forbidden.' })
    return { ownerUserId: session === 'owner-1' ? 1 : 2, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, paymentWebhookJointTransaction: line.jointTransaction }
  })
  const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, error.statusCode || 500, error.statusMessage); await send(event, JSON.stringify({ statusCode: error.statusCode || 500, statusMessage: error.statusMessage || 'Request failed.' }), 'application/json') } })
  const router = createRouter(); router.use('/api/managed-sites/payments/**', paymentsHandler); app.use(router)
  const web = toWebHandler(app)
  const request = async (path: string, body: unknown, owner: 'owner-1' | 'owner-2' | null = 'owner-1') => {
    const response = await web(new Request(`https://management.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://management.test', ...(owner ? { 'x-test-owner-session': owner } : {}) }, body: JSON.stringify(body) }))
    const text = await response.text()
    return { response, body: text ? JSON.parse(text) : null }
  }
  return { line, fulfilment, request }
}

const completeBody = { reason: '客服已完成實際開通並核對設定', idempotencyKey: 'module-complete-001', confirmation: 'service_delivered' }
const cancelBody = { reason: '客戶確認從未開通並撤回此項服務', idempotencyKey: 'module-cancel-001', confirmation: 'not_activated' }
const suspendBody = { reason: 'Owner 要求暫停本系統後續所有操作', idempotencyKey: 'project-suspend-001', confirmation: 'suspend_project' }

describe('managed-site owner management routes', () => {
  it('rejects unauthenticated access to complete, cancel, and suspend without writes', async () => {
    const { line, request } = await managementLine()
    const before = structuredClone({ fulfilments: line.ordering.state.moduleFulfilments, projects: line.managed.state.projects, audits: line.managed.state.audits })
    const base = `/api/managed-sites/payments/orders/${line.order.order.id}/modules/stripe_payment`
    expect((await request(`${base}/complete`, completeBody, null)).response.status).toBe(401)
    expect((await request(`${base}/cancel`, cancelBody, null)).response.status).toBe(401)
    expect((await request(`/api/managed-sites/payments/projects/${line.prePurchase.project.id}/suspend`, suspendBody, null)).response.status).toBe(401)
    expect({ fulfilments: line.ordering.state.moduleFulfilments, projects: line.managed.state.projects, audits: line.managed.state.audits }).toEqual(before)
  })

  it('returns the same 404 boundary for cross-owner module and project operations', async () => {
    const { line, request } = await managementLine()
    const before = structuredClone({ fulfilments: line.ordering.state.moduleFulfilments, projects: line.managed.state.projects, audits: line.managed.state.audits })
    const base = `/api/managed-sites/payments/orders/${line.order.order.id}/modules/stripe_payment`
    expect((await request(`${base}/complete`, completeBody, 'owner-2')).response.status).toBe(404)
    expect((await request(`${base}/cancel`, cancelBody, 'owner-2')).response.status).toBe(404)
    expect((await request(`/api/managed-sites/payments/projects/${line.prePurchase.project.id}/suspend`, suspendBody, 'owner-2')).response.status).toBe(404)
    expect({ fulfilments: line.ordering.state.moduleFulfilments, projects: line.managed.state.projects, audits: line.managed.state.audits }).toEqual(before)
  })

  it('rejects invalid module scope and refuses fulfilment resolution without an existing project link', async () => {
    const { line, request } = await managementLine()
    const orderId = line.order.order.id
    expect((await request(`/api/managed-sites/payments/orders/${orderId}/modules/not_a_module/complete`, completeBody)).response.status).toBe(422)
    expect((await request(`/api/managed-sites/payments/orders/${orderId}/modules/ecpay_payment/complete`, completeBody)).response.status).toBe(404)
    line.ordering.state.orders[0]!.projectId = null
    expect((await request(`/api/managed-sites/payments/orders/${orderId}/modules/stripe_payment/complete`, completeBody)).response.status).toBe(409)
    expect(line.ordering.state.moduleFulfilments[0]).toMatchObject({ status: 'pending_manual_setup', ownerActionRequired: true, completedAt: null })
    expect(line.managed.state.audits.filter(event => event.action === 'managed_site_module_fulfilment_completed')).toHaveLength(0)
  })

  it('completes one manual service, validates strict input, replays once, and rejects cancellation afterward', async () => {
    const { line, request } = await managementLine(); const path = `/api/managed-sites/payments/orders/${line.order.order.id}/modules/stripe_payment/complete`
    for (const body of [{ ...completeBody, confirmation: 'not_activated' }, { ...completeBody, reason: '短' }, { ...completeBody, extra: true }]) expect((await request(path, body)).response.status).toBe(422)
    const preserved = structuredClone({ order: line.ordering.state.orders[0], payments: line.ordering.state.paymentEvents, receipts: line.live.state.receipts, attempts: line.live.state.attempts })
    const completed = await request(path, completeBody); expect(completed.response.status).toBe(200); expect(completed.body).toMatchObject({ replayed: false, fulfilment: { status: 'manual_setup_completed', customerVisibleStatus: '客服已完成設定', ownerActionRequired: false, billedMinor: 3000 } }); expect(completed.body.fulfilment.completedAt).toBeTruthy()
    expect((await request(path, completeBody)).body.replayed).toBe(true)
    expect((await request(path, { ...completeBody, idempotencyKey: 'module-complete-002' })).body.replayed).toBe(true)
    expect((await request(path.replace('/complete', '/cancel'), cancelBody)).response.status).toBe(409)
    expect({ order: line.ordering.state.orders[0], payments: line.ordering.state.paymentEvents, receipts: line.live.state.receipts, attempts: line.live.state.attempts }).toEqual(preserved)
    const audits = await listManagedSiteAuditEvents(1, line.prePurchase.project.id, { ownerUserId: 1, actorUserId: 1, authority: 'owner_session', role: 'owner' }, line.managed.repository)
    const managementAudits = audits.filter(event => event.action === 'managed_site_module_fulfilment_completed'); expect(managementAudits).toHaveLength(1); expect(managementAudits[0]).toMatchObject({ action: 'managed_site_module_fulfilment_completed', actorUserId: 1, authority: 'owner_session', metadata: { reason: completeBody.reason, previousStatus: 'pending_manual_setup', status: 'manual_setup_completed', billedMinor: 3000, refundIssued: false, providerCallMade: false } })
  })

  it('cancels one never-activated item without marking completion and accepts paid lineage replay', async () => {
    const { line, request } = await managementLine(); const path = `/api/managed-sites/payments/orders/${line.order.order.id}/modules/stripe_payment/cancel`
    for (const body of [{ ...cancelBody, confirmation: 'service_delivered' }, { ...cancelBody, reason: '短' }, { ...cancelBody, extra: true }]) expect((await request(path, body)).response.status).toBe(422)
    const preserved = structuredClone({ order: line.ordering.state.orders[0], payments: line.ordering.state.paymentEvents, receipts: line.live.state.receipts, attempts: line.live.state.attempts })
    const cancelled = await request(path, cancelBody); expect(cancelled.response.status).toBe(200); expect(cancelled.body).toMatchObject({ replayed: false, fulfilment: { status: 'cancelled', customerVisibleStatus: '已取消・未開通', ownerActionRequired: false, completedAt: null, billedMinor: 3000 } })
    expect((await request(path, cancelBody)).body.replayed).toBe(true)
    expect((await request(path, { ...cancelBody, idempotencyKey: 'module-cancel-002' })).body.replayed).toBe(true)
    expect((await request(path.replace('/cancel', '/complete'), completeBody)).response.status).toBe(409)
    expect({ order: line.ordering.state.orders[0], payments: line.ordering.state.paymentEvents, receipts: line.live.state.receipts, attempts: line.live.state.attempts }).toEqual(preserved)
    const quote = line.ordering.state.quotes.find(item => item.id === line.order.order.quoteId)!; const lines = await line.ordering.repository.listQuoteLines(quote.id)
    await expect(createPaidManagedSiteModuleFulfilments(1, line.order.order.id, quote, lines, line.ordering.repository)).resolves.toEqual([expect.objectContaining({ status: 'cancelled', completedAt: null })])
    expect(line.managed.state.audits.filter(event => event.action === 'managed_site_module_fulfilment_cancelled')).toEqual([expect.objectContaining({ action: 'managed_site_module_fulfilment_cancelled', metadata: expect.objectContaining({ reason: cancelBody.reason, previousStatus: 'pending_manual_setup', status: 'cancelled', refundIssued: false, providerCallMade: false }) })])
  })

  it('rolls the fulfilment CAS back when the audit insert fails', async () => {
    const { line } = await managementLine()
    const faultyJoint: ManagedSiteJointTransaction = work => line.jointTransaction(repositories => work({ ...repositories, managed: { ...repositories.managed, async insertAuditEvent() { throw new Error('synthetic audit failure') } } }))
    await expect(resolveManagedSiteManualModuleFulfilment(1, line.order.order.id, 'stripe_payment', 'cancelled', { reason: cancelBody.reason, idempotencyKey: 'module-audit-failure' }, faultyJoint)).rejects.toThrow('synthetic audit failure')
    expect(await line.ordering.repository.findModuleFulfilment(1, line.order.order.id, 'stripe_payment')).toMatchObject({ status: 'pending_manual_setup', ownerActionRequired: true, completedAt: null })
    expect(line.managed.state.audits.filter(event => event.action === 'managed_site_module_fulfilment_cancelled')).toHaveLength(0)
  })

  it('suspends one project transactionally, revokes sessions, preserves commerce evidence, and replays without another audit', async () => {
    const { line, request } = await managementLine(); const projectId = line.prePurchase.project.id
    await line.managed.repository.insertSubscription({ ownerUserId: 1, projectId, planKey: 'site_geo', status: 'active', subscriptionReference: 'stripe:subscription-reference', gracePeriodEndsAt: null, termEndsAt: null, idempotencyKey: 'management-subscription-001', stateFingerprint: stableFingerprint({ projectId, status: 'active' }) } as any)
    await line.managed.repository.insertSession({ ownerUserId: 1, projectId, membershipId: 99, sessionHash: 'management-session-hash', expiresAt: new Date('2031-01-01T00:00:00.000Z'), revokedAt: null, lastSeenAt: null } as any)
    const path = `/api/managed-sites/payments/projects/${projectId}/suspend`
    for (const body of [{ ...suspendBody, confirmation: 'service_delivered' }, { ...suspendBody, reason: '' }, { ...suspendBody, unknown: true }]) expect((await request(path, body)).response.status).toBe(422)
    const preserved = structuredClone({ orders: line.ordering.state.orders, payments: line.ordering.state.paymentEvents, receipts: line.live.state.receipts, attempts: line.live.state.attempts, releases: line.live.state.releases })
    const suspended = await request(path, suspendBody); expect(suspended.response.status).toBe(200); expect(suspended.body).toMatchObject({ replayed: false, project: { status: 'suspended' }, subscription: { status: 'suspended' } })
    expect(line.managed.state.sessions[0]?.revokedAt).toBeTruthy()
    expect((await request(path, suspendBody)).body.replayed).toBe(true)
    expect((await request(path, { ...suspendBody, idempotencyKey: 'project-suspend-002' })).body.replayed).toBe(true)
    expect({ orders: line.ordering.state.orders, payments: line.ordering.state.paymentEvents, receipts: line.live.state.receipts, attempts: line.live.state.attempts, releases: line.live.state.releases }).toEqual(preserved)
    const audits = await listManagedSiteAuditEvents(1, projectId, { ownerUserId: 1, actorUserId: 1, authority: 'owner_session', role: 'owner' }, line.managed.repository)
    const managementAudits = audits.filter(event => event.action === 'managed_site_project_suspended'); expect(managementAudits).toHaveLength(1); expect(managementAudits[0]).toMatchObject({ action: 'managed_site_project_suspended', actorUserId: 1, metadata: { previousProjectStatus: 'payment_pending', previousSubscriptionStatus: 'active', subscriptionStatus: 'suspended', reason: suspendBody.reason, stripeSubscriptionCancelled: false, refundIssued: false, domainDeleted: false, dataDeletion: false, providerCallMade: false } })
  })
})
