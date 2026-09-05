import { createHash } from 'node:crypto'
import { createError, type H3Event } from 'h3'
import type { ManagedSiteProject } from '../../database/schema'
import { requestFingerprint } from '../../utils/lead'
import { managedSiteEmailTransportFromEnv, type ManagedSiteEmailTransport } from '../contact-inbox/email-transport'
import { getManagedSiteContactFormRepository, type ManagedSiteContactFormRepository } from './repository'
import { normalizePublicSiteOrigin } from '../../utils/publicCors'

const DEDUPE_WINDOW_MS = 15 * 60 * 1000
const FINGERPRINT_WINDOW_MS = 60 * 60 * 1000
const PROJECT_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_FINGERPRINT_SUBMISSIONS = 5
const MAX_PROJECT_SUBMISSIONS = 100
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const TOKEN = /^[a-f0-9]{64}$/u

type ParsedSubmission = { name: string; email: string; phone: string | null; message: string; honeypot: boolean }
type Bucket = { startedAt: number; count: number }

export type ManagedSiteContactFormRateLimiter = { claim(fingerprint: string, projectId: number, now: Date): void }

/** Per-process buckets are the F2b baseline; a shared store is the future multi-instance hardening step. */
export function createManagedSiteContactFormRateLimiter(): ManagedSiteContactFormRateLimiter {
  const fingerprintBuckets = new Map<string, Bucket>()
  const projectBuckets = new Map<number, Bucket>()
  const claim = <T>(buckets: Map<T, Bucket>, key: T, now: number, windowMs: number, limit: number) => {
    const current = buckets.get(key)
    const bucket = !current || current.startedAt + windowMs <= now ? { startedAt: now, count: 0 } : current
    if (bucket.count >= limit) throw createError({ statusCode: 429, statusMessage: '送出次數過多，請稍後再試。' })
    bucket.count += 1
    buckets.set(key, bucket)
  }
  return {
    claim(fingerprint, projectId, now) {
      claim(fingerprintBuckets, fingerprint, now.getTime(), FINGERPRINT_WINDOW_MS, MAX_FINGERPRINT_SUBMISSIONS)
      claim(projectBuckets, projectId, now.getTime(), PROJECT_WINDOW_MS, MAX_PROJECT_SUBMISSIONS)
    },
  }
}

export type ManagedSiteContactFormDependencies = {
  repository: ManagedSiteContactFormRepository
  transport: ManagedSiteEmailTransport
  rateLimiter: ManagedSiteContactFormRateLimiter
  clock: () => Date
}

const runtimeRateLimiter = createManagedSiteContactFormRateLimiter()
let testDependencies: ManagedSiteContactFormDependencies | null = null

export function setManagedSiteContactFormDependenciesForTests(dependencies: ManagedSiteContactFormDependencies | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site contact form dependency injection is test-only.' })
  testDependencies = dependencies
}

function dependencies(): ManagedSiteContactFormDependencies {
  if (process.env.NODE_ENV === 'test' && testDependencies) return testDependencies
  return { repository: getManagedSiteContactFormRepository(), transport: managedSiteEmailTransportFromEnv(), rateLimiter: runtimeRateLimiter, clock: () => new Date() }
}

function field(params: URLSearchParams, key: string, maxLength: number, required: boolean): string {
  const values = params.getAll(key)
  if (values.length !== 1 && (required || values.length > 1)) throw createError({ statusCode: 422, statusMessage: '聯絡表單欄位格式不正確。' })
  const value = (values[0] || '').normalize('NFC').trim()
  if ((required && !value) || value.length > maxLength) throw createError({ statusCode: 422, statusMessage: '聯絡表單欄位格式不正確。' })
  return value
}

function parseSubmission(rawBody: Buffer): ParsedSubmission {
  const params = new URLSearchParams(rawBody.toString('utf8'))
  const name = field(params, 'name', 160, true)
  const email = field(params, 'email', 320, true)
  const phone = field(params, 'phone', 64, false) || null
  const message = field(params, 'message', 2000, true)
  const companyFax = field(params, 'companyFax', 512, false)
  if ([name, email, phone || ''].some(value => CONTROL.test(value))) throw createError({ statusCode: 422, statusMessage: '聯絡表單欄位含有不允許的控制字元。' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw createError({ statusCode: 422, statusMessage: 'Email 格式不正確。' })
  return { name, email, phone, message, honeypot: Boolean(companyFax) }
}

function genericNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: '聯絡表單不存在或尚未啟用。' })
}

function successFor(project: ManagedSiteProject): { status: 303; location: string } | { status: 200; html: string } {
  const origin = normalizePublicSiteOrigin(project.canonicalWebsiteIdentity, process.env.NODE_ENV || 'production')
  if (origin) return { status: 303, location: `${origin}/thanks?sent=1` }
  return { status: 200, html: '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>訊息已送出</title><body><p>謝謝你的訊息，我們已經收到。</p></body></html>' }
}

function forwardErrorCode(error: unknown): string {
  const name = String((error as { name?: unknown })?.name || '')
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'provider_rejected'
}

async function markForwardResult(repository: ManagedSiteContactFormRepository, id: number, patch: Parameters<ManagedSiteContactFormRepository['updateSubmission']>[1]): Promise<void> {
  try { await repository.updateSubmission(id, patch) } catch {
    // The stored row remains retrievable as `received`; retry once without ever turning provider failure into a visitor-facing 500.
    try { await repository.updateSubmission(id, patch) } catch { /* best-effort status repair is handled operationally */ }
  }
}

export async function ingestManagedSiteContactForm(
  event: H3Event,
  token: string,
  rawBody: Buffer,
  injected: ManagedSiteContactFormDependencies = dependencies(),
) {
  if (!TOKEN.test(token)) genericNotFound()
  const parsed = parseSubmission(rawBody)
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const project = await injected.repository.findProjectByTokenHash(tokenHash)
  if (!project || project.status !== 'active') genericNotFound()
  const success = successFor(project)
  if (parsed.honeypot) return success

  const now = injected.clock()
  const fingerprint = requestFingerprint(event)
  injected.rateLimiter.claim(fingerprint, project.id, now)
  const dedupeKey = createHash('sha256').update(`${project.id}:${parsed.email}:${parsed.message}`).digest('hex')
  const duplicate = await injected.repository.findRecentDuplicate(dedupeKey, new Date(now.getTime() - DEDUPE_WINDOW_MS))
  if (duplicate) return success

  const submission = await injected.repository.insertSubmission({
    projectId: project.id,
    submittedName: parsed.name,
    submittedEmail: parsed.email,
    submittedPhone: parsed.phone,
    submittedMessage: parsed.message,
    status: 'received',
    forwardTargetEmail: null,
    forwardedAt: null,
    forwardErrorCode: null,
    requestFingerprint: fingerprint,
    dedupeKey,
  })
  const binding = await injected.repository.findBoundInbox(project.id)
  if (!binding) {
    await markForwardResult(injected.repository, submission.id, { status: 'forward_failed', forwardErrorCode: 'no_bound_inbox', forwardTargetEmail: null, forwardedAt: null })
    return success
  }
  if (!injected.transport.configured) {
    await markForwardResult(injected.repository, submission.id, { status: 'forward_failed', forwardErrorCode: 'transport_unconfigured', forwardTargetEmail: null, forwardedAt: null })
    return success
  }
  try {
    await injected.transport.send({
      to: binding.email,
      replyTo: parsed.email,
      subject: `網站聯絡表單新訊息｜${project.canonicalClientIdentity}`,
      text: `你的網站收到一則新的聯絡表單訊息。\n\n姓名：${parsed.name}\nEmail：${parsed.email}\n電話：${parsed.phone || '未提供'}\n\n訊息：\n${parsed.message}`,
    })
    await markForwardResult(injected.repository, submission.id, { status: 'forwarded', forwardedAt: now, forwardTargetEmail: binding.email, forwardErrorCode: null })
  } catch (error) {
    await markForwardResult(injected.repository, submission.id, { status: 'forward_failed', forwardErrorCode: forwardErrorCode(error), forwardTargetEmail: null, forwardedAt: null })
  }
  return success
}
