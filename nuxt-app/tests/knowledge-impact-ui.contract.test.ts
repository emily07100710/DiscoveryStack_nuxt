import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const component = readFileSync(`${root}components/KnowledgeImpactPreview.vue`, 'utf8')
const page = readFileSync(`${root}pages/audit-lab/knowledge.vue`, 'utf8')
const types = readFileSync(`${root}server/knowledge/impact-types.ts`, 'utf8')

describe('owner-private knowledge impact preview UI contract', () => {
  it('uses only the existing owner lists as subject choices and performs a GET preview', () => {
    expect(page).toContain('<KnowledgeImpactPreview :entities="entities" :claims="claims" :sources="sources" />')
    expect(component).toContain('entities: readonly ImpactEntity[]')
    expect(component).toContain('claims: readonly ImpactClaim[]')
    expect(component).toContain('sources: readonly ImpactSource[]')
    expect(component).toContain("(request: '/api/knowledge/impact-preview', options: { query: { kind: SubjectKind, id: number } }) => Promise<unknown>")
    expect(component).toContain("fetchImpact('/api/knowledge/impact-preview', { query: { kind: kind.value, id } })")
    expect(component).not.toContain('method:')
    expect(component).not.toContain('body:')
    expect(component).not.toContain("method: 'POST'")
    expect(component).not.toContain('type="number"')
    expect(component).toContain('options.value.some(option => String(option.id) === selectedId.value)')
  })

  it('represents loading, owner/auth/input/not-found/failure states without displaying private errors', () => {
    for (const state of ['loading', 'unauthorized', 'invalid', 'not-found', 'conflict', 'unavailable', 'empty', 'ready']) expect(component).toContain(`'${state}'`)
    expect(component).toContain('status === 401')
    expect(component).toContain('status === 422')
    expect(component).toContain('status === 404')
    expect(component).toContain('status === 409')
    expect(component).toContain('未截斷結果')
    expect(component).toContain('沒有以假資料補足')
    expect(component).not.toContain('error.message')
    expect(component).not.toContain('statusMessage')
  })

  it('requires the fixed six-bucket order, explicit unknown coverage, and fail-closed flags', () => {
    for (const bucket of ['content', 'schema', 'dataset', 'public_api', 'benchmark_prompt', 'reviewer']) {
      expect(component).toContain(`'${bucket}'`)
      expect(types).toContain(`'${bucket}'`)
    }
    expect(component).toContain('尚未接上，無法判定')
    expect(component).toContain('known_explicit_dependencies_only')
    expect(component).toContain('exhaustive !== false')
    expect(component).toContain('automaticPublication !== false')
    expect(component).toContain('productionActivation !== false')
    expect(component).toContain('automaticTrainingAdmission !== false')
    expect(component).toContain('value.ownerUserId < 1')
    expect(component).toContain('bucket.items.length !== 0')
    expect(component).toContain('validLineage(value.affectedKnowledge)')
    expect(component).toContain('value.length <= 10_000')
    expect(component).toContain('不是 compare-and-swap 授權')
    expect(component).toContain('直接關聯的知識紀錄')
  })

  it('states the preview cannot publish, mutate, train, or activate', () => {
    expect(component).toContain('不發布、不訓練')
    expect(component).toContain('不變更業務狀態')
    expect(component).toContain('不自動准入訓練')
    expect(component).not.toContain('/api/knowledge/publish')
    expect(component).not.toContain('/api/knowledge/training')
  })
})
