export const PUBLIC_CORS_PATHS = ['/api/leads', '/api/site-analysis'] as const
export type PublicCorsPath = (typeof PUBLIC_CORS_PATHS)[number]

export type PublicCorsDecision = {
  allowed: boolean
  isPreflight: boolean
  headers: Record<string, string>
  reason: 'not-target' | 'same-origin' | 'allowed' | 'missing-production-origin' | 'origin-mismatch' | 'method-not-allowed' | 'non-public-method'
}

function isLocalhost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function normalizePublicSiteOrigin(value: unknown, nodeEnv = process.env.NODE_ENV || 'production') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const localDevelopment = nodeEnv === 'development' && isLocalhost(url.hostname)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return ''
    if (url.protocol !== 'https:' && !localDevelopment) return ''
    if (nodeEnv !== 'development' && isLocalhost(url.hostname)) return ''
    return url.origin
  } catch {
    return ''
  }
}

export function decidePublicCors(input: {
  path: string
  method: string
  origin?: string
  accessRequestMethod?: string
  configuredOrigin?: string
  nodeEnv?: string
}): PublicCorsDecision {
  if (!PUBLIC_CORS_PATHS.includes(input.path as PublicCorsPath)) return { allowed: true, isPreflight: false, headers: {}, reason: 'not-target' }
  const method = input.method.toUpperCase()
  const isPreflight = method === 'OPTIONS'
  const requestedMethod = String(input.accessRequestMethod || '').toUpperCase()
  if (isPreflight && requestedMethod && requestedMethod !== 'POST') return { allowed: false, isPreflight, headers: {}, reason: 'method-not-allowed' }
  if (!isPreflight && method !== 'POST') return { allowed: true, isPreflight, headers: {}, reason: 'non-public-method' }
  const configuredOrigin = normalizePublicSiteOrigin(input.configuredOrigin, input.nodeEnv)
  const origin = String(input.origin || '').trim()
  if (!origin) {
    if (isPreflight) return { allowed: false, isPreflight, headers: {}, reason: configuredOrigin ? 'origin-mismatch' : 'missing-production-origin' }
    return { allowed: true, isPreflight, headers: {}, reason: 'same-origin' }
  }
  if (!configuredOrigin) return { allowed: false, isPreflight, headers: {}, reason: 'missing-production-origin' }
  if (origin !== configuredOrigin) return { allowed: false, isPreflight, headers: {}, reason: 'origin-mismatch' }
  return {
    allowed: true,
    isPreflight,
    headers: {
      'access-control-allow-origin': configuredOrigin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '600',
      vary: 'Origin',
    },
    reason: 'allowed',
  }
}
