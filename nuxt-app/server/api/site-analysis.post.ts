import { z } from 'zod'
import { analysePublicHomepage } from '../utils/publicSiteAnalysis'
import { requestFingerprint } from '../utils/lead'

const inputSchema = z.object({ url: z.string().trim().url().max(2048) })
const buckets = new Map<string, { count: number, startedAt: number }>()
const WINDOW_MS = 60 * 60 * 1_000
const LIMIT = 8

function enforceRateLimit(key: string) {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    buckets.set(key, { count: 1, startedAt: now })
    return
  }
  if (bucket.count >= LIMIT) throw createError({ statusCode: 429, statusMessage: 'Too many website checks. Please try again later.' })
  bucket.count += 1
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Enter a valid public website URL.' })
  enforceRateLimit(requestFingerprint(event))
  try {
    return await analysePublicHomepage(parsed.data.url)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'analysis_failed'
    const normalizedCode = code.toLowerCase()
    if (
      code === 'private_network_target'
      || normalizedCode.includes('private')
      || normalizedCode.includes('local network')
      || normalizedCode.includes('link-local')
      || normalizedCode.includes('public website')
      || normalizedCode.includes('public http')
    ) {
      throw createError({ statusCode: 422, statusMessage: 'Only public websites can be checked.' })
    }
    if (code === 'unsupported_content_type') throw createError({ statusCode: 422, statusMessage: 'That address did not return an HTML webpage.' })
    if (code === 'response_too_large') throw createError({ statusCode: 413, statusMessage: 'That homepage is too large for the free check.' })
    if (code === 'redirect_limit') throw createError({ statusCode: 422, statusMessage: 'That address redirects too many times.' })
    throw createError({ statusCode: 502, statusMessage: 'The public homepage could not be reached safely.' })
  }
})
