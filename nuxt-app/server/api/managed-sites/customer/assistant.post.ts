import { readBody, setHeader } from 'h3'
import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { roleAllows } from '../../../managed-sites/types'
import { runManagedSiteAssistant } from '../../../managed-sites/modules-service'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  const access = await requireManagedSiteCustomer(event)
  if (!roleAllows(access.membership.role, 'content:read')) throw createError({ statusCode: 403, statusMessage: 'This customer role cannot use the managed-site assistant.' })
  return runManagedSiteAssistant(access.project.ownerUserId, { ...(await readBody(event) || {}), projectId: access.project.id })
})
