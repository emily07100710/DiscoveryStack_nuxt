import { createError } from 'h3'
import { getDatabase } from '../../../database'
import { admitGeoObservation, GeoAdmissionError } from '../../../geo-outcome-model/admission'
import { readGeoBody, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders } from '../_helpers'

function fail(error: unknown): never {
  if (error instanceof GeoAdmissionError) throw createError({ statusCode: error.statusCode, statusMessage: error.statusMessage })
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = Number(error.statusCode)
    const safeMessages: Record<number, string> = {
      400: 'Request body must be an object.',
      401: 'Owner authentication is required.',
      403: 'Same-origin owner mutation is required.',
      413: 'Request body exceeds the bounded GEO outcome limit.',
      503: 'GEO admission could not be completed.',
    }
    if (safeMessages[statusCode]) throw createError({ statusCode, statusMessage: safeMessages[statusCode] })
  }
  throw createError({ statusCode: 503, statusMessage: 'GEO admission could not be completed.' })
}

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event, 64 * 1024)
    const database = getDatabase()
    if (!database) throw createError({ statusCode: 503, statusMessage: 'GEO outcome model storage is not configured.' })
    return await admitGeoObservation(ownerUserId, body, database)
  } catch (error) { return fail(error) }
})
