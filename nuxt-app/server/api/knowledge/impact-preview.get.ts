import { createError, defineEventHandler, getQuery } from 'h3'
import { KnowledgeImpactError } from '../../knowledge/impact-types'
import { createKnowledgeImpactPreview, parseKnowledgeImpactSubject } from '../../knowledge/impact-preview'
import { requireKnowledgeOwner, setKnowledgePrivateApiHeaders } from './_helpers'

function safeStatus(error: unknown): never {
  if (error instanceof KnowledgeImpactError) {
    const statusCode = error.code === 'INVALID_INPUT' ? 422 : error.code === 'SUBJECT_NOT_FOUND' ? 404 : 409
    throw createError({ statusCode, statusMessage: error.message })
  }
  throw createError({ statusCode: 503, statusMessage: 'Knowledge impact preview is unavailable.' })
}

export default defineEventHandler(async event => {
  setKnowledgePrivateApiHeaders(event)
  let ownerUserId: number
  try {
    // Resolve server-owned authority before inspecting any caller-controlled query values.
    const owner = await requireKnowledgeOwner(event)
    ownerUserId = owner.ownerUserId
  } catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && [401, 403, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 503
    throw createError({ statusCode, statusMessage: 'Knowledge owner authorization could not be verified.' })
  }
  try {
    const query = getQuery(event)
    if (Object.keys(query).some(key => key !== 'kind' && key !== 'id')) throw new KnowledgeImpactError('INVALID_INPUT', 'Impact preview accepts only kind and id.')
    const subject = parseKnowledgeImpactSubject({ kind: query.kind, id: query.id })
    const value = await createKnowledgeImpactPreview(ownerUserId, subject)
    return { status: 'ok', value }
  } catch (error) {
    return safeStatus(error)
  }
})
