import { createError } from 'h3'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { stableFingerprint } from '../../seo-geo-core/repository'

/** Locale-independent UTF-16 code-unit ordering for persisted fingerprints. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Deep key-sorted canonical form. Persisted fingerprints must not depend on JSON key order,
 * because MySQL/TiDB `json` columns return object keys sorted rather than in write order. */
export function canonicalFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFingerprintValue)
  if (!isPlainObject(value)) return value
  const canonical: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    if (value[key] !== undefined) canonical[key] = canonicalFingerprintValue(value[key])
  }
  return canonical
}

/** stableFingerprint over the canonical form; use this for any fingerprint that is persisted
 * and later recomputed from a database read. */
export function managedSiteStableFingerprint(value: unknown): string {
  return stableFingerprint(canonicalFingerprintValue(value))
}

/** NFKC plus ASCII-only case folding; artifact paths are admitted as ASCII. */
export function canonicalArtifactCollisionKey(value: string): string {
  return value.normalize('NFKC').replace(/[A-Z]/gu, character => character.toLowerCase())
}

export function managedSiteAllowedCheckoutOrigins(raw = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const item of String(raw || '').split(',').map(value => value.trim()).filter(Boolean)) {
    let parsed: URL
    try { parsed = new URL(item) } catch { throw createError({ statusCode: 503, statusMessage: 'Managed-site checkout allowlist contains an invalid origin.' }) }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw createError({ statusCode: 503, statusMessage: 'Managed-site checkout allowlist must contain exact HTTPS origins only.' })
    const normalized = assertPublicHttpsUrl(item, 'Managed-site checkout origin')
    origins.add(new URL(normalized).origin)
  }
  return origins
}

export function assertManagedSiteCheckoutOrigin(value: unknown, raw?: string): string {
  if (typeof value !== 'string') throw createError({ statusCode: 422, statusMessage: 'Managed-site checkout origin is required.' })
  let parsed: URL
  try { parsed = new URL(value) } catch { throw createError({ statusCode: 422, statusMessage: 'Managed-site checkout origin is invalid.' }) }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw createError({ statusCode: 422, statusMessage: 'Managed-site checkout origin must be an exact HTTPS origin.' })
  const origin = new URL(assertPublicHttpsUrl(value, 'Managed-site checkout origin')).origin
  if (!managedSiteAllowedCheckoutOrigins(raw).has(origin)) throw createError({ statusCode: 503, statusMessage: 'Managed-site checkout origin is not in the server-only exact allowlist.' })
  return origin
}

export function assertManagedSiteCheckoutUrl(value: unknown, configuredOrigin: string, options: { allowFragment?: boolean } = {}): string {
  if (typeof value !== 'string' || value.length > 2048) throw createError({ statusCode: 409, statusMessage: 'Checkout URL is invalid or oversized.' })
  let parsed: URL
  try { parsed = new URL(value) } catch { throw createError({ statusCode: 409, statusMessage: 'Checkout URL is invalid.' }) }
  if (parsed.username || parsed.password || (parsed.hash && !options.allowFragment) || parsed.origin !== configuredOrigin || parsed.pathname.length > 1024 || parsed.search.length > 1024) throw createError({ statusCode: 409, statusMessage: 'Checkout URL is outside the configured exact checkout origin.' })
  for (const [key, parameter] of parsed.searchParams) {
    if (/^(?:redirect|redirect_uri|return|return_url|next|continue|callback|target|url)$/iu.test(key) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(parameter.trim())) throw createError({ statusCode: 409, statusMessage: 'Checkout URL contains a forbidden redirect-like parameter.' })
  }
  const normalized = new URL(assertPublicHttpsUrl(value, 'Checkout URL'))
  if (normalized.origin !== configuredOrigin) throw createError({ statusCode: 409, statusMessage: 'Checkout URL origin is mismatched.' })
  if (options.allowFragment) normalized.hash = parsed.hash
  return normalized.toString()
}
