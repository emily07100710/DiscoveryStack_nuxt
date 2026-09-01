import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup, resolveTxt as dnsResolveTxt } from 'node:dns/promises'
import { isSpecialUseIpv4, isSpecialUseIpv6 } from '../../../content-operations/normalization'

export type OwnershipDnsTxtResolver = (hostname: string) => Promise<string[][]>
export type OwnershipAddressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>
export type OwnershipWellKnownFetcher = (canonicalDomain: string) => Promise<{ status: number; body: string }>

function publicAddress(address: string): boolean {
  const version = isIP(address)
  return version === 4 ? !isSpecialUseIpv4(address) : version === 6 ? !isSpecialUseIpv6(address) : false
}

export async function resolveManagedSiteOwnershipTxt(canonicalDomain: string, challengeReference: string, resolver: OwnershipDnsTxtResolver = dnsResolveTxt): Promise<{ verified: boolean; matched: string | null }> {
  const expected = `discoverystack-site-verification=${challengeReference}`
  try {
    const records = await resolver(`_discoverystack-challenge.${canonicalDomain}`)
    const matched = records.map(chunks => chunks.join('')).find(record => record === expected) || null
    return { verified: Boolean(matched), matched }
  } catch { return { verified: false, matched: null } }
}

export async function securelyFetchManagedSiteWellKnown(canonicalDomain: string, dependencies: { lookup?: OwnershipAddressLookup; timeoutMs?: number } = {}): Promise<{ status: number; body: string }> {
  const lookup = dependencies.lookup || (hostname => dnsLookup(hostname, { all: true, verbatim: true }))
  let addresses: Array<{ address: string; family: number }>
  try { addresses = await lookup(canonicalDomain) } catch { return { status: 0, body: '' } }
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return { status: 0, body: '' }
  const pinned = addresses[0]!
  return new Promise(resolve => {
    let settled = false; let total = 0; const chunks: Buffer[] = []
    const finish = (value: { status: number; body: string }) => { if (settled) return; settled = true; resolve(value) }
    const request = httpsRequest({ protocol: 'https:', hostname: canonicalDomain, servername: canonicalDomain, port: 443, method: 'GET', path: '/.well-known/discoverystack-site-verification.txt', headers: { accept: 'text/plain', 'user-agent': 'DiscoveryStack-Ownership-Verification/1' }, lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family as 4 | 6) }, response => {
      const status = response.statusCode || 0
      response.on('data', chunk => { const bytes = Buffer.from(chunk); total += bytes.byteLength; if (total > 64 * 1024) { request.destroy(); finish({ status: 0, body: '' }) } else chunks.push(bytes) })
      response.on('end', () => finish({ status, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', () => finish({ status: 0, body: '' }))
    })
    request.setTimeout(Math.min(Math.max(dependencies.timeoutMs || 10_000, 1_000), 10_000), () => { request.destroy(); finish({ status: 0, body: '' }) })
    request.on('error', () => finish({ status: 0, body: '' }))
    request.end()
  })
}

export async function verifyManagedSiteWellKnown(canonicalDomain: string, challengeReference: string, fetcher: OwnershipWellKnownFetcher = securelyFetchManagedSiteWellKnown): Promise<{ verified: boolean; matched: string | null }> {
  let response: { status: number; body: string }
  try { response = await fetcher(canonicalDomain) } catch { return { verified: false, matched: null } }
  if (response.status !== 200 || Buffer.byteLength(response.body, 'utf8') > 64 * 1024) return { verified: false, matched: null }
  const matched = response.body.split(/\r?\n/u).find(line => line === challengeReference) || null
  return { verified: Boolean(matched), matched }
}
