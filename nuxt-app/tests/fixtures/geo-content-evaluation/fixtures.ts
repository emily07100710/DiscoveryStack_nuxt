import {
  buildPromptPack,
  buildRetrievalResult,
  fingerprintContentQualityInput,
  parseMarkdownStructure,
  sha256Text,
} from '../../../server/geo-content-quality'
import type {
  ContentQualityInput,
  ProviderOutput,
  RetrievalResult,
} from '../../../server/geo-content-quality'
import { syntheticInput, syntheticProviderOutput } from '../geo-content-quality/fixtures'
import type {
  GeoContentEvaluationCandidateInput,
} from '../../../server/geo-content-evaluation'

export const GOLDEN_CASE_ID = 'golden-synthetic-service'
export const GOLDEN_INPUT = syntheticInput()
export const GOLDEN_MARKDOWN = syntheticProviderOutput(GOLDEN_INPUT).body
export const GOLDEN_OUTPUT = syntheticProviderOutput(GOLDEN_INPUT)

export function goldenInput(overrides: Partial<ContentQualityInput> = {}): ContentQualityInput {
  const input = { ...GOLDEN_INPUT, ...overrides }
  return {
    ...input,
    retrievalPlan: { ...input.retrievalPlan },
    selectedRuleIds: [...input.selectedRuleIds],
    goals: [...input.goals],
    constraints: [...input.constraints],
    approvedEvidenceChunks: input.approvedEvidenceChunks.map(chunk => ({ ...chunk })),
    authoritySources: input.authoritySources.map(source => ({ ...source })),
    providerProvenance: { ...input.providerProvenance },
  }
}

export function goldenOutput(input: ContentQualityInput = GOLDEN_INPUT, overrides: Partial<ProviderOutput> = {}): ProviderOutput {
  return syntheticProviderOutput(input, overrides)
}

export function goldenRetrieval(input: ContentQualityInput = GOLDEN_INPUT): RetrievalResult {
  return buildRetrievalResult(input, input.approvedEvidenceChunks.map(chunk => ({ chunk })))
}

export function goldenPromptFingerprint(input: ContentQualityInput = GOLDEN_INPUT): string | null {
  const result = buildPromptPack(input, goldenRetrieval(input))
  return result.status === 'ready' ? result.promptPack.promptFingerprint : null
}

export function goldenContentHash(markdown = GOLDEN_MARKDOWN): string {
  return sha256Text(markdown)
}

export function goldenInputFingerprint(input: ContentQualityInput = GOLDEN_INPUT): string | null {
  const result = fingerprintContentQualityInput(input)
  return result.status === 'valid' ? result.fingerprint : null
}

export function goldenParagraphCount(markdown = GOLDEN_MARKDOWN): number {
  return parseMarkdownStructure(markdown).report.paragraphs.length
}

export function goldenCandidate(overrides: Partial<GeoContentEvaluationCandidateInput> = {}): GeoContentEvaluationCandidateInput {
  const input = overrides.qualityInput && typeof overrides.qualityInput === 'object'
    ? overrides.qualityInput as ContentQualityInput
    : GOLDEN_INPUT
  const output = overrides.providerOutput && typeof overrides.providerOutput === 'object'
    ? overrides.providerOutput as ProviderOutput
    : goldenOutput(input)
  return {
    caseId: GOLDEN_CASE_ID,
    candidateId: 'candidate-golden',
    variantLabel: 'golden',
    qualityInput: input,
    providerOutput: output,
    markdown: overrides.markdown ?? output.body,
    ...overrides,
  }
}

export function goldenCandidateVariants(): GeoContentEvaluationCandidateInput[] {
  const valid = goldenCandidate()
  const malformedMarkdown = goldenCandidate({ candidateId: 'candidate-malformed-markdown', variantLabel: 'malformed-markdown', markdown: `${GOLDEN_MARKDOWN}\n\nUnbound mutation.` })
  const missingAnswer = goldenCandidate({ candidateId: 'candidate-missing-answer', variantLabel: 'missing-answer', providerOutput: goldenOutput(GOLDEN_INPUT, { body: GOLDEN_MARKDOWN.replace('Acme provides a bounded answer', 'Acme omits the direct answer') }) })
  const wrongTopic = goldenCandidate({ candidateId: 'candidate-wrong-topic', variantLabel: 'wrong-topic', qualityInput: goldenInput({ topic: 'unrelated topic', primaryQuestion: 'What is another scope?' }) })
  const staleEvidence = goldenCandidate({ candidateId: 'candidate-stale-evidence', variantLabel: 'stale-evidence', qualityInput: goldenInput({ evidenceSnapshotHash: 'f'.repeat(64) }) })
  const wrongRules = goldenCandidate({ candidateId: 'candidate-wrong-rules', variantLabel: 'wrong-rule-ids', qualityInput: goldenInput({ selectedRuleIds: ['unknown-rule'] }) })
  const unsupportedClaim = goldenCandidate({ candidateId: 'candidate-unsupported-claim', variantLabel: 'unsupported-claim', providerOutput: goldenOutput(GOLDEN_INPUT, { claims: [{ ...GOLDEN_OUTPUT.claims[0]!, claimId: 'unsupported', claimType: 'quantitative', text: 'This produced 100% guaranteed results.', citationIds: [] }] }) })
  const unselectedCitation = goldenCandidate({ candidateId: 'candidate-unselected-citation', variantLabel: 'unselected-citation', providerOutput: goldenOutput(GOLDEN_INPUT, { citations: [{ ...GOLDEN_OUTPUT.citations[0]!, citationId: 'citation-foreign', sourceId: 'foreign-source', artifactId: 'foreign-artifact', chunkId: 'foreign-chunk' }] }) })
  const providerMismatch = goldenCandidate({ candidateId: 'candidate-provider-mismatch', variantLabel: 'provider-mismatch', providerOutput: goldenOutput(GOLDEN_INPUT, { provider: 'other-provider' }) })
  const promptRegression = goldenCandidate({ candidateId: 'candidate-prompt-regression', variantLabel: 'prompt-regression', providerOutput: goldenOutput(GOLDEN_INPUT, { promptFingerprint: 'e'.repeat(64) }) })
  const retrievalRegression = goldenCandidate({ candidateId: 'candidate-retrieval-regression', variantLabel: 'retrieval-regression', providerOutput: goldenOutput(GOLDEN_INPUT, { retrievalFingerprint: 'e'.repeat(64) }) })
  const unicode = goldenCandidate({ candidateId: 'candidate-unicode-cjk', variantLabel: 'unicode-cjk', qualityInput: goldenInput({ language: 'zh-hant', topic: '合成服務範圍', workingTitle: '合成服務範圍', primaryQuestion: '什麼是合成服務範圍？' }) })
  return [valid, malformedMarkdown, missingAnswer, wrongTopic, staleEvidence, wrongRules, unsupportedClaim, unselectedCitation, providerMismatch, promptRegression, retrievalRegression, unicode]
}
