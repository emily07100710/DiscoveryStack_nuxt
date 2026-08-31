import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

const migrationPath = fileURLToPath(new URL('../server/database/migrations/0028_cool_salo.sql', import.meta.url))
const migration = readFileSync(migrationPath, 'utf8')

function claim(ownerUserId: number, releaseId: number, canonicalDomain: string, status: 'pending' | 'verified' | 'blocked' | 'released') {
  const requestFingerprint = stableFingerprint({ ownerUserId, releaseId, canonicalDomain, status })
  return { canonicalDomain, ownerUserId, projectId: releaseId + 100, releaseId, claimKind: releaseId % 2 ? 'generated' : 'existing', status, authorityReceiptFingerprint: status === 'pending' ? null : stableFingerprint({ authority: requestFingerprint }), requestFingerprint, idempotencyKey: `claim-${ownerUserId}-${releaseId}`, projectionFingerprint: stableFingerprint({ requestFingerprint, status }) } as const
}

describe('managed-site migration 0028 generated active-domain authority', () => {
  it('uses a virtual generated column before the unique index, without an application backfill or DML', () => {
    const generated = 'ADD `activeCanonicalDomainKey` varchar(253) GENERATED ALWAYS AS (CASE WHEN `status` = \'released\' THEN NULL ELSE `canonicalDomain` END) VIRTUAL'
    expect(migration).toContain(generated)
    expect(migration.indexOf(generated)).toBeLessThan(migration.indexOf('managed_site_domain_claim_active_canonical_unique'))
    expect(migration).not.toMatch(/^\s*(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|CREATE\s+TRIGGER|CREATE\s+PROCEDURE)\b/imu)
    expect(migration).toContain('DROP INDEX `managed_site_domain_claim_canonical_unique`')
  })

  it('projects pending, verified, and blocked rows as active while released history has a null active key', async () => {
    const memory = createLiveConnectorMemoryRepository()
    const rows = await Promise.all([
      memory.repository.insertDomainClaim(claim(1, 1, 'pending.example.com', 'pending')),
      memory.repository.insertDomainClaim(claim(1, 2, 'verified.example.com', 'verified')),
      memory.repository.insertDomainClaim(claim(1, 3, 'blocked.example.com', 'blocked')),
      memory.repository.insertDomainClaim(claim(1, 4, 'released.example.com', 'released')),
    ])
    expect(rows.map(row => row.activeCanonicalDomainKey)).toEqual(['pending.example.com', 'verified.example.com', 'blocked.example.com', null])
  })

  it('fails closed on concurrent active collisions and preserves history while allowing a post-release owner claim', async () => {
    const memory = createLiveConnectorMemoryRepository()
    const first = await memory.repository.insertDomainClaim(claim(1, 11, 'shared.example.com', 'pending'))
    await expect(memory.repository.insertDomainClaim(claim(2, 12, 'shared.example.com', 'blocked'))).rejects.toMatchObject({ statusCode: 409 })
    const releasedFingerprint = stableFingerprint({ prior: first.projectionFingerprint, status: 'released' })
    const released = await memory.repository.transitionDomainClaim(1, first.id, 'pending', first.projectionFingerprint, { status: 'released', authorityReceiptFingerprint: stableFingerprint({ release: first.id }), projectionFingerprint: releasedFingerprint })
    expect(released).toMatchObject({ canonicalDomain: 'shared.example.com', activeCanonicalDomainKey: null, status: 'released' })
    const second = await memory.repository.insertDomainClaim(claim(2, 12, 'shared.example.com', 'pending'))
    expect(second).toMatchObject({ ownerUserId: 2, activeCanonicalDomainKey: 'shared.example.com' })
    expect(memory.state.domainClaims).toHaveLength(2)
  })
})
