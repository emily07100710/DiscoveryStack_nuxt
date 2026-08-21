import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd())
const schema = readFileSync(join(root, 'server/database/schema.ts'), 'utf8')
const pipeline = readFileSync(join(root, 'server/model-improvement/pipeline.ts'), 'utf8')
const task = readFileSync(join(root, 'server/tasks/model-improvement/collect.ts'), 'utf8')
const config = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')
const listApi = readFileSync(join(root, 'server/api/intelligence/model-improvement/pipeline.get.ts'), 'utf8')
const collectApi = readFileSync(join(root, 'server/api/intelligence/model-improvement/collect.post.ts'), 'utf8')
const reviewApi = readFileSync(join(root, 'server/api/intelligence/model-improvement/candidates/[id]/review.post.ts'), 'utf8')

describe('daily consented-data automation contract', () => {
  it('schedules one named Nitro task and keeps manual controls owner-only', () => {
    expect(config).toContain("['model-improvement:collect']")
    expect(task).toContain("name: 'model-improvement:collect'")
    expect(listApi).toContain('requireOwner(event)')
    expect(collectApi).toContain('requireOwner(event)')
    expect(collectApi).toContain("runTask('model-improvement:collect'")
    expect(reviewApi).toContain('requireOwner(event)')
  })

  it('selects only active explicit consent and never stores raw HTML or contact PII', () => {
    expect(pipeline).toContain("eq(leads.modelImprovementConsent, true)")
    expect(pipeline).toContain('isNull(leads.modelImprovementConsentRevokedAt)')
    expect(pipeline).toContain('rawHtmlStored: false')
    expect(pipeline).toContain('contactPiiStored: false')
    expect(schema).toContain("uniqueIndex('model_improvement_candidate_lead_unique')")
  })

  it('requires human labels, rights confirmation and production thresholds before retraining', () => {
    expect(reviewApi).toContain('rightsConfirmed: z.literal(true)')
    expect(reviewApi).toContain('seoGeoMultilabelSchema')
    expect(pipeline).toContain('PRODUCTION_MINIMUM = 150')
    expect(pipeline).toContain('PRODUCTION_MINIMUM_PER_STAGE = 20')
    expect(pipeline).toContain("preparationStatus: 'ready_for_owner_review'")
    expect(pipeline).toContain("status: 'awaiting_manifest_approval'")
    expect(pipeline).toContain('modelImprovementAutoTrain')
  })

  it('cascades consent withdrawal into the governed source and candidate lifecycle', () => {
    expect(pipeline).toContain('removeOwnerPublicSource')
    expect(pipeline).toContain("status: 'revoked'")
    expect(pipeline).toContain('modelImprovementConsentRevokedAt')
  })
})
