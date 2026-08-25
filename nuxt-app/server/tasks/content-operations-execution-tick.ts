import { resolveControlledOwnerDatabaseUserId } from '../audit/repository'
import { runContentOperationsExecutionTick } from '../content-operations'
import { getContentOperationsRuntimeDependencies } from '../content-operations/runtime-dependencies'

export default defineTask({
  meta: {
    name: 'content-operations:execution-tick',
    description: 'Process at most 50 owner-scoped content operation generation, review synchronization, and publication leases.',
  },
  async run({ payload }) {
    const config = useRuntimeConfig()
    const ownerUserId = await resolveControlledOwnerDatabaseUserId(String(config.ownerOpenId || process.env.OWNER_OPEN_ID || ''))
    const requested = payload && typeof payload === 'object' && 'maxRuns' in payload ? Number((payload as { maxRuns?: unknown }).maxRuns) : 50
    const maxRuns = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 50) : 50
    const result = await runContentOperationsExecutionTick({ ownerUserId, maxRuns, dependencies: getContentOperationsRuntimeDependencies() })
    return { result, ownerUserId, limitations: ['task invocation is explicit; Nitro import/build does not execute the tick'] }
  },
})
