import { createError, type H3Event } from 'h3'

export function setMeasurementPrivateApiHeaders(event: H3Event) {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
}

export function parseMeasurementRouteId(value: string | undefined): number {
  if (!value || !/^\d{1,12}$/u.test(value)) throw createError({ statusCode: 422, statusMessage: 'Measurement route identifier is invalid.' })
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 422, statusMessage: 'Measurement route identifier is invalid.' })
  return id
}

export function toPublicMeasurementError(error: unknown, fallback: string): never {
  const candidate = error as { statusCode?: unknown; statusMessage?: unknown; message?: unknown }
  const statusCode = typeof candidate.statusCode === 'number' && [401, 404, 409, 422, 503].includes(candidate.statusCode) ? candidate.statusCode : 503
  const messages: Record<number, string> = { 401: 'Private administration requires an owner session.', 404: 'Measurement resource was not found.', 409: 'Measurement request conflicts with current state.', 422: 'Measurement request is invalid.', 503: fallback }
  throw createError({ statusCode, statusMessage: messages[statusCode] || fallback })
}
