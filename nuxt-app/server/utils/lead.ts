import { createHash } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { createError, getHeader, getRequestIP, type H3Event } from 'h3'
import { getDatabase } from '../database'
import { leads } from '../database/schema'
import { appendGrantedGrowthConsent } from '../growth/ledger'
import { leadDedupeKey, type LeadInput } from './leadInput'

const DEDUPE_WINDOW_MS = 15 * 60 * 1_000
const RATE_WINDOW_MS = 60 * 60 * 1_000
const RATE_LIMIT = 5
const rateBuckets = new Map<string, { count: number, startedAt: number }>()
const hashFingerprint = (value: string) => createHash('sha256').update(value).digest('hex')

export function requestFingerprint(event: H3Event) {
  return hashFingerprint(`${getRequestIP(event, { xForwardedFor: true }) || ''}\n${getHeader(event, 'user-agent') || ''}`)
}

export function enforceLeadRateLimit(fingerprint: string) {
  const now = Date.now()
  const bucket = rateBuckets.get(fingerprint)
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(fingerprint, { count: 1, startedAt: now })
    return
  }
  if (bucket.count >= RATE_LIMIT) throw createError({ statusCode: 429, statusMessage: 'Too many submissions. Please try again later.' })
  bucket.count += 1
}

export async function storeLead(event: H3Event, input: LeadInput) {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Lead capture is temporarily unavailable.' })

  const dedupeKey = leadDedupeKey(input)
  const fingerprint = requestFingerprint(event)
  enforceLeadRateLimit(fingerprint)
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS)
  const existing = await database.select({ id: leads.id }).from(leads)
    .where(and(eq(leads.dedupeKey, dedupeKey), gt(leads.createdAt, since))).limit(1)
  if (existing.length) return { received: true, duplicate: true } as const

  const created = await database.insert(leads).values({
    name: input.name,
    email: input.email,
    company: input.company,
    website: input.website || null,
    packageInterest: input.packageInterest,
    language: input.language,
    message: input.message || null,
    privacyConsent: input.privacyConsent,
    recontactConsent: input.recontactConsent,
    growthResearchConsent: input.growthResearchConsent,
    dedupeKey,
    requestFingerprint: fingerprint,
  })
  if (input.growthResearchConsent) await appendGrantedGrowthConsent({ leadId: Number(created[0].insertId), website: input.website || undefined, locale: input.language, requestFingerprintHash: fingerprint })
  return { received: true, duplicate: false } as const
}
