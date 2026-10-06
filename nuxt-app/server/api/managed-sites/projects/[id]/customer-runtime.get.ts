import { createError, getRouterParam } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { getManagedSiteRepository } from '../../../../managed-sites/repository'
import { parsePathId } from '../../../../managed-sites/normalization'
import { privateManagedSiteHeaders } from '../../../../managed-sites/live-connectors/http'

export default defineEventHandler(async event => {
  privateManagedSiteHeaders(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const repository = getManagedSiteRepository()
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project || project.ownerUserId !== ownerUserId) throw createError({ statusCode: 404, statusMessage: '找不到專案。' })
  return { versions: (await repository.listVersions(ownerUserId, projectId)).filter(version => version.ownerUserId === ownerUserId && version.projectId === projectId).map(version => ({ id: version.id, version: version.version, status: version.lifecycleStatus })) }
})
