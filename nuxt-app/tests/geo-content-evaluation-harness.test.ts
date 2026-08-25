import { describe, expect, it } from 'vitest'
import {
  buildGeoContentRegressionReport,
  compareGeoContentCandidates,
  computeEvaluationFingerprint,
  createGeoContentEvaluationCase,
  emptyEvaluationMetric,
  evaluateGeoContentCandidate,
  metricByName,
  metricNames,
  metricRatio,
  makeEvaluationMetric,
  aggregateEvaluationMetrics,
  evaluationCaseFingerprint,
} from '../server/geo-content-evaluation'
import {
  GOLDEN_CASE_ID,
  GOLDEN_INPUT,
  GOLDEN_MARKDOWN,
  GOLDEN_OUTPUT,
  goldenCandidate,
  goldenInput,
  goldenOutput,
  goldenRetrieval,
} from './fixtures/geo-content-evaluation/fixtures'
import { sha256Text } from '../server/geo-content-quality'
import type { GeoContentEvaluationCase, EvaluationMetricName } from '../server/geo-content-evaluation'

function evaluate(overrides: Record<string, unknown> = {}): GeoContentEvaluationCase {
  return evaluateGeoContentCandidate({ ...goldenCandidate(), ...overrides })
}

function validCase(overrides: Record<string, unknown> = {}): GeoContentEvaluationCase {
  return evaluate(overrides)
}

function cloneCase(value: GeoContentEvaluationCase, patch: Partial<GeoContentEvaluationCase>): GeoContentEvaluationCase {
  return { ...value, ...patch }
}

describe('createGeoContentEvaluationCase', () => {
  it('creates a server-evaluated golden case', () => {
    const result = createGeoContentEvaluationCase(goldenCandidate())
    expect(result.suiteVersion).toBe('geo-content-evaluation-harness-v1')
    expect(result.caseId).toBe(GOLDEN_CASE_ID)
    expect(result.candidateId).toBe('candidate-golden')
  })

  it('normalizes content type from the quality contract', () => {
    expect(validCase().contentType).toBe('article')
  })

  it('normalizes locale from the quality contract', () => {
    expect(validCase().locale).toBe('en')
  })

  it('copies topic from the trusted normalized input', () => {
    expect(validCase().topic).toBe(GOLDEN_INPUT.topic)
  })

  it('computes a brief fingerprint server-side', () => {
    expect(validCase().briefFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('computes the prompt fingerprint server-side', () => {
    expect(validCase().promptPackFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('computes the retrieval fingerprint server-side', () => {
    expect(validCase().retrievalFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('binds the evidence snapshot hash', () => {
    expect(validCase().evidenceSnapshotHash).toBe(GOLDEN_INPUT.evidenceSnapshotHash)
  })

  it('preserves canonical selected rule order', () => {
    expect(validCase().selectedRuleIds).toEqual(GOLDEN_INPUT.selectedRuleIds)
  })

  it('preserves exact markdown bytes', () => {
    expect(validCase().exactMarkdown).toBe(GOLDEN_MARKDOWN)
  })

  it('computes the exact markdown content hash', () => {
    expect(validCase().contentHash).toBe(sha256Text(GOLDEN_MARKDOWN))
  })

  it('copies provider provenance without trusting candidate metadata', () => {
    const result = validCase()
    expect(result.providerProvenance?.provider).toBe(GOLDEN_OUTPUT.provider)
    expect(result.providerProvenance?.model).toBe(GOLDEN_OUTPUT.model)
  })

  it('retains the structured quality gate result', () => {
    expect(validCase().qualityGateResult).not.toBeNull()
    expect(validCase().qualityGateResult?.humanReviewRequired).toBe(true)
  })

  it('maps a non-blocked candidate to review_ready', () => {
    expect(validCase().status).toBe('review_ready')
  })

  it('does not expose an opaque total score', () => {
    expect(validCase()).not.toHaveProperty('score')
    expect(validCase()).not.toHaveProperty('geoScore')
  })

  it('rejects an extra candidate field', () => {
    const result = createGeoContentEvaluationCase({ ...goldenCandidate(), score: 0.99 })
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('rejects a null candidate', () => {
    expect(createGeoContentEvaluationCase(null).status).toBe('blocked')
  })

  it('rejects an array candidate', () => {
    expect(createGeoContentEvaluationCase([]).status).toBe('blocked')
  })

  it('rejects a missing case id', () => {
    const value = { ...goldenCandidate() }
    delete (value as Record<string, unknown>).caseId
    expect(createGeoContentEvaluationCase(value).status).toBe('blocked')
  })

  it('rejects an empty candidate id', () => {
    expect(evaluate({ candidateId: '' }).status).toBe('blocked')
  })

  it('rejects an empty variant label', () => {
    expect(evaluate({ variantLabel: '' }).status).toBe('blocked')
  })

  it('rejects an overlong case id', () => {
    expect(evaluate({ caseId: 'x'.repeat(161) }).status).toBe('blocked')
  })

  it('rejects an overlong candidate id', () => {
    expect(evaluate({ candidateId: 'x'.repeat(161) }).status).toBe('blocked')
  })

  it('rejects an overlong variant label', () => {
    expect(evaluate({ variantLabel: 'x'.repeat(161) }).status).toBe('blocked')
  })

  it('rejects an unknown quality input field through the public contract', () => {
    const input = { ...GOLDEN_INPUT, injected: true } as unknown
    const result = evaluate({ qualityInput: input })
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('rejects null markdown as insufficient data', () => {
    const result = evaluate({ markdown: null })
    expect(result.status).toBe('insufficient_data')
    expect(result.reasonCodes).toContain('EVALUATION_DATA_INSUFFICIENT')
  })

  it('rejects an array markdown as insufficient data', () => {
    const result = evaluate({ markdown: [] })
    expect(result.status).toBe('insufficient_data')
  })

  it('rejects null provider output as insufficient data', () => {
    const result = evaluate({ providerOutput: null })
    expect(result.status).toBe('insufficient_data')
  })

  it('does not treat caller contentHash as input', () => {
    const result = evaluate({ contentHash: 'a'.repeat(64) })
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('rejects a markdown mutation through the quality contract', () => {
    const result = evaluate({ markdown: `${GOLDEN_MARKDOWN}\nmutation` })
    expect(result.status).toBe('blocked')
  })

  it('rejects a Markdown mutation against validated provider body', () => {
    const output = goldenOutput(GOLDEN_INPUT)
    const mutatedMarkdown = `${output.body}\nmutation`
    const result = evaluate({ providerOutput: output, markdown: mutatedMarkdown })
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('CONTENT_HASH_MISMATCH')
  })

  it('retains the exact suite version', () => {
    expect(validCase().suiteVersion).toBe('geo-content-evaluation-harness-v1')
  })

  it.each([
    ['direct-answer-presence', ['markdown:first-meaningful-paragraph']],
    ['heading-hierarchy', ['markdown:heading-levels']],
    ['paragraph-binding-integrity', ['provider-output:paragraph-bindings']],
    ['faq-binding', ['markdown:faq']],
    ['selected-autogeo-rule-coverage', ['quality-gate:selected-rule-checks']],
    ['citation-marker-coverage', ['markdown:citation-markers']],
    ['selected-evidence-utilization', ['quality-gate:source-coverage']],
    ['unused-citation-count', ['quality-gate:citation-coverage']],
    ['unsupported-factual-claim-findings', ['quality-gate:reason-codes']],
    ['authority-source-binding', ['quality-input:authority-sources']],
    ['title-h1-alignment', ['markdown:title-h1']],
    ['topic-lexical-relevance', ['quality-input:topic']],
    ['content-bounds', ['markdown:content-bounds']],
    ['provider-provenance-integrity', ['provider-output:provenance']],
    ['human-review-requirement', ['quality-gate:human-review']],
  ] as Array<[EvaluationMetricName, string[]]>)('records evidence locator for %s', (metricName, locator) => {
    const metric = metricByName(validCase(), metricName)
    expect(metric.evidenceLocator).toContain(locator[0])
  })
})

describe('computeEvaluationFingerprint', () => {
  it('returns a valid fingerprint for a plain object', () => {
    const result = computeEvaluationFingerprint({ a: 1, b: 'x' })
    expect(result.status).toBe('valid')
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is independent of object key insertion order', () => {
    const left = computeEvaluationFingerprint({ a: 1, b: 2 })
    const right = computeEvaluationFingerprint({ b: 2, a: 1 })
    expect(left.status).toBe('valid')
    expect(right.status).toBe('valid')
    expect(left.fingerprint).toBe(right.fingerprint)
  })

  it('is sensitive to array order', () => {
    const left = computeEvaluationFingerprint({ values: ['a', 'b'] })
    const right = computeEvaluationFingerprint({ values: ['b', 'a'] })
    expect(left.fingerprint).not.toBe(right.fingerprint)
  })

  it('is sensitive to candidate variant identity', () => {
    const left = computeEvaluationFingerprint({ candidateId: 'a' })
    const right = computeEvaluationFingerprint({ candidateId: 'b' })
    expect(left.fingerprint).not.toBe(right.fingerprint)
  })

  it('handles null values canonically', () => {
    expect(computeEvaluationFingerprint({ value: null }).status).toBe('valid')
  })

  it('handles booleans canonically', () => {
    expect(computeEvaluationFingerprint({ value: true }).status).toBe('valid')
  })

  it('handles nested arrays canonically', () => {
    expect(computeEvaluationFingerprint({ value: [[1], [2]] }).status).toBe('valid')
  })

  it('rejects non-finite numbers', () => {
    expect(computeEvaluationFingerprint({ value: Number.NaN }).status).toBe('invalid')
    expect(computeEvaluationFingerprint({ value: Number.POSITIVE_INFINITY }).status).toBe('invalid')
  })

  it('rejects a circular object', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(computeEvaluationFingerprint(value).status).toBe('invalid')
  })

  it('rejects symbol keys', () => {
    const value = { value: 1, [Symbol('unknown')]: 2 }
    expect(computeEvaluationFingerprint(value).status).toBe('invalid')
  })

  it('returns canonicalValue for valid input', () => {
    const result = computeEvaluationFingerprint({ a: 1 })
    expect(result.canonicalValue).toBe('{"a":1}')
  })

  it('returns null fingerprint for invalid input', () => {
    const result = computeEvaluationFingerprint(Number.NaN)
    expect(result.fingerprint).toBeNull()
  })

  it('fingerprints a server-created evaluation case', () => {
    const result = evaluationCaseFingerprint(validCase())
    expect(result.status).toBe('valid')
  })

  it('changes case fingerprint when reason codes change', () => {
    const first = validCase()
    const second = cloneCase(first, { reasonCodes: ['EVALUATION_CASE_BLOCKED'] })
    expect(evaluationCaseFingerprint(first).fingerprint).not.toBe(evaluationCaseFingerprint(second).fingerprint)
  })

  it('changes case fingerprint when metrics change', () => {
    const first = validCase()
    const second = cloneCase(first, { metrics: [] })
    expect(evaluationCaseFingerprint(first).fingerprint).not.toBe(evaluationCaseFingerprint(second).fingerprint)
  })

  it('changes case fingerprint when variant label changes', () => {
    const first = validCase()
    const second = cloneCase(first, { variantLabel: 'other' })
    expect(evaluationCaseFingerprint(first).fingerprint).not.toBe(evaluationCaseFingerprint(second).fingerprint)
  })
})

describe('evaluation metrics', () => {
  it('returns null for 0/0', () => {
    expect(metricRatio(0, 0)).toBeNull()
  })

  it('returns null for a negative denominator', () => {
    expect(metricRatio(0, -1)).toBeNull()
  })

  it('returns null for an infinite denominator', () => {
    expect(metricRatio(1, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('returns zero for 0/positive', () => {
    expect(metricRatio(0, 4)).toBe(0)
  })

  it('returns one for equal positive values', () => {
    expect(metricRatio(4, 4)).toBe(1)
  })

  it('clamps numerator to denominator', () => {
    expect(makeEvaluationMetric('direct-answer-presence', 8, 2).numerator).toBe(2)
  })

  it('clamps negative numerator to zero', () => {
    expect(makeEvaluationMetric('direct-answer-presence', -1, 2).numerator).toBe(0)
  })

  it('rejects fractional metric values instead of truncating them', () => {
    const metric = makeEvaluationMetric('direct-answer-presence', 1.9, 2.9)
    expect(metric.denominator).toBe(0)
    expect(metric.reasonCodes).toContain('EVALUATION_METRIC_BOUNDS')
    expect(metric.ratio).toBeNull()
  })

  it('preserves reason codes', () => {
    expect(makeEvaluationMetric('direct-answer-presence', 0, 1, ['EVALUATION_INVALID_INPUT']).reasonCodes).toEqual(['EVALUATION_INVALID_INPUT'])
  })

  it('deduplicates reason codes', () => {
    expect(makeEvaluationMetric('direct-answer-presence', 0, 1, ['EVALUATION_INVALID_INPUT', 'EVALUATION_INVALID_INPUT']).reasonCodes).toEqual(['EVALUATION_INVALID_INPUT'])
  })

  it('deduplicates evidence locators', () => {
    expect(makeEvaluationMetric('direct-answer-presence', 1, 1, [], ['a', 'a']).evidenceLocator).toEqual(['a'])
  })

  it('creates an explicit non-applicable metric', () => {
    const metric = emptyEvaluationMetric('faq-binding')
    expect(metric.applicable).toBe(false)
    expect(metric.ratio).toBeNull()
  })

  it('uses the fixed metric catalog', () => {
    expect(metricNames()).toHaveLength(15)
  })

  it('contains direct-answer metric in the catalog', () => {
    expect(metricNames()).toContain('direct-answer-presence')
  })

  it('contains heading metric in the catalog', () => {
    expect(metricNames()).toContain('heading-hierarchy')
  })

  it('contains paragraph-binding-integrity metric in the catalog', () => {
    expect(metricNames()).toContain('paragraph-binding-integrity')
  })

  it('contains FAQ metric in the catalog', () => {
    expect(metricNames()).toContain('faq-binding')
  })

  it('contains rule coverage metric in the catalog', () => {
    expect(metricNames()).toContain('selected-autogeo-rule-coverage')
  })

  it('contains citation metric in the catalog', () => {
    expect(metricNames()).toContain('citation-marker-coverage')
  })

  it('contains evidence utilization metric in the catalog', () => {
    expect(metricNames()).toContain('selected-evidence-utilization')
  })

  it('contains unused citation metric in the catalog', () => {
    expect(metricNames()).toContain('unused-citation-count')
  })

  it('contains unsupported claim metric in the catalog', () => {
    expect(metricNames()).toContain('unsupported-factual-claim-findings')
  })

  it('contains authority metric in the catalog', () => {
    expect(metricNames()).toContain('authority-source-binding')
  })

  it('contains title alignment metric in the catalog', () => {
    expect(metricNames()).toContain('title-h1-alignment')
  })

  it('contains topic relevance metric in the catalog', () => {
    expect(metricNames()).toContain('topic-lexical-relevance')
  })

  it('contains content bounds metric in the catalog', () => {
    expect(metricNames()).toContain('content-bounds')
  })

  it('contains provenance metric in the catalog', () => {
    expect(metricNames()).toContain('provider-provenance-integrity')
  })

  it('contains human review metric in the catalog', () => {
    expect(metricNames()).toContain('human-review-requirement')
  })

  it('aggregates an empty case set with null ratios', () => {
    const aggregates = aggregateEvaluationMetrics([])
    expect(aggregates).toHaveLength(15)
    expect(aggregates.every(metric => metric.ratio === null)).toBe(true)
  })

  it('aggregates non-applicable FAQ as 0/0 with null ratio', () => {
    const aggregate = aggregateEvaluationMetrics([validCase()]).find(metric => metric.metricName === 'faq-binding')
    expect(aggregate?.denominator).toBe(0)
    expect(aggregate?.ratio).toBeNull()
  })
})

describe('candidate comparison', () => {
  it('compares two compatible raw candidates', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'a' }), goldenCandidate({ candidateId: 'candidate-b', variantLabel: 'b' }))
    expect(result.baselineCompatible).toBe(true)
    expect(result.status).toBe('review_ready')
  })

  it('does not compare different topics', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'a' }), goldenCandidate({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ topic: 'different topic' }) }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('does not compare different content types', () => {
    expect(compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'a' }), goldenCandidate({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ contentType: 'service_page' }) })).status).toBe('blocked')
  })

  it('does not compare different locales', () => {
    expect(compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'a' }), goldenCandidate({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ language: 'zh-hant' }) })).status).toBe('blocked')
  })

  it('does not compare different evidence snapshots', () => {
    expect(compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'a' }), goldenCandidate({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ evidenceSnapshotHash: 'f'.repeat(64) }) })).status).toBe('blocked')
  })

  it('does not compare different selected rules', () => {
    expect(compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'a' }), goldenCandidate({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ selectedRuleIds: ['evidence-boundary', 'direct-answer-first'] }) })).status).toBe('blocked')
  })

  it('rejects an output-only evaluation case', () => {
    const outputOnly = validCase({ candidateId: 'candidate-b', variantLabel: 'b' })
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'a' }), outputOnly)
    expect(result.status).toBe('blocked')
    expect(result.winnerCandidateId).toBeNull()
    expect(result.reasonCodes).toContain('EVALUATION_RAW_INPUT_REQUIRED')
  })

  it('rejects forged status and metrics fields', () => {
    const forged = { ...goldenCandidate({ candidateId: 'candidate-b' }), status: 'review_ready', metrics: [], contentHash: 'f'.repeat(64) }
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'candidate-a' }), forged)
    expect(result.status).toBe('blocked')
    expect(result.winnerCandidateId).toBeNull()
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('rejects null left candidate', () => {
    expect(compareGeoContentCandidates(null, goldenCandidate()).status).toBe('blocked')
  })

  it('rejects null right candidate', () => {
    expect(compareGeoContentCandidates(goldenCandidate(), null).status).toBe('blocked')
  })

  it('rejects array left candidate', () => {
    expect(compareGeoContentCandidates([], goldenCandidate()).status).toBe('blocked')
  })

  it('rejects array right candidate', () => {
    expect(compareGeoContentCandidates(goldenCandidate(), []).status).toBe('blocked')
  })

  it('does not choose a blocked winner', () => {
    const blocked = goldenCandidate({ qualityInput: { ...GOLDEN_INPUT, injected: true }, candidateId: 'blocked' })
    const result = compareGeoContentCandidates(blocked, goldenCandidate({ candidateId: 'ready' }))
    expect(result.winnerCandidateId).toBeNull()
    expect(result.decision).toBe('blocked')
  })

  it('does not choose an insufficient-data winner', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ markdown: null, candidateId: 'insufficient' }), goldenCandidate({ candidateId: 'ready' }))
    expect(result.winnerCandidateId).toBeNull()
    expect(result.decision).toBe('insufficient_data')
  })

  it('returns a fixed metric comparison order', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'a' }), goldenCandidate({ candidateId: 'b' }))
    expect(result.metricComparisons.map(metric => metric.metricName)).toEqual(metricNames())
  })

  it('uses a tie decision when every content metric is equal', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'a' }), goldenCandidate({ candidateId: 'b' }))
    expect(result.decision).toBe('tie')
    expect(result.winnerCandidateId).toBeNull()
  })

  it('uses Pareto left dominance for a strictly better heading candidate', () => {
    const worseBody = GOLDEN_MARKDOWN.replace('## Details', '#### Details')
    const result = compareGeoContentCandidates(
      goldenCandidate({ candidateId: 'left', providerOutput: goldenOutput(GOLDEN_INPUT, { body: GOLDEN_MARKDOWN }), markdown: GOLDEN_MARKDOWN }),
      goldenCandidate({ candidateId: 'right', providerOutput: goldenOutput(GOLDEN_INPUT, { body: worseBody }), markdown: worseBody }),
    )
    expect(result.decision).toBe('left')
    expect(result.winnerCandidateId).toBe('left')
  })

  it('uses Pareto right dominance symmetrically', () => {
    const worseBody = GOLDEN_MARKDOWN.replace('## Details', '#### Details')
    const result = compareGeoContentCandidates(
      goldenCandidate({ candidateId: 'left', providerOutput: goldenOutput(GOLDEN_INPUT, { body: worseBody }), markdown: worseBody }),
      goldenCandidate({ candidateId: 'right', providerOutput: goldenOutput(GOLDEN_INPUT, { body: GOLDEN_MARKDOWN }), markdown: GOLDEN_MARKDOWN }),
    )
    expect(result.decision).toBe('right')
    expect(result.winnerCandidateId).toBe('right')
  })

  it('returns inconclusive for mixed metric wins', () => {
    const directAnswerMissing = GOLDEN_MARKDOWN.replace('Acme provides a bounded answer', 'This article begins with an overview')
    const headingRegression = GOLDEN_MARKDOWN.replace('## Details', '#### Details')
    const result = compareGeoContentCandidates(
      goldenCandidate({ candidateId: 'left', providerOutput: goldenOutput(GOLDEN_INPUT, { body: directAnswerMissing }), markdown: directAnswerMissing }),
      goldenCandidate({ candidateId: 'right', providerOutput: goldenOutput(GOLDEN_INPUT, { body: headingRegression }), markdown: headingRegression }),
    )
    expect(result.decision).toBe('inconclusive')
    expect(result.winnerCandidateId).toBeNull()
  })

  it('does not vote governance metrics into a winner', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'a' }), goldenCandidate({ candidateId: 'b' }))
    const governance = result.metricComparisons.filter(metric => ['provider-provenance-integrity', 'human-review-requirement'].includes(metric.metricName))
    expect(governance.every(metric => metric.winner === 'not_comparable')).toBe(true)
  })

  it('returns insufficient_data when both raw candidates have no comparable content data', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'a', providerOutput: null }), goldenCandidate({ candidateId: 'b', providerOutput: null }))
    expect(result.status).toBe('insufficient_data')
    expect(result.decision).toBe('insufficient_data')
    expect(result.winnerCandidateId).toBeNull()
  })

  it('does not return a truth or majority score', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ candidateId: 'a' }), goldenCandidate({ candidateId: 'b' }))
    expect(result).not.toHaveProperty('score')
    expect(result).not.toHaveProperty('ranking')
    expect(result).not.toHaveProperty('leftWins')
    expect(result).not.toHaveProperty('rightWins')
  })

  it('returns comparison limitations', () => {
    expect(compareGeoContentCandidates(goldenCandidate({ candidateId: 'a' }), goldenCandidate({ candidateId: 'b' })).limitations.length).toBeGreaterThan(0)
  })
})

describe('regression reports', () => {
  it('builds a report from one raw candidate', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate()])
    expect(report.caseCount).toBe(1)
    expect(report.regressionFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(report.cases[0]?.evaluationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('builds a report for two raw variants', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'a' }), goldenCandidate({ candidateId: 'b' })])
    expect(report.caseCount).toBe(2)
    expect(report.cases).toHaveLength(2)
  })

  it('sorts report cases by stable code-unit identity', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'b' }), goldenCandidate({ candidateId: 'a' })])
    expect(report.cases.map(value => value.candidateId)).toEqual(['a', 'b'])
  })

  it('is independent of input case order', () => {
    const left = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'a' }), goldenCandidate({ candidateId: 'b' })])
    const right = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'b' }), goldenCandidate({ candidateId: 'a' })])
    expect(left.regressionFingerprint).toBe(right.regressionFingerprint)
  })

  it('counts review-ready cases', () => {
    expect(buildGeoContentRegressionReport([goldenCandidate()]).reviewReadyCount).toBe(1)
  })

  it('counts blocked cases', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate(), goldenCandidate({ qualityInput: { ...GOLDEN_INPUT, injected: true } })])
    expect(report.blockedCount).toBeGreaterThanOrEqual(1)
    expect(report.status).toBe('blocked')
  })

  it('counts insufficient-data cases', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate({ markdown: null })])
    expect(report.insufficientDataCount).toBe(1)
    expect(report.status).toBe('insufficient_data')
  })

  it('preserves blocked status for a malformed provider object', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate({ providerOutput: {} })])
    expect(report.status).toBe('blocked')
    expect(report.cases[0]?.reasonCodes.length).toBeGreaterThan(0)
  })

  it('returns insufficient_data for an empty array', () => {
    const report = buildGeoContentRegressionReport([])
    expect(report.status).toBe('insufficient_data')
    expect(report.regressionFingerprint).toBeNull()
  })

  it('rejects a null report input', () => {
    expect(buildGeoContentRegressionReport(null).status).toBe('blocked')
  })

  it('rejects a scalar report input', () => {
    expect(buildGeoContentRegressionReport('not-an-array').status).toBe('blocked')
  })

  it('rejects an output-only evaluation case array', () => {
    expect(buildGeoContentRegressionReport([validCase()]).reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('rejects duplicate case/candidate/variant identity', () => {
    const first = goldenCandidate({ candidateId: 'same', variantLabel: 'same' })
    const second = goldenCandidate({ candidateId: 'same', variantLabel: 'same' })
    const report = buildGeoContentRegressionReport([first, second])
    expect(report.status).toBe('blocked')
    expect(report.regressionFingerprint).toBeNull()
    expect(report.reasonCodes).toContain('EVALUATION_DUPLICATE_IDENTITY')
  })

  it('rejects more than 500 candidates before evaluation', () => {
    const values = Array.from({ length: 501 }, (_, index) => goldenCandidate({ candidateId: `candidate-${index}`, variantLabel: `variant-${index}` }))
    const report = buildGeoContentRegressionReport(values)
    expect(report.status).toBe('blocked')
    expect(report.regressionFingerprint).toBeNull()
    expect(report.reasonCodes).toContain('EVALUATION_LIMIT_EXCEEDED')
  })

  it('rejects a throwing candidate getter without throwing the report', () => {
    const candidate = new Proxy(goldenCandidate(), { get(_target, property) { if (property === 'candidateId') throw new Error('hostile getter'); return Reflect.get(_target, property) } })
    expect(() => buildGeoContentRegressionReport([candidate])).not.toThrow()
    expect(buildGeoContentRegressionReport([candidate]).status).toBe('blocked')
  })

  it('keeps metric aggregate denominators', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate()])
    expect(report.metricAggregates.every(metric => Number.isInteger(metric.denominator) && metric.denominator >= 0)).toBe(true)
  })

  it('keeps metric aggregate ratios nullable', () => {
    expect(buildGeoContentRegressionReport([]).metricAggregates.every(metric => metric.ratio === null)).toBe(true)
  })

  it('contains all metric aggregates', () => {
    expect(buildGeoContentRegressionReport([goldenCandidate()]).metricAggregates).toHaveLength(15)
  })

  it('includes human-review limitation text', () => {
    expect(buildGeoContentRegressionReport([goldenCandidate()]).limitations.join(' ')).toContain('publication')
  })

  it('does not label a report approved', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate()])
    expect(report).not.toHaveProperty('approved')
    expect(report).not.toHaveProperty('publishable')
  })

  it('does not label a report as ranking improvement', () => {
    expect(buildGeoContentRegressionReport([goldenCandidate()])).not.toHaveProperty('rankingImprovement')
  })

  it('preserves insufficient-data reason codes in the report', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate({ providerOutput: null })])
    expect(report.cases[0]?.reasonCodes).toContain('EVALUATION_DATA_INSUFFICIENT')
  })

  it('changes regression fingerprint when candidate identity changes', () => {
    const first = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'a' })])
    const second = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'b' })])
    expect(first.regressionFingerprint).not.toBe(second.regressionFingerprint)
  })

  it('changes regression fingerprint when provider request identity changes', () => {
    const first = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'a' })])
    const changedOutput = goldenOutput(GOLDEN_INPUT, { requestId: 'request-2' })
    const second = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'a', providerOutput: changedOutput })])
    expect(first.regressionFingerprint).not.toBe(second.regressionFingerprint)
  })
})

describe('golden fixtures and contract variants', () => {
  it.each([
    ['high-quality candidate', {}, 'review_ready', [], [['direct-answer-presence', 1, 1, 1], ['paragraph-binding-integrity', 1, 1, 1], ['faq-binding', 0, 0, null]]],
    ['malformed Markdown candidate', { candidateId: 'malformed', variantLabel: 'malformed', markdown: `${GOLDEN_MARKDOWN}\nUnbound mutation.` }, 'blocked', ['CONTENT_HASH_MISMATCH'], []],
    ['missing direct answer candidate', { candidateId: 'missing-answer', variantLabel: 'missing-answer', providerOutput: goldenOutput(GOLDEN_INPUT, { body: GOLDEN_MARKDOWN.replace('Acme provides a bounded answer', 'This article begins with an overview') }), markdown: GOLDEN_MARKDOWN.replace('Acme provides a bounded answer', 'This article begins with an overview') }, 'review_ready', ['DIRECT_ANSWER_MISSING', 'RULE_CHECK_FAILED'], [['direct-answer-presence', 0, 1, 0]]],
    ['heading regression candidate', { candidateId: 'heading-regression', variantLabel: 'heading-regression', providerOutput: goldenOutput(GOLDEN_INPUT, { body: GOLDEN_MARKDOWN.replace('## Details', '#### Details') }), markdown: GOLDEN_MARKDOWN.replace('## Details', '#### Details') }, 'review_ready', ['INVALID_HEADING_HIERARCHY'], [['heading-hierarchy', 0, 1, 0]]],
    ['citation missing candidate', { candidateId: 'citation-missing', variantLabel: 'citation-missing', providerOutput: goldenOutput(GOLDEN_INPUT, { citations: [] }) }, 'blocked', ['INVALID_CITATION_BINDING'], []],
    ['unselected evidence candidate', { candidateId: 'unselected', variantLabel: 'unselected', providerOutput: goldenOutput(GOLDEN_INPUT, { citations: [{ ...GOLDEN_OUTPUT.citations[0]!, sourceId: 'foreign' }] }) }, 'blocked', ['CITATION_OUTSIDE_APPROVED_EVIDENCE'], []],
    ['unsupported claim candidate', { candidateId: 'unsupported', variantLabel: 'unsupported', providerOutput: goldenOutput(GOLDEN_INPUT, { claims: [{ ...GOLDEN_OUTPUT.claims[0]!, claimType: 'quantitative', text: '100% guaranteed.', citationIds: [] }] }) }, 'blocked', ['PARAGRAPH_BINDING_MISMATCH'], []],
    ['stale evidence candidate', { candidateId: 'stale', variantLabel: 'stale', qualityInput: goldenInput({ evidenceSnapshotHash: 'f'.repeat(64) }) }, 'blocked', ['EVALUATION_INVALID_INPUT', 'EVIDENCE_SNAPSHOT_MISMATCH'], []],
    ['wrong rule candidate', { candidateId: 'wrong-rule', variantLabel: 'wrong-rule', qualityInput: goldenInput({ selectedRuleIds: ['unknown-rule'] }) }, 'blocked', ['EVALUATION_INVALID_INPUT', 'RULE_CHECK_FAILED'], []],
    ['FAQ unbound candidate', { candidateId: 'faq-unbound', variantLabel: 'faq-unbound', qualityInput: goldenInput({ contentType: 'faq' }), providerOutput: goldenOutput(goldenInput({ contentType: 'faq' }), { faqPairs: [] }) }, 'blocked', ['FAQ_BODY_MISMATCH'], []],
    ['Unicode CJK candidate', { candidateId: 'unicode', variantLabel: 'unicode-cjk', qualityInput: goldenInput({ language: 'zh-hant', topic: '合成服務範圍', workingTitle: '合成服務範圍', primaryQuestion: '什麼是合成服務範圍？' }) }, 'blocked', ['EVALUATION_INVALID_INPUT', 'QUERY_FINGERPRINT_MISMATCH'], []],
    ['prompt regression candidate', { candidateId: 'prompt-regression', variantLabel: 'prompt-regression', providerOutput: goldenOutput(GOLDEN_INPUT, { promptFingerprint: 'e'.repeat(64) }) }, 'blocked', ['PROVIDER_PROVENANCE_MISMATCH'], []],
    ['retrieval regression candidate', { candidateId: 'retrieval-regression', variantLabel: 'retrieval-regression', providerOutput: goldenOutput(GOLDEN_INPUT, { retrievalFingerprint: 'e'.repeat(64) }) }, 'blocked', ['RETRIEVAL_FINGERPRINT_MISMATCH'], []],
    ['provider provenance candidate', { candidateId: 'provenance', variantLabel: 'provenance', providerOutput: goldenOutput(GOLDEN_INPUT, { provider: 'other' }) }, 'blocked', ['PROVIDER_PROVENANCE_MISMATCH'], []],
  ])('matches exact golden expected outcome: %s', (_label, overrides, expectedStatus, expectedReasonCodes, expectedMetrics) => {
    const result = evaluate(overrides)
    expect(result.status).toBe(expectedStatus)
    expect(result.reasonCodes).toEqual(expectedReasonCodes)
    for (const [metricName, numerator, denominator, ratio] of expectedMetrics as Array<[EvaluationMetricName, number, number, number | null]>) {
      const metric = metricByName(result, metricName)
      expect(metric.numerator).toBe(numerator)
      expect(metric.denominator).toBe(denominator)
      expect(metric.ratio).toBe(ratio)
    }
    expect(result.suiteVersion).toBe('geo-content-evaluation-harness-v1')
  })

  it('uses the public retrieval builder in fixture context', () => {
    expect(goldenRetrieval().retrievalVersion).toBe('geo-content-quality-retrieval-v1')
  })

  it('uses synthetic markdown only', () => {
    expect(GOLDEN_MARKDOWN).toContain('Synthetic Article')
    expect(GOLDEN_MARKDOWN).not.toContain('http://')
  })

  it('uses synthetic provider metadata only', () => {
    expect(GOLDEN_OUTPUT.provider).toBe('synthetic-provider')
    expect(GOLDEN_OUTPUT.requestId).toBe('request-1')
  })
})


describe('final trust-boundary regressions', () => {
  it('re-evaluates raw output instead of accepting caller status', () => {
    const raw = goldenCandidate()
    const forged = { ...raw, status: 'review_ready', qualityGateResult: null }
    const result = evaluateGeoContentCandidate(forged)
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('re-evaluates raw output instead of accepting caller metric values', () => {
    const raw = goldenCandidate()
    const forged = { ...raw, metrics: [{ metricName: 'direct-answer-presence', applicable: true, numerator: 999, denominator: 999, ratio: 1, reasonCodes: [], evidenceLocator: [] }] }
    const result = evaluateGeoContentCandidate(forged)
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('binds comparison baseline to caseId', () => {
    const result = compareGeoContentCandidates(goldenCandidate({ caseId: 'case-a' }), goldenCandidate({ caseId: 'case-b' }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('requires the full raw envelope for comparison', () => {
    const result = compareGeoContentCandidates({ caseId: 'a' }, goldenCandidate())
    expect(result.status).toBe('blocked')
    expect(result.winnerCandidateId).toBeNull()
    expect(result.reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('does not treat output-only report input as a valid raw candidate', () => {
    const report = buildGeoContentRegressionReport([validCase()])
    expect(report.status).toBe('blocked')
    expect(report.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('returns a deterministic evaluation-case fingerprint', () => {
    const value = validCase()
    expect(evaluationCaseFingerprint(value)).toEqual(evaluationCaseFingerprint(value))
  })

  it('changes evaluation-case fingerprint when Markdown changes', () => {
    const first = validCase()
    const second = evaluate({ markdown: `${GOLDEN_MARKDOWN}\nextra` })
    expect(evaluationCaseFingerprint(first).fingerprint).not.toBe(evaluationCaseFingerprint(second).fingerprint)
  })

  it('rejects a throwing case fingerprint getter without throwing', () => {
    const value = new Proxy(validCase(), { get(_target, property) { if (property === 'metrics') throw new Error('hostile getter'); return Reflect.get(_target, property) } })
    expect(() => evaluationCaseFingerprint(value)).not.toThrow()
    expect(evaluationCaseFingerprint(value).status).toBe('invalid')
  })

  it('rejects a non-record fingerprint input', () => {
    expect(computeEvaluationFingerprint(null).status).toBe('invalid')
    expect(computeEvaluationFingerprint([]).status).toBe('invalid')
  })

  it('produces canonical string output for a valid fingerprint', () => {
    const result = computeEvaluationFingerprint({ z: 1, a: 'two' })
    expect(result.status).toBe('valid')
    expect(result.canonicalValue).toBe('{"a":"two","z":1}')
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps every canonical metric finite and bounded', () => {
    for (const metric of validCase().metrics) {
      expect(Number.isFinite(metric.numerator)).toBe(true)
      expect(Number.isFinite(metric.denominator)).toBe(true)
      expect(metric.numerator).toBeGreaterThanOrEqual(0)
      expect(metric.denominator).toBeGreaterThanOrEqual(0)
      if (metric.ratio !== null) expect(metric.ratio).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps all metrics in the fixed catalog exactly once', () => {
    const metrics = validCase().metrics
    expect(metrics.map(metric => metric.metricName)).toEqual(metricNames())
    expect(new Set(metrics.map(metric => metric.metricName)).size).toBe(metrics.length)
  })

  it('keeps metric ratios at or below one', () => {
    for (const metric of validCase().metrics) {
      if (metric.ratio !== null) expect(metric.ratio).toBeLessThanOrEqual(1)
    }
  })

  it('represents a non-applicable FAQ metric as 0/0 null', () => {
    const metric = metricByName(validCase(), 'faq-binding')
    expect(metric.applicable).toBe(false)
    expect(metric.numerator).toBe(0)
    expect(metric.denominator).toBe(0)
    expect(metric.ratio).toBeNull()
    expect(metric.reasonCodes).toContain('METRIC_NOT_APPLICABLE')
  })

  it('represents an empty metric as 0/0 null', () => {
    const metric = emptyEvaluationMetric('faq-binding')
    expect(metric).toMatchObject({ applicable: false, numerator: 0, denominator: 0, ratio: null })
    expect(metric.reasonCodes).toContain('METRIC_NOT_APPLICABLE')
  })

  it('fails closed for a negative denominator', () => {
    const metric = makeEvaluationMetric('direct-answer-presence', 0, -1)
    expect(metric.denominator).toBe(0)
    expect(metric.ratio).toBeNull()
    expect(metric.reasonCodes).toContain('EVALUATION_METRIC_BOUNDS')
  })

  it('fails closed when numerator exceeds denominator', () => {
    const metric = makeEvaluationMetric('direct-answer-presence', 2, 1)
    expect(metric.numerator).toBe(1)
    expect(metric.denominator).toBe(1)
    expect(metric.reasonCodes).toContain('EVALUATION_METRIC_BOUNDS')
  })

  it('fails closed for NaN and Infinity metrics', () => {
    const nanMetric = makeEvaluationMetric('direct-answer-presence', Number.NaN, 1)
    const infiniteMetric = makeEvaluationMetric('direct-answer-presence', 1, Number.POSITIVE_INFINITY)
    expect(nanMetric.ratio).toBeNull()
    expect(nanMetric.reasonCodes).toContain('EVALUATION_NON_FINITE_METRIC')
    expect(infiniteMetric.ratio).toBeNull()
    expect(infiniteMetric.reasonCodes).toContain('EVALUATION_NON_FINITE_METRIC')
  })

  it('deduplicates metric reason codes and evidence locators', () => {
    const metric = makeEvaluationMetric('direct-answer-presence', 1, 1, ['EVALUATION_INVALID_INPUT', 'EVALUATION_INVALID_INPUT'], ['x', 'x'])
    expect(metric.reasonCodes).toEqual(['EVALUATION_INVALID_INPUT'])
    expect(metric.evidenceLocator).toEqual(['x'])
  })

  it('aggregates applicable numerator and denominator independently', () => {
    const cases = [validCase({ candidateId: 'one' }), validCase({ candidateId: 'two' })]
    const aggregate = aggregateEvaluationMetrics(cases).find(metric => metric.metricName === 'direct-answer-presence')
    expect(aggregate).toMatchObject({ applicableCases: 2, numerator: 2, denominator: 2, ratio: 1 })
  })

  it('keeps aggregate ratio null when every case is 0/0', () => {
    const aggregate = aggregateEvaluationMetrics([]).find(metric => metric.metricName === 'faq-binding')
    expect(aggregate).toMatchObject({ applicableCases: 0, numerator: 0, denominator: 0, ratio: null })
  })

  it('merges aggregate reason codes from non-applicable metrics', () => {
    const aggregate = aggregateEvaluationMetrics([validCase()]).find(metric => metric.metricName === 'faq-binding')
    expect(aggregate?.reasonCodes).toContain('METRIC_NOT_APPLICABLE')
  })

  it('includes an evaluation fingerprint for every accepted report case', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate()])
    expect(report.cases[0]?.evaluationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns review_ready only when every raw case is review_ready', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate({ candidateId: 'ready-a' }), goldenCandidate({ candidateId: 'ready-b' })])
    expect(report.status).toBe('review_ready')
    expect(report.reviewReadyCount).toBe(2)
    expect(report.blockedCount).toBe(0)
    expect(report.insufficientDataCount).toBe(0)
  })

  it('accepts exactly 500 raw candidates within the capacity bound', () => {
    const values = Array.from({ length: 500 }, (_, index) => goldenCandidate({ candidateId: `capacity-${index}`, variantLabel: `capacity-${index}` }))
    const report = buildGeoContentRegressionReport(values)
    expect(report.status).toBe('review_ready')
    expect(report.caseCount).toBe(500)
  })

  it('sorts report identity by caseId before candidateId', () => {
    const report = buildGeoContentRegressionReport([
      goldenCandidate({ caseId: 'case-b', candidateId: 'same', variantLabel: 'same' }),
      goldenCandidate({ caseId: 'case-a', candidateId: 'same', variantLabel: 'same' }),
    ])
    expect(report.cases.map(value => value.caseId)).toEqual(['case-a', 'case-b'])
  })

  it('keeps regression fingerprint independent of raw input order', () => {
    const a = goldenCandidate({ caseId: 'case-a', candidateId: 'a' })
    const b = goldenCandidate({ caseId: 'case-b', candidateId: 'b' })
    expect(buildGeoContentRegressionReport([a, b]).regressionFingerprint).toBe(buildGeoContentRegressionReport([b, a]).regressionFingerprint)
  })

  it('does not expose cryptographic signature semantics for regression fingerprints', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate()])
    expect(report).not.toHaveProperty('signature')
    expect(report.limitations.join(' ')).toContain('cryptographic')
  })
})
