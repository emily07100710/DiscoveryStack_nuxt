import { getOwnerDatabaseUserId } from '../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../llm-visibility/api'
import { benchmarkCreateInputSchema } from '../../llm-visibility/benchmark-contracts'
import { createBenchmark, startBenchmarkInBackground } from '../../llm-visibility/benchmark-runtime'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const input = await parseVisibilityBody(event, benchmarkCreateInputSchema)
  try {
    const created = await createBenchmark(ownerUserId, input)
    void startBenchmarkInBackground(ownerUserId, created.benchmarkId)
    return created
  } catch (error) { rethrowVisibilityError(error) }
})
