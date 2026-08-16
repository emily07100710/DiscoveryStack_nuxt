import { clearOwnerSession } from '../../utils/auth'

export default defineEventHandler((event) => {
  clearOwnerSession(event)
  setHeader(event, 'cache-control', 'no-store')
  return { signedOut: true }
})
