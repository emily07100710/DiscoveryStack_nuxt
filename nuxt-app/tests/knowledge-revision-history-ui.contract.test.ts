import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const component = readFileSync(`${root}components/KnowledgeRevisionHistory.vue`, 'utf8')
const route = readFileSync(`${root}server/api/knowledge/revision-history.get.ts`, 'utf8')
const types = readFileSync(`${root}server/knowledge/revision-types.ts`, 'utf8')

describe('owner-private knowledge revision history contract', () => {
  it('uses only existing owner subject lists and a read-only GET with opaque keyset paging', () => {
    expect(component).toContain('entities: readonly HistoryEntity[]')
    expect(component).toContain('claims: readonly HistoryClaim[]')
    expect(component).toContain('sources: readonly HistorySource[]')
    expect(component).toContain("fetchHistory('/api/knowledge/revision-history', { query:")
    expect(component).toContain('cursor?: string')
    expect(component).toContain('pageItems.length > 25')
    expect(component).toContain('載入更早的 25 筆')
    expect(component).not.toContain('method:')
    expect(component).not.toContain('body:')
    expect(component).not.toContain('localStorage')
  })

  it('rejects raw or extra DTO fields and treats legacy baseline as a separate non-event origin', () => {
    expect(component).toContain('function hasExactKeys')
    expect(component).toContain('hasExactKeys(value, historyItemKeys)')
    expect(component).toContain("historyScope !== 'recorded_mutations_only'")
    expect(component).toContain('rawSnapshotIncluded !== false')
    expect(component).toContain('Legacy baseline · 不是原始舊歷史事件')
    expect(component).toContain("'legacy_baseline'")
    expect(types).toContain('canonicalSnapshot: string')
    expect(component).not.toContain('canonicalSnapshot')
    expect(component).not.toContain('snapshot:')
  })

  it('keeps all actions read-only and fails closed on stale or private errors', () => {
    expect(component).toContain('requestGeneration += 1')
    expect(component).toContain('generation !== requestGeneration')
    expect(component).toContain("status === 401 || status === 403 ? 'unauthorized'")
    expect(component).toContain("status === 409 ? 'conflict'")
    expect(component).toContain("status === 422 ? 'invalid'")
    expect(component).toContain('沒有以假資料替代')
    expect(component).not.toContain('error.message')
    expect(component).not.toContain('statusMessage')
    expect(component).toContain('不會審批、發布或訓練')
    expect(component).toContain('不提供任何修訂、審批、發布、模型准入或訓練操作')
    expect(component).not.toMatch(/(?:POST|DELETE|PUT|PATCH)/u)
  })

  it('authenticates before strict query processing, sets private headers, and maps service errors safely', () => {
    expect(route).toContain('setKnowledgePrivateApiHeaders(event)')
    expect(route).toContain('await requireKnowledgeOwner(event)')
    expect(route.indexOf('await requireKnowledgeOwner(event)')).toBeLessThan(route.indexOf('const query = getQuery(event)'))
    expect(route).toContain("key !== 'kind' && key !== 'id' && key !== 'cursor'")
    expect(route).toContain("'CORRUPT_STATE' || error.code === 'REVISION_CONFLICT' || error.code === 'LIMIT_EXCEEDED'")
    expect(route).toContain("'Knowledge history is unavailable.'")
  })
})
