import { getQuery } from 'h3'
import { boundedPage, systemFactoryOwnerContext } from '../../system-factory/http'
import { listSystemWorkspaces } from '../../system-factory/service'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event); const page = boundedPage(getQuery(event))
  return { systems: await listSystemWorkspaces(ownerUserId, page.limit, page.offset), pagination: page }
})
