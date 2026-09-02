import { createError } from 'h3'
import { describe, expect, it } from 'vitest'
import { routeError } from '../server/intervention-loop/http'
import { INTERVENTION_PUBLIC_STATUS_CODES, toPublicInterventionLoopError } from '../server/intervention-loop/normalization'

type PublicError = { statusCode: number, statusMessage: string, data: { code: string } }
function mapped(error: unknown): PublicError { return toPublicInterventionLoopError(error) as unknown as PublicError }

describe('intervention loop public error mapping', () => {
  it('keeps the guard status codes so an expired owner session shows as 401, not a generic failure', () => {
    expect([...INTERVENTION_PUBLIC_STATUS_CODES]).toEqual([400, 401, 403, 404, 409, 413, 422, 503])
    const cases: Array<[number, string]> = [
      [401, 'Private administration requires an owner session.'],
      [403, 'Intervention mutation requires an exact same-origin request.'],
      [400, 'Request body must be a plain object.'],
      [413, 'Request body exceeds the 64 KB intervention limit.'],
      [404, 'Intervention was not found.'],
      [422, 'id must be a positive integer.'],
      [503, 'Private intervention origin is not configured correctly.'],
    ]
    for (const [statusCode, statusMessage] of cases) {
      const result = mapped(createError({ statusCode, statusMessage }))
      expect(result.statusCode, statusMessage).toBe(statusCode)
      expect(result.statusMessage).toBe(statusMessage)
      expect(result.data.code).toBe('INTERVENTION_LOOP_ERROR')
    }
  })

  it('preserves the machine-readable code of state-machine rejections', () => {
    const result = mapped(createError({ statusCode: 409, statusMessage: 'Recrawl must be confirmed before measuring.', data: { code: 'RECRAWL_NOT_CONFIRMED' } }))
    expect(result).toMatchObject({ statusCode: 409, statusMessage: 'Recrawl must be confirmed before measuring.', data: { code: 'RECRAWL_NOT_CONFIRMED' } })
  })

  it('collapses every other failure to 503 with a generic message and no internal detail', () => {
    for (const error of [new Error('mysql connection refused at host secret-db'), createError({ statusCode: 500, statusMessage: 'db exploded', data: { code: 'DB_DOWN' } }), createError({ statusCode: 418, statusMessage: 'teapot' }), createError({ statusCode: 429, statusMessage: 'slow down' }), 'string failure', undefined]) {
      const result = mapped(error)
      expect(result.statusCode).toBe(503)
      expect(result.statusMessage).toBe('Intervention loop request could not be completed.')
      expect(result.data.code).toBe('INTERVENTION_LOOP_UNAVAILABLE')
      expect(JSON.stringify(result)).not.toMatch(/secret-db|exploded|DB_DOWN|teapot/u)
    }
  })

  it('routeError rethrows the mapped error with the original status', () => {
    expect(() => routeError(createError({ statusCode: 401, statusMessage: 'Private administration requires an owner session.' }))).toThrowError(expect.objectContaining({ statusCode: 401, statusMessage: 'Private administration requires an owner session.' }))
    expect(() => routeError(new Error('internal'))).toThrowError(expect.objectContaining({ statusCode: 503 }))
  })
})
