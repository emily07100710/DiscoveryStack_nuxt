import { isSameSite, normalizeUrl, sha256Hex } from './normalization'
import { evaluateParsedRobots, parseRobots } from './robots'
import type { ReconciliationInput, FindingInventoryItem } from './findings'
import type { SiteEvidenceFinding } from './types'

const GRAPH_VERSION = 'site-evidence-observed-links-v1'
const BOT_POLICY_VERSION = 'geo-v2-robots-purpose-audit-v1'
// These are the tokens in GEO Engineering Spec V2 §7.2, not verified crawler identities.
const BOTS = [
  { token: 'OAI-SearchBot', purpose: 'search' },
  { token: 'GPTBot', purpose: 'training' },
  { token: 'Claude-SearchBot', purpose: 'search' },
  { token: 'Claude-User', purpose: 'user_fetch' },
  { token: 'ClaudeBot', purpose: 'training' },
  { token: 'PerplexityBot', purpose: 'search' },
  { token: 'Googlebot', purpose: 'general_search' },
  { token: 'Google-Extended', purpose: 'training' },
] as const
const GRAPH_LIMITS = new Set(['page_cap_reached', 'scan_deadline_reached', 'sitemap_entries_truncated', 'sitemap_url_consideration_cap_reached'])
const MAX_EDGES = 2_000
const MAX_LINK_FINDINGS = 50

function observedHtml(page: FindingInventoryItem) {
  return page.httpStatus === 200 && !page.errorCode && Boolean(page.rawSignals)
    && /^(?:text\/html|application\/xhtml\+xml)$/iu.test(page.contentType || '')
}

function nodeKey(page: FindingInventoryItem) { return normalizeUrl(page.url) }

/** Only uses raw HTML and HTTP status captured by this scan. It never fetches targets. */
export function buildObservedInternalLinkFindings(input: ReconciliationInput): SiteEvidenceFinding[] {
  if (!input.targetOrigin || !input.inventory.length) return []
  const pages = [...input.inventory].sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)))
  const byUrl = new Map(pages.map(page => [nodeKey(page), page]))
  const htmlPages = pages.filter(observedHtml)
  const graphLimitations = (input.limitations || []).filter(value => GRAPH_LIMITS.has(value))
  if (pages.some(page => !observedHtml(page) && ![404, 410].includes(page.httpStatus || 0))) graphLimitations.push('some_raw_pages_unavailable')
  const edges: Array<{ source: FindingInventoryItem; targetKey: string; target?: FindingInventoryItem }> = []
  let edgeLimitReached = false
  for (const source of htmlPages) {
    const keys = [...new Set((source.rawSignals?.internalLinks || []).flatMap(link => {
      try { return isSameSite(link, input.targetOrigin!) ? [normalizeUrl(link)] : [] } catch { return [] }
    }))].sort()
    for (const targetKey of keys) {
      if (targetKey === nodeKey(source)) continue
      if (edges.length === MAX_EDGES) { edgeLimitReached = true; break }
      edges.push({ source, targetKey, target: byUrl.get(targetKey) })
    }
    if (edgeLimitReached) break
  }
  if (edgeLimitReached) graphLimitations.push('internal_link_edge_cap_reached')
  if (edges.some(edge => !edge.target)) graphLimitations.push('some_link_targets_not_observed')
  const incoming = new Map<number, Set<number>>()
  const outgoing = new Map<number, Set<string>>()
  for (const edge of edges) {
    const targets = outgoing.get(edge.source.id) || new Set<string>()
    targets.add(edge.targetKey)
    outgoing.set(edge.source.id, targets)
    if (edge.target) {
      const sources = incoming.get(edge.target.id) || new Set<number>()
      sources.add(edge.source.id)
      incoming.set(edge.target.id, sources)
    }
  }
  const rootKey = normalizeUrl(new URL('/', input.targetOrigin).toString())
  const root = byUrl.get(rootKey)
  const depth = new Map<number, number>()
  if (root && observedHtml(root)) {
    depth.set(root.id, 0)
    const queue = [root]
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const source = queue[cursor]!
      for (const edge of edges.filter(candidate => candidate.source.id === source.id)) {
        if (!edge.target || !observedHtml(edge.target) || depth.has(edge.target.id)) continue
        depth.set(edge.target.id, depth.get(source.id)! + 1)
        queue.push(edge.target)
      }
    }
  } else graphLimitations.push('homepage_not_observed')
  const limitations = [...new Set(graphLimitations)].sort()
  const scopeComplete = limitations.length === 0
  const output: SiteEvidenceFinding[] = [{
    category: 'observed_internal_link_graph', severity: 'info', status: scopeComplete ? 'detected' : 'unknown', urlId: null,
    evidence: {
      graphVersion: GRAPH_VERSION, scope: 'bounded_raw_html_scan', edgeCount: edges.length,
      nodeCount: htmlPages.length, scopeComplete, limitations,
      nodes: htmlPages.map(page => ({ urlId: page.id, urlHash: page.urlHash, incomingLinks: incoming.get(page.id)?.size || 0, outgoingLinks: outgoing.get(page.id)?.size || 0, observedClickDepth: depth.get(page.id) ?? null })),
      edges: edges.map(edge => ({ sourceUrlId: edge.source.id, targetUrlId: edge.target?.id ?? null, targetUrlHash: sha256Hex(edge.targetKey), observedHttpStatus: edge.target?.httpStatus ?? null })),
      interpretation: 'Counts and depth describe this scan only; they are not whole-site coverage, query intent, or ranking evidence.',
    },
  }]
  for (const page of htmlPages) {
    if (page.id !== root?.id && !incoming.get(page.id)?.size) output.push({
      category: 'orphan_page_candidate', severity: scopeComplete ? 'warning' : 'info', status: scopeComplete ? 'detected' : 'unknown', urlId: page.id,
      evidence: { graphVersion: GRAPH_VERSION, urlHash: page.urlHash, observedIncomingLinks: 0, scope: 'bounded_raw_html_scan', limitations },
    })
  }
  let linkFindings = 0
  for (const edge of edges) {
    const broken = Boolean(edge.target && [404, 410].includes(edge.target.httpStatus || 0) && !edge.target.errorCode)
    const unverified = !edge.target || edge.target.errorCode || edge.target.httpStatus === null || [401, 403, 429].includes(edge.target.httpStatus) || edge.target.httpStatus >= 500
    if ((!broken && !unverified) || linkFindings >= MAX_LINK_FINDINGS) continue
    linkFindings++
    output.push({
      category: broken ? 'broken_internal_link' : 'internal_link_target_unknown', severity: broken ? 'warning' : 'info', status: broken ? 'detected' : 'unknown', urlId: edge.source.id,
      evidence: { graphVersion: GRAPH_VERSION, sourceUrlHash: edge.source.urlHash, targetUrlId: edge.target?.id ?? null, targetUrlHash: sha256Hex(edge.targetKey), observedHttpStatus: edge.target?.httpStatus ?? null, reason: broken ? 'observed_http_not_found' : edge.target ? 'target_not_conclusive' : 'target_not_attempted', scope: 'bounded_raw_html_scan' },
    })
  }
  if (edges.filter(edge => !edge.target || Boolean(edge.target.errorCode) || edge.target.httpStatus === null || (edge.target.httpStatus || 0) >= 400).length > MAX_LINK_FINDINGS) {
    output.push({ category: 'internal_link_findings_truncated', severity: 'info', status: 'unknown', urlId: null, evidence: { maximumFindings: MAX_LINK_FINDINGS, graphVersion: GRAPH_VERSION } })
  }
  return output
}

/** A robots rule verdict is not a bot identity, observed crawl, WAF verdict, or desired policy. */
export function buildBotRobotsFindings(input: ReconciliationInput): SiteEvidenceFinding[] {
  const content = input.robotsContent
  const parsed = typeof content === 'string' ? parseRobots(content) : null
  const available = Boolean(parsed && !parsed.malformed)
  const contentHash = available && typeof content === 'string' ? sha256Hex(content) : null
  const capturedAt = input.robotsCapturedAt && Number.isFinite(input.robotsCapturedAt.getTime()) ? input.robotsCapturedAt.toISOString() : null
  return input.inventory.map(page => {
    const url = new URL(page.url)
    const bots = BOTS.map(bot => {
      const rule = available && parsed ? evaluateParsedRobots(parsed, url.pathname + url.search, bot.token) : null
      return { robotsToken: bot.token, purpose: bot.purpose, verdict: rule?.verdict || 'unknown', matchedRuleFingerprint: rule?.matchedRule ? sha256Hex(rule.matchedRule) : null }
    })
    return {
      category: 'bot_robots_policy', severity: 'info', status: available ? 'detected' : 'unknown', urlId: page.id,
      evidence: { policyVersion: BOT_POLICY_VERSION, urlHash: page.urlHash, robotsContentHash: contentHash, capturedAt, bots, limitation: available ? 'robots_rules_only' : 'robots_unavailable_or_malformed', identityVerified: false, crawlerObserved: false, wafVerified: false, policyChanged: false },
    }
  })
}
