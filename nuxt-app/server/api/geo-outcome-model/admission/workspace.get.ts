import { createError, getQuery } from 'h3'
import { getDatabase } from '../../../database'
import { getGeoObservationAdmissionWorkspace, GeoAdmissionError } from '../../../geo-outcome-model/admission'
import { requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders } from '../_helpers'

function fail(error: unknown): never {
  if (error instanceof GeoAdmissionError) throw createError({ statusCode: error.statusCode, statusMessage: error.statusMessage })
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = Number(error.statusCode)
    const safeMessages: Record<number, string> = { 401: 'Owner authentication is required.', 403: 'Owner access is required.', 503: 'GEO admission workspace is unavailable.' }
    if (safeMessages[statusCode]) throw createError({ statusCode, statusMessage: safeMessages[statusCode] })
  }
  throw createError({ statusCode: 503, statusMessage: 'GEO admission workspace is unavailable.' })
}

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const database = getDatabase()
    if (!database) throw createError({ statusCode: 503, statusMessage: 'GEO outcome model storage is not configured.' })
    const workspace = await getGeoObservationAdmissionWorkspace(ownerUserId, getQuery(event), database)
    return { status: 'success', workspace }
  } catch (error) { return fail(error) }
})
