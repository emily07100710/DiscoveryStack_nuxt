import { setHeader } from 'h3'
import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { getManagedSiteModuleWorkspace } from '../../../managed-sites/modules-service'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  const access = await requireManagedSiteCustomer(event)
  const workspace = await getManagedSiteModuleWorkspace(access.project.ownerUserId, access.project.id)
  return {
    modules: workspace.modules,
    canonicalContentOperations: { linked: workspace.canonicalContentOperations.linked, clientId: null, reuseOnly: true as const, message: workspace.canonicalContentOperations.message },
    truthfulBoundary: workspace.truthfulBoundary,
  }
})
