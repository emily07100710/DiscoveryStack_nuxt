import { resolveControlledOwnerDatabaseUserId } from '../audit/repository'
import { runContentOperationsTick } from '../content-operations'

export default defineTask<Awaited<ReturnType<typeof runContentOperationsTick>> | { status: 'disabled'; processed: 0 }>({
  meta: {
    name: 'content-operations:tick',
    description: 'Materialize at most 50 due owner-scoped content operations without provider execution.',
  },
  async run({ payload }) {
    // Server-only opt-in, before owner resolution, storage or runtime construction.
    // A task payload cannot authorize background database/provider writes.
    if (process.env.NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED !== 'true') return { result: { status: 'disabled' as const, processed: 0 as const } }
    const config = useRuntimeConfig()
    const ownerUserId = await resolveControlledOwnerDatabaseUserId(String(config.ownerOpenId || process.env.OWNER_OPEN_ID || ''))
    const requested = payload && typeof payload === 'object' && 'maxEntries' in payload ? Number((payload as { maxEntries?: unknown }).maxEntries) : 50
    const maxEntries = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 50) : 50
    const result = await runContentOperationsTick({ ownerUserId, maxEntries })
    return { result }
  },
})
