import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const listApi = readFileSync(join(root, 'server/api/leads.get.ts'), 'utf8')
const updateApi = readFileSync(join(root, 'server/api/leads/[id].patch.ts'), 'utf8')
const page = readFileSync(join(root, 'pages/leads.vue'), 'utf8')
const config = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')

describe('private lead desk', () => {
  it('requires the owner boundary for reading and changing private leads', () => {
    expect(listApi).toContain('await requireOwner(event)')
    expect(updateApi).toContain('await requireOwner(event)')
    expect(listApi).toContain("'private, no-store, max-age=0'")
    expect(updateApi).toContain("'private, no-store, max-age=0'")
  })

  it('never returns request fingerprints or dedupe keys to the browser', () => {
    expect(listApi).not.toContain('requestFingerprint:')
    expect(listApi).not.toContain('dedupeKey:')
  })

  it('keeps lead permission types visibly separate', () => {
    expect(page).toContain("lead.recontactConsent ? '已同意' : '只回覆本次詢問'")
    expect(page).toContain("lead.modelImprovementConsent ? '已另外同意' : '未同意'")
  })

  it('marks the page private and non-indexable', () => {
    expect(page).toContain('noindex, nofollow, noarchive')
    expect(config).toContain("'/leads': { headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'private, no-store, max-age=0' } }")
  })
})
