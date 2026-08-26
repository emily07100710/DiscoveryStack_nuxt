import { createError } from 'h3'

export default defineEventHandler(() => {
  throw createError({ statusCode: 405, statusMessage: 'Preview access requires a POST body token and is never accepted in a GET query string.' })
})
