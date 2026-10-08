import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../pages/audit-lab/geo-outcome-model.vue', import.meta.url), 'utf8')

describe('GEO Knowledge authority owner UI contract', () => {
  it('requires an intentional declaration and exact visible acknowledgment before approval', () => {
    expect(page).toContain("type KnowledgeMode = 'declared_none_v1' | 'pinned_v1'")
    expect(page).toContain('knowledgeMode: KnowledgeMode | \'\'')
    expect(page).toContain('Select a declaration…')
    expect(page).toContain('我確認此 immutable dataset 不依賴')
    expect(page).toContain('我確認此 immutable dataset 將依賴系統目前解析並記錄的 Knowledge pins')
    expect(page).toContain('!datasetReviewDraft(dataset).knowledgeMode || !datasetReviewDraft(dataset).confirmed')
    expect(page).toContain("@change=\"changeKnowledgeMode(dataset)\"")
    expect(page).toContain("to=\"/audit-lab/knowledge\"")
    expect(page).not.toContain('localStorage')
  })

  it('shows optional authority status without inventing a no-dependency declaration', () => {
    expect(page).toContain('knowledgeAuthority?: KnowledgeAuthoritySummary')
    expect(page).toContain('dataset.knowledgeAuthority.status')
    expect(page).toContain('dataset.knowledgeAuthority.activePinCount')
    expect(page).toContain('dataset.knowledgeAuthority.reasonCodes')
    expect(page).toContain('no dependency declaration can be inferred')
    expect(page).not.toContain("knowledgeMode: 'declared_none_v1'")
  })

  it('preserves exact approval body and idempotency key through uncertainty, and reloads on conflict', () => {
    expect(page).toContain('type DatasetReviewCommand = { key: string, body: Record<string, unknown> }')
    expect(page).toContain("state: 'idle' | 'sending' | 'uncertain' | 'reload_required'")
    expect(page).toContain('draft.command = { key, body: { idempotencyKey: key, ...body } }')
    expect(page).toContain("draft.state = 'uncertain'")
    expect(page).toContain("draft.state = 'reload_required'")
    expect(page).toContain('Retry same approval')
    expect(page).toContain('Reload workspace')
    expect(page).toContain("dataset.status === 'approved' && (!dataset.knowledgeAuthority || dataset.knowledgeAuthority.status === 'stale' || dataset.knowledgeAuthority.status === 'not_declared')")
    expect(page).toContain("@click=\"reviewDataset(dataset, 'revoke')\"")
  })
})
