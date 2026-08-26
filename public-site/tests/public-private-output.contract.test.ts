import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicRoot = join(process.cwd(), 'dist')
const readableExtensions = new Set(['.html', '.js', '.txt', '.xml', '.json'])
const allowedPublicApiPaths = new Set(['/api/leads', '/api/site-analysis', '/api/managed-sites/previews'])
const route = (...parts: string[]) => `/${parts.join('/')}`
const compound = (...parts: string[]) => parts.join('-')
const privateRoutePatterns = [
  route(compound('audit', 'lab')),
  route('leads'),
  route(compound('training', 'pipeline')),
  route(compound('ml', 'lab', 'preview')),
  route('api', compound('audit')),
  route('api', compound('intelligence')),
  route('api', compound('seo', 'geo')),
  route('api', compound('geo')),
  route('auth'),
  route('oauth'),
]
const secretMarkers = [
  ['DATABASE', 'URL'].join('_'),
  ['JWT', 'SECRET'].join('_'),
  ['HUGGINGFACE', 'API', 'TOKEN'].join('_'),
  ['FIRECRAWL', 'API', 'KEY'].join('_'),
  ['PUBLIC', 'OPS', 'UI', 'ORIGIN'].join('_'),
  ['public', 'Ops', 'Ui', 'Origin'].join(''),
]

function readPublicFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return readPublicFiles(path)
    return readableExtensions.has(path.slice(path.lastIndexOf('.'))) ? [readFileSync(path, 'utf8')] : []
  })
}

describe('Astro public build output boundary', () => {
  it('contains only explicitly public API paths', () => {
    expect(existsSync(publicRoot), 'run `pnpm test` so the package script builds dist first').toBe(true)
    const output = readPublicFiles(publicRoot).join('\n')
    const apiPaths = [...output.matchAll(/\/api\/[a-z0-9/_-]+/gi)].map(match => match[0].replace(/[.,;)]+$/, '').replace(/\/+$/u, ''))

    expect(new Set(apiPaths)).toEqual(new Set([...allowedPublicApiPaths]))
    for (const marker of secretMarkers.slice(-2)) expect(output).not.toContain(marker)
  })

  it('does not expose private route paths or server-only secret markers', () => {
    const output = readPublicFiles(publicRoot).join('\n')
    const privatePathPatterns = privateRoutePatterns.map((path) => {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?<!${route('api')})${escaped}(?:[/?#"'\\s]|$)`, 'i')
    })

    for (const pattern of privatePathPatterns) expect(output).not.toMatch(pattern)
    for (const marker of secretMarkers) expect(output).not.toContain(marker)
  })
})
