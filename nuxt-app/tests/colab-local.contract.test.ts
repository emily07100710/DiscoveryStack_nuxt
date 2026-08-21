import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('Google Colab local training governance contract', () => {
  it('exports only frozen owner-approved manifest records through an owner-only no-store endpoint', () => {
    const route = read('server/api/intelligence/training-snapshot.get.ts')
    expect(route).toContain('requireOwner(event)')
    expect(route).toContain("'cache-control', 'no-store, private'")
    expect(route).toContain('createColabLocalSnapshot')
  })

  it('requires manifest digest, checkpoint hash and five non-training smoke examples before a Colab ledger completion', () => {
    const service = read('server/public-intelligence/colab-local.ts')
    expect(service).toContain("provider: 'google_colab_local'")
    expect(service).toContain('input.result.datasetDigest !== datasetDigest')
    expect(service).toContain('nonTrainingExampleCount !== 5')
    expect(service).toContain('minimumExamples: 150')
  })

  it('does not misstate an owner browser download as a Google Drive artifact', () => {
    const service = read('server/public-intelligence/colab-local.ts')
    const route = read('server/api/intelligence/colab-training-results.post.ts')
    expect(service).toContain("artifactStorage: 'owner_browser_download' | 'owner_controlled_google_drive'")
    expect(service).toContain('storage: input.result.artifactStorage')
    expect(route).toContain("z.enum(['owner_browser_download', 'owner_controlled_google_drive']).default('owner_browser_download')")
  })

  it('allows controlled CLI export fallback only when exactly one private admin exists', () => {
    const repository = read('server/audit/repository.ts')
    expect(repository).toContain('resolveControlledOwnerDatabaseUserId')
    expect(repository).toContain("eq(users.role, 'admin')")
    expect(repository).toContain('limit(2)')
    expect(repository).toContain('admins.length !== 1')
  })
})
