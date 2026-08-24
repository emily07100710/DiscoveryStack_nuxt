import { resolveControlledOwnerDatabaseUserId } from '../audit/repository'
import { runContentOperationsTick } from '../content-operations'

export default defineTask({
  meta: {
    name: 'content-operations:tick',
    description: 'Materialize at most 50 due owner-scoped content operations without provider execution.',
  },
  async run({ payload }) {
    const config = useRuntimeConfig()
    const ownerUserId = await resolveControlledOwnerDatabaseUserId(String(config.ownerOpenId || process.env.OWNER_OPEN_ID || ''))
    const requested = payload && typeof payload === 'object' && 'maxEntries' in payload ? Number((payload as { maxEntries?: unknown }).maxEntries) : 50
    const maxEntries = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 50) : 50
    const result = await runContentOperationsTick({ ownerUserId, maxEntries, leaseOwner: `content-operations-task:${process.pid}` })
    return { result }
  },
})
