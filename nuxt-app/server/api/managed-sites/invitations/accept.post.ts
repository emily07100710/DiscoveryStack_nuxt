import { readBody } from 'h3'
import { acceptManagedSiteInvitation } from '../../../managed-sites/service'
import { setManagedSiteSessionCookie } from '../../../managed-sites/auth'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const token = typeof body?.token === 'string' ? body.token : ''
  const result = await acceptManagedSiteInvitation(token)
  setManagedSiteSessionCookie(event, result.sessionToken)
  return { accepted: true, project: result.project }
})
