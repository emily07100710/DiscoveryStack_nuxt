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

  it('rejects a provider body mutation through the response contract', () => {
    const output = goldenOutput(GOLDEN_INPUT, { body: `${GOLDEN_MARKDOWN}\nmutation` })
    expect(evaluate({ providerOutput: output, markdown: output.body }).status).toBe('blocked')
  })

  it('retains the exact suite version', () => {
    expect(validCase().suiteVersion).toBe('geo-content-evaluation-harness-v1')
  })

  it.each([
    ['direct-answer-presence', ['markdown:first-meaningful-paragraph']],
    ['heading-hierarchy', ['markdown:heading-levels']],
    ['paragraph-bounds', ['markdown:meaningful-paragraph-count']],
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

  it('truncates fractional values', () => {
    expect(makeEvaluationMetric('direct-answer-presence', 1.9, 2.9).denominator).toBe(2)
  })

  it('preserves reason codes', () => {
    expect(makeEvaluationMetric('direct-answer-presence', 0, 1, ['X']).reasonCodes).toEqual(['X'])
  })

  it('deduplicates reason codes', () => {
    expect(makeEvaluationMetric('direct-answer-presence', 0, 1, ['X', 'X']).reasonCodes).toEqual(['X'])
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

  it('contains paragraph metric in the catalog', () => {
    expect(metricNames()).toContain('paragraph-bounds')
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
  it('compares two compatible review-ready candidates', () => {
    const left = validCase({ candidateId: 'candidate-a', variantLabel: 'a' })
    const right = validCase({ candidateId: 'candidate-b', variantLabel: 'b' })
    const result = compareGeoContentCandidates(left, right)
    expect(result.baselineCompatible).toBe(true)
    expect(result.status).toBe('review_ready')
  })

  it('does not compare different topics', () => {
    const left = validCase({ candidateId: 'candidate-a', variantLabel: 'a' })
    const right = validCase({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ topic: 'different topic' }) })
    const result = compareGeoContentCandidates(left, right)
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('does not compare different content types', () => {
    const left = validCase({ candidateId: 'candidate-a', variantLabel: 'a' })
    const right = validCase({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ contentType: 'service_page' }) })
    expect(compareGeoContentCandidates(left, right).status).toBe('blocked')
  })

  it('does not compare different locales', () => {
    const left = validCase({ candidateId: 'candidate-a', variantLabel: 'a' })
    const right = validCase({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ language: 'zh-hant' }) })
    expect(compareGeoContentCandidates(left, right).status).toBe('blocked')
  })

  it('does not compare different evidence snapshots', () => {
    const left = validCase({ candidateId: 'candidate-a', variantLabel: 'a' })
    const right = validCase({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ evidenceSnapshotHash: 'f'.repeat(64) }) })
    expect(compareGeoContentCandidates(left, right).status).toBe('blocked')
  })

  it('does not compare different selected rules', () => {
    const left = validCase({ candidateId: 'candidate-a', variantLabel: 'a' })
    const right = validCase({ candidateId: 'candidate-b', variantLabel: 'b', qualityInput: goldenInput({ selectedRuleIds: ['evidence-boundary', 'direct-answer-first'] }) })
    expect(compareGeoContentCandidates(left, right).status).toBe('blocked')
  })

  it('does not compare different suite versions', () => {
    const left = validCase({ candidateId: 'candidate-a', variantLabel: 'a' })
    const right = cloneCase(validCase({ candidateId: 'candidate-b', variantLabel: 'b' }), { suiteVersion: 'wrong-suite' as GeoContentEvaluationCase['suiteVersion'] })
    expect(compareGeoContentCandidates(left, right).status).toBe('blocked')
  })

  it('rejects null left candidate', () => {
    expect(compareGeoContentCandidates(null, validCase()).status).toBe('blocked')
  })

  it('rejects null right candidate', () => {
    expect(compareGeoContentCandidates(validCase(), null).status).toBe('blocked')
  })

  it('rejects array left candidate', () => {
    expect(compareGeoContentCandidates([], validCase()).status).toBe('blocked')
  })

  it('rejects array right candidate', () => {
    expect(compareGeoContentCandidates(validCase(), []).status).toBe('blocked')
  })

  it('does not choose a blocked winner', () => {
    const blocked = validCase({ qualityInput: { ...GOLDEN_INPUT, injected: true }, candidateId: 'blocked' })
    const ready = validCase({ candidateId: 'ready' })
    const result = compareGeoContentCandidates(blocked, ready)
    expect(result.winnerCandidateId).toBeNull()
    expect(result.decision).toBe('blocked')
  })

  it('does not choose an insufficient-data winner', () => {
    const insufficient = validCase({ markdown: null, candidateId: 'insufficient' })
    const ready = validCase({ candidateId: 'ready' })
    const result = compareGeoContentCandidates(insufficient, ready)
    expect(result.winnerCandidateId).toBeNull()
    expect(result.decision).toBe('insufficient_data')
  })

  it('returns a fixed metric comparison order', () => {
    const result = compareGeoContentCandidates(validCase({ candidateId: 'a' }), validCase({ candidateId: 'b' }))
    expect(result.metricComparisons.map(metric => metric.metricName)).toEqual(metricNames())
  })

  it('uses a tie decision when every metric is equal', () => {
    const result = compareGeoContentCandidates(validCase({ candidateId: 'a' }), validCase({ candidateId: 'b' }))
    expect(result.decision).toBe('tie')
    expect(result.winnerCandidateId).toBeNull()
  })

  it('does not return a truth score', () => {
    const result = compareGeoContentCandidates(validCase({ candidateId: 'a' }), validCase({ candidateId: 'b' }))
    expect(result).not.toHaveProperty('score')
    expect(result).not.toHaveProperty('ranking')
  })

  it('marks a changed prompt fingerprint as incomparable', () => {
    const left = validCase({ candidateId: 'a' })
    const right = cloneCase(validCase({ candidateId: 'b' }), { promptPackFingerprint: 'f'.repeat(64) })
    expect(compareGeoContentCandidates(left, right).reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('marks a changed retrieval fingerprint as incomparable', () => {
    const left = validCase({ candidateId: 'a' })
    const right = cloneCase(validCase({ candidateId: 'b' }), { retrievalFingerprint: 'f'.repeat(64) })
    expect(compareGeoContentCandidates(left, right).reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('marks a changed brief fingerprint as incomparable', () => {
    const left = validCase({ candidateId: 'a' })
    const right = cloneCase(validCase({ candidateId: 'b' }), { briefFingerprint: 'f'.repeat(64) })
    expect(compareGeoContentCandidates(left, right).reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('marks a changed case evidence hash as incomparable', () => {
    const left = validCase({ candidateId: 'a' })
    const right = cloneCase(validCase({ candidateId: 'b' }), { evidenceSnapshotHash: 'f'.repeat(64) })
    expect(compareGeoContentCandidates(left, right).reasonCodes).toContain('EVALUATION_BASELINE_MISMATCH')
  })

  it('returns comparison limitations', () => {
    const result = compareGeoContentCandidates(validCase({ candidateId: 'a' }), validCase({ candidateId: 'b' }))
    expect(result.limitations.length).toBeGreaterThan(0)
  })
})

describe('regression reports', () => {
  it('builds a report for one case', () => {
    const report = buildGeoContentRegressionReport([validCase()])
    expect(report.caseCount).toBe(1)
    expect(report.regressionFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('builds a report for two variants', () => {
    const report = buildGeoContentRegressionReport([validCase({ candidateId: 'a' }), validCase({ candidateId: 'b' })])
    expect(report.caseCount).toBe(2)
    expect(report.cases).toHaveLength(2)
  })

  it('sorts report cases by stable code-unit identity', () => {
    const report = buildGeoContentRegressionReport([validCase({ candidateId: 'b' }), validCase({ candidateId: 'a' })])
    expect(report.cases.map(value => value.candidateId)).toEqual(['a', 'b'])
  })

  it('is independent of input case order', () => {
    const left = buildGeoContentRegressionReport([validCase({ candidateId: 'a' }), validCase({ candidateId: 'b' })])
    const right = buildGeoContentRegressionReport([validCase({ candidateId: 'b' }), validCase({ candidateId: 'a' })])
    expect(left.regressionFingerprint).toBe(right.regressionFingerprint)
  })

  it('counts review-ready cases', () => {
    const report = buildGeoContentRegressionReport([validCase()])
    expect(report.reviewReadyCount).toBe(1)
  })

  it('counts blocked cases', () => {
    const report = buildGeoContentRegressionReport([validCase(), validCase({ qualityInput: { ...GOLDEN_INPUT, injected: true } })])
    expect(report.blockedCount).toBeGreaterThanOrEqual(1)
  })

  it('counts insufficient-data cases', () => {
    const report = buildGeoContentRegressionReport([validCase({ markdown: null })])
    expect(report.insufficientDataCount).toBe(1)
  })

  it('blocks reports containing blocked cases', () => {
    const report = buildGeoContentRegressionReport([validCase({ providerOutput: null })])
    expect(report.status).toBe('insufficient_data')
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

  it('rejects an array with a malformed case', () => {
    expect(buildGeoContentRegressionReport([{}]).status).toBe('blocked')
  })

  it('keeps metric aggregate denominators', () => {
    const report = buildGeoContentRegressionReport([validCase()])
    expect(report.metricAggregates.every(metric => metric.denominator >= 0)).toBe(true)
  })

  it('keeps metric aggregate ratios nullable', () => {
    const report = buildGeoContentRegressionReport([])
    expect(report.metricAggregates.every(metric => metric.ratio === null)).toBe(true)
  })

  it('contains all metric aggregates', () => {
    expect(buildGeoContentRegressionReport([validCase()]).metricAggregates).toHaveLength(15)
  })

  it('includes human-review limitation text', () => {
    const report = buildGeoContentRegressionReport([validCase()])
    expect(report.limitations.join(' ')).toContain('publication')
  })

  it('does not label a report approved', () => {
    const report = buildGeoContentRegressionReport([validCase()])
    expect(report).not.toHaveProperty('approved')
    expect(report).not.toHaveProperty('publishable')
  })

  it('does not label a report as ranking improvement', () => {
    expect(buildGeoContentRegressionReport([validCase()])).not.toHaveProperty('rankingImprovement')
  })

  it('preserves case reason codes in the report', () => {
    const value = validCase({ providerOutput: null })
    const report = buildGeoContentRegressionReport([value])
    expect(report.cases[0]?.reasonCodes).toContain('EVALUATION_DATA_INSUFFICIENT')
  })

  it('changes regression fingerprint when candidate outcome changes', () => {
    const first = buildGeoContentRegressionReport([validCase({ candidateId: 'a' })])
    const second = buildGeoContentRegressionReport([validCase({ candidateId: 'b' })])
    expect(first.regressionFingerprint).not.toBe(second.regressionFingerprint)
  })
})

describe('golden fixtures and contract variants', () => {
  it.each([
    ['high-quality candidate', {}],
    ['missing direct answer candidate', { candidateId: 'missing-answer', variantLabel: 'missing-answer' }],
    ['heading regression candidate', { candidateId: 'heading-regression', variantLabel: 'heading-regression', markdown: GOLDEN_MARKDOWN.replace('## Details', '#### Details') }],
    ['citation missing candidate', { candidateId: 'citation-missing', variantLabel: 'citation-missing', providerOutput: goldenOutput(GOLDEN_INPUT, { citations: [] }) }],
    ['unselected evidence candidate', { candidateId: 'unselected', variantLabel: 'unselected', providerOutput: goldenOutput(GOLDEN_INPUT, { citations: [{ ...GOLDEN_OUTPUT.citations[0]!, sourceId: 'foreign' }] }) }],
    ['unsupported claim candidate', { candidateId: 'unsupported', variantLabel: 'unsupported', providerOutput: goldenOutput(GOLDEN_INPUT, { claims: [{ ...GOLDEN_OUTPUT.claims[0]!, claimType: 'quantitative', text: '100% guaranteed.', citationIds: [] }] }) }],
    ['stale evidence candidate', { candidateId: 'stale', variantLabel: 'stale', qualityInput: goldenInput({ evidenceSnapshotHash: 'f'.repeat(64) }) }],
    ['wrong rule candidate', { candidateId: 'wrong-rule', variantLabel: 'wrong-rule', qualityInput: goldenInput({ selectedRuleIds: ['unknown-rule'] }) }],
    ['FAQ unbound candidate', { candidateId: 'faq-unbound', variantLabel: 'faq-unbound', qualityInput: goldenInput({ contentType: 'faq' }) }],
    ['Unicode CJK candidate', { candidateId: 'unicode', variantLabel: 'unicode-cjk', qualityInput: goldenInput({ language: 'zh-hant', topic: '合成服務範圍', workingTitle: '合成服務範圍', primaryQuestion: '什麼是合成服務範圍？' }) }],
    ['prompt regression candidate', { candidateId: 'prompt-regression', variantLabel: 'prompt-regression', providerOutput: goldenOutput(GOLDEN_INPUT, { promptFingerprint: 'e'.repeat(64) }) }],
    ['retrieval regression candidate', { candidateId: 'retrieval-regression', variantLabel: 'retrieval-regression', providerOutput: goldenOutput(GOLDEN_INPUT, { retrievalFingerprint: 'e'.repeat(64) }) }],
    ['provider provenance candidate', { candidateId: 'provenance', variantLabel: 'provenance', providerOutput: goldenOutput(GOLDEN_INPUT, { provider: 'other' }) }],
  ])('evaluates fixture variant: %s', (_label, overrides) => {
    const result = evaluate(overrides)
    expect(['review_ready', 'blocked', 'insufficient_data']).toContain(result.status)
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
