import { createError, defineEventHandler, getQuery } from 'h3'
import { requireKnowledgeOwner, setKnowledgePrivateApiHeaders } from './_helpers'
import { DrizzleKnowledgeConsumerBindingRepository } from '../../knowledge/consumer-bindings-drizzle'
import { readKnowledgeConsumerBindingWorkspace } from '../../knowledge/consumer-bindings'
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
    if (Object.keys(getQuery(event)).length) throw new KnowledgeConsumerBindingError('INVALID_INPUT')
    const workspace = await new DrizzleKnowledgeConsumerBindingRepository().readOnly(tx => readKnowledgeConsumerBindingWorkspace(ownerUserId, tx))
    // The internal impact adapter includes owner IDs and dependency graphs. The operator
    // needs only coverage metadata and safe current-head summaries, not that raw graph.
    const coverage = workspace.coverage.map(({ category, state, scope, limitationCodes, consumers }) => ({ category, state, scope, limitationCodes, registeredConsumerCount: consumers.length }))
    return { status: 'ok', coverage, bindings: workspace.bindings, exhaustive: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false }
  } catch (error) {
    if (error instanceof KnowledgeConsumerBindingError || error instanceof KnowledgeRevisionError) throw createError({ statusCode: error.code === 'INVALID_INPUT' ? 422 : 409, statusMessage: 'Knowledge binding read could not be completed.' })
    throw createError({ statusCode: 503, statusMessage: 'Knowledge binding storage is unavailable.' })
  }
})
