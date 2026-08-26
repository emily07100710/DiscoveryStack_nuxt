import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { revokeMeasurementConnection } from '../../../../measurement-collection'
import { parseMeasurementRouteId, setMeasurementPrivateApiHeaders, toPublicMeasurementError } from '../../../../measurement-collection/api'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  setMeasurementPrivateApiHeaders(event)
  try {
    const owner = await requireOwner(event)
    return await revokeMeasurementConnection(await getOwnerDatabaseUserId(owner.openId), parseMeasurementRouteId(getRouterParam(event, 'id')))
  } catch (error) {
    return toPublicMeasurementError(error, 'Measurement connection could not be revoked.')
  }
})
