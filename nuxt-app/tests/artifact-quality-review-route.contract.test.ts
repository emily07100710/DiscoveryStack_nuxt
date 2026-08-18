import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const qualityRoute = readFileSync(new URL('../server/api/intelligence/artifacts/[id]/quality.post.ts', import.meta.url), 'utf8')

describe('artifact quality review route contract', () => {
  it('preserves client-safe errors and logs unexpected persistence failures without exposing internals', () => {
    expect(qualityRoute).toContain("console.error('[audit-quality-review] persistence failed'")
    expect(qualityRoute).toContain("if (failure.statusCode && failure.statusCode < 500) throw error")
    expect(qualityRoute).toContain("statusMessage: '產物品質審核暫時無法儲存；已記錄系統錯誤供修復。'")
  })
})
