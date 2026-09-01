import type { RobotsVerdict } from './types'

type RobotsRule = { allow: boolean, pattern: string }
type RobotsGroup = { agents: string[], rules: RobotsRule[] }

export type ParsedRobots = { groups: RobotsGroup[], sitemaps: string[], malformed: boolean }

export function parseRobots(content: string): ParsedRobots {
  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []
  let group: RobotsGroup | null = null
  let malformed = false
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 1) { malformed = true; continue }
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (field === 'sitemap') {
      try {
        const url = new URL(value)
        if (['http:', 'https:'].includes(url.protocol)) sitemaps.push(url.toString())
        else malformed = true
      } catch { malformed = true }
      continue
    }
    if (field === 'user-agent') {
      if (!value) { malformed = true; continue }
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] }
        groups.push(group)
      }
      group.agents.push(value.toLowerCase())
      continue
    }
    if (field === 'allow' || field === 'disallow') {
      if (!group?.agents.length) { malformed = true; continue }
      if (value || field === 'allow') group.rules.push({ allow: field === 'allow', pattern: value })
    }
  }
  return { groups, sitemaps: [...new Set(sitemaps)], malformed }
}

function escapeRegex(value: string) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function ruleMatch(pattern: string, pathname: string): number {
  if (!pattern) return -1
  const anchored = pattern.endsWith('$')
  const source = escapeRegex(anchored ? pattern.slice(0, -1) : pattern).replace(/\*/g, '.*')
  const match = pathname.match(new RegExp(`^${source}${anchored ? '$' : ''}`, 'u'))
  return match ? match[0].length : -1
}

export function evaluateRobots(content: string, path: string, userAgent = 'DiscoveryStack-SiteEvidence/1.0'): { verdict: Extract<RobotsVerdict, 'allowed' | 'disallowed'>, matchedRule: string | null } {
  const parsed = parseRobots(content)
  const agent = userAgent.toLowerCase()
  const candidates = parsed.groups.map(group => ({
    group,
    specificity: Math.max(...group.agents.map(value => value === '*' ? 0 : agent.includes(value) ? value.length : -1)),
  })).filter(value => value.specificity >= 0)
  if (!candidates.length) return { verdict: 'allowed', matchedRule: null }
  const specificity = Math.max(...candidates.map(value => value.specificity))
  const rules = candidates.filter(value => value.specificity === specificity).flatMap(value => value.group.rules)
  const matches = rules.map(rule => ({ rule, length: ruleMatch(rule.pattern, path || '/') })).filter(value => value.length >= 0)
  if (!matches.length) return { verdict: 'allowed', matchedRule: null }
  matches.sort((left, right) => right.length - left.length || Number(right.rule.allow) - Number(left.rule.allow))
  const winner = matches[0]!
  return { verdict: winner.rule.allow ? 'allowed' : 'disallowed', matchedRule: `${winner.rule.allow ? 'Allow' : 'Disallow'}: ${winner.rule.pattern}` }
}

export function extractSitemapUrls(content: string) {
  return parseRobots(content).sitemaps
}
