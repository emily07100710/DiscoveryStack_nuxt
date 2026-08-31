import { resolveControlledOwnerDatabaseUserId } from '../../audit/repository'
import { runMeasurementCollectionTick } from '../../measurement-collection'

export default defineTask({
  meta: {
    name: 'content-operations:measurement-tick',
    description: 'Claim and process at most 50 owner-scoped publication measurement runs with bounded leases and retries.',
  },
  async run({ payload }) {
    const config = useRuntimeConfig()
    const ownerUserId = await resolveControlledOwnerDatabaseUserId(String(config.ownerOpenId || process.env.OWNER_OPEN_ID || ''))
    const requested = payload && typeof payload === 'object' && 'maxRuns' in payload ? Number((payload as { maxRuns?: unknown }).maxRuns) : 50
    const maxRuns = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 50) : 50
    const result = await runMeasurementCollectionTick(ownerUserId, { maxRuns })
    return { result, ownerUserId, limitations: ['task invocation is explicit; Nitro import/build does not execute the tick'] }
  },
})
