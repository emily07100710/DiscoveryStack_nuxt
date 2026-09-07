import { setHeader } from 'h3'
import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { getManagedSiteCustomerProjection } from '../../../managed-sites/service'
import { getManagedSiteLiveConnectorRepository } from '../../../managed-sites/live-connectors/repository'
import { getPreviewRepository } from '../../../managed-sites/ordering-repository'
import { projectManagedSiteLaunchStatus } from '../../../managed-sites/funnel/launch-status'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  const access = await requireManagedSiteCustomer(event)
  const projection = await getManagedSiteCustomerProjection(access.token)
  const repository = getManagedSiteLiveConnectorRepository()
  const releases = await repository.listReleases(access.session.ownerUserId, access.project.id)
  const release = releases.filter(row => row.ownerUserId === access.session.ownerUserId && row.projectId === access.project.id).sort((left, right) => right.id - left.id)[0]
  const launch = release ? await projectManagedSiteLaunchStatus(access.session.ownerUserId, release, repository, getPreviewRepository()) : null
  return { ...projection, launch }
})
