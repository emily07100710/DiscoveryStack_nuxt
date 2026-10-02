import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { suspendManagedSiteProject } from '../server/managed-sites/service'
import { createManagedSiteCheckoutSession, createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { setManagedSiteRouteDependencyFactoryForTests } from '../server/managed-sites/live-connectors/http'
import { runFunnelCheckout } from '../server/managed-sites/funnel/checkout-orchestrator'
import { createFunnelSession, MANAGED_SITE_FUNNEL_CONSENT_VERSION, recordFunnelConsent } from '../server/managed-sites/funnel/session-service'
import type { ManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/types'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const liveCheckoutAdapterFactory = vi.hoisted(() => vi.fn())
vi.mock('../server/managed-sites/live-connectors/runtime-adapters', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), managedSiteLiveCheckoutAdapter: liveCheckoutAdapterFactory }))

const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const }
const clock = () => managedSiteFixedNow
const ROUTE_PATH = 'server/api/managed-sites/projects/[id]/releases/[releaseId]/checkout.post.ts'

beforeAll(() => { (globalThis as any).defineEventHandler = defineEventHandler; (globalThis as any).createError = createError })
afterEach(() => { setManagedSiteRouteDependencyFactoryForTests(null); liveCheckoutAdapterFactory.mockReset(); vi.useRealTimers(); vi.unstubAllEnvs() })

type Line = Awaited<ReturnType<typeof createAuthoritativeManagedSiteReleaseFixture>>
const suspend = (line: Line) => suspendManagedSiteProject(1, line.prePurchase.project.id, actor, { reason: 'Owner requested a bounded suspension', idempotencyKey: 'checkout-guard-suspend-001' }, line.managed.repository)
const dependencies = (line: Line) => ({ connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, clock })
const spyAdapter = () => { const mock = createMockManagedSiteCheckoutSessionAdapter(); const createSession = vi.fn(mock.createSession); return { adapter: { createSession } as ManagedSiteCheckoutSessionAdapter, createSession } }
const checkoutAttempts = (line: Line) => line.live.state.attempts.filter(item => item.operation === 'checkout_session_create').length
const checkoutReceipts = (line: Line) => line.live.state.receipts.filter(item => item.receiptType === 'checkout_session_created').length

async function callRoute(line: Line, executionMode: 'mocked' | 'live', idempotencyKey: string, projectId = line.prePurchase.project.id) {
  vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://ops.test')
  const handler = (await import('../server/api/managed-sites/projects/[id]/releases/[releaseId]/checkout.post')).default
  const app = createApp({ debug: false }); const router = createRouter(); router.post('/api/managed-sites/projects/:id/releases/:releaseId/checkout', handler); app.use(router)
  return toWebHandler(app)(new Request(`https://ops.test/api/managed-sites/projects/${projectId}/releases/${line.release.release.id}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://ops.test' }, body: JSON.stringify({ executionMode, idempotencyKey }) }))
}

describe('managed-site checkout suspension guard', () => {
  it('creates a checkout for an active project (control)', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false }); const { adapter, createSession } = spyAdapter()
    const created = await createManagedSiteCheckoutSession(1, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-guard-active-001' }, adapter, dependencies(line))
    expect(created.replayed).toBe(false); expect(createSession).toHaveBeenCalledTimes(1); expect(checkoutAttempts(line)).toBe(1); expect(checkoutReceipts(line)).toBe(1)
  })

  it('rejects a suspended project before any attempt row, adapter call, or receipt', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false }); await suspend(line); const { adapter, createSession } = spyAdapter()
    await expect(createManagedSiteCheckoutSession(1, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-guard-suspended-001' }, adapter, dependencies(line))).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Suspended or unavailable managed-site projects cannot perform this operation.' })
    expect(createSession).not.toHaveBeenCalled(); expect(checkoutAttempts(line)).toBe(0); expect(checkoutReceipts(line)).toBe(0)
    expect(line.live.state.releases.find(item => item.id === line.release.release.id)?.status).toBe('approved')
  })

  it('stops replaying an existing payment link once the project is suspended', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture(); const { adapter, createSession } = spyAdapter()
    const input = { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked' as const, idempotencyKey: 'fixture-checkout-001' }
    await expect(createManagedSiteCheckoutSession(1, input, adapter, dependencies(line))).resolves.toMatchObject({ replayed: true, checkout: { url: line.checkout!.checkout.url } })
    await suspend(line)
    await expect(createManagedSiteCheckoutSession(1, input, adapter, dependencies(line))).rejects.toMatchObject({ statusCode: 409 })
    expect(createSession).not.toHaveBeenCalled(); expect(checkoutAttempts(line)).toBe(1); expect(checkoutReceipts(line)).toBe(1)
  })

  it('rejects a project that no longer exists and keeps owner isolation ahead of the status answer', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false }); const { adapter, createSession } = spyAdapter()
    const input = { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked' as const, idempotencyKey: 'checkout-guard-missing-001' }
    await expect(createManagedSiteCheckoutSession(2, input, adapter, dependencies(line))).rejects.toMatchObject({ statusCode: 404 })
    line.managed.state.projects.splice(0)
    await expect(createManagedSiteCheckoutSession(1, input, adapter, dependencies(line))).rejects.toMatchObject({ statusCode: 409 })
    expect(createSession).not.toHaveBeenCalled(); expect(checkoutAttempts(line)).toBe(0)
  })

  it('refuses at the owner route before the live payment adapter is obtained', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(managedSiteFixedNow)
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false }); const { adapter, createSession } = spyAdapter(); liveCheckoutAdapterFactory.mockResolvedValue(adapter)
    setManagedSiteRouteDependencyFactoryForTests(() => ({ ownerUserId: 1, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository }))
    const active = await callRoute(line, 'live', 'checkout-guard-route-active')
    expect(liveCheckoutAdapterFactory).toHaveBeenCalledTimes(1); expect(active.status).not.toBe(409)
    liveCheckoutAdapterFactory.mockClear(); await suspend(line)
    const live = await callRoute(line, 'live', 'checkout-guard-route-live'); expect(live.status).toBe(409)
    const mocked = await callRoute(line, 'mocked', 'checkout-guard-route-mocked'); expect(mocked.status).toBe(409)
    expect(liveCheckoutAdapterFactory).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled(); expect(checkoutAttempts(line)).toBe(0); expect(checkoutReceipts(line)).toBe(0)
  })

  it('refuses a missing project at the owner route and still creates a mocked checkout for an active one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(managedSiteFixedNow)
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    setManagedSiteRouteDependencyFactoryForTests(() => ({ ownerUserId: 1, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository }))
    const created = await callRoute(line, 'mocked', 'checkout-guard-route-created'); expect(created.status).toBe(200); expect(checkoutReceipts(line)).toBe(1)
    line.managed.state.projects.splice(0)
    const missing = await callRoute(line, 'live', 'checkout-guard-route-missing'); expect(missing.status).toBe(409)
    expect(liveCheckoutAdapterFactory).not.toHaveBeenCalled(); expect(checkoutReceipts(line)).toBe(1)
  })

  it('keeps the project-status check ahead of adapter resolution in the owner route source', () => {
    const source = readFileSync(resolve(process.cwd(), ROUTE_PATH), 'utf8')
    const guard = source.indexOf('await assertManagedSiteProjectNotSuspended(ownerUserId, projectId, managedRepository)')
    expect(guard).toBeGreaterThan(-1); expect(guard).toBeLessThan(source.indexOf('managedSiteLiveCheckoutAdapter(ownerUserId, repository)')); expect(guard).toBeLessThan(source.indexOf('createManagedSiteCheckoutSession(ownerUserId'))
  })

  it('withholds the existing self-serve payment link and the adapter once the project is suspended', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture(); const funnel = createFunnelSessionMemoryRepository()
    const created = await createFunnelSession(funnel.repository, clock)
    await recordFunnelConsent(created.sessionId, created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, funnel.repository, clock)
    const release = (await line.live.repository.findRelease(1, line.release.release.id))!; const preview = (await line.ordering.repository.findPreviewById(line.preview.preview.id))!
    await funnel.repository.updateSession(created.sessionId, { status: 'checkout_pending', releaseId: release.id, projectId: release.projectId, previewId: preview.id, previewAccessTokenHash: preview.accessTokenHash, draftOrderId: line.order.order.id, builtPreviewUrl: release.previewUrl })
    const { adapter, createSession } = spyAdapter()
    const funnelDependencies = { funnelRepository: funnel.repository, orderingRepository: line.ordering.repository, connectorRepository: line.live.repository, managedRepository: line.managed.repository, executionMode: 'mocked' as const, checkoutAdapter: adapter, clock, resolveOwnerUserId: async () => 1 }
    await expect(runFunnelCheckout(created.sessionId, created.sessionToken, funnelDependencies)).resolves.toEqual({ checkoutUrl: line.checkout!.checkout.url })
    await suspend(line); const before = structuredClone({ receipts: line.live.state.receipts, attempts: line.live.state.attempts, session: funnel.state.sessions[0] })
    await expect(runFunnelCheckout(created.sessionId, created.sessionToken, funnelDependencies)).rejects.toMatchObject({ statusCode: 409 })
    await expect(runFunnelCheckout(created.sessionId, created.sessionToken, { ...funnelDependencies, executionMode: 'live', checkoutAdapter: undefined })).rejects.toMatchObject({ statusCode: 409 })
    expect(liveCheckoutAdapterFactory).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled()
    expect({ receipts: line.live.state.receipts, attempts: line.live.state.attempts, session: funnel.state.sessions[0] }).toEqual(before)
  })
})
