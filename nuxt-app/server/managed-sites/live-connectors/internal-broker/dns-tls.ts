import { createError } from 'h3'
import { stableFingerprint } from '../../../seo-geo-core/repository'
import { assertPublicHttpsUrl } from '../../../content-operations/normalization'
import { readBoundedManagedSiteResponse } from '../hmac-broker-transport'
import type { ManagedSiteDnsTlsReceipt } from '../types'
import { managedSitePagesProjectName, type CloudflarePagesOptions } from './cloudflare-pages'

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARE_ID = /^[a-f0-9]{32}$/u
const DOMAIN_STATES = new Set(['initializing', 'pending', 'active', 'deactivated', 'blocked', 'error'])
const VALIDATION_STATES = new Set(['initializing', 'pending', 'active', 'deactivated', 'error'])
const VERIFICATION_STATES = new Set(['pending', 'active', 'deactivated', 'blocked', 'error'])
const FAILED_STATES = new Set(['deactivated', 'blocked', 'error'])
type Readiness = Pick<ManagedSiteDnsTlsReceipt, 'dnsStatus' | 'tlsStatus' | 'providerReference'>

function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function fail(statusCode: number, statusMessage: string): never { throw createError({ statusCode, statusMessage }) }

async function readProviderObject(path: string, options: Pick<CloudflarePagesOptions, 'fetchImpl' | 'apiToken'>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(timeoutMs, 4_000)))
  try {
    let response: Response
    try { response = await options.fetchImpl(`${CLOUDFLARE_API}${path}`, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${options.apiToken}`, accept: 'application/json' } }) } catch { fail(503, 'Cloudflare domain readiness transport failed.') }
    if (response.status !== 200) {
      await response.body?.cancel()
      if (response.status === 404) return null
      fail(503, 'Cloudflare domain readiness lookup was rejected.')
    }
    let body: unknown
    try { body = JSON.parse(await readBoundedManagedSiteResponse(response)) } catch { fail(502, 'Cloudflare domain readiness response is malformed or oversized.') }
    if (!plain(body) || body.success !== true || !plain(body.result)) fail(502, 'Cloudflare domain readiness response lacks verified provider evidence.')
    return body.result
  } finally { clearTimeout(timer) }
}

/**
 * Verify an existing Pages association only. The DNS command has no record
 * replacement authority, so custom-domain/DNS setup remains an explicit action.
 * Provider API: /accounts/{account}/pages/projects/{project}/domains/{domain}.
 */
export async function verifyCloudflareManagedSiteDnsTls(input: { ownerUserId: number; projectId: number; canonicalDomain: string; timeoutMs: number }, options: Pick<CloudflarePagesOptions, 'fetchImpl' | 'accountId' | 'apiToken' | 'projectPrefix'>): Promise<Readiness> {
  if (!CLOUDFLARE_ID.test(options.accountId) || ![input.ownerUserId, input.projectId, input.timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) fail(422, 'Cloudflare domain readiness identity is invalid.')
  const canonicalDomain = new URL(assertPublicHttpsUrl(`https://${input.canonicalDomain}`, 'Managed-site DNS domain')).hostname
  if (canonicalDomain !== input.canonicalDomain) fail(422, 'Cloudflare domain readiness hostname is not canonical.')
  const projectName = managedSitePagesProjectName(options.projectPrefix, input.ownerUserId, input.projectId)
  const deadline = Date.now() + Math.min(input.timeoutMs, 8_000)
  const remaining = () => {
    const budget = deadline - Date.now()
    if (budget < 1) fail(503, 'Cloudflare domain readiness reached its bounded provider budget.')
    return budget
  }
  const providerReference = `cf-pages-domain-${stableFingerprint({ accountId: options.accountId, projectName, canonicalDomain }).slice(0, 40)}`
  const pending: Readiness = { providerReference, dnsStatus: 'propagation_pending', tlsStatus: 'pending' }
  const domain = await readProviderObject(`/accounts/${options.accountId}/pages/projects/${projectName}/domains/${encodeURIComponent(canonicalDomain)}`, options, remaining())
  if (!domain) return pending
  if (domain.name !== canonicalDomain || typeof domain.id !== 'string' || !/^[A-Za-z0-9_-]{3,160}$/u.test(domain.id) || !DOMAIN_STATES.has(String(domain.status)) || !plain(domain.validation_data) || !VALIDATION_STATES.has(String(domain.validation_data.status)) || !plain(domain.verification_data) || !VERIFICATION_STATES.has(String(domain.verification_data.status)) || typeof domain.zone_tag !== 'string' || domain.zone_tag !== '' && !CLOUDFLARE_ID.test(domain.zone_tag)) fail(409, 'Cloudflare custom-domain evidence does not match the exact requested domain.')
  // The zone comes from the exact provider-owned Pages association. Never guess
  // a zone from a suffix search, and never edit a record or change nameservers.
  if (domain.zone_tag) {
    const zone = await readProviderObject(`/zones/${domain.zone_tag}`, options, remaining())
    if (!zone || zone.id !== domain.zone_tag || !plain(zone.account) || zone.account.id !== options.accountId || typeof zone.name !== 'string' || !(canonicalDomain === zone.name || canonicalDomain.endsWith(`.${zone.name}`))) fail(409, 'Cloudflare custom-domain zone does not belong to the configured account and domain.')
    if (zone.status !== 'active') return pending
  }
  const states = [String(domain.status), String(domain.validation_data.status), String(domain.verification_data.status)]
  if (states.some(status => FAILED_STATES.has(status))) return { providerReference, dnsStatus: 'partial_failure', tlsStatus: 'failed' }
  return states.every(status => status === 'active') ? { providerReference, dnsStatus: 'verified', tlsStatus: 'verified' } : pending
}
