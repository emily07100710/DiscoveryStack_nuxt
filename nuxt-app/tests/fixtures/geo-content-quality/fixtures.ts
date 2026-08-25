import { sha256Text } from '../../../server/geo-content-quality'
import type { ApprovedEvidenceChunk, ContentQualityInput, ProviderOutput, RetrievalPlan } from '../../../server/geo-content-quality'

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
export const HASH_C = 'c'.repeat(64)
export const HASH_D = 'd'.repeat(64)
export const HASH_E = 'e'.repeat(64)

export function syntheticChunk(overrides: Partial<ApprovedEvidenceChunk> = {}): ApprovedEvidenceChunk {
  return {
    sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', sourceType: 'first_party', title: 'Synthetic approved source', locator: 'https://example.com/source-1', artifactHash: HASH_D, chunkHash: HASH_E, corpusSnapshotHash: HASH_B, evidenceSnapshotHash: HASH_A, reviewedText: 'Acme provides a bounded synthetic service description for testing evidence binding.', approvedPurposes: ['content_draft'], capturedAt: '2026-08-24T00:00:00.000Z', reviewStatus: 'approved', ...overrides,
  }
}

export function syntheticRetrievalPlan(overrides: Partial<RetrievalPlan> = {}): RetrievalPlan {
  return { retrievalVersion: 'geo-content-quality-retrieval-v1', queryFingerprint: HASH_C, corpusSnapshotHash: HASH_B, evidenceSnapshotHash: HASH_A, topK: 5, allowedSourceIds: ['source-1'], allowedArtifactIds: ['artifact-1'], requiredPurposes: ['content_draft'], ...overrides }
}

export function syntheticInput(overrides: Partial<ContentQualityInput> = {}): ContentQualityInput {
  const input: ContentQualityInput = {
    contractVersion: 'geo-content-quality-v1', ownerUserId: 'owner-1', clientId: 'client-1', briefId: 'brief-1', jobId: 'job-1', contentType: 'article', language: 'en', industryRisk: 'general', audience: 'Readers comparing a bounded service option.', brandVoice: 'Clear, calm, evidence-led, and modest.', goals: ['Explain the service scope clearly.'], constraints: ['Do not invent outcomes.'], selectedRuleIds: ['direct-answer-first', 'evidence-boundary'], evidenceSnapshotHash: HASH_A, approvedEvidenceChunks: [syntheticChunk()], authoritySources: [{ sourceId: 'authority-1', artifactId: 'authority-artifact-1', title: 'Synthetic authority reference', locator: 'https://example.org/authority-1', sourceHash: HASH_C, capturedAt: '2026-08-24T00:00:00.000Z', reviewStatus: 'approved' }], retrievalPlan: syntheticRetrievalPlan(), providerProvenance: { provider: 'synthetic-provider', model: 'synthetic-model', providerVersion: 'synthetic-provider-v1', generationMode: 'offline-fixture', generatedAt: '2026-08-24T00:00:00.000Z' }, requestedAt: '2026-08-24T00:00:00.000Z',
  }
  return { ...input, ...overrides }
}

export function syntheticProviderOutput(input: ContentQualityInput = syntheticInput(), overrides: Partial<ProviderOutput> = {}): ProviderOutput {
  const body = input.contentType === 'faq'
    ? '# Synthetic FAQ\n\nAcme provides a bounded answer based on the approved source.\n\n## FAQ\n\nQ: What is the service?\nThe service is described only by the approved source [citation-1].'
    : input.contentType === 'service_page'
      ? '# Synthetic Service\n\nAcme provides a bounded service description based on the approved source.\n\n## Problem\nThe problem scope is limited to the approved evidence [citation-1].\n\n## Service scope\nThe scope is described without invented outcomes.\n\n## Process\nThe process is reviewed by a human before publication.\n\n## Deliverables\nThe deliverables remain subject to the approved evidence.\n\n## Limitations\nMissing facts remain limitations.\n\n## CTA\nContact the owner for a human review.'
      : '# Synthetic Article\n\nAcme provides a bounded answer based on the approved source.\n\n## Details\nThe service scope is described only by approved evidence [citation-1].\n\n## Conclusion\nReview the evidence before publication.'
  const output: ProviderOutput = {
    outputVersion: 'geo-content-quality-output-v1', title: 'Synthetic evidence-bound content', summary: 'A bounded synthetic summary based on approved evidence.', body, bodyHash: sha256Text(body), faqPairs: input.contentType === 'faq' ? [{ question: 'What is the service?', answer: 'The service is described only by approved evidence.', citationIds: ['citation-1'] }] : [], claims: [{ claimId: 'claim-1', text: 'The service scope is bounded by the approved source.', claimType: 'factual', bodyLocator: 'body.section:details', citationIds: ['citation-1'] }], citations: [{ citationId: 'citation-1', sourceId: input.approvedEvidenceChunks[0]!.sourceId, artifactId: input.approvedEvidenceChunks[0]!.artifactId, chunkId: input.approvedEvidenceChunks[0]!.chunkId, chunkHash: input.approvedEvidenceChunks[0]!.chunkHash }], appliedRuleIds: [...input.selectedRuleIds], limitations: ['Synthetic output; human review required before publication.'],
  }
  return { ...output, ...overrides, bodyHash: overrides.bodyHash ?? sha256Text(overrides.body ?? body) }
}

export function syntheticMarkdown(input: ContentQualityInput = syntheticInput()): string {
  return syntheticProviderOutput(input).body
}

export function syntheticRetrievalCandidates(input: ContentQualityInput = syntheticInput()) {
  return input.approvedEvidenceChunks.map(chunk => ({ chunk, scoreBasis: 'synthetic lexical retrieval heuristic', limitations: ['Synthetic score basis is not an evidence-veracity measure.'] }))
}

export function withMutation<T extends object>(value: T, mutation: Partial<T>): T { return { ...value, ...mutation } }
