import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  config: vi.fn(() => ({ ownerOpenId: 'configured-owner-only' })),
  owner: vi.fn(async () => 7),
  materialize: vi.fn(async (input: { ownerUserId: number; maxEntries: number }) => ({ selected: input.maxEntries, materialized: 0 })),
  execute: vi.fn(async (input: { ownerUserId: number; maxRuns: number; dependencies: unknown }) => ({ processed: input.maxRuns, results: [] })),
  dependencies: vi.fn(() => ({ fetchImpl: 'test-transport', serverCredentialResolver: 'test-resolver', nonceProvider: 'test-nonce' })),
}))
vi.mock('../server/audit/repository', () => ({ resolveControlledOwnerDatabaseUserId: calls.owner }))
vi.mock('../server/content-operations', () => ({ runContentOperationsTick: calls.materialize, runContentOperationsExecutionTick: calls.execute }))
vi.mock('../server/content-operations/runtime-dependencies', () => ({ getContentOperationsRuntimeDependencies: calls.dependencies }))

type Task = typeof import('../server/tasks/content-operations-tick').default
let materializeTask: Task
let executionTask: typeof import('../server/tasks/content-operations-execution-tick').default
beforeAll(async () => {
  vi.stubGlobal('defineTask', (task: unknown) => task)
  vi.stubGlobal('useRuntimeConfig', calls.config)
  materializeTask = (await import('../server/tasks/content-operations-tick')).default
  executionTask = (await import('../server/tasks/content-operations-execution-tick')).default
})
beforeEach(() => { vi.clearAllMocks(); calls.owner.mockResolvedValue(7) })
afterEach(() => { vi.unstubAllEnvs() })

for (const kind of ['materialize', 'execute'] as const) describe(`content scheduled ${kind} server opt-in`, () => {
  const task = () => kind === 'materialize' ? materializeTask : executionTask
  const worker = () => kind === 'materialize' ? calls.materialize : calls.execute
  const bound = kind === 'materialize' ? 'maxEntries' : 'maxRuns'

  it.each([undefined, '', 'false', 'TRUE', '1', 'yes', ' true '])('performs zero config/owner/storage/runtime/provider I/O when flag is %j, even with an enabling payload', async value => {
    vi.stubEnv('NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED', value)
    expect(await task().run({ name: 'test-scheduled-gate', context: {}, payload: { enabled: true, NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED: 'true', ownerUserId: 999, [bound]: 999 } })).toEqual({ result: { status: 'disabled', processed: 0 } })
    for (const call of [calls.config, calls.owner, calls.materialize, calls.execute, calls.dependencies]) expect(call).not.toHaveBeenCalled()
  })

  it.each([{ value: 1, expected: 1 }, { value: 50, expected: 50 }, { value: 999, expected: 50 }, { value: 0, expected: 50 }, { value: -1, expected: 50 }, { value: 'invalid', expected: 50 }])('uses the controlled owner and bounds a true opt-in request to $expected for $value', async ({ value, expected }) => {
    vi.stubEnv('NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED', 'true')
    await task().run({ name: 'test-scheduled-gate', context: {}, payload: { ownerUserId: 999, [bound]: value } })
    expect(calls.config).toHaveBeenCalledTimes(1)
    expect(calls.owner).toHaveBeenCalledExactlyOnceWith('configured-owner-only')
    expect(worker()).toHaveBeenCalledTimes(1)
    expect(worker().mock.calls[0]?.[0]).toMatchObject({ ownerUserId: 7, [bound]: expected })
    expect(kind === 'materialize' ? calls.execute : calls.materialize).not.toHaveBeenCalled()
    expect(calls.dependencies).toHaveBeenCalledTimes(kind === 'execute' ? 1 : 0)
  })

  it('stops before runtime/provider work when controlled owner resolution fails', async () => {
    vi.stubEnv('NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED', 'true')
    calls.owner.mockRejectedValueOnce(new Error('owner unavailable'))
    await expect(task().run({ name: 'test-scheduled-gate', context: {}, payload: { ownerUserId: 999 } })).rejects.toThrow('owner unavailable')
    for (const call of [calls.materialize, calls.execute, calls.dependencies]) expect(call).not.toHaveBeenCalled()
  })
})

describe('content scheduler deployment contract', () => {
  it('keeps the flag server-only and keeps manual owner execution available', () => {
    const config = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
    expect(config).not.toContain('NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED')
    const manual = readFileSync(new URL('../server/content-operations/orchestrator.ts', import.meta.url), 'utf8')
    expect(manual).not.toContain('NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED')
    const service = readFileSync(new URL('../server/content-operations/service.ts', import.meta.url), 'utf8')
    expect(service).toContain("schedulerEnabled: process.env.NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED === 'true'")
  })
})
