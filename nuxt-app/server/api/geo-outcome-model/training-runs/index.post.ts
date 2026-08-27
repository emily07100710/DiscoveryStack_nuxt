import { createTrainingRun } from '../../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'datasetManifestId', 'modelFamily', 'config'])
    const idempotencyKey = requiredIdempotency(body)
    if (typeof body.datasetManifestId !== 'string' || typeof body.modelFamily !== 'string') throw new Error('datasetManifestId and modelFamily are required.')
    if (body.config !== undefined && (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))) throw new Error('config must be an object.')
    const run = await withMutationIdempotency(ownerUserId, 'training-runs.create', idempotencyKey, { datasetManifestId: body.datasetManifestId, modelFamily: body.modelFamily, config: body.config === undefined ? null : body.config }, transaction => createTrainingRun(ownerUserId, { datasetManifestId: body.datasetManifestId as string, modelFamily: body.modelFamily, config: body.config as Record<string, unknown> | undefined }, transaction))
    return { status: 'success', trainingRun: run }
  } catch (error) { return routeError(error) }
})
