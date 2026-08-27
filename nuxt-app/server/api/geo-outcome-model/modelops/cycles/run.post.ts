import { createModelOpsCycle, executeModelOpsCycle } from '../../../../geo-outcome-model/modelops-service'
import { getProductionModelOpsDependencies } from '../../../../geo-outcome-model/modelops-runtime'
import { requireGeoOutcomeOwner, requiredIdempotency, routeError, readGeoBody, setGeoOutcomePrivateApiHeaders, strictKeys, withMutationIdempotency } from '../../_helpers'
import { projectCycleResult } from '../_response'

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'cycleId'])
    const idempotencyKey = requiredIdempotency(body)
    const cycleId = typeof body.cycleId === 'string' ? body.cycleId : null
    const { outcomeRepository, modelOpsRepository } = getProductionModelOpsDependencies()
    const result = await withMutationIdempotency(ownerUserId, 'geo-outcome-model/modelops/cycles/run', idempotencyKey, body, async () => {
      const cycle = cycleId ? await modelOpsRepository.getCycle(ownerUserId, cycleId) : await createModelOpsCycle(ownerUserId, 'owner_manual', idempotencyKey, outcomeRepository, modelOpsRepository)
      if (!cycle) throw new Error('Cycle not found.')
      return executeModelOpsCycle(ownerUserId, cycle.cycleId, outcomeRepository, modelOpsRepository, `owner-${ownerUserId}`)
    })
    return { status: 'success', ...projectCycleResult(result) }
  } catch (error) {
    return routeError(error)
  }
})
