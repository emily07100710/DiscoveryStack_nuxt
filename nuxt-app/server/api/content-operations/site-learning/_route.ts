import { createError, getRequestHeader, getRequestURL, setResponseHeaders, type H3Event } from 'h3'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { createBoundedFetch } from '../../../content-operations/bounded-fetch'
import { createContentOperationsRepository, type ContentOperationsRepository } from '../../../content-operations/repository'
import { resolveConfirmedSiteMeasurementLineages } from '../../../content-operations/site-measurement'
import { getContentOperationsRuntimeDependencies } from '../../../content-operations/runtime-dependencies'
import type { SiteLearningOptions } from '../../../content-operations/site-learning'
import { DrizzleLearningLoopRepository } from '../../../learning-loop/repository'
import { createWeeklyContentRepository } from '../../../weekly-content/repository'
import { readBoundedRequestBody } from '../../../utils/bounded-request-body'
import { requireOwner } from '../../../utils/auth'

export function setSiteLearningPrivateHeaders(event: H3Event) {
  setResponseHeaders(event, {
    'cache-control': 'private, no-store, max-age=0',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
}

export async function requireSiteLearningOwner(event: H3Event) {
  // Authentication is intentionally first: do not parse a body or construct repositories for anonymous requests.
  return requireOwner(event)
}

export async function siteLearningOwnerUserId(owner: Awaited<ReturnType<typeof requireOwner>>) {
  return getOwnerDatabaseUserId(owner.openId)
}

export function assertSiteLearningSameOrigin(event: H3Event) {
  const configuredOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  let expected: URL
  try {
    expected = configuredOrigin ? new URL(configuredOrigin) : getRequestURL(event)
    if (configuredOrigin && (configuredOrigin !== expected.origin || expected.username || expected.password || !['https:', 'http:'].includes(expected.protocol))) throw new Error('invalid configured origin')
  } catch {
    throw createError({ statusCode: 503 })
  }
  const origin = getRequestHeader(event, 'origin')
  const site = getRequestHeader(event, 'sec-fetch-site')
  if (!origin || origin !== expected.origin || (site && site !== 'same-origin')) throw createError({ statusCode: 403 })
}

export async function readSiteLearningBody(event: H3Event, maxBytes = 2048): Promise<unknown> {
  return readBoundedRequestBody(event, {
    maxBytes,
    oversizedMessage: '成效資料治理請求過大。',
    invalidMessage: '成效資料治理請求格式不正確。',
    invalidStatusCode: 422,
  })
}

export function exactSiteLearningRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid prototype')
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) throw new Error('unexpected fields')
    const result: Record<string, unknown> = Object.create(null)
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('invalid field')
      result[key] = descriptor.value
    }
    return result
  } catch {
    throw createError({ statusCode: 422 })
  }
}

export function positiveSiteLearningId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

export async function siteLearningOptions(): Promise<SiteLearningOptions> {
  const operations = createContentOperationsRepository()
  const learning = new DrizzleLearningLoopRepository()
  return {
    operations,
    learning,
    now: new Date(),
    resolveSiteLineages(ownerUserId, entryId, context) {
      const repository: ContentOperationsRepository = context.repository || operations
      const now = new Date()
      return resolveConfirmedSiteMeasurementLineages(ownerUserId, entryId, {
        repository,
        fresh: context.fresh,
        weeklyRepositoryFactory: createWeeklyContentRepository,
        ...(context.fresh ? { dependencies: { ...getContentOperationsRuntimeDependencies(), fetchImpl: createBoundedFetch({ maxResponseBodyBytes: 4096 }), now } } : {}),
        now,
      })
    },
  }
}

export function siteLearningPublicError(error: unknown, message: string): never {
  const statusCode = error && typeof error === 'object' && 'statusCode' in error
    && [403, 404, 409, 413, 422, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 503
  throw createError({ statusCode, statusMessage: message })
}
