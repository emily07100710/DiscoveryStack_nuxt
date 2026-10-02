import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createManagedSiteOperationState, refreshManagedSiteOperationScreen, runManagedSiteOperation } from '../utils/managedSiteOperation'

describe('managed-site owner operation feedback', () => {
  it('reports success with a fresh screen when both the operation and the refresh work', async () => {
    const state = createManagedSiteOperationState(); const submit = vi.fn(async () => ({ replayed: false })); const refresh = vi.fn(async () => true)
    await expect(runManagedSiteOperation(state, 'module-120001:stripe_payment', submit, refresh)).resolves.toEqual({ status: 'success', result: { replayed: false }, refreshFailed: false })
    expect(submit).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1); expect(state).toEqual({ completed: { 'module-120001:stripe_payment': true }, refreshFailed: false })
  })

  it.each([
    ['throws', async () => { throw new Error('network down') }],
    ['reports a failed reload', async () => false],
  ])('keeps the success when the screen refresh %s', async (_label, refreshImpl) => {
    const state = createManagedSiteOperationState(); const submit = vi.fn(async () => ({ replayed: false })); const refresh = vi.fn(refreshImpl as () => Promise<boolean>)
    await expect(runManagedSiteOperation(state, 'suspend-90001', submit, refresh)).resolves.toEqual({ status: 'success', result: { replayed: false }, refreshFailed: true })
    expect(submit).toHaveBeenCalledTimes(1); expect(state.completed['suspend-90001']).toBe(true); expect(state.refreshFailed).toBe(true)
  })

  it('never submits a completed operation again, even while the screen is still stale', async () => {
    const state = createManagedSiteOperationState(); const submit = vi.fn(async () => ({ replayed: false })); const refresh = vi.fn(async () => false)
    await runManagedSiteOperation(state, 'suspend-90001', submit, refresh)
    await expect(runManagedSiteOperation(state, 'suspend-90001', submit, refresh)).resolves.toEqual({ status: 'already_completed' })
    expect(submit).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1); expect(state.refreshFailed).toBe(true)
  })

  it('retries only the screen refresh and clears the hint once it works', async () => {
    const state = createManagedSiteOperationState(); const submit = vi.fn(async () => ({ replayed: false })); let reloadWorks = false; const refresh = vi.fn(async () => reloadWorks)
    await runManagedSiteOperation(state, 'module-120001:stripe_payment', submit, refresh)
    await expect(refreshManagedSiteOperationScreen(state, refresh)).resolves.toBe(false); expect(state.refreshFailed).toBe(true)
    reloadWorks = true
    await expect(refreshManagedSiteOperationScreen(state, refresh)).resolves.toBe(true)
    expect(state.refreshFailed).toBe(false); expect(state.completed['module-120001:stripe_payment']).toBe(true); expect(submit).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('reports a rejected operation as blocked, does not refresh, and leaves it open for a retry', async () => {
    const state = createManagedSiteOperationState(); const failure = Object.assign(new Error('conflict'), { data: { message: 'server says no' } }); const refresh = vi.fn(async () => true)
    const submit = vi.fn<() => Promise<{ replayed: boolean }>>().mockRejectedValueOnce(failure).mockResolvedValueOnce({ replayed: false })
    await expect(runManagedSiteOperation(state, 'module-120001:stripe_payment', submit, refresh)).resolves.toEqual({ status: 'blocked', error: failure })
    expect(refresh).not.toHaveBeenCalled(); expect(state).toEqual({ completed: {}, refreshFailed: false })
    await expect(runManagedSiteOperation(state, 'module-120001:stripe_payment', submit, refresh)).resolves.toMatchObject({ status: 'success', refreshFailed: false })
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('keeps separate operations independent', async () => {
    const state = createManagedSiteOperationState(); const submit = vi.fn(async () => ({ replayed: false })); const refresh = vi.fn(async () => true)
    await runManagedSiteOperation(state, 'module-120001:stripe_payment', submit, refresh)
    await expect(runManagedSiteOperation(state, 'suspend-90001', submit, refresh)).resolves.toMatchObject({ status: 'success' })
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('wires complete, cancel and suspend on the owner page through the helper with a separate refresh hint', () => {
    const page = readFileSync(new URL('../pages/audit-lab/managed-sites.vue', import.meta.url), 'utf8')
    const section = (start: string, end: string) => page.slice(page.indexOf(start), page.indexOf(end))
    const resolveModule = section('async function resolveModule(', 'function prepareSuspension(')
    const suspendProject = section('async function suspendProject(', 'async function configureProvider(')
    for (const body of [resolveModule, suspendProject]) {
      expect(body).toContain('runManagedSiteOperation(managementOperations,')
      expect(body).toContain('refreshScreen)')
      expect(body).toContain("if (outcome.status === 'blocked')")
      expect(body).not.toContain('try {')
      expect(body).not.toContain('await refresh()')
      expect(body).not.toContain('畫面已重新整理')
      expect(body).toContain("failure.value = caught?.data?.message || '尚未確認操作結果，請重新整理確認。'; return }")
      expect(body).not.toContain('既有狀態未變更')
      expect(body.match(/crypto\.randomUUID\(\)/g)).toBeNull()
    }
    expect(resolveModule).toContain('if (managementOperations.completed[operationKey]) return')
    expect(suspendProject).toContain('if (managementOperations.completed[key]) return')
    expect(page).toContain('async function refreshScreen(): Promise<boolean> { await refresh(); return !error.value && !ordersError.value }')
    expect(page).toContain('async function retryScreenRefresh() { await refreshManagedSiteOperationScreen(managementOperations, refreshScreen) }')
    expect(page).toContain('v-if="managementOperations.refreshFailed"')
    expect(page).toContain('操作已成功並已記錄，但畫面更新失敗')
    expect(page).toContain('@click="retryScreenRefresh">重新整理畫面</button>')
    expect(page).toContain('v-if="error && !managementOperations.refreshFailed"')
    expect(page).toContain("managementOperations.completed[`module-${moduleOperationKey(order.id, fulfilment.moduleKey)}`]")
    expect(page).toContain("managementOperations.completed[`suspend-${row.project.id}`]")
  })
})
