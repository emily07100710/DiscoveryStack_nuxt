import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { cleanAndExtractPublicDocument, readBoundedPublicHtml } from '../public-intelligence/ingestion'
import { assertSafeAuditTarget } from '../audit/targetGuard'

export type PublicSiteAnalysisResult = {
  requestedUrl: string
  finalUrl: string
  hostname: string
  analysedAt: string
  scope: 'public_homepage_only'
  scores: { overall: number, seo: number, geo: number, brandContent: number, ux: number }
  checks: Record<string, boolean | number | string>
  recommendationKeys: string[]
}

const blockedIpv4Ranges: Array<[number, number]> = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0000000, 0xc00000ff],
  [0xc0000200, 0xc00002ff],
  [0xc0a80000, 0xc0a8ffff],
  [0xc6120000, 0xc613ffff],
  [0xc6336400, 0xc63364ff],
  [0xcb007100, 0xcb0071ff],
  [0xe0000000, 0xffffffff],
]

function ipv4Number(address: string) {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0)
}

export function isPublicIpAddress(address: string) {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)
    return !blockedIpv4Ranges.some(([start, end]) => value >= start && value <= end)
  }
  if (family === 6) {
    const normalized = address.toLowerCase()
    if (normalized.startsWith('::ffff:')) return isPublicIpAddress(normalized.slice(7))
    return /^[23]/.test(normalized) && !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:10:') && !normalized.startsWith('2002:')
  }
  return false
}

async function assertPublicDns(hostname: string) {
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new Error('private_network_target')
    return
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => !isPublicIpAddress(item.address))) throw new Error('private_network_target')
}

async function fetchHomepage(rawUrl: string) {
  let current = assertSafeAuditTarget(rawUrl).normalizedUrl
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const safe = assertSafeAuditTarget(current)
    await assertPublicDns(safe.hostname)
    const response = await fetch(safe.normalizedUrl, {
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-encoding': 'identity',
        'user-agent': 'DiscoveryStack-WebsiteCheck/1.0 (+single-page owner-requested review)',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirectCount === 3) throw new Error('redirect_limit')
      current = new URL(location, safe.normalizedUrl).toString()
      continue
    }
    if (!response.ok) throw new Error(`upstream_http_${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() || ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('unsupported_content_type')
    const { html } = await readBoundedPublicHtml(response)
    return { html, finalUrl: safe.normalizedUrl, hostname: safe.hostname }
  }
  throw new Error('redirect_limit')
}

function bounded(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function analysePublicHomepageHtml(input: { html: string, requestedUrl: string, finalUrl?: string, hostname?: string, analysedAt?: Date }): PublicSiteAnalysisResult {
  const extracted = cleanAndExtractPublicDocument(input.html)
  const { features } = extracted
  const internalLinks = Math.min(features.internalLinkCount, 12)
  const seo = bounded(
    Number(features.documentTitlePresent) * 24
    + Number(features.hasH1) * 24
    + Number(features.canonicalPresent) * 18
    + (features.indexability === 'noindex' ? 0 : features.indexability === 'indexable' ? 20 : 10)
    + (internalLinks / 12) * 14,
  )
  const geo = bounded(
    Number(features.schemaTypes.length > 0) * 25
    + Number(features.signals.faqOrGuidedTopics) * 20
    + Number(features.signals.trustSignals) * 20
    + Number(features.signals.expertContact) * 20
    + Number(features.signals.insights) * 15,
  )
  const brandContent = bounded(
    Number(features.documentTitlePresent) * 15
    + Number(features.hasH1) * 20
    + Number(features.signals.serviceRouting) * 25
    + Number(features.signals.trustSignals) * 25
    + Number(features.signals.insights) * 15,
  )
  const ux = bounded(
    Number(features.signals.primaryCta) * 30
    + Number(features.signals.expertContact) * 20
    + Number(features.signals.serviceRouting) * 20
    + Number(features.signals.priceOrEstimator) * 15
    + Math.min(internalLinks / 8, 1) * 15,
  )
  const checks = {
    titlePresent: features.documentTitlePresent,
    h1Present: features.hasH1,
    canonicalPresent: features.canonicalPresent,
    indexability: features.indexability,
    schemaPresent: features.schemaTypes.length > 0,
    schemaTypeCount: features.schemaTypes.length,
    internalLinkCount: features.internalLinkCount,
    primaryCta: features.signals.primaryCta,
    serviceRouting: features.signals.serviceRouting,
    expertContact: features.signals.expertContact,
    insights: features.signals.insights,
    trustSignals: features.signals.trustSignals,
    priceOrEstimator: features.signals.priceOrEstimator,
    faqOrGuidedTopics: features.signals.faqOrGuidedTopics,
  }
  const candidates: Array<[boolean, string]> = [
    [features.indexability === 'noindex', 'remove_noindex'],
    [!features.documentTitlePresent || !features.hasH1, 'clarify_page_topic'],
    [!features.signals.primaryCta, 'add_primary_action'],
    [!features.signals.serviceRouting, 'improve_service_routing'],
    [!features.canonicalPresent, 'add_canonical'],
    [features.schemaTypes.length === 0, 'add_structured_data'],
    [!features.signals.trustSignals, 'add_trust_evidence'],
    [!features.signals.faqOrGuidedTopics, 'add_answer_content'],
    [!features.signals.expertContact, 'add_human_contact'],
  ]
  const recommendationKeys = candidates.filter(([missing]) => missing).map(([, key]) => key).slice(0, 3)
  if (!recommendationKeys.length) recommendationKeys.push('review_deeper_pages')
  return {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl || input.requestedUrl,
    hostname: input.hostname || new URL(input.finalUrl || input.requestedUrl).hostname,
    analysedAt: (input.analysedAt || new Date()).toISOString(),
    scope: 'public_homepage_only',
    scores: { overall: bounded((seo + geo + brandContent + ux) / 4), seo, geo, brandContent, ux },
    checks,
    recommendationKeys,
  }
}

export async function analysePublicHomepage(rawUrl: string) {
  const fetched = await fetchHomepage(rawUrl)
  return analysePublicHomepageHtml({ html: fetched.html, requestedUrl: rawUrl, finalUrl: fetched.finalUrl, hostname: fetched.hostname })
}
