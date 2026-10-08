import { createError, defineEventHandler, getQuery } from 'h3'
import { requireKnowledgeOwner, setKnowledgePrivateApiHeaders } from './_helpers'
import { DrizzleKnowledgeConsumerBindingRepository } from '../../knowledge/consumer-bindings-drizzle'
import { parseKnowledgeConsumerCatalogQuery, readKnowledgeConsumerCatalog } from '../../knowledge/consumer-catalog'
import { KnowledgeConsumerBindingError } from '../../knowledge/consumer-binding-types'
import { KnowledgeRevisionError } from '../../knowledge/revision-types'

export default defineEventHandler(async event => {
  setKnowledgePrivateApiHeaders(event)
  let ownerUserId: number
  try { ownerUserId = (await requireKnowledgeOwner(event)).ownerUserId }
  catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error && [401, 403, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 503
    throw createError({ statusCode, statusMessage: 'Knowledge owner authorization could not be verified.' })
  }
  try {
    const query = getQuery(event)
    parseKnowledgeConsumerCatalogQuery(query)
    const catalog = await new DrizzleKnowledgeConsumerBindingRepository().readOnly(tx => readKnowledgeConsumerCatalog(ownerUserId, query, tx))
    return { status: 'ok', catalog }
  } catch (error) {
    if (error instanceof KnowledgeConsumerBindingError || error instanceof KnowledgeRevisionError) throw createError({ statusCode: error.code === 'INVALID_INPUT' ? 422 : 409, statusMessage: 'Knowledge catalog read could not be completed.' })
    throw createError({ statusCode: 503, statusMessage: 'Knowledge catalog storage is unavailable.' })
  }
})
