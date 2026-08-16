import { requireOwner } from '../../utils/auth'

/** A minimal live guard check. Audit Lab and private settings must call the same owner-session boundary. */
export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const owner = await requireOwner(event)
  return { authorized: true, owner: { name: owner.name, role: owner.role } }
})
