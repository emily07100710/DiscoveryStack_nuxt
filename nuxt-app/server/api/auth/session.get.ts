import { getOwnerSession } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const session = await getOwnerSession(event)
  return { authenticated: Boolean(session), user: session ? { name: session.name, role: session.role } : null }
})
