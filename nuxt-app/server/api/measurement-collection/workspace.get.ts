import { getOwnerDatabaseUserId } from '../../audit/repository'
import { getMeasurementCollectionWorkspace } from '../../measurement-collection'
import { toPublicMeasurementError, setMeasurementPrivateApiHeaders } from '../../measurement-collection/api'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setMeasurementPrivateApiHeaders(event)
  try {
    const owner = await requireOwner(event)
    return await getMeasurementCollectionWorkspace(await getOwnerDatabaseUserId(owner.openId))
  } catch (error) {
    return toPublicMeasurementError(error, 'Measurement workspace is temporarily unavailable.')
  }
})
