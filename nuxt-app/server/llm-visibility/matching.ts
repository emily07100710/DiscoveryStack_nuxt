export function normalizeMatchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim()
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function requiresTokenBoundary(alias: string) {
  return /[a-z0-9]/i.test(alias)
}

export type AliasMatch = { alias: string, start: number, end: number }

/** Deterministic Unicode-aware alias matching. ASCII aliases require letter/number token boundaries. */
export function findAliasMatches(text: string, aliases: string[]): AliasMatch[] {
  const normalizedText = normalizeMatchText(text)
  const normalizedAliases = [...new Set(aliases.map(normalizeMatchText).filter(Boolean))].sort((left, right) => right.length - left.length || left.localeCompare(right))
  const candidates: AliasMatch[] = []
  for (const alias of normalizedAliases) {
    const escaped = escapeRegExp(alias).replace(/\s+/g, '\\s+')
    const pattern = requiresTokenBoundary(alias) ? `(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])` : `(${escaped})`
    const expression = new RegExp(pattern, 'gu')
    for (const match of normalizedText.matchAll(expression)) {
      const prefixLength = requiresTokenBoundary(alias) ? (match[1]?.length || 0) : 0
      const start = (match.index || 0) + prefixLength
      candidates.push({ alias, start, end: start + alias.length })
    }
  }
  const accepted: AliasMatch[] = []
  for (const candidate of candidates.sort((left, right) => left.start - right.start || right.end - left.end || left.alias.localeCompare(right.alias))) {
    if (!accepted.some(match => candidate.start < match.end && candidate.end > match.start)) accepted.push(candidate)
  }
  return accepted
}

export function countBrandMentions(text: string, brandName: string, aliases: string[]) {
  const matches = findAliasMatches(text, [brandName, ...aliases])
  return { mentioned: matches.length > 0, exactMentionCount: matches.length, firstMentionPosition: matches.length ? matches[0]!.start + 1 : null, matches }
}

export function countCompetitorMentions(text: string, competitors: string[]): Record<string, number> {
  return Object.fromEntries(competitors.map(competitor => [competitor, findAliasMatches(text, [competitor]).length]))
}
