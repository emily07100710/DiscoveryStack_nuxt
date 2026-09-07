import { afterEach, describe, expect, it, vi } from 'vitest'

const advancers = vi.hoisted(() => ({ legacy: vi.fn(), funnel: vi.fn() }))
vi.mock('../server/managed-sites/live-connectors/provision-advancer', () => ({ advanceEligibleManagedSiteProvisioning: advancers.legacy }))
vi.mock('../server/managed-sites/funnel/fulfilment-advancer', () => ({ advancePaidManagedSiteFunnel: advancers.funnel }))
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('managed-site scheduled task', () => {
  it('keeps existing owner advancement and continues paid funnel pages independently of any browser request', async () => {
    vi.stubGlobal('defineTask', (task: unknown) => task)
    advancers.legacy.mockResolvedValue({ scanned: 3, advanced: 2, failed: 0 })
    advancers.funnel.mockResolvedValueOnce({ scanned: 20, advanced: 1, waiting: 19, failed: 0, nextAfterId: 55 }).mockResolvedValueOnce({ scanned: 0, advanced: 0, waiting: 0, failed: 0, nextAfterId: 0 })
    const { default: task } = await import('../server/tasks/managed-sites/provisioning-tick')
    const first = await task.run({} as any)
    await task.run({} as any)
    expect(first).toMatchObject({ result: { scanned: 3, advanced: 2, failed: 0, funnel: { scanned: 20, advanced: 1 } } })
    expect(advancers.legacy).toHaveBeenCalledTimes(2)
    expect(advancers.funnel.mock.calls).toEqual([[{ limit: 20, afterId: 0 }], [{ limit: 20, afterId: 55 }]])
  })
})
