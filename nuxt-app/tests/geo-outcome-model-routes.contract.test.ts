import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const routes = [
  'server/api/geo-outcome-model/workspace.get.ts',
  'server/api/geo-outcome-model/observations.manual.post.ts',
  'server/api/geo-outcome-model/observations/[id]/verify.post.ts',
  'server/api/geo-outcome-model/datasets/build.post.ts',
  'server/api/geo-outcome-model/datasets/[id]/review.post.ts',
  'server/api/geo-outcome-model/training-runs/index.post.ts',
  'server/api/geo-outcome-model/training-runs/[id]/execute.post.ts',
  'server/api/geo-outcome-model/training-runs/[id]/index.get.ts',
  'server/api/geo-outcome-model/models/[id]/review.post.ts',
  'server/api/geo-outcome-model/models/[id]/revoke.post.ts',
  'server/api/geo-outcome-model/models/[id]/predict.post.ts',
  'server/api/geo-outcome-model/modelops/workspace.get.ts',
  'server/api/geo-outcome-model/modelops/policies/index.post.ts',
  'server/api/geo-outcome-model/modelops/policies/[id]/enable.post.ts',
  'server/api/geo-outcome-model/modelops/policies/[id]/pause.post.ts',
  'server/api/geo-outcome-model/modelops/policies/[id]/revoke.post.ts',
  'server/api/geo-outcome-model/modelops/cycles/dry-run.post.ts',
  'server/api/geo-outcome-model/modelops/cycles/run.post.ts',
  'server/api/geo-outcome-model/models/[id]/shadow-evaluate.post.ts',
  'server/api/geo-outcome-model/models/[id]/rollback.post.ts',
]

describe('GEO outcome owner boundary', () => {
  it('protects every route with existing owner authority and private headers', () => {
    for (const relativePath of routes) {
      const path = `${root}${relativePath}`
      expect(existsSync(path)).toBe(true)
      const source = readFileSync(path, 'utf8')
      expect(source).toContain('requireGeoOutcomeOwner')
      expect(source).toContain('setGeoOutcomePrivateApiHeaders')
      expect(source).not.toContain('console.log')
    }
  })
  it('does not create public prediction endpoints and never returns raw model weights', () => {
    expect(existsSync(`${root}server/api/geo-outcome-model/public.get.ts`)).toBe(false)
    const prediction = readFileSync(`${root}server/api/geo-outcome-model/models/[id]/predict.post.ts`, 'utf8')
    expect(prediction).toContain('predictionType: \'experimental_prediction\'')
    expect(prediction).not.toContain('coefficients')
    const projection = readFileSync(`${root}server/api/geo-outcome-model/modelops/_response.ts`, 'utf8')
    expect(projection).not.toContain('eligibleObservationFingerprints: cycle')
    expect(projection).not.toContain('artifact.coefficients')
    expect(projection).toContain('productionActive: false')
    const page = readFileSync(`${root}pages/audit-lab/geo-outcome-model.vue`, 'utf8')
    expect(page).toContain('predictionIsVerifiedOutcome: false')
    expect(page).toContain('externalDatasetStatus')
    expect(page).toContain('production model: NOT READY')
    expect(page).not.toMatch(/(?:citation|rank|traffic|conversion|ROI).*(?:提升|保證|guarantee)/iu)
  })
  it('keeps the public Astro surface out of the change set', () => {
    expect(existsSync(`${root}pages/geo-outcome-model.vue`)).toBe(false)
  })
  it('requires independent evidence, consent, PII and revocation governance actions', () => {
    const source = readFileSync(`${root}server/api/geo-outcome-model/observations/[id]/verify.post.ts`, 'utf8')
    expect(source).toContain('verify_evidence')
    expect(source).toContain('approve_consent')
    expect(source).toContain('approve_pii')
    expect(source).toContain('revoke')
    expect(source).not.toContain('verify_primary')
    expect(source).toContain('sourceRecordId')
    expect(source).not.toContain('evidenceLocatorHash')
    expect(source).not.toContain('responseHash')
    expect(source).not.toContain('verifiedByOwner')
  })
})
