export const PUBLIC_API_PATHS = ['/api/leads', '/api/site-analysis'] as const
export type PublicApiPath = (typeof PUBLIC_API_PATHS)[number]

const isLocalhost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

export function assertPublicJourneyOrigin(name: string, origin: string, siteOrigin: string): string {
  if (!import.meta.env.DEV && !isPlaceholderPublicOrigin(siteOrigin) && isPlaceholderPublicOrigin(origin)) throw new Error(`${name} cannot be a placeholder when PUBLIC_SITE_URL is a production origin`)
  return origin
}

export function readPublicOrigin(name: string, configuredValue: string | undefined, fallback: string) {
  const value = configuredValue || fallback
  try {
    const url = new URL(value)
    const development = import.meta.env.DEV
    const localAllowed = development && isLocalhost(url.hostname)
    if (url.protocol !== 'https:' && !localAllowed) throw new Error(`${name} must use HTTPS`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} must be an origin`)
    if (!development && isLocalhost(url.hostname)) throw new Error(`${name} cannot use localhost in production`)
    return url.origin
  } catch (error) {
    if (error instanceof Error && error.message.includes('must use HTTPS')) throw error
    throw new Error(`${name} must be an absolute HTTPS origin`)
  }
}

// Vite only replaces statically named import.meta.env properties. Dynamic
// access (`import.meta.env[name]`) silently dropped deployment values and left
// the public forms posting to the placeholder origin in production builds.
export const publicSiteOrigin = readPublicOrigin('PUBLIC_SITE_URL', import.meta.env.PUBLIC_SITE_URL, 'https://www.example.com')
export const publicOpsApiOrigin = assertPublicJourneyOrigin('PUBLIC_OPS_API_ORIGIN', readPublicOrigin('PUBLIC_OPS_API_ORIGIN', import.meta.env.PUBLIC_OPS_API_ORIGIN, 'https://api.example.com'), publicSiteOrigin)

function isAllowedPath(pathname: string): pathname is PublicApiPath {
  return PUBLIC_API_PATHS.includes(pathname as PublicApiPath)
}

export async function publicApiFetch<T>(path: PublicApiPath, options: { body: unknown; signal?: AbortSignal }): Promise<T> {
  if (!isAllowedPath(path)) throw new Error('Public API path is not allowed')
  const response = await fetch(`${publicOpsApiOrigin}${path}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body),
    signal: options.signal,
  })
  if (!response.ok) throw new Error('The public request could not be completed')
  try {
    return await response.json() as T
  } catch {
    throw new Error('The public request returned an invalid response')
  }
}
import { isPlaceholderPublicOrigin } from './origin-policy'
