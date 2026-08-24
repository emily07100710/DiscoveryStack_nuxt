import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSummaryProjection } from '../server/llm-visibility/service'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const routeFiles = [
  'server/api/llm-visibility/workspace.get.ts',
  'server/api/llm-visibility/projects.post.ts',
  'server/api/llm-visibility/queries.post.ts',
  'server/api/llm-visibility/observations.post.ts',
  'server/api/llm-visibility/projects/[id]/summary.get.ts',
]

describe('LLM visibility private API and projection contracts', () => {
  it('exposes exactly the five requested routes and every route requires owner auth', () => {
    const discovered = readdirSync(join(root, 'server/api/llm-visibility'), { recursive: true }).filter(name => typeof name === 'string' && name.endsWith('.ts')).map(String).sort()
    expect(discovered).toEqual(['observations.post.ts', 'projects.post.ts', 'projects/[id]/summary.get.ts', 'queries.post.ts', 'workspace.get.ts'])
    for (const file of routeFiles) expect(read(file)).toContain('requireOwner(event)')
  })

  it('keeps mutations strict, bounded and owner-scoped without external executor code', () => {
    const contracts = read('server/llm-visibility/contracts.ts')
    const repository = read('server/llm-visibility/repository.ts')
    const observationRoute = read('server/api/llm-visibility/observations.post.ts')
    const moduleFiles = readdirSync(join(root, 'server/llm-visibility')).map(file => read(`server/llm-visibility/${file}`)).join('\n')
    expect(contracts).toContain('.strict()')
    expect(contracts).toContain('.max(1000)')
    expect(repository).toContain('eq(llmVisibilityObservations.ownerUserId, ownerUserId)')
    expect(repository).toContain('eq(llmVisibilityRuns.ownerUserId, ownerUserId)')
    expect(observationRoute).toContain("import { ownerManualObservationImportSchema }")
    expect(observationRoute).toContain('parseVisibilityBody(event, ownerManualObservationImportSchema)')
    expect(observationRoute).not.toContain('parseVisibilityBody(event, observationInputSchema)')
    expect(moduleFiles).not.toMatch(/globalThis\.fetch|from ['"]axios|puppeteer|playwright|page\.goto|browser\.newPage/i)
  })

  it('projects workspace/summary limitations and explicit not_ready values', () => {
    const projection = buildSummaryProjection({ project: { id: 1, ownerUserId: 7, name: 'P', canonicalWebsiteUrl: 'https://example.com/', canonicalDomain: 'example.com', locale: 'en', brandName: 'Acme', brandAliases: [], competitorBrands: [], status: 'active' }, queries: [{ id: 1, locale: 'en', active: true }], observations: [], recentObservations: [], now: new Date('2026-08-24T00:00:00Z') })
    expect(projection.metrics.current).toMatchObject({ status: 'not_ready', brandMentionRate: null })
    expect(projection.metricBasis).toBe('manual_verified_v1')
    expect(projection.limitations.join(' ')).toContain('consumer ChatGPT')
    expect(projection.prohibitedClaims).toEqual(expect.arrayContaining(['search ranking', 'conversion guarantee', 'revenue or ROI guarantee']))
  })

  it('keeps the private page owner-layout, noindex and free of mock metrics', () => {
    const page = read('pages/audit-lab/llm-visibility.vue')
    const ownerLayout = read('layouts/owner.vue')
    expect(page).toContain("definePageMeta({ i18n: false, layout: 'owner' })")
    expect(page).toContain("content: 'noindex, nofollow, noarchive'")
    expect(page).toContain("$fetch<Workspace>('/api/llm-visibility/workspace')")
    expect(page).toContain('not_ready')
    expect(page).toContain("observationMode: 'manual_verified'")
    expect(page).not.toContain('<option value="provider_api_observation">')
    expect(page).not.toContain('observationForm.observationMode')
    expect(page).toContain('seen.has(canonicalKey)')
    expect(page).toContain('請只保留一筆，避免覆蓋計數')
    expect(page).not.toContain('mockData')
    expect(ownerLayout).toContain('to="/audit-lab/llm-visibility"')
    expect(ownerLayout).toContain("activeSection === 'visibility'")
  })
})
