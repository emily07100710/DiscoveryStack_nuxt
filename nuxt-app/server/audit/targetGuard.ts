const privateIpv4Ranges = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[0-1])\./]

function isBlockedHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || privateIpv4Ranges.some(pattern => pattern.test(host)) || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
}

export type SafeAuditTarget = { requestedUrl: string, normalizedUrl: string, hostname: string }

/** Protects the product boundary: only public http(s) targets without credentials or custom ports may ever enter an audit request. */
export function assertSafeAuditTarget(rawTarget: string): SafeAuditTarget {
  let parsed: URL
  try { parsed = new URL(rawTarget.trim()) } catch { throw new Error('Please enter a valid public website URL.') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only public http(s) websites can be audited.')
  if (parsed.username || parsed.password) throw new Error('Audit URLs cannot include credentials.')
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw new Error('Audit URLs must use a standard public web port.')
  if (isBlockedHostname(parsed.hostname)) throw new Error('Private, local, and link-local network targets cannot be audited.')
  parsed.hash = ''
  return { requestedUrl: rawTarget, normalizedUrl: parsed.toString(), hostname: parsed.hostname.toLowerCase() }
}
