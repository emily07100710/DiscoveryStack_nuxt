import { describe, expect, it } from 'vitest'
import { meanEstimate, proportionEstimate, sampleLimitations, wilsonInterval } from '../server/llm-visibility/statistics'

describe('LLM visibility benchmark statistics', () => {
  it('computes known Wilson 95% intervals and proportion standard errors', () => {
    expect(wilsonInterval(3, 5)?.lower).toBeCloseTo(0.2307, 3)
    expect(wilsonInterval(3, 5)?.upper).toBeCloseTo(0.8824, 3)
    expect(wilsonInterval(0, 5)).toMatchObject({ lower: 0 })
    expect(wilsonInterval(0, 5)?.upper).toBeCloseTo(0.4345, 3)
    expect(wilsonInterval(5, 5)?.lower).toBeCloseTo(0.5655, 3)
    expect(wilsonInterval(5, 5)?.upper).toBe(1)
    expect(proportionEstimate(3, 5)?.standardError).toBeCloseTo(0.2191, 4)
  })

  it('computes sample mean standard error with n-1 sample variance', () => {
    expect(meanEstimate([1, 3, 5])).toMatchObject({ mean: 3, n: 3 })
    expect(meanEstimate([1, 3, 5])?.standardError).toBeCloseTo(1.1547, 4)
    expect(meanEstimate([2])).toEqual({ mean: 2, n: 1, standardError: null })
  })

  it('returns honest zero/single/partial sample limitations', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
    expect(proportionEstimate(0, 0)).toBeNull()
    expect(meanEstimate([])).toBeNull()
    expect(sampleLimitations(0, 5)).toEqual(['insufficient_sample'])
    expect(sampleLimitations(1, 1)).toEqual(['single_sample_not_trend'])
    expect(sampleLimitations(2, 5)).toEqual(['partial_sample'])
  })
})
