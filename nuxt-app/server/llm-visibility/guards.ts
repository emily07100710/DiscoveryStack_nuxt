import { BlockList, isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { VisibilityContractError } from './contracts'

const nonPublicAddresses = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) nonPublicAddresses.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) nonPublicAddresses.addSubnet(network, prefix, 'ipv6')

export function canonicalizePublicHttps(input: string): { url: string, hostname: string } {
  let parsed: URL
  try { parsed = new URL(input.trim()) } catch { throw new VisibilityContractError(422, '網站網址必須是有效的公開 HTTPS URL。') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new VisibilityContractError(422, '網站網址只接受不含帳密的公開 HTTPS URL。')
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const ipVersion = isIP(hostname)
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.invalid') || hostname.endsWith('.test') || hostname.endsWith('.example') || !ipVersion && !hostname.includes('.')) throw new VisibilityContractError(422, '網站網址不得指向 localhost、保留或內部網域。')
  if (ipVersion && nonPublicAddresses.check(hostname, ipVersion === 4 ? 'ipv4' : 'ipv6')) throw new VisibilityContractError(422, '網站網址不得指向私有、loopback、保留或 link-local IP。')
  parsed.hostname = ipVersion === 6 ? `[${hostname}]` : hostname
  parsed.hash = ''
  if (parsed.port === '443') parsed.port = ''
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/')
  return { url: parsed.toString(), hostname }
}

export function canonicalHostname(input: string): string {
  const candidate = input.includes('://') ? input : `https://${input}`
  return canonicalizePublicHttps(candidate).hostname
}

export function citationMatchesDomain(citationUrl: string, canonicalDomain: string): boolean {
  try { return canonicalizePublicHttps(citationUrl).hostname === canonicalHostname(canonicalDomain) } catch { return false }
}

export function normalizedPromptHash(prompt: string): string {
  const normalized = prompt.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
  if (!normalized) throw new VisibilityContractError(422, '追蹤 prompt 不可為空。')
  return createHash('sha256').update(normalized).digest('hex')
}

export function validateObservationTimestamp(value: string, now = new Date()): Date {
  const observedAt = new Date(value)
  if (!Number.isFinite(observedAt.getTime())) throw new VisibilityContractError(422, 'observedAt 必須是有效時間。')
  const age = now.getTime() - observedAt.getTime()
  if (age < -5 * 60 * 1000 || age > 366 * 24 * 60 * 60 * 1000) throw new VisibilityContractError(422, 'observedAt 不可在未來，且不得早於 366 天前。')
  return observedAt
}
