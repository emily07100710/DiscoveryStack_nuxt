import { describe, expect, it } from 'vitest'
import {
  aggregateEvaluationMetrics,
  buildGeoContentRegressionReport,
  compareGeoContentCandidates,
  createGeoContentEvaluationCase,
  evaluationCaseFingerprint,
  isValidApplicableMetric,
  makeEvaluationMetric,
  rawCandidateIdentityTuple,
  validateRawCandidateEnvelope,
} from '../server/geo-content-evaluation'
import { sha256Text, tokenizeLexical } from '../server/geo-content-quality'
import type { GeoContentEvaluationCase } from '../server/geo-content-evaluation'
import {
  GOLDEN_INPUT,
  GOLDEN_MARKDOWN,
  GOLDEN_OUTPUT,
  ZH_HANT_INPUT,
  ZH_HANT_MARKDOWN,
  ZH_HANT_OUTPUT,
  goldenCandidate,
  goldenInput,
  goldenOutput,
  zhHantCandidate,
} from './fixtures/geo-content-evaluation/fixtures'

function candidateWith(field: string, value: unknown): Record<string, unknown> {
  return { ...goldenCandidate(), [field]: value }
}

function invalidRawReasons(value: unknown): string[] {
  const result = validateRawCandidateEnvelope(value)
  expect(result.status).toBe('invalid')
  return result.status === 'invalid' ? result.reasonCodes : []
}

describe('GEO evaluation adversarial raw boundary', () => {
  it('rejects a symbol own key', () => {
    const candidate = { ...goldenCandidate(), [Symbol('extra')]: true }
    const result = createGeoContentEvaluationCase(candidate)
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('rejects a non-enumerable extra field', () => {
    const candidate = { ...goldenCandidate() }
    Object.defineProperty(candidate, 'extra', { value: true, enumerable: false })
    expect(invalidRawReasons(candidate)).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('rejects a class instance as the outer candidate', () => {
    class CandidateClass {}
    const candidate = Object.assign(new CandidateClass(), goldenCandidate())
    expect(createGeoContentEvaluationCase(candidate).status).toBe('blocked')
  })

  it('rejects an accessor field on the raw candidate', () => {
    const candidate = { ...goldenCandidate() }
    Object.defineProperty(candidate, 'providerOutput', { enumerable: true, get: () => GOLDEN_OUTPUT })
    expect(invalidRawReasons(candidate)).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it('fails closed when Proxy ownKeys throws', () => {
    const candidate = new Proxy(goldenCandidate(), { ownKeys: () => { throw new Error('ownKeys') } })
    expect(() => createGeoContentEvaluationCase(candidate)).not.toThrow()
    expect(createGeoContentEvaluationCase(candidate).status).toBe('blocked')
  })

  it('fails closed when Proxy getOwnPropertyDescriptor throws', () => {
    const candidate = new Proxy(goldenCandidate(), { getOwnPropertyDescriptor: () => { throw new Error('descriptor') } })
    expect(validateRawCandidateEnvelope(candidate).status).toBe('invalid')
  })

  it('fails closed when Proxy field get throws', () => {
    const candidate = new Proxy(goldenCandidate(), { get: (target, property, receiver) => property === 'markdown' ? (() => { throw new Error('get') })() : Reflect.get(target, property, receiver) })
    expect(createGeoContentEvaluationCase(candidate).status).toBe('blocked')
  })

  it('rejects a provider class instance', () => {
    class ProviderClass {}
    const provider = Object.assign(new ProviderClass(), GOLDEN_OUTPUT)
    const result = createGeoContentEvaluationCase(candidateWith('providerOutput', provider))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_INVALID_INPUT')
  })

  it('rejects a provider object with an accessor field', () => {
    const provider = { ...GOLDEN_OUTPUT }
    Object.defineProperty(provider, 'body', { enumerable: true, get: () => GOLDEN_OUTPUT.body })
    const result = createGeoContentEvaluationCase(candidateWith('providerOutput', provider))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_INVALID_INPUT')
  })

  it.each([
    ['provider string', 'providerOutput', 'malformed'],
    ['provider number', 'providerOutput', 3],
    ['provider boolean', 'providerOutput', false],
    ['provider array', 'providerOutput', []],
    ['provider function', 'providerOutput', () => 'bad'],
    ['provider symbol', 'providerOutput', Symbol('bad')],
    ['provider bigint', 'providerOutput', 1n],
    ['markdown array', 'markdown', []],
    ['markdown object', 'markdown', {}],
    ['markdown number', 'markdown', 3],
    ['markdown boolean', 'markdown', false],
    ['markdown function', 'markdown', () => 'bad'],
    ['markdown symbol', 'markdown', Symbol('bad')],
    ['markdown bigint', 'markdown', 1n],
    ['markdown undefined', 'markdown', undefined],
  ])('classifies %s as invalid input rather than missing data', (_label: string, field: string, value: unknown) => {
    const result = createGeoContentEvaluationCase(candidateWith(field, value))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_INVALID_INPUT')
    expect(result.reasonCodes).not.toContain('EVALUATION_DATA_INSUFFICIENT')
  })

  it('classifies explicit null markdown as insufficient data', () => {
    const result = createGeoContentEvaluationCase(candidateWith('markdown', null))
    expect(result.status).toBe('insufficient_data')
    expect(result.reasonCodes).toContain('EVALUATION_DATA_INSUFFICIENT')
  })

  it('classifies explicit null provider output as insufficient data', () => {
    const result = createGeoContentEvaluationCase(candidateWith('providerOutput', null))
    expect(result.status).toBe('insufficient_data')
    expect(result.reasonCodes).toContain('EVALUATION_DATA_INSUFFICIENT')
  })

  it('rejects a missing required top-level field', () => {
    const candidate = { ...goldenCandidate() } as Record<string, unknown>
    delete candidate.markdown
    const result = createGeoContentEvaluationCase(candidate)
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_INVALID_INPUT')
  })

  it('rejects a non-enumerable required field', () => {
    const candidate = { ...goldenCandidate() } as Record<string, unknown>
    delete candidate.markdown
    Object.defineProperty(candidate, 'markdown', { value: GOLDEN_MARKDOWN, enumerable: false })
    const result = createGeoContentEvaluationCase(candidate)
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_UNKNOWN_FIELD')
  })

  it.each(['\u0000', '\u0001', '\u001f', '\u007f', '\u0085'])('rejects control character %s in identity', control => {
    const result = createGeoContentEvaluationCase(goldenCandidate({ candidateId: `candidate${control}id` }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_INVALID_INPUT')
  })

  it('enforces the identity UTF-8 byte limit without truncation', () => {
    const value = 'é'.repeat(81)
    const result = createGeoContentEvaluationCase(goldenCandidate({ candidateId: value }))
    expect(result.status).toBe('blocked')
    expect(result.candidateId).toBe('')
  })

  it('normalizes NFKC identity and trims it before saving', () => {
    const result = createGeoContentEvaluationCase(goldenCandidate({ candidateId: '  ｃａｎｄｉｄａｔｅ－１  ' }))
    expect(result.status).toBe('review_ready')
    expect(result.candidateId).toBe('candidate-1')
  })

  it('uses an unambiguous canonical tuple instead of NUL delimiters', () => {
    const left = { caseId: 'a\u0000b', candidateId: 'c', variantLabel: 'd' }
    const right = { caseId: 'a', candidateId: 'b\u0000c', variantLabel: 'd' }
    expect(`${left.caseId}\u0000${left.candidateId}\u0000${left.variantLabel}`).toBe(`${right.caseId}\u0000${right.candidateId}\u0000${right.variantLabel}`)
    expect(rawCandidateIdentityTuple(left)).not.toBe(rawCandidateIdentityTuple(right))
  })

  it('blocks comparison when candidate IDs are equal but variants differ', () => {
    const result = compareGeoContentCandidates(
      goldenCandidate({ candidateId: 'same-id', variantLabel: 'left' }),
      goldenCandidate({ candidateId: 'same-id', variantLabel: 'right' }),
    )
    expect(result.status).toBe('blocked')
    expect(result.winnerCandidateId).toBeNull()
    expect(result.reasonCodes).toContain('EVALUATION_DUPLICATE_COMPARISON_IDENTITY')
  })

  it('blocks comparison when candidate IDs are only NFKC-different', () => {
    const result = compareGeoContentCandidates(
      goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'left' }),
      goldenCandidate({ candidateId: 'ｃａｎｄｉｄａｔｅ－ａ', variantLabel: 'right' }),
    )
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('EVALUATION_DUPLICATE_COMPARISON_IDENTITY')
  })

  it('blocks a report containing NFKC-duplicate identities before evaluation', () => {
    const report = buildGeoContentRegressionReport([
      goldenCandidate({ candidateId: 'candidate-a', variantLabel: 'same' }),
      goldenCandidate({ candidateId: 'ｃａｎｄｉｄａｔｅ－ａ', variantLabel: 'same' }),
    ])
    expect(report.status).toBe('blocked')
    expect(report.caseCount).toBe(0)
    expect(report.cases).toEqual([])
    expect(report.regressionFingerprint).toBeNull()
    expect(report.reasonCodes).toContain('EVALUATION_DUPLICATE_IDENTITY')
  })

  it('rejects an over-capacity report without evaluating any cases', () => {
    const values = Array.from({ length: 501 }, (_, index) => goldenCandidate({ candidateId: `over-${index}`, variantLabel: `over-${index}` }))
    const report = buildGeoContentRegressionReport(values)
    expect(report.status).toBe('blocked')
    expect(report.caseCount).toBe(0)
    expect(report.cases).toEqual([])
    expect(report.regressionFingerprint).toBeNull()
    expect(report.reasonCodes).toContain('EVALUATION_LIMIT_EXCEEDED')
  })
})

describe('GEO evaluation adversarial metric boundary', () => {
  it.each([
    ['numerator exceeds denominator', 2, 1, 'EVALUATION_METRIC_BOUNDS'],
    ['negative numerator', -1, 2, 'EVALUATION_METRIC_BOUNDS'],
    ['negative denominator', 1, -2, 'EVALUATION_METRIC_BOUNDS'],
    ['fractional numerator', 1.5, 2, 'EVALUATION_METRIC_BOUNDS'],
    ['fractional denominator', 1, 2.5, 'EVALUATION_METRIC_BOUNDS'],
    ['NaN numerator', Number.NaN, 1, 'EVALUATION_NON_FINITE_METRIC'],
    ['positive Infinity denominator', 1, Number.POSITIVE_INFINITY, 'EVALUATION_NON_FINITE_METRIC'],
    ['negative Infinity numerator', Number.NEGATIVE_INFINITY, 1, 'EVALUATION_NON_FINITE_METRIC'],
    ['safe integer overflow', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 'EVALUATION_METRIC_BOUNDS'],
  ])('fails closed for %s', (_label: string, numerator: number, denominator: number, reason: string) => {
    const metric = makeEvaluationMetric('direct-answer-presence', numerator, denominator)
    expect(metric).toMatchObject({ applicable: false, numerator: 0, denominator: 0, ratio: null })
    expect(metric.reasonCodes).toContain(reason)
  })

  it('excludes an invalid metric from regression aggregation', () => {
    const evaluation = createGeoContentEvaluationCase(goldenCandidate())
    const invalid = makeEvaluationMetric('direct-answer-presence', 2, 1)
    const forged: GeoContentEvaluationCase = { ...evaluation, metrics: evaluation.metrics.map(metric => metric.metricName === 'direct-answer-presence' ? invalid : metric) }
    const aggregate = aggregateEvaluationMetrics([forged]).find(metric => metric.metricName === 'direct-answer-presence')
    expect(aggregate).toMatchObject({ applicableCases: 0, numerator: 0, denominator: 0, ratio: null })
    expect(aggregate?.reasonCodes).toContain('EVALUATION_METRIC_BOUNDS')
  })

  it('excludes an invalid metric from Pareto comparability', () => {
    const invalid = makeEvaluationMetric('direct-answer-presence', 2, 1)
    expect(isValidApplicableMetric(invalid)).toBe(false)
  })

  it('rejects a 0/0 metric without an explicit non-applicable reason', () => {
    const value = createGeoContentEvaluationCase(goldenCandidate())
    const metrics = value.metrics.map(metric => metric.metricName === 'direct-answer-presence' ? { ...metric, applicable: false, numerator: 0, denominator: 0, ratio: null, reasonCodes: [] } : metric)
    expect(evaluationCaseFingerprint({ ...value, metrics }).status).toBe('invalid')
  })
})

describe('GEO evaluation adversarial fingerprint and report admission', () => {
  it('binds status while accepting a server-evaluated blocked quality case', () => {
    const ready = createGeoContentEvaluationCase(goldenCandidate())
    const blocked = createGeoContentEvaluationCase(goldenCandidate({ providerOutput: {}, markdown: GOLDEN_MARKDOWN }))
    const readyFingerprint = evaluationCaseFingerprint(ready)
    const blockedFingerprint = evaluationCaseFingerprint(blocked)
    expect(readyFingerprint.status).toBe('valid')
    expect(blockedFingerprint.status).toBe('valid')
    expect(readyFingerprint.fingerprint).not.toBe(blockedFingerprint.fingerprint)
  })

  it('rejects a forged status inconsistent with the quality gate', () => {
    const value = createGeoContentEvaluationCase(goldenCandidate())
    const forged = { ...value, status: 'blocked' as const }
    expect(evaluationCaseFingerprint(forged).status).toBe('invalid')
  })

  it('returns no fingerprint for a structurally invalid empty evaluation case', () => {
    const invalid = createGeoContentEvaluationCase(candidateWith('markdown', []))
    const fingerprint = evaluationCaseFingerprint(invalid)
    expect(fingerprint.status).toBe('invalid')
    expect(fingerprint.fingerprint).toBeNull()
  })

  it('rejects an inconsistent exactMarkdown/contentHash pair', () => {
    const value = createGeoContentEvaluationCase(goldenCandidate())
    const forged = { ...value, contentHash: '0'.repeat(64) }
    expect(evaluationCaseFingerprint(forged).status).toBe('invalid')
  })

  it('binds quality gate result changes', () => {
    const value = createGeoContentEvaluationCase(goldenCandidate())
    const changed = createGeoContentEvaluationCase(goldenCandidate({ candidateId: 'candidate-quality-gate-change', variantLabel: 'quality-gate-change', markdown: `${GOLDEN_MARKDOWN}\n\nUnbound mutation.` }))
    expect(value.qualityGateResult?.status).toBe('passed')
    expect(changed.qualityGateResult?.status).toBe('blocked')
    expect(evaluationCaseFingerprint(value).status).toBe('valid')
    expect(evaluationCaseFingerprint(changed).status).toBe('valid')
    expect(evaluationCaseFingerprint(value).fingerprint).not.toBe(evaluationCaseFingerprint(changed).fingerprint)
  })

  it('binds normalized quality input changes', () => {
    const changedInput = goldenInput({ goals: ['A changed deterministic goal.'] })
    const first = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate()))
    const second = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate({ qualityInput: changedInput, providerOutput: null, markdown: null })))
    expect(first.status).toBe('valid')
    expect(second.status).toBe('valid')
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('binds validated provider claim changes', () => {
    const changedOutput = goldenOutput(GOLDEN_INPUT, { claims: [{ ...GOLDEN_OUTPUT.claims[0]!, claimId: 'claim-summary-revision' }] })
    const first = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate()))
    const second = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate({ providerOutput: changedOutput })))
    expect(first.status).toBe('valid')
    expect(second.status).toBe('valid')
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('binds citation changes even when provider validation blocks the candidate', () => {
    const changedOutput = goldenOutput(GOLDEN_INPUT, { citations: [{ ...GOLDEN_OUTPUT.citations[0]!, sourceId: 'foreign-source' }] })
    const first = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate()))
    const second = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate({ providerOutput: changedOutput })))
    expect(first.status).toBe('valid')
    expect(second.status).toBe('valid')
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it('binds provider provenance changes even when the changed output is blocked', () => {
    const changedOutput = goldenOutput(GOLDEN_INPUT, { requestId: 'request-revision' })
    const first = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate()))
    const second = evaluationCaseFingerprint(createGeoContentEvaluationCase(goldenCandidate({ providerOutput: changedOutput })))
    expect(first.status).toBe('valid')
    expect(second.status).toBe('valid')
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })

  it('binds metric applicability and ratio changes', () => {
    const value = createGeoContentEvaluationCase(goldenCandidate())
    const ratioChanged = { ...value, metrics: value.metrics.map(metric => metric.metricName === 'direct-answer-presence' ? { ...metric, numerator: 0, denominator: 1, ratio: 0 } : metric) }
    const applicabilityChanged = { ...value, metrics: value.metrics.map(metric => metric.metricName === 'direct-answer-presence' ? { ...metric, applicable: false, numerator: 0, denominator: 0, ratio: null, reasonCodes: ['METRIC_NOT_APPLICABLE' as const] } : metric) }
    expect(evaluationCaseFingerprint(value).status).toBe('valid')
    expect(evaluationCaseFingerprint(ratioChanged).status).toBe('valid')
    expect(evaluationCaseFingerprint(applicabilityChanged).status).toBe('valid')
    expect(evaluationCaseFingerprint(value).fingerprint).not.toBe(evaluationCaseFingerprint(ratioChanged).fingerprint)
    expect(evaluationCaseFingerprint(value).fingerprint).not.toBe(evaluationCaseFingerprint(applicabilityChanged).fingerprint)
  })

  it('binds selected rule order changes', () => {
    const value = createGeoContentEvaluationCase(goldenCandidate())
    const changed = { ...value, selectedRuleIds: [...value.selectedRuleIds!].reverse() }
    expect(evaluationCaseFingerprint(value).fingerprint).not.toBe(evaluationCaseFingerprint(changed).fingerprint)
  })

  it('admits valid insufficient data with a deterministic non-null report fingerprint', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate({ providerOutput: null })])
    expect(report.status).toBe('insufficient_data')
    expect(report.caseCount).toBe(1)
    expect(report.cases[0]?.status).toBe('insufficient_data')
    expect(report.cases[0]?.evaluationFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(report.regressionFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('admits no cases for a structurally invalid malformed provider report', () => {
    const report = buildGeoContentRegressionReport([candidateWith('providerOutput', 'malformed')])
    expect(report.status).toBe('blocked')
    expect(report.caseCount).toBe(0)
    expect(report.cases).toEqual([])
    expect(report.regressionFingerprint).toBeNull()
    expect(report.reasonCodes).toContain('EVALUATION_INVALID_INPUT')
  })

  it('admits no cases for a mixed valid and structurally invalid report', () => {
    const report = buildGeoContentRegressionReport([goldenCandidate(), candidateWith('markdown', [])])
    expect(report.status).toBe('blocked')
    expect(report.caseCount).toBe(0)
    expect(report.cases).toEqual([])
    expect(report.regressionFingerprint).toBeNull()
    expect(report.reasonCodes).toContain('EVALUATION_INVALID_INPUT')
  })

  it('admits no cases for an output-only evaluation report with raw-required reason', () => {
    const outputOnly = createGeoContentEvaluationCase(goldenCandidate())
    const report = buildGeoContentRegressionReport([outputOnly])
    expect(report.status).toBe('blocked')
    expect(report.caseCount).toBe(0)
    expect(report.cases).toEqual([])
    expect(report.regressionFingerprint).toBeNull()
    expect(report.reasonCodes).toContain('EVALUATION_RAW_INPUT_REQUIRED')
  })
})

describe('GEO evaluation positive zh-hant golden', () => {
  it('evaluates the canonical zh-hant candidate without input mismatch', () => {
    const result = createGeoContentEvaluationCase(zhHantCandidate())
    expect(result.status).toBe('review_ready')
    expect(result.reasonCodes).not.toContain('EVALUATION_INVALID_INPUT')
    expect(result.reasonCodes).not.toContain('QUERY_FINGERPRINT_MISMATCH')
    expect(result.reasonCodes).not.toContain('CONTENT_TOPIC_MISMATCH')
  })

  it('rebuilds zh-hant retrieval and prompt lineage from normalized input', () => {
    const result = createGeoContentEvaluationCase(zhHantCandidate())
    expect(result.locale).toBe('zh-hant')
    expect(result.topic).toBe('合成服務範圍')
    expect(result.retrievalFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.promptPackFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(ZH_HANT_INPUT.retrievalPlan.queryFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps zh-hant Markdown and provider body byte-exact', () => {
    const result = createGeoContentEvaluationCase(zhHantCandidate())
    expect(ZH_HANT_MARKDOWN).toBe(ZH_HANT_OUTPUT.body)
    expect(result.exactMarkdown).toBe(ZH_HANT_OUTPUT.body)
    expect(result.contentHash).toBe(sha256Text(ZH_HANT_OUTPUT.body))
    expect(result.providerOutput?.body).toBe(result.exactMarkdown)
  })

  it('proves Han bigram tokenization and topic lexical relevance', () => {
    const tokens = tokenizeLexical('合成服務範圍')
    expect(tokens).toEqual(expect.arrayContaining(['合成', '成服', '服務', '務範', '範圍']))
    const result = createGeoContentEvaluationCase(zhHantCandidate())
    expect(result.qualityGateResult?.structureChecks.topicOverlap).toBe(true)
  })

  it('keeps fullwidth zh-hant punctuation in the canonical input path', () => {
    expect(ZH_HANT_INPUT.primaryQuestion).toBe('什麼是合成服務範圍?')
    expect(ZH_HANT_OUTPUT.body).toContain('。')
    expect(ZH_HANT_OUTPUT.body).not.toContain('QUERY_FINGERPRINT_MISMATCH')
  })
})
