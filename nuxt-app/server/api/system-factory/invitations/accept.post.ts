import { assertSameOriginMutation, privateSystemFactoryHeaders, strictSystemFactoryBody } from '../../../system-factory/http'
import { validateInvitationAcceptance } from '../../../system-factory/service'

export default defineEventHandler(async event => {
  privateSystemFactoryHeaders(event)
  assertSameOriginMutation(event)
  const body = await strictSystemFactoryBody(event, ['token', 'password'])
  await validateInvitationAcceptance(body as any)
  throw createError({ statusCode: 503, statusMessage: 'Tenant invitation activation requires the configured server-only Frappe activator.' })
})
