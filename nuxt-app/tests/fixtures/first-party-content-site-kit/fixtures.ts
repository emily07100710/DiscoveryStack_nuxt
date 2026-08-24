import { createHash } from 'node:crypto'
import { buildFirstPartyMarkdownArtifact } from '../../../server/first-party-publishing/artifact'
import { parseFirstPartyContentDocument } from '../../../server/first-party-content-site-kit/parser'
import type { ApprovedFirstPartyPublication } from '../../../server/first-party-publishing/types'
import type { FirstPartyContentDocument, FirstPartyContentType } from '../../../server/first-party-content-site-kit/types'

export const CONTENT_ROOT = 'content'
export const FIXTURE_EVIDENCE_HASH = 'a'.repeat(64)
export const FIXTURE_NOW = '2026-08-25T12:00:00.000Z'
export const DEFAULT_BODY = 'A verified first-party content body for deterministic fixture coverage.'

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function makePublication(overrides: Partial<ApprovedFirstPartyPublication> = {}): ApprovedFirstPartyPublication {
  const body = overrides.body ?? DEFAULT_BODY
  const contentHash = overrides.contentHash ?? sha256(body)
  return {
    ownerScopeKey: 'owner-scope-001',
    scheduleEntryId: 'schedule-001',
    productionPlanId: 'production-plan-001',
    productionDeliverableId: 'publication-001',
    jobId: 'job-001',
    draftId: 'draft-001',
    draftVersion: 1,
    draftStage: 'optimized',
    reviewId: 'review-001',
    reviewDecision: 'approved_for_delivery',
    riskGateStatus: 'passed',
    evidenceSnapshotHash: FIXTURE_EVIDENCE_HASH,
    contentHash,
    title: 'Verified First-party Article',
    body,
    slug: 'verified-first-party-article',
    contentType: 'article',
    language: 'en',
    scheduledAt: FIXTURE_NOW,
    scheduleKey: 'schedule-key-001',
    authoritySourceIds: ['source-001', 'source-002'],
    ruleIds: ['rule-001', 'rule-002'],
    ...overrides,
  }
}

export function makeArtifactMarkdown(publication: ApprovedFirstPartyPublication = makePublication(), contentRoot = CONTENT_ROOT): { readonly markdown: string; readonly sourcePath: string } {
  const artifact = buildFirstPartyMarkdownArtifact(contentRoot, publication)
  if (artifact.status !== 'ok') throw new Error(`fixture artifact failed: ${artifact.code}`)
  return {
    markdown: `${artifact.artifact.frontmatter}\n${artifact.artifact.body}`,
    sourcePath: artifact.artifact.path,
  }
}

export function makeParsedDocument(publication: ApprovedFirstPartyPublication = makePublication(), contentRoot = CONTENT_ROOT): FirstPartyContentDocument {
  const input = makeArtifactMarkdown(publication, contentRoot)
  const result = parseFirstPartyContentDocument({ contentRoot, sourcePath: input.sourcePath, markdown: input.markdown })
  if (result.status !== 'verified') throw new Error(`fixture parse failed: ${result.code}`)
  return result.document
}

export function makeDocument(overrides: Partial<ApprovedFirstPartyPublication> = {}, contentRoot = CONTENT_ROOT): FirstPartyContentDocument {
  return makeParsedDocument(makePublication(overrides), contentRoot)
}

export function makeFaqDocument(overrides: Partial<ApprovedFirstPartyPublication> = {}): FirstPartyContentDocument {
  return makeDocument({
    ...overrides,
    productionDeliverableId: overrides.productionDeliverableId ?? 'publication-faq-001',
    draftId: overrides.draftId ?? 'draft-faq-001',
    reviewId: overrides.reviewId ?? 'review-faq-001',
    slug: overrides.slug ?? 'verified-faq',
    title: overrides.title ?? 'Verified FAQ',
    contentType: 'faq',
  })
}

export function makeServiceDocument(overrides: Partial<ApprovedFirstPartyPublication> = {}): FirstPartyContentDocument {
  return makeDocument({
    ...overrides,
    productionDeliverableId: overrides.productionDeliverableId ?? 'publication-service-001',
    draftId: overrides.draftId ?? 'draft-service-001',
    reviewId: overrides.reviewId ?? 'review-service-001',
    slug: overrides.slug ?? 'verified-service',
    title: overrides.title ?? 'Verified Service',
    contentType: 'service_page',
  })
}

export function makePublicationSet(count: number, contentType: FirstPartyContentType = 'article'): FirstPartyContentDocument[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, '0')
    return makeDocument({
      productionDeliverableId: `publication-${suffix}`,
      scheduleEntryId: `schedule-${suffix}`,
      productionPlanId: `production-plan-${suffix}`,
      jobId: `job-${suffix}`,
      draftId: `draft-${suffix}`,
      reviewId: `review-${suffix}`,
      slug: `article-${suffix}`,
      title: `Article ${suffix}`,
      contentType,
    })
  })
}

export function makeSeoInput(document: FirstPartyContentDocument, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document,
    siteOrigin: 'https://client.example.com',
    siteName: 'Client Example',
    ...overrides,
  }
}
