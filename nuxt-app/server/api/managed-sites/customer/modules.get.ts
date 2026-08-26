import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { getManagedSiteModuleWorkspace } from '../../../managed-sites/modules-service'

export default defineEventHandler(async (event) => {
  const access = await requireManagedSiteCustomer(event)
  const workspace = await getManagedSiteModuleWorkspace(access.project.ownerUserId, access.project.id)
  return {
    modules: workspace.modules,
    canonicalContentOperations: { linked: workspace.canonicalContentOperations.linked, clientId: null, reuseOnly: true as const, message: workspace.canonicalContentOperations.message },
    truthfulBoundary: workspace.truthfulBoundary,
  }
})
