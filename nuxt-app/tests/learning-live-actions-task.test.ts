import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const seams = vi.hoisted(() => ({
  ownerId: vi.fn(),
  acquisition: vi.fn(),
  publicationRecovery: vi.fn(),
  repository: vi.fn(),
  expireCollections: vi.fn(),
  modelRetention: vi.fn(),
  training: vi.fn(),
  actionRetention: vi.fn(),
  actionRecovery: vi.fn(),
  runtimeConfig: vi.fn(),
}))

vi.mock('../server/audit/repository', () => ({ resolveControlledOwnerDatabaseUserId: seams.ownerId }))
vi.mock('../server/learning-loop/runtime', () => ({ runLearningAcquisitionTick: seams.acquisition }))
vi.mock('../server/learning-loop/publication-bridge', () => ({ reconcileLearningPublications: seams.publicationRecovery }))
vi.mock('../server/content-operations/repository', () => ({ createContentOperationsRepository: seams.repository }))
vi.mock('../server/learning-loop/service', () => ({ expireLearningEvidenceCollections: seams.expireCollections }))
vi.mock('../server/learning-loop/effect-service', () => ({ cleanInvalidContentEffectModels: seams.modelRetention, runContentEffectTrainingTick: seams.training }))
vi.mock('../server/learning-loop/live-action-service', () => ({ cleanInvalidLivePublicationActions: seams.actionRetention, runLivePublicationActionRecovery: seams.actionRecovery }))

let task: { meta: { name: string }, run: (...args: unknown[]) => Promise<{ result: Record<string, unknown> }> }

beforeAll(async () => {
  vi.stubGlobal('defineTask', (definition: unknown) => definition)
  vi.stubGlobal('useRuntimeConfig', seams.runtimeConfig)
  task = (await import('../server/tasks/learning-loop-tick')).default as typeof task
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NUXT_LEARNING_LOOP_ENABLED', 'false')
  vi.stubEnv('NUXT_LEARNING_RETENTION_ENABLED', 'false')
  vi.stubEnv('NUXT_LEARNING_LIVE_ACTION_ENABLED', 'false')
  vi.stubEnv('OWNER_OPEN_ID', '')
  seams.runtimeConfig.mockReturnValue({ ownerOpenId: 'synthetic-task-owner' })
  seams.ownerId.mockResolvedValue(91)
  seams.expireCollections.mockResolvedValue({ status: 'clean' })
  seams.modelRetention.mockResolvedValue({ status: 'clean' })
  seams.actionRetention.mockResolvedValue({ status: 'clean' })
  seams.publicationRecovery.mockResolvedValue({ status: 'reconciled' })
  seams.actionRecovery.mockResolvedValue({ status: 'disabled' })
  seams.repository.mockReturnValue({ syntheticOnly: true })
  seams.acquisition.mockResolvedValue({ status: 'disabled' })
  seams.training.mockResolvedValue({ status: 'disabled' })
})

afterEach(() => { vi.unstubAllEnvs() })
afterAll(() => { vi.unstubAllGlobals() })

describe('learning live-action scheduled task boundary', () => {
  it('returns disabled before owner resolution or any service when loop and retention are off', async () => {
    const result = await task.run()
    expect(task.meta.name).toBe('learning-loop:tick')
    expect(result).toEqual({ result: { status: 'disabled' } })
    expect(seams.runtimeConfig).not.toHaveBeenCalled()
    expect(seams.ownerId).not.toHaveBeenCalled()
    expect(seams.expireCollections).not.toHaveBeenCalled()
    expect(seams.modelRetention).not.toHaveBeenCalled()
    expect(seams.actionRetention).not.toHaveBeenCalled()
    expect(seams.publicationRecovery).not.toHaveBeenCalled()
    expect(seams.actionRecovery).not.toHaveBeenCalled()
    expect(seams.acquisition).not.toHaveBeenCalled()
    expect(seams.training).not.toHaveBeenCalled()
  })

  it('allows retention-only cleanup but never performs recovery, acquisition, or training', async () => {
    vi.stubEnv('NUXT_LEARNING_RETENTION_ENABLED', 'true')
    const result = await task.run()
    expect(result.result).toMatchObject({ status: 'retention_only', actionRetention: { status: 'clean' } })
    expect(seams.ownerId).toHaveBeenCalledExactlyOnceWith('synthetic-task-owner')
    expect(seams.expireCollections).toHaveBeenCalledExactlyOnceWith(91)
    expect(seams.modelRetention).toHaveBeenCalledExactlyOnceWith(91)
    expect(seams.actionRetention).toHaveBeenCalledExactlyOnceWith(91)
    expect(seams.publicationRecovery).not.toHaveBeenCalled()
    expect(seams.repository).not.toHaveBeenCalled()
    expect(seams.actionRecovery).not.toHaveBeenCalled()
    expect(seams.acquisition).not.toHaveBeenCalled()
    expect(seams.training).not.toHaveBeenCalled()
    expect(result.result).not.toHaveProperty('productionModelActivation')
  })

  it('keeps loop execution independent from retention and does not run action cleanup when retention is off', async () => {
    vi.stubEnv('NUXT_LEARNING_LOOP_ENABLED', 'true')
    const result = await task.run()
    expect(seams.actionRetention).not.toHaveBeenCalled()
    expect(result.result).toMatchObject({ actionRetention: { status: 'disabled' }, actionRecovery: { status: 'disabled' }, productionModelActivation: false })
    expect(seams.actionRecovery).toHaveBeenCalledExactlyOnceWith(91)
    expect(seams.acquisition).toHaveBeenCalledExactlyOnceWith(91)
    expect(seams.training).toHaveBeenCalledExactlyOnceWith(91)
    expect(result.result).not.toHaveProperty('payload')
    expect(result.result).not.toHaveProperty('enabled')
  })

  it('treats publication recovery, live-action recovery, acquisition, and training as separate bounded steps', async () => {
    vi.stubEnv('NUXT_LEARNING_LOOP_ENABLED', 'true')
    seams.publicationRecovery.mockRejectedValueOnce(new Error('synthetic publication recovery failure'))
    seams.actionRecovery.mockRejectedValueOnce(new Error('synthetic live action recovery failure'))
    const result = await task.run()
    expect(seams.repository).toHaveBeenCalledExactlyOnceWith()
    expect(seams.publicationRecovery).toHaveBeenCalledExactlyOnceWith(91, { syntheticOnly: true })
    expect(seams.actionRecovery).toHaveBeenCalledExactlyOnceWith(91)
    expect(seams.acquisition).toHaveBeenCalledExactlyOnceWith(91)
    expect(seams.training).toHaveBeenCalledExactlyOnceWith(91)
    expect(result.result).toMatchObject({
      recovery: { status: 'deferred', reasonCode: 'PUBLICATION_RECOVERY_DEFERRED' },
      actionRecovery: { status: 'deferred', reasonCode: 'LIVE_ACTION_RECOVERY_DEFERRED' },
      acquisition: { status: 'disabled' },
      training: { status: 'disabled' },
      productionModelActivation: false,
    })
  })

  it('does not let invocation payload flags enable acquisition or replace configured owner scope', async () => {
    vi.stubEnv('NUXT_LEARNING_LOOP_ENABLED', 'true')
    const suppliedFlags = { ownerUserId: 999, enabled: true, liveActionEnabled: true, productionModelActivation: true }
    const result = await task.run(suppliedFlags)
    expect(seams.runtimeConfig).toHaveBeenCalledExactlyOnceWith()
    expect(seams.ownerId).toHaveBeenCalledExactlyOnceWith('synthetic-task-owner')
    expect(seams.acquisition).toHaveBeenCalledExactlyOnceWith(91)
    expect(process.env.NUXT_LEARNING_LIVE_ACTION_ENABLED).toBe('false')
    expect(result.result).toMatchObject({ actionRecovery: { status: 'disabled' }, productionModelActivation: false })
    expect(result.result).not.toHaveProperty('enabled')
    expect(result.result).not.toHaveProperty('ownerUserId')
  })
})
