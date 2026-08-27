import { getRouterParam } from 'h3'
import { getProductionGeoOutcomeRepository } from '../../../../geo-outcome-model'
import { routeError, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders } from '../../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try { const { ownerUserId } = await requireGeoOutcomeOwner(event); const id = getRouterParam(event, 'id'); if (!id) throw new Error('Training run id is required.'); const run = await getProductionGeoOutcomeRepository().getTrainingRun(ownerUserId, id); if (!run) throw new Error('Training run not found.'); return { status: 'success', trainingRun: run } } catch (error) { return routeError(error) }
})
