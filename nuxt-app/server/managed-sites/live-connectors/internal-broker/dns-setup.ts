import { createError } from 'h3'
import { canonicalizeManagedDomain } from '../domain-connectors'
import { readBoundedManagedSiteResponse } from '../hmac-broker-transport'
import { managedSitePagesProjectName, type CloudflarePagesOptions } from './cloudflare-pages'
import { verifyCloudflareManagedSiteDnsTls } from './dns-tls'

const API = 'https://api.cloudflare.com/client/v4'
const PROVIDER_ID = /^[a-f0-9]{32}$/u
type SetupInput = { ownerUserId: number; projectId: number; releaseId: number; canonicalDomain: string; timeoutMs: number }
export type ManagedSiteDnsSetupOptions = Pick<CloudflarePagesOptions, 'fetchImpl' | 'accountId' | 'apiToken' | 'projectPrefix'> & {
  /** Re-read durable paid/delegated registration authority immediately before each mutation. */
  beforeMutation: () => Promise<void>
  setRegistrarNameservers: (nameservers: string[], timeoutMs: number) => Promise<{ verified: boolean }>
  sleep?: (milliseconds: number) => Promise<void>
}
type Envelope = { success: true; result: unknown; result_info?: { total_count?: number; total_pages?: number } }
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function fail(statusCode: number, statusMessage: string): never { throw createError({ statusCode, statusMessage }) }

/** Configure only a newly registered, explicitly delegated domain. No update/delete DNS operations exist here. */
export async function setupCloudflareManagedSiteDnsTls(input: SetupInput, options: ManagedSiteDnsSetupOptions) {
  const domain = canonicalizeManagedDomain(input.canonicalDomain)
  if (domain.canonicalDomain !== input.canonicalDomain || domain.registrableDomain !== input.canonicalDomain || !PROVIDER_ID.test(options.accountId) || ![input.ownerUserId, input.projectId, input.releaseId, input.timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) fail(422, 'Automatic DNS setup requires one exact newly registered apex domain.')
  const deadline = Date.now() + Math.min(Math.max(input.timeoutMs - 1_000, 1_000), 12_000)
  const remaining = () => {
    const budget = deadline - Date.now()
    if (budget < 1) fail(503, 'Automatic DNS setup reached its bounded provider budget.')
    return Math.min(budget, 3_000)
  }
  const projectName = managedSitePagesProjectName(options.projectPrefix, input.ownerUserId, input.projectId)
  const projectPath = `/accounts/${options.accountId}/pages/projects/${projectName}`
  const expectedTarget = `${projectName}.pages.dev`
  const request = async (path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>): Promise<Envelope | null> => {
    if (method === 'POST') await options.beforeMutation()
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), remaining())
    try {
      let response: Response
      try { response = await options.fetchImpl(`${API}${path}`, { method, redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${options.apiToken}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }) } catch { fail(503, 'Cloudflare automatic DNS transport failed; retry will inspect existing provider state.') }
      if (response.status === 404 && method === 'GET') { await response.body?.cancel(); return null }
      if (![200, 201].includes(response.status)) { await response.body?.cancel(); fail(response.status === 409 ? 409 : 503, 'Cloudflare automatic DNS request was rejected; no conflicting provider state was overwritten.') }
      let value: unknown
      try { value = JSON.parse(await readBoundedManagedSiteResponse(response)) } catch { fail(502, 'Cloudflare automatic DNS response is malformed or oversized.') }
      if (!plain(value) || value.success !== true || !Object.hasOwn(value, 'result')) fail(502, 'Cloudflare automatic DNS response lacks provider evidence.')
      return value as Envelope
    } finally { clearTimeout(timer) }
  }
  const object = (value: Envelope | null): Record<string, unknown> => {
    if (!value || !plain(value.result)) fail(409, 'Cloudflare automatic DNS object identity is missing.')
    return value.result
  }
  const list = (value: Envelope | null): Record<string, unknown>[] => {
    if (!value || !Array.isArray(value.result) || value.result.some(item => !plain(item)) || !value.result_info || !Number.isSafeInteger(value.result_info.total_count) || value.result_info.total_count !== value.result.length || ![0, 1].includes(value.result_info.total_pages ?? -1)) fail(409, 'Cloudflare automatic DNS listing is incomplete or ambiguous.')
    return value.result as Record<string, unknown>[]
  }
  await options.beforeMutation()
  const project = object(await request(projectPath))
  if (project.name !== projectName || project.subdomain !== expectedTarget) fail(409, 'Automatic DNS target does not match the exact existing Pages project.')
  const domainPath = `${projectPath}/domains/${encodeURIComponent(domain.canonicalDomain)}`
  const existingAssociation = await request(domainPath)
  if (existingAssociation) {
    const existing = object(existingAssociation)
    if (existing.name !== domain.canonicalDomain || typeof existing.id !== 'string' || typeof existing.zone_tag !== 'string' || !PROVIDER_ID.test(existing.zone_tag)) fail(409, 'An existing Cloudflare Pages domain association conflicts with automatic setup.')
  }
  // Search the exact name across token-visible accounts to reject an accessible
  // foreign zone rather than silently creating another zone in the target account.
  const zones = list(await request(`/zones?${new URLSearchParams({ name: domain.canonicalDomain, per_page: '50', page: '1' })}`))
  if (zones.length > 1 || zones.some(zone => zone.name !== domain.canonicalDomain || !plain(zone.account) || zone.account.id !== options.accountId)) fail(409, 'Automatic DNS found a conflicting or foreign Cloudflare zone.')
  const zone = zones[0] || object(await request('/zones', 'POST', { account: { id: options.accountId }, name: domain.canonicalDomain, type: 'full' }))
  if (typeof zone.id !== 'string' || !PROVIDER_ID.test(zone.id) || zone.name !== domain.canonicalDomain || !plain(zone.account) || zone.account.id !== options.accountId || zone.type !== 'full' || !['active', 'pending', 'initializing'].includes(String(zone.status)) || !Array.isArray(zone.name_servers) || zone.name_servers.length !== 2 || new Set(zone.name_servers).size !== 2 || zone.name_servers.some(value => typeof value !== 'string' || !/^[a-z0-9-]+\.ns\.cloudflare\.com$/u.test(value))) fail(409, 'Automatic DNS zone identity or delegated nameservers are invalid.')
  if (existingAssociation && object(existingAssociation).zone_tag !== zone.id) fail(409, 'The existing Pages domain is bound to another Cloudflare zone.')
  const recordsPath = `/zones/${zone.id}/dns_records`
  const records = list(await request(`${recordsPath}?per_page=100&page=1`))
  const matches = (record: Record<string, unknown>) => record.type === 'CNAME' && record.name === domain.canonicalDomain && record.content === expectedTarget && record.proxied === true
  if (records.length > 1 || records.some(record => !matches(record))) fail(409, 'Automatic DNS refuses to replace conflicting or unrelated existing zone records.')
  if (!records.length) {
    const record = object(await request(recordsPath, 'POST', { type: 'CNAME', name: domain.canonicalDomain, content: expectedTarget, ttl: 1, proxied: true }))
    if (!matches(record) || typeof record.id !== 'string' || !PROVIDER_ID.test(record.id)) fail(409, 'Cloudflare did not confirm the exact Pages DNS record.')
  }
  await options.beforeMutation()
  const registrar = await options.setRegistrarNameservers(zone.name_servers as string[], remaining())
  const pending = { providerReference: `cf-pages-setup-${zone.id}`, dnsStatus: 'propagation_pending' as const, tlsStatus: 'pending' as const }
  if (!registrar.verified) return pending
  const currentZone = object(await request(`/zones/${zone.id}`))
  if (currentZone.id !== zone.id || currentZone.name !== domain.canonicalDomain || !plain(currentZone.account) || currentZone.account.id !== options.accountId) fail(409, 'Cloudflare zone changed during automatic DNS setup.')
  // Nameserver activation is asynchronous. Leave the durable attempt retryable;
  // subsequent ticks reuse this exact zone/record before attaching the Pages domain.
  if (currentZone.status !== 'active') return pending
  const association = await request(domainPath)
  const bound = association ? object(association) : object(await request(`${projectPath}/domains`, 'POST', { name: domain.canonicalDomain }))
  if (bound.name !== domain.canonicalDomain || typeof bound.id !== 'string' || typeof bound.zone_tag !== 'string' || bound.zone_tag !== zone.id) fail(409, 'Cloudflare Pages custom-domain association is mismatched.')
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  for (let poll = 0; poll < 3; poll += 1) {
    await options.beforeMutation()
    const ready = await verifyCloudflareManagedSiteDnsTls({ ...input, timeoutMs: remaining() }, options)
    if (ready.dnsStatus === 'verified' && ready.tlsStatus === 'verified' || ready.dnsStatus === 'partial_failure' || ready.tlsStatus === 'failed') return ready
    if (poll === 2 || deadline - Date.now() < 1_000) return ready
    await sleep(250)
  }
  return pending
}
