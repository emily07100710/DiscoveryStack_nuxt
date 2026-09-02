export const INSUFFICIENT_SAMPLE = 'insufficient_sample' as const
export const SINGLE_SAMPLE_NOT_TREND = 'single_sample_not_trend' as const
export const PARTIAL_SAMPLE = 'partial_sample' as const

export const VISIBILITY_SAMPLE_LIMITATION_CODES = [
  INSUFFICIENT_SAMPLE,
  SINGLE_SAMPLE_NOT_TREND,
  PARTIAL_SAMPLE,
] as const

const clampRate = (value: number) => Math.max(0, Math.min(1, value))

export function wilsonInterval(successes: number, n: number, z = 1.959964): { lower: number, upper: number } | null {
  if (n === 0) return null
  const p = successes / n
  const zSquared = z * z
  const denominator = 1 + zSquared / n
  const center = (p + zSquared / (2 * n)) / denominator
  const margin = z * Math.sqrt((p * (1 - p) + zSquared / (4 * n)) / n) / denominator
  return { lower: clampRate(center - margin), upper: clampRate(center + margin) }
}

export function proportionEstimate(successes: number, n: number) {
  if (n === 0) return null
  const rate = successes / n
  const confidenceInterval = wilsonInterval(successes, n)!
  return {
    rate,
    n,
    standardError: Math.sqrt(rate * (1 - rate) / n),
    confidenceInterval: { level: 0.95 as const, ...confidenceInterval },
  }
}

export function meanEstimate(values: number[]) {
  const n = values.length
  if (n === 0) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  if (n < 2) return { mean, n, standardError: null }
  const sampleVariance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  return { mean, n, standardError: Math.sqrt(sampleVariance) / Math.sqrt(n) }
}

export function sampleLimitations(n: number, requested: number): string[] {
  if (n === 0) return [INSUFFICIENT_SAMPLE]
  const limitations: string[] = []
  if (n === 1) limitations.push(SINGLE_SAMPLE_NOT_TREND)
  if (n < requested) limitations.push(PARTIAL_SAMPLE)
  return limitations
}
