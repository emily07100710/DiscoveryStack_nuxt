import { describe, expect, it } from 'vitest'
import { appendExportLedger } from '../server/seo-geo-core/repository'

describe('append-only export ledger', () => {
  it('retains every repeated export entry', () => {
    const first = { exportId: 'first', format: 'markdown' }
    const second = { exportId: 'second', format: 'json' }
    const third = { exportId: 'third', format: 'markdown' }
    const history = appendExportLedger(appendExportLedger([first], second), third)
    expect(history).toEqual([first, second, third])
  })

  it('preserves a legacy single object before appending new history', () => {
    expect(appendExportLedger({ exportId: 'legacy' }, { exportId: 'new' })).toEqual([{ exportId: 'legacy' }, { exportId: 'new' }])
  })
})
