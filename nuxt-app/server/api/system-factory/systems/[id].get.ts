import { getRouterParam } from 'h3'
import { systemFactoryOwnerContext } from '../../../system-factory/http'
import { getSystemWorkspace } from '../../../system-factory/service'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event); const id = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 422, statusMessage: 'System id is invalid.' })
  return getSystemWorkspace(ownerUserId, id)
})
