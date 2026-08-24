import type { ZodType } from 'zod'
import type { H3Event } from 'h3'
import { VisibilityContractError } from './contracts'

export async function parseVisibilityBody<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: '請修正 LLM visibility 輸入欄位。', data: parsed.error.flatten().fieldErrors })
  return parsed.data
}
export function rethrowVisibilityError(error: unknown): never {
  if (error instanceof VisibilityContractError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
  throw error
}

export function setPrivateApiHeaders(event: H3Event) {
  setHeader(event, 'cache-control', 'no-store')
  setHeader(event, 'x-robots-tag', 'noindex, nofollow, noarchive')
}
