import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createMeasurementConnection } from '../../measurement-collection'
import { toPublicMeasurementError, setMeasurementPrivateApiHeaders } from '../../measurement-collection/api'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setMeasurementPrivateApiHeaders(event)
  try {
    const owner = await requireOwner(event)
    return await createMeasurementConnection(await getOwnerDatabaseUserId(owner.openId), await readBody(event))
  } catch (error) {
    return toPublicMeasurementError(error, 'Measurement connection could not be saved.')
  }
})
