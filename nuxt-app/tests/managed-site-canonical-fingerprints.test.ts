import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { buildSiteSpec, parseSiteSpecSnapshot } from '../server/managed-sites/site-spec'
import { versionFingerprint } from '../server/managed-sites/normalization'
import { compareCodeUnits, canonicalArtifactCollisionKey, managedSiteStableFingerprint } from '../server/managed-sites/live-connectors/canonical'
import { managedSiteCommerceSnapshotFingerprint } from '../server/managed-sites/prepurchase-service'
import { blueprintCompilerFingerprint, compileManagedSiteBlueprint } from '../server/managed-sites/live-connectors/blueprint'
import { buildManagedSitePreview } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import type { ManagedSiteBlueprintV1 } from '../server/managed-sites/live-connectors/types'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

function tidbJsonRoundTrip<T>(value: T): T {
  const sortObjectKeys = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sortObjectKeys)
    if (!candidate || typeof candidate !== 'object') return candidate
    return Object.fromEntries(Object.keys(candidate).sort(compareCodeUnits).map(key => [key, sortObjectKeys((candidate as Record<string, unknown>)[key])]))
  }
  return JSON.parse(JSON.stringify(sortObjectKeys(value))) as T
}

describe('managed-site locale-independent canonical fingerprints', () => {
  it('uses explicit code-unit ordering for Unicode without consulting locale APIs', () => {
    const values = ['ä', 'Z', 'a', 'İ', 'é', 'e\u0301']
    const expected = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    expect([...values].sort(compareCodeUnits)).toEqual(expected)
    expect(canonicalArtifactCollisionKey('É/INDEX.ASTRO')).toBe(canonicalArtifactCollisionKey('É/index.astro'))
  })

  it('produces one commercial fingerprint for every input line order', () => {
    const core = { previewId: 1, quoteId: 2, draftOrderId: 3, quoteVersion: 'quote-v1', totalMinor: 300, currency: 'TWD', planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', taxStatus: 'not_calculated' }
    const lines = [
      { lineKey: 'é-module', quantity: 1, unitAmountMinor: 100, lineAmountMinor: 100, lineFingerprint: 'a'.repeat(64) },
      { lineKey: 'Z-base', quantity: 1, unitAmountMinor: 200, lineAmountMinor: 200, lineFingerprint: 'b'.repeat(64) },
    ]
    expect(managedSiteCommerceSnapshotFingerprint({ ...core, lines })).toBe(managedSiteCommerceSnapshotFingerprint({ ...core, lines: [...lines].reverse() }))
  })

  it('accepts a persisted SiteSpec after a TiDB JSON round trip', () => {
    const spec = buildSiteSpec({ draftIdentity: 'tidb-fingerprint-spec', brandName: 'TiDB Fingerprint', audience: 'Taiwan customers', brief: 'A JSON round-trip fixture.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin'], styleReferences: [] }, new Date('2026-09-04T00:00:00.000Z'))
    expect(parseSiteSpecSnapshot(tidbJsonRoundTrip(spec))).toEqual(tidbJsonRoundTrip(spec))
  })

  it('canonicalizes persisted JSON key order while plain stableFingerprint remains order-sensitive', () => {
    const insertionOrdered = { zebra: { yellow: 1, amber: 2 }, apple: 'first' }
    const roundTripped = tidbJsonRoundTrip(insertionOrdered)
    expect(stableFingerprint(insertionOrdered)).not.toBe(stableFingerprint(roundTripped))
    expect(managedSiteStableFingerprint(insertionOrdered)).toBe(managedSiteStableFingerprint(roundTripped))
  })

  it('keeps managed-site version fingerprints stable after TiDB sorts JSON snapshot keys', () => {
    const snapshot = {
      siteSpecSnapshot: buildSiteSpec({ draftIdentity: 'tidb-fingerprint-version', brandName: 'TiDB Version', audience: 'Taiwan customers', brief: 'A version JSON round-trip fixture.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin'], styleReferences: [] }, new Date('2026-09-04T00:00:00.000Z')),
      designTokenSnapshot: { accent: '#0b7285', typography: { heading: 'serif', body: 'sans' } },
      selectedModuleSnapshot: ['managed_content_admin'],
    }
    expect(versionFingerprint(1, 2, snapshot, 'a'.repeat(64))).toBe(versionFingerprint(1, 2, tidbJsonRoundTrip(snapshot), 'a'.repeat(64)))
  })
})

describe('managed-site blueprint identity after TiDB JSON storage', () => {
  it('keeps blueprint and compiler fingerprints stable after TiDB sorts stored manifest keys', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'canonical-hash-unit.acme.taipei', buildPreview: false })
    const manifest = line.live.state.candidates.find(row => row.id === line.generation.candidate!.id)!.manifest as { blueprint: ManagedSiteBlueprintV1; blueprintHash: string; compilerFingerprint: string }
    const stored = tidbJsonRoundTrip(manifest)
    expect(Object.keys(stored.blueprint)).not.toEqual(Object.keys(manifest.blueprint))
    // Negative control: the key-order-sensitive hash can never re-match a DB-read object.
    expect(stableFingerprint(stored.blueprint)).not.toBe(stableFingerprint(manifest.blueprint))
    expect(managedSiteStableFingerprint(stored.blueprint)).toBe(manifest.blueprintHash)
    expect(blueprintCompilerFingerprint(stored.blueprint, compileManagedSiteBlueprint(stored.blueprint))).toBe(manifest.compilerFingerprint)
  })

  it('still changes the blueprint hash when page order changes', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'canonical-hash-order.acme.taipei', buildPreview: false })
    const blueprint = (line.live.state.candidates.find(row => row.id === line.generation.candidate!.id)!.manifest as { blueprint: ManagedSiteBlueprintV1 }).blueprint
    expect(blueprint.pages.length).toBeGreaterThan(1)
    const reordered = { ...blueprint, pages: [...blueprint.pages].reverse() }
    expect(managedSiteStableFingerprint(reordered)).not.toBe(managedSiteStableFingerprint(blueprint))
  })

  it('passes preview gates when the candidate manifest is read back with sorted JSON keys', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'canonical-hash-gate.acme.taipei', buildPreview: false })
    const candidate = line.live.state.candidates.find(row => row.id === line.generation.candidate!.id)!
    const written = candidate.manifest as { blueprint: ManagedSiteBlueprintV1; blueprintHash: string }
    candidate.manifest = tidbJsonRoundTrip(written)
    expect(stableFingerprint((candidate.manifest as typeof written).blueprint)).not.toBe(stableFingerprint(written.blueprint))
    const built = await buildManagedSitePreview(line.ownerUserId, { releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'canonical-hash-gate-preview-001' }, line.deploymentAdapter, { repository: line.live.repository, clock: () => managedSiteFixedNow })
    expect(built.release.status).toBe('preview_ready')
    const gates = 'gates' in built ? built.gates : undefined
    if (!gates) throw new Error('Preview build replayed instead of running gates.')
    expect(gates.map(gate => `${gate.gateType}:${gate.result}`)).toEqual(['artifact_admission:passed', 'deterministic_compiler:passed', 'preview_build:passed', 'security_static_active_content:passed', 'geo_content_structure:passed', 'human_review:required'])
  })
})
