export const PUBLIC_API_PATHS = ['/api/leads', '/api/site-analysis'] as const
export type PublicApiPath = (typeof PUBLIC_API_PATHS)[number]

const isLocalhost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

function readOrigin(name: 'PUBLIC_SITE_URL' | 'PUBLIC_OPS_API_ORIGIN', fallback: string) {
  const value = import.meta.env[name] || fallback
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

export const publicSiteOrigin = readOrigin('PUBLIC_SITE_URL', 'https://www.example.com')
export const publicOpsApiOrigin = readOrigin('PUBLIC_OPS_API_ORIGIN', 'https://api.example.com')

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
