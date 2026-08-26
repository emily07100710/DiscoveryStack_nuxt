import { readBody } from 'h3'
import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { roleAllows } from '../../../managed-sites/types'
import { runManagedSiteAssistant } from '../../../managed-sites/modules-service'

export default defineEventHandler(async (event) => {
  const access = await requireManagedSiteCustomer(event)
  if (!roleAllows(access.membership.role, 'content:read')) throw createError({ statusCode: 403, statusMessage: 'This customer role cannot use the managed-site assistant.' })
  return runManagedSiteAssistant(access.project.ownerUserId, { ...(await readBody(event) || {}), projectId: access.project.id })
})
