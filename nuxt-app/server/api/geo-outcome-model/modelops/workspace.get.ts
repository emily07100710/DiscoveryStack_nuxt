import { getModelOpsWorkspace } from '../../../geo-outcome-model/modelops-service'
import { getProductionModelOpsDependencies } from '../../../geo-outcome-model/modelops-runtime'
import { requireGeoOutcomeOwner, routeError, setGeoOutcomePrivateApiHeaders } from '../_helpers'
import { projectWorkspace } from './_response'

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const { outcomeRepository, modelOpsRepository } = getProductionModelOpsDependencies()
    const workspace = await getModelOpsWorkspace(ownerUserId, outcomeRepository, modelOpsRepository)
    return { status: 'success', workspace: projectWorkspace(workspace) }
  } catch (error) {
    return routeError(error)
  }
})
