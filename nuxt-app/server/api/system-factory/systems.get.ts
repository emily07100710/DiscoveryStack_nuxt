import { getQuery } from 'h3'
import { boundedKeysetPage, systemFactoryOwnerContext } from '../../system-factory/http'
import { listSystemWorkspaces } from '../../system-factory/service'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event); const page = boundedKeysetPage(getQuery(event)); const result = await listSystemWorkspaces(ownerUserId, page.limit, page.cursor)
  return { systems: result.items, pagination: { limit: page.limit, nextCursor: result.nextCursor } }
})
