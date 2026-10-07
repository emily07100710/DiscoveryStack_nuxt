import { lookup as systemLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions as HttpRequestOptions } from 'node:http'
import { performance } from 'node:perf_hooks'
import { isPublicIpAddress } from '../utils/publicSiteAnalysis'
import { evaluateParsedRobots, parseRobots } from '../site-evidence/robots'
import type { LearningAuthority, LearningAuthoritySelector } from '../site-evidence/learning-crawler'
import { projectLivePage, type LivePageProjection } from './live-page-projection'

const MAX_DEADLINE_MS = 20_000
const DEFAULT_DEADLINE_MS = 20_000
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_SPACING_MS = 1_000
const USER_AGENT = 'DiscoveryStack-LiveLearning/1.0'
const SECRET_PATH = /(?:token|secret|api[_-]?key|authorization|session|cookie|signature|jwt|password|credential)/iu

type DnsAddress = { address: string; family: number }
export type LiveAcquisitionAuthority = { authorizationFingerprint: string; authority: LearningAuthority }
type HttpPurpose = 'robots' | 'page'
type PinnedHttpResponse = { statusCode: number; headers: IncomingHttpHeaders; body: Buffer }

type PinnedRequestOptions = {
  hostname: string
  port: 443
  path: string
  method: 'GET'
  headers: Readonly<Record<string, string>>
  agent: false
  rejectUnauthorized: true
  servername?: string
  lookup: NonNullable<HttpRequestOptions['lookup']>
}

/** Synthetic tests may replace only the bounded pinned transport; production uses node:https below. */
export type PinnedTransport = (input: { request: PinnedRequestOptions; timeoutMs: number; maxBytes: number; signal: AbortSignal }) => Promise<PinnedHttpResponse>

export type LivePageFetcherDependencies = {
  resolveCurrentAuthority: (selector: LearningAuthoritySelector, now: Date) => Promise<LiveAcquisitionAuthority | null>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  /** Test seam. Production callers must not supply this. */
  transport?: PinnedTransport
  deadlineMs?: number
}

export type LivePageFetchResult = {
  status: 'captured' | 'blocked' | 'deferred'
  projection: LivePageProjection | null
  capturedAt: string | null
  reasonCode: string | null
  authorizationFingerprint: string | null
  sourceFingerprint: string | null
  consentReceiptHash: string | null
}

class DeadlineError extends Error {}
class AuthorityUnavailableError extends Error {}
class AuthorityChangedError extends Error {}
class ScopeBlockedError extends Error {}
class RobotsBlockedError extends Error {}
class ContentBlockedError extends Error {}
class ProjectionNotVerifiedError extends Error {}
class TransportDeferredError extends Error {}
class TransportBlockedError extends Error {}

function result(status: LivePageFetchResult['status'], reasonCode: string | null, auth?: LiveAcquisitionAuthority | null, projection: LivePageProjection | null = null, capturedAt: string | null = null): LivePageFetchResult {
  return {
    status,
    projection,
    capturedAt,
    reasonCode,
    authorizationFingerprint: auth?.authorizationFingerprint || null,
    sourceFingerprint: auth?.authority.sourceFingerprint || null,
    consentReceiptHash: auth?.authority.consentReceiptHash || null,
  }
}

function dateMs(value: Date | string): number {
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : Number.NaN
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
}

function originOf(value: string): URL | null {
  try { return new URL(value) } catch { return null }
}

function validPublicHttpsUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 2048 || raw !== raw.trim()) return null
  let parsed: URL
  try { parsed = new URL(raw) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443') || parsed.search || parsed.hash || raw.includes('?') || raw.includes('#')) return null
  if (!parsed.hostname || parsed.hostname.endsWith('.')) return null
  let decodedPath: string
  try { decodedPath = decodeURIComponent(parsed.pathname) } catch { return null }
  if (SECRET_PATH.test(`${parsed.pathname}\n${decodedPath}`)) return null
  return parsed
}

function currentAuthorityIsValid(value: LiveAcquisitionAuthority | null, selector: LearningAuthoritySelector, now: Date): value is LiveAcquisitionAuthority {
  if (!value || !/^[a-f0-9]{64}$/iu.test(value.authorizationFingerprint)) return false
  const authority = value.authority
  if (!authority || authority.ownerUserId !== selector.ownerUserId || authority.clientId !== selector.clientId || authority.sourceId !== selector.sourceId || typeof authority.authorizedHost !== 'string' || !authority.authorizedHost) return false
  if (authority.authorizationStatus !== 'active' || authority.rightsReviewStatus !== 'approved' || authority.allowModelImprovement !== true
    || authority.revokedAt !== null || !authority.consentVersion || !/^[a-f0-9]{64}$/iu.test(authority.consentReceiptHash)
    || !/^[a-f0-9]{64}$/iu.test(authority.sourceFingerprint) || !['owner_authorized', 'licensed', 'open_license_verified'].includes(authority.rightsBasis)
    || !['training_candidate', 'approved'].includes(authority.sourceStatus) || authority.termsAllowTraining !== true
    || authority.piiReviewStatus !== 'none_detected' || authority.retentionActive !== true || authority.removalRequested !== false) return false
  const approvedAt = dateMs(authority.approvedAt)
  const expiresAt = dateMs(authority.expiresAt)
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > now.getTime() || expiresAt <= now.getTime()) return false
  const sourceUrl = validPublicHttpsUrl(authority.sourceUrl)
  if (!sourceUrl || normalizedHostname(sourceUrl.hostname) !== normalizedHostname(authority.authorizedHost)) return false
  return true
}

function stableAuthorityValues(auth: LiveAcquisitionAuthority) {
  const authority = auth.authority
  const source = new URL(authority.sourceUrl)
  return {
    authorizationFingerprint: auth.authorizationFingerprint,
    sourceFingerprint: authority.sourceFingerprint,
    consentReceiptHash: authority.consentReceiptHash,
    authorizedOrigin: source.origin,
    authorizedHost: normalizedHostname(authority.authorizedHost),
    approvedAt: dateMs(authority.approvedAt),
    expiresAt: dateMs(authority.expiresAt),
  }
}

function sameStableAuthority(left: LiveAcquisitionAuthority, right: LiveAcquisitionAuthority): boolean {
  const a = stableAuthorityValues(left)
  const b = stableAuthorityValues(right)
  return a.authorizationFingerprint === b.authorizationFingerprint && a.sourceFingerprint === b.sourceFingerprint
    && a.consentReceiptHash === b.consentReceiptHash && a.authorizedOrigin === b.authorizedOrigin
    && a.authorizedHost === b.authorizedHost && a.approvedAt === b.approvedAt && a.expiresAt === b.expiresAt
}

function validSelector(selector: LearningAuthoritySelector): boolean {
  return Boolean(selector && typeof selector === 'object' && !Array.isArray(selector)
    && Object.keys(selector).length === 3 && Object.keys(selector).every(key => ['ownerUserId', 'clientId', 'sourceId'].includes(key))
    && Number.isSafeInteger(selector.ownerUserId) && selector.ownerUserId > 0
    && Number.isSafeInteger(selector.clientId) && selector.clientId > 0
    && Number.isSafeInteger(selector.sourceId) && selector.sourceId > 0)
}

async function withDeadline<T>(operation: () => Promise<T>, remainingMs: () => number): Promise<T> {
  const remaining = Math.floor(remainingMs())
  if (remaining <= 0) throw new DeadlineError()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DeadlineError()), remaining) })
    const value = await Promise.race([Promise.resolve().then(operation), deadline])
    if (remainingMs() <= 0) throw new DeadlineError()
    return value
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

function decodeResponseBody(bytes: Buffer, rawContentType: string, purpose: HttpPurpose): string {
  const pieces = rawContentType.split(';').map(part => part.trim())
  const mime = (pieces.shift() || '').toLowerCase()
  if (purpose === 'robots' ? mime !== 'text/plain' : !['text/html', 'application/xhtml+xml'].includes(mime)) throw new ContentBlockedError()
  let charset = 'utf-8'
  for (const parameter of pieces) {
    const match = /^charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))$/iu.exec(parameter)
    if (parameter.toLowerCase().startsWith('charset')) {
      if (!match) throw new ContentBlockedError()
      charset = (match[1] || match[2] || match[3] || '').toLowerCase()
    }
  }
  if (!['utf-8', 'utf8'].includes(charset)) throw new ContentBlockedError()
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new ContentBlockedError() }
}

function getHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value.join(', ') : value || ''
}

function requireIdentityContentEncoding(headers: IncomingHttpHeaders): void {
  const encoding = getHeader(headers, 'content-encoding').trim().toLowerCase()
  if (encoding && encoding !== 'identity') throw new ContentBlockedError()
}

function createPinnedRequestOptions(url: URL, address: DnsAddress, purpose: HttpPurpose): PinnedRequestOptions {
  const hostname = normalizedHostname(url.hostname)
  const servername = isIP(hostname) ? undefined : hostname
  const lookup = ((requestedHost: string, options: { all?: boolean } | ((error: NodeJS.ErrnoException | null, address: string, family?: number) => void), callback?: (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    const cb = typeof options === 'function' ? options as (error: NodeJS.ErrnoException | null, address: string, family?: number) => void : callback!
    if (normalizedHostname(requestedHost) !== hostname) {
      cb(Object.assign(new Error('Pinned host mismatch'), { code: 'EAI_FAIL' }), '', 0)
      return
    }
    if (typeof options !== 'function' && options.all) {
      ;(cb as unknown as (error: NodeJS.ErrnoException | null, addresses: DnsAddress[]) => void)(null, [{ address: address.address, family: address.family }])
      return
    }
    ;(cb as (error: NodeJS.ErrnoException | null, address: string, family?: number) => void)(null, address.address, address.family)
  }) as NonNullable<HttpRequestOptions['lookup']>
  return {
    hostname,
    port: 443,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { Accept: purpose === 'robots' ? 'text/plain' : 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
    agent: false,
    rejectUnauthorized: true,
    ...(servername ? { servername } : {}),
    lookup,
  }
}

function nodePinnedHttpsGet(input: { request: PinnedRequestOptions; timeoutMs: number; maxBytes: number; signal: AbortSignal }): Promise<PinnedHttpResponse> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) { reject(new TransportDeferredError()); return }
    let settled = false
    let received = 0
    const chunks: Buffer[] = []
    const fail = (error: Error, blocked = false) => {
      if (settled) return
      settled = true
      reject(blocked ? new TransportBlockedError() : error instanceof DeadlineError ? error : new TransportDeferredError())
    }
    let responseHeaders: IncomingHttpHeaders | null = null
    let statusCode = 0
    let request: ClientRequest
    const onResponse = (response: IncomingMessage) => {
      statusCode = response.statusCode || 0
      responseHeaders = response.headers
      const declaredLength = Number(getHeader(response.headers, 'content-length') || 0)
      if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
        response.destroy()
        request.destroy()
        fail(new TransportBlockedError(), true)
        return
      }
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        received += buffer.byteLength
        if (received > input.maxBytes) {
          response.destroy()
          request.destroy()
          fail(new TransportBlockedError(), true)
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        resolve({ statusCode, headers: responseHeaders!, body: Buffer.concat(chunks, received) })
      })
      response.on('error', error => fail(error))
    }
    try {
      request = httpsRequest({ ...input.request, signal: input.signal }, onResponse)
      request.setTimeout(input.timeoutMs, () => request.destroy(new DeadlineError('request timeout')))
      request.on('error', error => fail(error))
      request.end()
    } catch (error) { fail(error instanceof Error ? error : new Error('request failed')) }
  })
}

function deadlineBudget(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return DEFAULT_DEADLINE_MS
  return Math.min(MAX_DEADLINE_MS, Math.floor(value))
}

/** Capture exactly one server-selected publication URL under current source authorization. */
export async function captureAuthorizedLivePage(input: { selector: LearningAuthoritySelector; publicationUrl: string }, deps: LivePageFetcherDependencies): Promise<LivePageFetchResult> {
  const now = deps.now || (() => new Date())
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
    || Object.keys(input).some(key => key !== 'selector' && key !== 'publicationUrl')
    || !validSelector(input.selector) || typeof input.publicationUrl !== 'string') return result('blocked', 'INVALID_SELECTOR')
  const selector: LearningAuthoritySelector = { ownerUserId: input.selector.ownerUserId, clientId: input.selector.clientId, sourceId: input.selector.sourceId }
  if (typeof deps?.resolveCurrentAuthority !== 'function') return result('deferred', 'AUTHORITY_UNAVAILABLE')
  const budget = deadlineBudget(deps.deadlineMs)
  const startedAt = performance.now()
  const remainingMs = () => budget - (performance.now() - startedAt)
  const abortController = new AbortController()
  const abortTimer = setTimeout(() => abortController.abort(new DeadlineError()), budget)
  let granted: LiveAcquisitionAuthority | null = null
  const currentAuthority = async (initial?: LiveAcquisitionAuthority): Promise<LiveAcquisitionAuthority> => {
    let current: LiveAcquisitionAuthority | null
    try { current = await withDeadline(() => deps.resolveCurrentAuthority(selector, now()), remainingMs) }
    catch (error) { if (error instanceof DeadlineError) throw error; throw new AuthorityUnavailableError() }
    const checkNow = now()
    if (!currentAuthorityIsValid(current, input.selector, checkNow)) throw new AuthorityChangedError()
    if (initial && !sameStableAuthority(initial, current)) throw new AuthorityChangedError()
    return current
  }
  try {
    if (remainingMs() <= 0) throw new DeadlineError()
    let initial: LiveAcquisitionAuthority
    try {
      const candidate = await withDeadline(() => deps.resolveCurrentAuthority(selector, now()), remainingMs)
      if (!currentAuthorityIsValid(candidate, selector, now())) return result('blocked', 'AUTHORIZATION_NOT_CURRENT')
      initial = candidate
      granted = candidate
    } catch (error) {
      if (error instanceof DeadlineError) throw error
      return result('deferred', 'AUTHORITY_UNAVAILABLE')
    }
    const pageUrl = validPublicHttpsUrl(input.publicationUrl)
    const authorityUrl = validPublicHttpsUrl(initial.authority.sourceUrl)
    if (!pageUrl || !authorityUrl || pageUrl.origin !== authorityUrl.origin
      || normalizedHostname(pageUrl.hostname) !== normalizedHostname(initial.authority.authorizedHost)) throw new ScopeBlockedError()

    const stable = stableAuthorityValues(initial)
    const literal = normalizedHostname(pageUrl.hostname)
    let addresses: DnsAddress[]
    try {
      await currentAuthority(initial)
      if (remainingMs() <= 0) throw new DeadlineError()
      if (isIP(literal)) addresses = [{ address: literal, family: isIP(literal) }]
      else addresses = await withDeadline(() => (deps.dnsLookup || (hostname => systemLookup(hostname, { all: true, verbatim: true })))(literal), remainingMs)
    } catch (error) {
      if (error instanceof DeadlineError) throw error
      if (error instanceof AuthorityChangedError) throw error
      if (error instanceof AuthorityUnavailableError) throw error
      throw new TransportDeferredError()
    }
    if (!addresses.length || addresses.some(entry => !Number.isInteger(entry.family) || ![4, 6].includes(entry.family) || !isPublicIpAddress(entry.address) || isIP(entry.address) !== entry.family)) throw new ScopeBlockedError()
    const address = addresses[0]!

    const transport = deps.transport || (input => nodePinnedHttpsGet(input))
    let lastCompletedAt: number | null = null
    const waitForSpacing = async () => {
      if (lastCompletedAt === null) return
      const wait = REQUEST_SPACING_MS - (performance.now() - lastCompletedAt)
      if (wait > 0) await withDeadline(() => (deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait), remainingMs)
    }
    const get = async (url: URL, purpose: HttpPurpose): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> => {
      await waitForSpacing()
      await currentAuthority(initial)
      if (remainingMs() <= 0) throw new DeadlineError()
      const requestOptions = createPinnedRequestOptions(url, address, purpose)
      let response: PinnedHttpResponse
      try {
        response = await withDeadline(() => transport({ request: requestOptions, timeoutMs: Math.max(1, Math.floor(remainingMs())), maxBytes: MAX_RESPONSE_BYTES, signal: abortController.signal }), remainingMs)
      } catch (error) {
        if (error instanceof DeadlineError || error instanceof TransportDeferredError || error instanceof TransportBlockedError) throw error
        throw new TransportDeferredError()
      }
      lastCompletedAt = performance.now()
      if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new TransportBlockedError()
      return response
    }

    const robotsUrl = new URL('/robots.txt', stable.authorizedOrigin)
    let robotsResponse: PinnedHttpResponse
    try { robotsResponse = await get(robotsUrl, 'robots') } catch (error) { if (error instanceof AuthorityChangedError) throw error; throw error }
    await currentAuthority(initial)
    if (robotsResponse.statusCode !== 200) {
      if (robotsResponse.statusCode === 429 || robotsResponse.statusCode >= 500) throw new TransportDeferredError()
      throw new RobotsBlockedError()
    }
    requireIdentityContentEncoding(robotsResponse.headers)
    const robotsText = decodeResponseBody(robotsResponse.body, getHeader(robotsResponse.headers, 'content-type'), 'robots')
    const robots = parseRobots(robotsText)
    if (robots.malformed || evaluateParsedRobots(robots, `${pageUrl.pathname}${pageUrl.search}`, USER_AGENT).verdict !== 'allowed') throw new RobotsBlockedError()

    let pageResponse: PinnedHttpResponse
    try { pageResponse = await get(pageUrl, 'page') } catch (error) { throw error }
    await currentAuthority(initial)
    if (pageResponse.statusCode >= 300 && pageResponse.statusCode < 400) throw new ScopeBlockedError()
    if (pageResponse.statusCode === 429 || pageResponse.statusCode >= 500) throw new TransportDeferredError()
    if (pageResponse.statusCode !== 200 && pageResponse.statusCode !== 404) throw new ScopeBlockedError()
    requireIdentityContentEncoding(pageResponse.headers)
    const html = decodeResponseBody(pageResponse.body, getHeader(pageResponse.headers, 'content-type'), 'page')
    const projection = projectLivePage({ html, status: pageResponse.statusCode, url: input.publicationUrl })
    if (!projection) throw new ProjectionNotVerifiedError()
    await currentAuthority(initial)
    const captured = now()
    if (dateMs(initial.authority.expiresAt) <= captured.getTime()) throw new AuthorityChangedError()
    return result('captured', null, initial, projection, captured.toISOString())
  } catch (error) {
    if (error instanceof DeadlineError) return result('deferred', 'DEADLINE_REACHED', granted)
    if (error instanceof AuthorityUnavailableError) return result('deferred', 'AUTHORITY_UNAVAILABLE', granted)
    if (error instanceof AuthorityChangedError) return result('blocked', 'AUTHORIZATION_CHANGED', granted)
    if (error instanceof ScopeBlockedError) return result('blocked', 'SCOPE_REJECTED', granted)
    if (error instanceof RobotsBlockedError) return result('blocked', 'ROBOTS_DISALLOWED', granted)
    if (error instanceof ContentBlockedError) return result('blocked', 'CONTENT_REJECTED', granted)
    if (error instanceof ProjectionNotVerifiedError) return result('blocked', 'PROJECTION_NOT_VERIFIED', granted)
    if (error instanceof TransportBlockedError) return result('blocked', 'RESPONSE_REJECTED', granted)
    if (error instanceof TransportDeferredError) return result('deferred', 'UPSTREAM_UNAVAILABLE', granted)
    return result('deferred', 'UPSTREAM_UNAVAILABLE', granted)
  } finally {
    clearTimeout(abortTimer)
  }
}
