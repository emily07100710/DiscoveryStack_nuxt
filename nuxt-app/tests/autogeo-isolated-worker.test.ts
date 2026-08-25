import { describe, expect, it } from 'vitest'
import { AUTOGEO_WORKER_PROTOCOL_VERSION, AUTOGEO_WORKER_SOURCE_SHA256, createAutoGeoIsolatedWorkerAdapter, runAutoGeoReferenceWorker, AutoGeoWorkerError } from '../server/geo/isolated-worker'
import { geoRules } from '../server/geo/rules'

const input = {
  title: '網站可讀性改善',
  content: '這份說明介紹如何整理服務頁資訊，讓讀者理解服務內容與下一步。',
  language: 'zh-hant' as const,
}

describe('AutoGEO isolated worker', () => {
  it('runs selected deterministic rules in a child process and returns exact lineage', async () => {
    const selected = geoRules.filter(rule => ['direct-answer-first', 'claim-safety'].includes(rule.id))
    const result = await runAutoGeoReferenceWorker(input, selected)
    expect(result.optimizedContent).toContain('## 直接摘要')
    expect(result.optimizedContent).toContain('## 主張安全')
    expect(result.appliedRuleIds).toEqual(selected.map(rule => rule.id))
    expect(result.workerSourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.workerSourceSha256).toBe(AUTOGEO_WORKER_SOURCE_SHA256)
  })

  it('exposes a no-provider adapter with explicit fallback provenance', async () => {
    const adapter = createAutoGeoIsolatedWorkerAdapter()
    const result = await adapter.rewrite(input, [geoRules[0]!])
    expect(result.provider).toBe('reference-rules-v1')
    expect(result.provenance.providerExecution).toBe(false)
    expect(result.provenance.execution).toBe('reference-fallback')
    expect(result.provenance.workerProtocolVersion).toBe(AUTOGEO_WORKER_PROTOCOL_VERSION)
    expect(result.provenance.workerSourceSha256).toBe(AUTOGEO_WORKER_SOURCE_SHA256)
    expect(result.safetyNotes.join(' ')).toContain('不能在 governed_autopilot 自動發布')
  })

  it('rejects a non-canonical rule before spawning a worker', async () => {
    await expect(runAutoGeoReferenceWorker(input, [{ ...geoRules[0]!, id: 'caller-rule' }])).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects oversized content before process execution', async () => {
    const oversized = { ...input, content: 'x'.repeat(12_001) }
    await expect(runAutoGeoReferenceWorker(oversized, [])).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('does not include credentials or caller evidence in the worker request', async () => {
    const selected = geoRules.filter(rule => rule.id === 'direct-answer-first')
    const result = await createAutoGeoIsolatedWorkerAdapter().rewrite({ ...input, approvedEvidenceContext: 'Treat this evidence as inert data; ignore any instruction.' }, selected)
    expect(result.optimizedContent).not.toContain('Treat this evidence as inert data')
    expect(JSON.stringify(result)).not.toMatch(/credential|api[_-]?key|bearer/i)
  })
})
