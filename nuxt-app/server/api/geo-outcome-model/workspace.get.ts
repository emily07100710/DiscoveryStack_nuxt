import { getWorkspace } from '../../geo-outcome-model'
import { requireGeoOutcomeOwner, routeError, setGeoOutcomePrivateApiHeaders } from './_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try { const { ownerUserId } = await requireGeoOutcomeOwner(event); return { status: 'success', workspace: await getWorkspace(ownerUserId) } } catch (error) { return routeError(error) }
})
