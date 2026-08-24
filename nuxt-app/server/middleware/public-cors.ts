import { createError, defineEventHandler, getMethod, getRequestHeader, getRequestURL, setResponseHeaders, setResponseStatus } from 'h3'
import { decidePublicCors } from '../utils/publicCors'

export default defineEventHandler((event) => {
  const runtime = useRuntimeConfig(event)
  const path = getRequestURL(event).pathname
  const decision = decidePublicCors({
    path,
    method: getMethod(event),
    origin: getRequestHeader(event, 'origin'),
    accessRequestMethod: getRequestHeader(event, 'access-control-request-method'),
    configuredOrigin: runtime.discoveryStackPublicSiteOrigin || process.env.DISCOVERYSTACK_PUBLIC_SITE_ORIGIN,
    nodeEnv: process.env.NODE_ENV,
  })

  if (Object.keys(decision.headers).length) setResponseHeaders(event, decision.headers)
  if (decision.reason === 'not-target' || decision.reason === 'same-origin') return
  if (!decision.allowed) {
    throw createError({ statusCode: 403, statusMessage: 'Public API origin is not allowed.' })
  }
  if (decision.isPreflight) {
    setResponseStatus(event, 204)
    return ''
  }
})
