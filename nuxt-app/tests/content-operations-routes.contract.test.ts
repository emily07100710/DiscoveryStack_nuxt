import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'server/api/content-operations')
const routes = [
  'workspace.get.ts',
  'clients.post.ts',
  'calendars.post.ts',
  'calendars/[id]/replan.post.ts',
  'calendars/[id]/materialize.post.ts',
  'outcomes.post.ts',
]

describe('Content Operations owner-only route contract', () => {
  it('requires owner authorization, resolves numeric owner identity, and disables caching on every route', () => {
    for (const route of routes) {
      const source = readFileSync(join(root, route), 'utf8')
      expect(source).toContain('requireOwner')
      expect(source).toContain('getOwnerDatabaseUserId')
      expect(source).toContain("'cache-control': 'no-store'")
      if (route !== 'workspace.get.ts') {
        expect(source).toContain('readBody')
        expect(source).toContain('parse')
      }
    }
  })

  it('keeps the materialize route server-clock-only and keeps calendar opportunity construction server-side', () => {
    const materialize = readFileSync(join(root, 'calendars/[id]/materialize.post.ts'), 'utf8')
    const calendars = readFileSync(join(root, 'calendars.post.ts'), 'utf8')
    expect(materialize).toContain('parseMaterializeInput')
    expect(materialize).not.toContain('nowLocalDate')
    expect(materialize).not.toContain('clock')
    expect(calendars).not.toContain('opportunities')
    expect(calendars).not.toContain('evidenceSnapshotHash')
  })

  it('exposes truthful capability values only in the workspace service contract', () => {
    const source = readFileSync(join(process.cwd(), 'server/content-operations/service.ts'), 'utf8')
    expect(source).toContain('generationExecutorConfigured: false')
    expect(source).toContain('firstPartyPublisherConfigured: false')
    expect(source).toContain('outcomeCollectionConfigured: false')
  })
})
