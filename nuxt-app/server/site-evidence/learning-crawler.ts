import { defaultPublicDnsCheck, safeFetch, SiteEvidenceFetchError, type DnsCheck } from './fetcher'
import { extractHtmlSignals } from './html'
import { normalizeUrl, sha256Hex, urlHash } from './normalization'
import { evaluateParsedRobots, parseRobots } from './robots'

const USER_AGENT = 'DiscoveryStack-SiteEvidence/1.0'
const MAX_PAGES = 20
const MAX_DEPTH = 2
const MAX_BYTES_PER_RESPONSE = 256 * 1024
const DEADLINE_MS = 30_000
const MIN_REQUEST_SPACING_MS = 1_000

export type LearningAuthority = {
  ownerUserId: number
  clientId: number
  sourceId: number
  sourceUrl: string
  authorizedHost: string
  sourceFingerprint: string
  authorizationStatus: 'active'
  rightsBasis: 'owner_authorized' | 'licensed' | 'open_license_verified'
  rightsReviewStatus: 'approved'
  allowModelImprovement: true
  consentVersion: string
  consentReceiptHash: string
  approvedAt: Date | string
  expiresAt: Date | string
  revokedAt: null
  sourceStatus: 'training_candidate' | 'approved'
  termsAllowTraining: true
  piiReviewStatus: 'none_detected'
  retentionActive: true
  removalRequested: false
}

/** Selectors are server-derived identifiers only. URL and consent values must come from the resolver. */
export type LearningAuthoritySelector = { ownerUserId: number, clientId: number, sourceId: number }

export type LearningCrawlerDependencies = {
  /** Re-read current owner, client, source, rights, consent, and revocation state from durable server state. */
  resolveCurrentAuthority: (selector: LearningAuthoritySelector, now: Date) => Promise<LearningAuthority | null>
  fetchImpl?: typeof fetch
  dnsCheck?: DnsCheck
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
}

export type LearningPageProjection = {
  urlHash: string
  contentHash: string | null
  depth: number
  httpStatus: number | null
  bytesFetched: number | null
  structural: {
    titlePresent: boolean
    h1Present: boolean
    canonicalPresent: boolean
    metaRobotsPresent: boolean
    textLengthBucket: '0' | '1-499' | '500-1999' | '2000-9999' | '10000+'
    anchorCountBucket: '0' | '1-4' | '5-19' | '20+'
    internalAnchorCountBucket: '0' | '1-4' | '5-19' | '20+'
  } | null
  evidenceLabel: 'unknown'
}

export type LearningCrawlerResult = {
  contractVersion: 'learning-crawl-projection-v1'
  ownerUserId: number
  clientId: number
  sourceId: number
  consentReceiptHash: string
  sourceFingerprint: string
  status: 'completed' | 'completed_partial' | 'blocked_authorization' | 'blocked_robots' | 'blocked_source'
  reasonCode: string | null
  pagesAttempted: number
  pagesCaptured: number
  duplicatePagesSkipped: number
  pageCap: number
  maxDepth: number
  labels: { aiCitation: 'unknown', searchVisibility: 'unknown', businessOutcome: 'unknown' }
  requiresHumanReview: true
  pages: LearningPageProjection[]
}

class LearningAuthorizationError extends Error {}
class LearningScopeError extends Error {}
class LearningDeadlineError extends Error {}

async function withinDeadline<T>(operation: () => Promise<T>, remainingMs: () => number): Promise<T> {
  const remaining = remainingMs()
  if (remaining <= 0) throw new LearningDeadlineError()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LearningDeadlineError()), remaining)
    })
    const result = await Promise.race([Promise.resolve().then(operation), timeout])
    if (remainingMs() <= 0) throw new LearningDeadlineError()
    return result
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function dateValue(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN
}

function isHttpsPublicStandardUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.hash
      && !/(?:token|secret|api[_-]?key|authorization|session|cookie|signature|jwt|password|credential)/iu.test(`${url.search}${url.pathname}`)
  } catch { return false }
}

function authorityIsCurrent(authority: LearningAuthority | null, selector: LearningAuthoritySelector, now: Date): authority is LearningAuthority {
  if (!authority || authority.ownerUserId !== selector.ownerUserId || authority.clientId !== selector.clientId || authority.sourceId !== selector.sourceId) return false
  if (authority.authorizationStatus !== 'active' || authority.rightsReviewStatus !== 'approved' || !authority.allowModelImprovement
    || !authority.consentVersion || !/^[a-f0-9]{64}$/iu.test(authority.consentReceiptHash) || authority.revokedAt !== null
    || !/^[a-f0-9]{64}$/iu.test(authority.sourceFingerprint)
    || !['owner_authorized', 'licensed', 'open_license_verified'].includes(authority.rightsBasis)
    || !['training_candidate', 'approved'].includes(authority.sourceStatus) || !authority.termsAllowTraining
    || authority.piiReviewStatus !== 'none_detected' || !authority.retentionActive || authority.removalRequested) return false
  const approvedAt = dateValue(authority.approvedAt)
  const expiresAt = dateValue(authority.expiresAt)
  const current = now.getTime()
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > current || expiresAt <= current) return false
  if (!isHttpsPublicStandardUrl(authority.sourceUrl)) return false
  try {
    const url = new URL(authority.sourceUrl)
    return url.hostname.toLowerCase().replace(/\.$/u, '') === authority.authorizedHost.toLowerCase().replace(/\.$/u, '')
      && authority.authorizedHost.length > 0
  } catch { return false }
}

function bucket(value: number, bounds: number[], labels: string[]) {
  for (let index = 0; index < bounds.length; index += 1) if (value <= bounds[index]!) return labels[index]!
  return labels[labels.length - 1]!
}

function textLengthBucket(length: number): LearningPageProjection['structural'] extends infer T ? T extends { textLengthBucket: infer U } ? U : never : never {
  return bucket(length, [0, 499, 1_999, 9_999], ['0', '1-499', '500-1999', '2000-9999', '10000+']) as never
}

function linkCountBucket(count: number): '0' | '1-4' | '5-19' | '20+' {
  return bucket(count, [0, 4, 19], ['0', '1-4', '5-19', '20+']) as '0' | '1-4' | '5-19' | '20+'
}

function emptyResult(selector: LearningAuthoritySelector, status: LearningCrawlerResult['status'], reasonCode: string, authority?: Pick<LearningAuthority, 'consentReceiptHash' | 'sourceFingerprint'>): LearningCrawlerResult {
  return {
    contractVersion: 'learning-crawl-projection-v1', ownerUserId: selector.ownerUserId, clientId: selector.clientId,
    sourceId: selector.sourceId, consentReceiptHash: authority?.consentReceiptHash || '', sourceFingerprint: authority?.sourceFingerprint || '', status, reasonCode, pagesAttempted: 0, pagesCaptured: 0,
    duplicatePagesSkipped: 0, pageCap: MAX_PAGES, maxDepth: MAX_DEPTH,
    labels: { aiCitation: 'unknown', searchVisibility: 'unknown', businessOutcome: 'unknown' }, requiresHumanReview: true, pages: [],
  }
}

function sameAuthorizedScope(rawUrl: string, authority: LearningAuthority) {
  if (!isHttpsPublicStandardUrl(rawUrl)) return false
  try { return new URL(rawUrl).hostname.toLowerCase().replace(/\.$/u, '') === authority.authorizedHost.toLowerCase().replace(/\.$/u, '') } catch { return false }
}

function safeReason(error: unknown) {
  if (error instanceof SiteEvidenceFetchError) return error.code.toUpperCase()
  return 'FETCH_FAILED'
}

/**
 * Bounded training acquisition. The durable authority resolver is mandatory and runs before any I/O,
 * then again immediately before each DNS and HTTP request (including every redirect hop).
 */
export async function collectLearningEvidence(selector: LearningAuthoritySelector, inputDependencies: LearningCrawlerDependencies): Promise<LearningCrawlerResult> {
  const now = inputDependencies.now || (() => new Date())
  const sleep = inputDependencies.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const resolve = inputDependencies.resolveCurrentAuthority
  if (!resolve || !Number.isSafeInteger(selector.ownerUserId) || !Number.isSafeInteger(selector.clientId) || !Number.isSafeInteger(selector.sourceId)) {
    return emptyResult(selector, 'blocked_authorization', 'AUTHORIZATION_UNAVAILABLE')
  }

  const startedAt = performance.now()
  const remainingMs = () => DEADLINE_MS - (performance.now() - startedAt)
  const deadline = () => remainingMs() <= 0
  let authority: LearningAuthority | null
  try {
    authority = await withinDeadline(() => resolve(selector, now()), remainingMs)
  } catch (error) {
    if (error instanceof LearningDeadlineError) return emptyResult(selector, 'blocked_authorization', 'DEADLINE_REACHED')
    return emptyResult(selector, 'blocked_authorization', 'AUTHORIZATION_UNAVAILABLE')
  }
  if (!authorityIsCurrent(authority, selector, now())) return emptyResult(selector, 'blocked_authorization', 'AUTHORIZATION_NOT_CURRENT')
  const granted = authority
  const immutableReceiptHash = granted.consentReceiptHash
  const immutableSourceFingerprint = granted.sourceFingerprint
  let pendingPolicyError: LearningAuthorizationError | LearningScopeError | LearningDeadlineError | null = null
  let robotsPolicy: ReturnType<typeof parseRobots> | null = null
  let requestPurpose: 'page' | 'robots' = 'robots'

  const revalidate = async () => {
    let current: LearningAuthority | null
    try { current = await withinDeadline(() => resolve(selector, now()), remainingMs) } catch (error) {
      if (error instanceof LearningDeadlineError) throw error
      throw new LearningAuthorizationError()
    }
    if (deadline()) throw new LearningDeadlineError()
    if (!authorityIsCurrent(current, selector, now()) || current.consentReceiptHash !== immutableReceiptHash || current.sourceFingerprint !== immutableSourceFingerprint
      || current.sourceUrl !== granted.sourceUrl || current.authorizedHost.toLowerCase() !== granted.authorizedHost.toLowerCase()) throw new LearningAuthorizationError()
    return current
  }

  let lastRequestAt = Number.NEGATIVE_INFINITY
  const waitForSpacing = async () => {
    const current = now().getTime()
    const wait = MIN_REQUEST_SPACING_MS - (current - lastRequestAt)
    if (wait > 0) await withinDeadline(() => sleep(Math.min(wait, remainingMs())), remainingMs)
    if (deadline()) throw new LearningDeadlineError()
    lastRequestAt = now().getTime()
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input)
    try {
      await revalidate()
      if (init?.method && init.method.toUpperCase() !== 'GET') throw new LearningScopeError()
      if (!sameAuthorizedScope(raw, granted)) throw new LearningScopeError()
      if (requestPurpose === 'page' && (!robotsPolicy || evaluateParsedRobots(robotsPolicy, new URL(raw).pathname + new URL(raw).search, USER_AGENT).verdict !== 'allowed')) throw new LearningScopeError()
      await waitForSpacing()
      // safeFetch itself owns redirect: manual, GET-only, content-type checks, timeout, body cap,
      // and the public-IP check. This second authority check occurs after DNS and just before HTTP.
      await revalidate()
      if (deadline()) throw new LearningDeadlineError()
      const remaining = Math.max(1, Math.floor(remainingMs()))
      const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining)
      return await withinDeadline(() => (inputDependencies.fetchImpl || fetch)(input, { ...init, signal }), remainingMs)
    } catch (error) {
      if (error instanceof LearningAuthorizationError || error instanceof LearningScopeError || error instanceof LearningDeadlineError) pendingPolicyError = error
      throw error
    }
  }
  const dnsCheck: DnsCheck = async hostname => {
    try {
      await revalidate()
      if (deadline()) throw new LearningDeadlineError()
      if (hostname.toLowerCase().replace(/\.$/u, '') !== granted.authorizedHost.toLowerCase().replace(/\.$/u, '')) throw new LearningScopeError()
      await withinDeadline(() => (inputDependencies.dnsCheck || defaultPublicDnsCheck)(hostname), remainingMs)
    } catch (error) {
      if (error instanceof LearningAuthorizationError || error instanceof LearningScopeError || error instanceof LearningDeadlineError) pendingPolicyError = error
      throw error
    }
  }
  const fetcher = async (url: string, purpose: 'page' | 'robots') => {
    requestPurpose = purpose
    try {
      return await withinDeadline(() => safeFetch(url, { purpose, fetchImpl, dnsCheck, timeoutMs: 5_000, maxBytes: MAX_BYTES_PER_RESPONSE }), remainingMs)
    } catch (error) {
      if (error instanceof LearningDeadlineError) throw error
      if (pendingPolicyError) {
        const policyError = pendingPolicyError
        pendingPolicyError = null
        throw policyError
      }
      throw error
    }
  }
  const result: LearningCrawlerResult = {
    contractVersion: 'learning-crawl-projection-v1', ownerUserId: selector.ownerUserId, clientId: selector.clientId,
    sourceId: selector.sourceId, consentReceiptHash: immutableReceiptHash, sourceFingerprint: immutableSourceFingerprint, status: 'completed', reasonCode: null,
    pagesAttempted: 0, pagesCaptured: 0, duplicatePagesSkipped: 0, pageCap: MAX_PAGES, maxDepth: MAX_DEPTH,
    labels: { aiCitation: 'unknown', searchVisibility: 'unknown', businessOutcome: 'unknown' }, requiresHumanReview: true, pages: [],
  }

  try {
    const robotsUrl = new URL('/robots.txt', granted.sourceUrl).toString()
    let robots
    try { robots = await fetcher(robotsUrl, 'robots') }
    catch (error) {
      if (error instanceof LearningAuthorizationError || error instanceof LearningScopeError || error instanceof LearningDeadlineError) throw error
      result.status = 'blocked_robots'; result.reasonCode = 'ROBOTS_UNAVAILABLE'; return result
    }
    if (robots.status < 200 || robots.status >= 300) {
      result.status = 'blocked_robots'; result.reasonCode = 'ROBOTS_UNAVAILABLE'; return result
    }
    const parsedRobots = parseRobots(robots.body)
    robotsPolicy = parsedRobots
    if (parsedRobots.malformed) { result.status = 'blocked_robots'; result.reasonCode = 'ROBOTS_UNAVAILABLE'; return result }

    const start = normalizeUrl(granted.sourceUrl)
    const queue: Array<{ url: string, depth: number }> = [{ url: start, depth: 0 }]
    const queued = new Set([start])
    const visited = new Set<string>()
    while (queue.length && result.pagesAttempted < MAX_PAGES && !deadline()) {
      await revalidate()
      const item = queue.shift()!
      const normalized = normalizeUrl(item.url)
      if (visited.has(normalized)) { result.duplicatePagesSkipped += 1; continue }
      visited.add(normalized)
      const target = new URL(item.url)
      const robotsDecision = evaluateParsedRobots(parsedRobots, target.pathname + target.search, USER_AGENT)
      if (robotsDecision.verdict !== 'allowed') {
        if (item.depth === 0) { result.status = 'blocked_robots'; result.reasonCode = 'ROBOTS_DISALLOW'; return result }
        continue
      }
      result.pagesAttempted += 1
      try {
        const fetched = await fetcher(item.url, 'page')
        if ([401, 403, 407, 429].includes(fetched.status) || /captcha|verify you are human|access denied|security challenge/iu.test(fetched.body.slice(0, 16_384))) {
          result.status = 'completed_partial'; result.reasonCode = 'AUTHENTICATION_OR_WAF_CHALLENGE'; break
        }
        if (fetched.status < 200 || fetched.status >= 300) continue
        if (!sameAuthorizedScope(fetched.finalUrl, granted)) throw new LearningScopeError()
        const signals = extractHtmlSignals(fetched.body, fetched.finalUrl)
        result.pages.push({
          urlHash: urlHash(item.url), contentHash: sha256Hex(fetched.body), depth: item.depth, httpStatus: fetched.status,
          bytesFetched: fetched.bytesFetched,
          structural: {
            titlePresent: signals.title !== null, h1Present: signals.h1 !== null, canonicalPresent: signals.canonicalUrl !== null,
            metaRobotsPresent: signals.metaRobots !== null, textLengthBucket: textLengthBucket(signals.textLength),
            anchorCountBucket: linkCountBucket(signals.anchorCount), internalAnchorCountBucket: linkCountBucket(signals.internalAnchorCount),
          }, evidenceLabel: 'unknown',
        })
        result.pagesCaptured += 1
        if (item.depth < MAX_DEPTH) for (const link of signals.internalLinks) {
          if (!sameAuthorizedScope(link, granted)) continue
          const key = normalizeUrl(link)
          if (queued.has(key)) { result.duplicatePagesSkipped += 1; continue }
          queued.add(key)
          if (queue.length < MAX_PAGES * 5) queue.push({ url: key, depth: item.depth + 1 })
        }
      } catch (error) {
        if (error instanceof LearningAuthorizationError) throw error
        if (error instanceof LearningScopeError) { result.status = 'completed_partial'; result.reasonCode = 'SCOPE_REJECTED'; break }
        if (error instanceof LearningDeadlineError) { result.status = 'completed_partial'; result.reasonCode = 'DEADLINE_REACHED'; break }
        result.status = 'completed_partial'
        result.reasonCode ||= safeReason(error)
      }
    }
    if (deadline() && result.status === 'completed') { result.status = 'completed_partial'; result.reasonCode = 'DEADLINE_REACHED' }
    if (result.pagesAttempted >= MAX_PAGES && queue.length && result.status === 'completed') { result.status = 'completed_partial'; result.reasonCode = 'PAGE_CAP_REACHED' }
  } catch (error) {
    if (error instanceof LearningAuthorizationError) return emptyResult(selector, 'blocked_authorization', 'AUTHORIZATION_NO_LONGER_CURRENT', granted)
    if (error instanceof LearningScopeError) { result.status = 'completed_partial'; result.reasonCode = 'SCOPE_REJECTED' }
    else if (error instanceof LearningDeadlineError) { result.status = 'completed_partial'; result.reasonCode = 'DEADLINE_REACHED' }
    else { result.status = 'completed_partial'; result.reasonCode = safeReason(error) }
  }
  return result
}
