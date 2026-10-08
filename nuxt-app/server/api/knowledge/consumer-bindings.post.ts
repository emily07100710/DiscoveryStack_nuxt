import { createError, defineEventHandler, getRequestHeader, getRequestURL } from 'h3'
import { requireKnowledgeOwner, setKnowledgePrivateApiHeaders, readKnowledgeBody, strictKeys } from './_helpers'
import { DrizzleKnowledgeConsumerBindingRepository } from '../../knowledge/consumer-bindings-drizzle'
import { mutateKnowledgeConsumerBinding } from '../../knowledge/consumer-bindings'
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
    const configured = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
    const expected = configured ? new URL(configured) : getRequestURL(event)
    if (configured && (configured !== expected.origin || expected.username || expected.password || !['https:', 'http:'].includes(expected.protocol))) throw createError({ statusCode: 503, statusMessage: 'Knowledge private origin is not configured correctly.' })
    const origin = getRequestHeader(event, 'origin')
    const site = getRequestHeader(event, 'sec-fetch-site')
    if (!origin || origin !== expected.origin || site && site !== 'same-origin') throw createError({ statusCode: 403, statusMessage: 'Knowledge binding requires an exact same-origin request.' })
    const body = await readKnowledgeBody(event)
    strictKeys(body, ['consumerKind', 'consumerId', 'subjectKind', 'subjectId', 'operation', 'expectedRevisionFingerprint', 'expectedBindingFingerprint', 'idempotencyKey'])
    const value = await mutateKnowledgeConsumerBinding(ownerUserId, body, new DrizzleKnowledgeConsumerBindingRepository())
    return { status: 'ok', value }
  } catch (error) {
    if (error instanceof KnowledgeConsumerBindingError || error instanceof KnowledgeRevisionError) {
      const statusCode = error.code === 'INVALID_INPUT' ? 422 : error.code === 'NOT_FOUND' || error.code === 'SUBJECT_NOT_FOUND' ? 404 : 409
      throw createError({ statusCode, statusMessage: 'Knowledge binding request could not be completed.' })
    }
    if (error && typeof error === 'object' && 'statusCode' in error && [400, 403, 413, 422, 503].includes(Number(error.statusCode))) throw createError({ statusCode: Number(error.statusCode), statusMessage: 'Knowledge binding request could not be completed.' })
    throw createError({ statusCode: 503, statusMessage: 'Knowledge binding storage is unavailable.' })
  }
})
