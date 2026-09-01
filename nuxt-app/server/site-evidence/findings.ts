import { classifyUrlVariant, isSameSite, normalizeUrl, urlHash } from './normalization'
import { compareRawRendered } from './html'
import type { HtmlSignals, SiteEvidenceFinding, SiteEvidenceSitemap, SiteEvidenceUrl } from './types'

export type FindingInventoryItem = SiteEvidenceUrl & { rawSignals?: HtmlSignals | null, renderedSignals?: HtmlSignals | null, renderedUnavailableReason?: string | null }
export type ReconciliationInput = { inventory: FindingInventoryItem[], sitemaps: SiteEvidenceSitemap[], targetOrigin?: string, limitations?: string[] }

const duplicateCategory = {
  scheme_variant: 'http_https_duplicate',
  www_variant: 'www_duplicate',
  slash_variant: 'trailing_slash_duplicate',
  param_variant: 'query_param_duplicate',
} as const

function finding(category: string, severity: SiteEvidenceFinding['severity'], evidence: Record<string, unknown>, urlId: number | null = null, status: SiteEvidenceFinding['status'] = 'detected'): SiteEvidenceFinding {
  return { category, severity, status, evidence, urlId }
}

export function buildSiteEvidenceFindings(input: ReconciliationInput): SiteEvidenceFinding[] {
  const output: SiteEvidenceFinding[] = []
  const sitemapUrls = new Map<string, string>()
  for (const sitemap of input.sitemaps) {
    for (const entry of sitemap.entries || []) {
      try { sitemapUrls.set(normalizeUrl(entry.url), entry.url) } catch { /* parser already records malformed entries */ }
    }
  }
  const byNormalized = new Map(input.inventory.map(item => [item.normalizedUrl, item]))
  const scanLimits = [...new Set((input.limitations || []).filter(item => item === 'page_cap_reached' || item === 'scan_deadline_reached'))]
  const sitemapBaseTruncated = (input.limitations || []).some(item => item === 'sitemap_entries_truncated' || item === 'sitemap_url_consideration_cap_reached')
  for (const [normalized, original] of sitemapUrls) {
    const page = byNormalized.get(normalized)
    if (!page) {
      // Failed fetch attempts always produce an inventory row, so a missing row means the
      // scanner never tried this URL (its own page cap, deadline, or site-scope rule) —
      // an honest unknown, never a detected customer-site defect.
      const outOfScope = Boolean(input.targetOrigin && !isSameSite(input.targetOrigin, original))
      const evidence: Record<string, unknown> = { url: original, urlHash: urlHash(original), reason: outOfScope ? 'out_of_site_scope' : 'not_attempted' }
      if (!outOfScope && scanLimits.length) evidence.scanLimits = scanLimits
      output.push(finding('in_sitemap_not_crawlable', 'info', evidence, null, 'unknown'))
      continue
    }
    const offSite = Boolean(page.finalUrl && !isSameSite(page.url, page.finalUrl))
    if (page.errorCode || (page.httpStatus !== null && page.httpStatus >= 400) || offSite) {
      output.push(finding('in_sitemap_not_crawlable', 'warning', { url: original, urlHash: urlHash(original), reason: offSite ? 'redirected_off_site' : page.errorCode || `http_${page.httpStatus}` }, page.id))
    }
  }
  for (const page of input.inventory) {
    if (page.httpStatus === 200 && page.contentType && /^(?:text\/html|application\/xhtml\+xml)$/u.test(page.contentType) && !sitemapUrls.has(page.normalizedUrl)) {
      if (sitemapBaseTruncated) output.push(finding('crawled_not_in_sitemap', 'info', { url: page.url, urlHash: page.urlHash, reason: 'sitemap_base_truncated' }, page.id, 'unknown'))
      else output.push(finding('crawled_not_in_sitemap', 'info', { url: page.url, urlHash: page.urlHash }, page.id))
    }
    if (page.canonicalUrl) {
      const relation = classifyUrlVariant(page.url, page.canonicalUrl)
      if (relation in duplicateCategory) output.push(finding('canonical_points_to_variant', 'warning', { url: page.url, canonicalUrl: page.canonicalUrl, variant: relation }, page.id))
      else if (normalizeUrl(page.canonicalUrl) !== page.normalizedUrl) output.push(finding('canonical_mismatch', 'warning', { url: page.url, canonicalUrl: page.canonicalUrl }, page.id))
    }
    if ((page.redirectChain?.length || 0) >= 2) output.push(finding('redirect_chain', 'warning', { url: page.url, finalUrl: page.finalUrl, hops: page.redirectChain }, page.id))
    if (page.httpStatus === 200 && page.rawSignals?.notFoundSignal) output.push(finding('soft_404_suspect', 'warning', { url: page.url, title: page.rawSignals.title }, page.id))
    if (page.rawSignals) {
      const comparison = compareRawRendered(page.rawSignals, page.renderedSignals)
      for (const category of ['raw_missing_main_content', 'js_only_links', 'raw_rendered_mismatch'] as const) {
        const check = comparison[category]
        if (check.status === 'detected') output.push(finding(category, category === 'raw_missing_main_content' ? 'warning' : category === 'js_only_links' ? 'info' : 'warning', { url: page.url, ...check.evidence }, page.id))
        else if (check.status === 'unknown') output.push(finding(category, 'info', { url: page.url, ...check.evidence }, page.id, 'unknown'))
      }
      if (!page.renderedSignals) output.push(finding('rendered_unknown', 'info', { url: page.url, reasonCode: page.renderedUnavailableReason || 'not_selected_for_rendering' }, page.id, 'unknown'))
    }
  }
  for (let left = 0; left < input.inventory.length; left += 1) {
    for (let right = left + 1; right < input.inventory.length; right += 1) {
      const a = input.inventory[left]!
      const b = input.inventory[right]!
      const relation = classifyUrlVariant(a.url, b.url)
      if (relation in duplicateCategory) output.push(finding(duplicateCategory[relation as keyof typeof duplicateCategory], 'warning', { urls: [a.url, b.url], urlHashes: [a.urlHash, b.urlHash] }))
    }
  }
  return output.sort((left, right) => left.category.localeCompare(right.category) || JSON.stringify(left.evidence).localeCompare(JSON.stringify(right.evidence)))
}
