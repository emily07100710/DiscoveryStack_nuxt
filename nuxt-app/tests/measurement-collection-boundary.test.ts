import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const routeFiles = [
  'server/api/measurement-collection/workspace.get.ts',
  'server/api/measurement-collection/connections.post.ts',
  'server/api/measurement-collection/connections/[id]/pause.post.ts',
  'server/api/measurement-collection/connections/[id]/revoke.post.ts',
  'server/api/measurement-collection/entries/[id]/schedule.post.ts',
  'server/api/measurement-collection/runs/[id]/dry-run.post.ts',
  'server/api/measurement-collection/runs/[id]/retry.post.ts',
]

describe('measurement collection private boundary', () => {
  it('has only owner-session API routes for the measurement surface', () => {
    for (const relativePath of routeFiles) {
      const path = `${root}${relativePath}`
      expect(existsSync(path)).toBe(true)
      const source = readFileSync(path, 'utf8')
      expect(source).toContain('requireOwner')
      expect(source).toContain('setMeasurementPrivateApiHeaders')
      expect(source).not.toContain('console.log')
    }
  })

  it('does not add a public measurement page or public API route', () => {
    expect(existsSync(`${root}pages/measurement-operations.vue`)).toBe(false)
    expect(existsSync(`${root}server/api/measurement-collection/public.get.ts`)).toBe(false)
  })

  it('keeps UI capability claims and provider limitations truthful', () => {
    const page = readFileSync(`${root}pages/audit-lab/measurement-operations.vue`, 'utf8')
    expect(page).toContain('NOT RUN')
    expect(page).toContain('NONE')
    expect(page).toContain('secondary-only')
    expect(page).toContain('不會呼叫 provider')
    expect(page).not.toMatch(/estimated\s+(?:traffic|roi|conversion)/iu)
  })
})
