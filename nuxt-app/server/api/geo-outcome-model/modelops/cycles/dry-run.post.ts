import { dryRunModelOpsCycle } from '../../../../geo-outcome-model/modelops-service'
import { getProductionModelOpsDependencies } from '../../../../geo-outcome-model/modelops-runtime'
import { requireGeoOutcomeOwner, routeError, readGeoBody, setGeoOutcomePrivateApiHeaders, strictKeys } from '../../_helpers'

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event)
    strictKeys(body, ['trigger'])
    if (body.trigger !== undefined && body.trigger !== 'dry_run') throw new Error('Dry-run trigger must be dry_run.')
    const { outcomeRepository, modelOpsRepository } = getProductionModelOpsDependencies()
    const plan = await dryRunModelOpsCycle(ownerUserId, 'dry_run', outcomeRepository, modelOpsRepository)
    return { status: 'success', dryRun: true, writesPerformed: false, plan }
  } catch (error) {
    return routeError(error)
  }
})
