import { sha256Text, canonicalizeQualityValue, buildPromptPack, buildRetrievalResult, parseMarkdownStructure, queryFingerprintForFields } from '../../../server/geo-content-quality'
import type { ApprovedEvidenceChunk, ContentQualityInput, ProviderOutput, RetrievalPlan } from '../../../server/geo-content-quality'

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
export const HASH_C = 'c'.repeat(64)
export const HASH_D = 'd'.repeat(64)
export const HASH_E = 'e'.repeat(64)

const DEFAULT_REVIEWED_TEXT = 'Acme provides a bounded synthetic service description for testing evidence binding.'

export function syntheticChunk(overrides: Partial<ApprovedEvidenceChunk> = {}): ApprovedEvidenceChunk {
  const reviewedText = overrides.reviewedText ?? DEFAULT_REVIEWED_TEXT
  const chunk = {
    sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', sourceType: 'first_party' as const, title: 'Synthetic approved source', locator: 'https://example.com/source-1', artifactHash: HASH_D, chunkHash: sha256Text(DEFAULT_REVIEWED_TEXT), corpusSnapshotHash: HASH_B, evidenceSnapshotHash: HASH_A, reviewedText, approvedPurposes: ['content_draft'], capturedAt: '2026-08-24T00:00:00.000Z', reviewStatus: 'approved' as const, ...overrides,
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'reviewedText') && !Object.prototype.hasOwnProperty.call(overrides, 'chunkHash')) chunk.chunkHash = sha256Text(chunk.reviewedText)
  return chunk
}

export function syntheticRetrievalPlan(overrides: Partial<RetrievalPlan> = {}): RetrievalPlan {
  return { retrievalVersion: 'geo-content-quality-retrieval-v1', queryFingerprint: HASH_C, corpusSnapshotHash: HASH_B, evidenceSnapshotHash: HASH_A, topK: 5, allowedSourceIds: ['source-1'], allowedArtifactIds: ['artifact-1'], requiredPurposes: ['content_draft'], ...overrides }
}

export function syntheticInput(overrides: Partial<ContentQualityInput> = {}): ContentQualityInput {
  const base: ContentQualityInput = {
    contractVersion: 'geo-content-quality-v1', ownerUserId: 'owner-1', clientId: 'client-1', briefId: 'brief-1', jobId: 'job-1', topic: 'synthetic service scope', workingTitle: 'Synthetic Article', primaryQuestion: 'What is the synthetic service scope?', contentType: 'article', language: 'en', industryRisk: 'general', audience: 'Readers comparing a bounded service option.', brandVoice: 'Clear, calm, evidence-led, and modest.', goals: ['Explain the service scope clearly.'], constraints: ['Do not invent outcomes.'], selectedRuleIds: ['direct-answer-first', 'evidence-boundary'], evidenceSnapshotHash: HASH_A, approvedEvidenceChunks: [syntheticChunk()], authoritySources: [{ sourceId: 'authority-1', artifactId: 'authority-artifact-1', title: 'Synthetic authority reference', locator: 'https://example.org/authority-1', sourceHash: HASH_C, capturedAt: '2026-08-24T00:00:00.000Z', reviewStatus: 'approved' }], retrievalPlan: syntheticRetrievalPlan(), providerProvenance: { provider: 'synthetic-provider', model: 'synthetic-model', requestId: 'request-1', providerVersion: 'synthetic-provider-v1', generationMode: 'offline-fixture', requestedAt: '2026-08-24T00:00:00.000Z', generatedAt: '2026-08-24T00:00:00.000Z' }, requestedAt: '2026-08-24T00:00:00.000Z',
  }
  const merged = { ...base, ...overrides }
  const retrievalPlanOverride = overrides.retrievalPlan
  const computedQueryFingerprint = queryFingerprintForFields(merged)
  return { ...merged, retrievalPlan: { ...base.retrievalPlan, ...retrievalPlanOverride, queryFingerprint: computedQueryFingerprint } }
}

function repeatedParagraph(label: string, index: number, words: number, citation = true): string {
  const body = Array.from({ length: words }, (_, wordIndex) => `${label}${index}term${wordIndex + 1}`).join(' ')
  return `${label} ${index} ${body}${citation ? ' [cite:citation-1]' : ''}.`
}

function articleBody(input: ContentQualityInput): string {
  const detailParagraphs = Array.from({ length: 11 }, (_, index) => repeatedParagraph('ArticleEvidence', index + 1, 55))
  return [`# ${input.workingTitle}`, 'Acme provides a bounded answer about the synthetic service scope based on the approved source [cite:citation-1].', '## Details', ...detailParagraphs.flatMap(paragraph => [paragraph, '']), '## Conclusion', 'Review the approved evidence before publication.'].join('\n')
}

function serviceBody(input: ContentQualityInput): string {
  const detailParagraphs = Array.from({ length: 8 }, (_, index) => repeatedParagraph('ServiceEvidence', index + 1, 45))
  return [`# ${input.workingTitle}`, 'Acme provides a bounded answer about the synthetic service scope based on the approved source [cite:citation-1].', '## Problem', detailParagraphs[0], '## Service scope', detailParagraphs[1], '## Process', detailParagraphs[2], '## Deliverables', detailParagraphs[3], '## Evidence details', ...detailParagraphs.slice(4), '## Limitations', 'Missing facts remain limitations.', '## CTA', 'Contact the owner for a human review.'].join('\n\n')
}

function faqBody(input: ContentQualityInput): string {
  const pairs = [
    ['What is the service?', 'The service is described only by the approved source. It has a bounded synthetic scope, preserves evidence limits, and requires human review before any publication or delivery decision.'],
    ['Who is the service for?', 'The service is intended for readers comparing a bounded option. This answer uses only the approved evidence and does not make customer, outcome, ranking, traffic, or revenue claims.'],
    ['What is the next step?', 'The next step is to review the approved evidence, verify the scope with the owner, and record any missing facts as limitations before drafting or publishing content.'],
  ]
  return [`# ${input.workingTitle}`, 'Acme provides a bounded answer about the synthetic service scope based on the approved source [cite:citation-1].', '## FAQ', ...pairs.flatMap(([question, answer]) => [`Q: ${question}`, `${answer} [cite:citation-1]`, '']), '## Conclusion', 'Review the approved evidence before publication.'].join('\n')
}

function bodyFor(input: ContentQualityInput): string { return input.contentType === 'faq' ? faqBody(input) : input.contentType === 'service_page' ? serviceBody(input) : articleBody(input) }
function responseHash(output: Omit<ProviderOutput, 'responseHash'>): string { return sha256Text(canonicalizeQualityValue(output)) }

export function syntheticProviderOutput(input: ContentQualityInput = syntheticInput(), overrides: Partial<ProviderOutput> = {}): ProviderOutput {
  const body = bodyFor(input)
  const firstChunk = input.approvedEvidenceChunks[0] ?? syntheticChunk()
  const prompt = buildPromptPack(input)
  const retrieval = buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })))
  const outputBase: Omit<ProviderOutput, 'responseHash'> = {
    outputVersion: 'geo-content-quality-output-v1', title: input.workingTitle, summary: 'A bounded synthetic summary based on approved evidence.', body, bodyHash: sha256Text(body), faqPairs: input.contentType === 'faq' ? [{ question: 'What is the service?', answer: 'The service is described only by the approved source. It has a bounded synthetic scope, preserves evidence limits, and requires human review before any publication or delivery decision. [cite:citation-1]', citationIds: ['citation-1'] }, { question: 'Who is the service for?', answer: 'The service is intended for readers comparing a bounded option. This answer uses only the approved evidence and does not make customer, outcome, ranking, traffic, or revenue claims. [cite:citation-1]', citationIds: ['citation-1'] }, { question: 'What is the next step?', answer: 'The next step is to review the approved evidence, verify the scope with the owner, and record any missing facts as limitations before drafting or publishing content. [cite:citation-1]', citationIds: ['citation-1'] }] : [], claims: [{ claimId: 'claim-1', text: 'The service scope is bounded by the approved source.', claimType: 'factual', bodyLocator: 'body.section:details', citationIds: ['citation-1'] }], citations: [{ citationId: 'citation-1', sourceId: firstChunk.sourceId, artifactId: firstChunk.artifactId, chunkId: firstChunk.chunkId, chunkHash: firstChunk.chunkHash, artifactHash: firstChunk.artifactHash, sourceLocator: firstChunk.locator }], appliedRuleIds: [...input.selectedRuleIds], limitations: ['Synthetic output; human review required before publication.'], paragraphBindings: [], provider: input.providerProvenance.provider, model: input.providerProvenance.model, requestId: input.providerProvenance.requestId, requestedAt: input.requestedAt, generatedAt: input.providerProvenance.generatedAt, promptFingerprint: prompt.status === 'ready' ? prompt.promptPack.promptFingerprint : HASH_E, contentQualityFingerprint: sha256Text(canonicalizeQualityValue(input)), retrievalFingerprint: retrieval.status === 'ready' ? retrieval.retrievalFingerprint! : HASH_E,
  }
  const derivedBody = overrides.body ?? body
  const parsedForBody = parseMarkdownStructure(derivedBody)
  const finalBindings = overrides.paragraphBindings ?? parsedForBody.report.paragraphs.map((paragraph, index) => ({ paragraphIndex: paragraph.paragraphIndex, paragraphHash: paragraph.paragraphHash, claimType: paragraph.citationMarkerIds.length > 0 ? 'factual' : 'process', citationIds: paragraph.citationMarkerIds }))
  const boundCitationIds = new Set(finalBindings.flatMap(binding => binding.citationIds))
  const derivedCitations = overrides.citations ?? outputBase.citations.filter(citation => boundCitationIds.has(citation.citationId))
  const derivedClaims = overrides.claims ?? outputBase.claims.map(claim => ({ ...claim, claimType: boundCitationIds.size > 0 ? claim.claimType : 'process', citationIds: claim.citationIds.filter(citationId => boundCitationIds.has(citationId)) }))
  const derivedFaqPairs = overrides.faqPairs ?? (input.contentType === 'faq' ? parsedForBody.report.faqPairs.map(pair => ({ question: pair.question, answer: pair.answer, citationIds: pair.answer.match(/\[cite:([A-Za-z0-9._:-]{1,160})\]/gu)?.map(marker => marker.slice('cite:'.length)) ?? [] })) : [])
  const merged = { ...outputBase, ...overrides, body: derivedBody, bodyHash: overrides.bodyHash ?? sha256Text(derivedBody), paragraphBindings: finalBindings, citations: derivedCitations, claims: derivedClaims, faqPairs: derivedFaqPairs }
  const withoutResponseHash = { ...merged } as Omit<ProviderOutput, 'responseHash'>
  delete (withoutResponseHash as Partial<ProviderOutput>).responseHash
  return { ...withoutResponseHash, responseHash: overrides.responseHash ?? responseHash(withoutResponseHash) }
}

export function syntheticMarkdown(input: ContentQualityInput = syntheticInput()): string { return syntheticProviderOutput(input).body }
export function syntheticRetrievalCandidates(input: ContentQualityInput = syntheticInput()) { return input.approvedEvidenceChunks.map(chunk => ({ chunk, limitations: ['Synthetic candidate for deterministic lexical retrieval.'] })) }
export function withMutation<T extends object>(value: T, mutation: Partial<T>): T { return { ...value, ...mutation } }
