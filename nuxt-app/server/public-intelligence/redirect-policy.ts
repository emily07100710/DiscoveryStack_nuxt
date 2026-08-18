import { assertSafeAuditTarget } from '../audit/targetGuard'

export const MAX_APPROVED_PUBLIC_REDIRECTS = 3

export type ApprovedPublicRedirectSource = {
  sourceUrl: string
  domain: string | null
}

function hostnameFor(url: string) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
}

export function isWithinApprovedSourceHost(source: ApprovedPublicRedirectSource, targetUrl: string) {
  const sourceHost = (source.domain || hostnameFor(source.sourceUrl)).toLowerCase().replace(/^www\./, '')
  const targetHost = hostnameFor(targetUrl)
  return targetHost === sourceHost || targetHost.endsWith(`.${sourceHost}`)
}

/**
 * Resolves one HTTP redirect without following it. The resulting URL must pass the
 * same public-target and approved-host checks as the original owner request.
 */
export function resolveApprovedPublicRedirect(input: { source: ApprovedPublicRedirectSource, currentUrl: string, location: string | null }) {
  if (!input.location) throw new Error('unexpected_redirect')
  let candidate: string
  try {
    candidate = new URL(input.location, input.currentUrl).toString()
  } catch {
    throw new Error('unexpected_redirect')
  }
  let safeTarget
  try {
    safeTarget = assertSafeAuditTarget(candidate)
  } catch {
    throw new Error('unexpected_redirect')
  }
  if (new URL(safeTarget.normalizedUrl).protocol !== 'https:' || !isWithinApprovedSourceHost(input.source, safeTarget.normalizedUrl)) throw new Error('unexpected_redirect')
  return safeTarget.normalizedUrl
}
