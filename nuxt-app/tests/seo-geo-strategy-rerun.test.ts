import { describe, expect, it } from 'vitest'
import { preserveStrategyRerunStatus } from '../server/seo-geo-core/repository'

describe('strategy rerun status preservation', () => {
  it.each(['proposed', 'selected', 'rejected', 'superseded'] as const)('preserves existing %s status', status => {
    expect(preserveStrategyRerunStatus(status)).toBe(status)
  })

  it('does not turn a selected strategy back into proposed', () => {
    const existing = { status: 'selected' as const }
    const rerun = { status: preserveStrategyRerunStatus(existing.status) }
    expect(rerun.status).toBe('selected')
    expect(rerun.status).not.toBe('proposed')
  })
})
