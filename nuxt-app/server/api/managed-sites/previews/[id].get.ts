import { createError } from 'h3'
import { privateManagedSiteHeaders } from '../../../managed-sites/live-connectors/http'

export default defineEventHandler((event) => {
  privateManagedSiteHeaders(event)
  throw createError({ statusCode: 405, statusMessage: 'Preview access requires a POST body token and is never accepted in a GET query string.' })
})
