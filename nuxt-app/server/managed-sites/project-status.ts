import { createError } from 'h3'
import { getManagedSiteRepository } from './repository'
import type { ManagedSiteRepository } from './types'

export async function assertManagedSiteProjectNotSuspended(ownerUserId: number, projectId: number, repository: ManagedSiteRepository = getManagedSiteRepository()) {
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project || project.status === 'suspended') throw createError({ statusCode: 409, statusMessage: 'Suspended or unavailable managed-site projects cannot perform this operation.' })
  return project
}
