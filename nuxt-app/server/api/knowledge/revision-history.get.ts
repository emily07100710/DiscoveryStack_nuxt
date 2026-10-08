import { createError, defineEventHandler, getQuery } from 'h3'
import { DrizzleKnowledgeRepository } from '../../knowledge/repository-drizzle'
import { getKnowledgeRevisionHistory } from '../../knowledge/revision-history'
import { KnowledgeRevisionError } from '../../knowledge/revision-types'
import { requireKnowledgeOwner, setKnowledgePrivateApiHeaders } from './_helpers'

function safeStatus(error: unknown): never {
  if (error instanceof KnowledgeRevisionError) {
    const statusCode = error.code === 'INVALID_INPUT' ? 422
      : error.code === 'SUBJECT_NOT_FOUND' ? 404
        : error.code === 'CORRUPT_STATE' || error.code === 'REVISION_CONFLICT' || error.code === 'LIMIT_EXCEEDED' ? 409 : 503
    const statusMessage = statusCode === 422 ? 'Knowledge history query is invalid.'
      : statusCode === 404 ? 'Knowledge history subject was not found.'
        : 'Knowledge history cannot be read consistently.'
    throw createError({ statusCode, statusMessage })
  }
  throw createError({ statusCode: 503, statusMessage: 'Knowledge history is unavailable.' })
}

export default defineEventHandler(async event => {
  setKnowledgePrivateApiHeaders(event)
  let ownerUserId: number
  try {
    const owner = await requireKnowledgeOwner(event)
    ownerUserId = owner.ownerUserId
  } catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && [401, 403, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 503
    throw createError({ statusCode, statusMessage: 'Knowledge owner authorization could not be verified.' })
  }

  try {
    const query = getQuery(event)
    if (Object.keys(query).some(key => key !== 'kind' && key !== 'id' && key !== 'cursor')) {
      throw new KnowledgeRevisionError('INVALID_INPUT')
    }
    const input = { kind: query.kind, id: query.id, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) }
    const history = await getKnowledgeRevisionHistory(ownerUserId, input, new DrizzleKnowledgeRepository())
    return { status: 'success', history }
  } catch (error) {
    return safeStatus(error)
  }
})
