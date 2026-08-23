import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const workbench = readFileSync(join(root, 'pages/audit-lab/seo-geo.vue'), 'utf8')
const jobsRoute = readFileSync(join(root, 'server/api/seo-geo/jobs.post.ts'), 'utf8')
const recommendRoute = readFileSync(join(root, 'server/api/seo-geo/recommend.post.ts'), 'utf8')
const service = readFileSync(join(root, 'server/seo-geo-core/service.ts'), 'utf8')
const repository = readFileSync(join(root, 'server/seo-geo-core/repository.ts'), 'utf8')
const targetRoute = readFileSync(join(root, 'server/api/seo-geo/delivery-targets.post.ts'), 'utf8')

describe('SEO/GEO route integration contracts', () => {
  it('keeps queued Job creation separate from foreground recommendation execution', () => {
    expect(jobsRoute).toContain("import { createContentJob } from '../../seo-geo-core/repository'")
    expect(jobsRoute).not.toContain("import { runOwnerAutoGeoContentJob }")
    expect(jobsRoute).toContain('operation: z.enum(')
    expect(jobsRoute).toContain('providerMode: z.enum(')
    expect(jobsRoute).not.toContain('document: z.object(')
    expect(workbench).toContain("post<{ id: number }>('/api/seo-geo/jobs'")
    expect(workbench).toContain('jobId: numberOrUndefined(recommendationForm.jobId)')
    expect(recommendRoute).toContain('jobId: z.number().int().positive().optional()')
  })

  it('resolves approved evidence on the server before provider execution', () => {
    expect(service).toContain('resolveApprovedEvidenceSnapshot')
    expect(service).toContain("['recommendation', 'content_draft']")
    expect(service).toContain('approvedEvidenceContext: approvedEvidence.context')
    expect(service).toContain('approvedEvidence.hash !== brief.evidenceSnapshotHash')
    expect(repository).toContain('inArray(seoGeoEvidenceApprovals.allowedFor, purposes)')
    expect(repository).toContain('options.requireArtifact')
  })

  it('records the explicit approval review in preview ledger and enforces disabled HTTPS targets', () => {
    expect(repository).toContain('approvalReviewId: review.id')
    expect(repository).toContain("eq(seoGeoContentReviews.decision, 'approved_for_preview')")
    expect(repository).toContain("eq(seoGeoDeliveryTargets.status, 'disabled')")
    expect(targetRoute).toContain('assertSafeHttpsOrigin')
  })
})
