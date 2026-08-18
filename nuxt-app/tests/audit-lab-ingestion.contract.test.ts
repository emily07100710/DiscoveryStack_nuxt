import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const auditLab = readFileSync(join(root, 'pages/audit-lab.vue'), 'utf8')

describe('Audit Lab approved ingestion form contract', () => {
  it('preselects exactly one fully eligible source and clears a stale selection', () => {
    expect(auditLab).toContain('function eligibleIngestionSources()')
    expect(auditLab).toContain("item.reviewStatus === 'approved'")
    expect(auditLab).toContain("item.robotsStatus === 'reviewed_allow'")
    expect(auditLab).toContain("['allows_research', 'allows_evaluation', 'allows_training'].includes(item.termsStatus)")
    expect(auditLab).toContain("item.copyrightRisk === 'low'")
    expect(auditLab).toContain("item.piiStatus === 'none_detected'")
    expect(auditLab).toContain('eligible.length === 1 && ingestionForm.sourceId === 0')
    expect(auditLab).toContain('ingestionForm.sourceId = eligible[0]!.id')
    expect(auditLab).toContain('!eligible.some(source => source.id === ingestionForm.sourceId)')
  })

  it('uses the same eligible-source policy, exposes bounded same-domain collection, and surfaces first-attempt errors in Traditional Chinese', () => {
    expect(auditLab).toContain('v-for="source in eligibleIngestionSources()"')
    expect(auditLab).toContain("await $fetch<{ message: string }>('/api/intelligence/ingestion-jobs'")
    expect(auditLab).toContain('已核准文件無法處理；請檢查來源政策、robots 與公開 URL。')
    expect(auditLab).toContain("mode: 'site' as 'document' | 'site'")
    expect(auditLab).toContain('maxPages: 10')
    expect(auditLab).toContain('maxDepth: 1')
    expect(auditLab).toContain('v-model="ingestionForm.mode"')
    expect(auditLab).toContain('v-model.number="ingestionForm.maxPages"')
    expect(auditLab).toContain('v-model.number="ingestionForm.maxDepth"')
    expect(auditLab).toContain('v-else-if="ingestionStatus === \'error\' && mlMessage" class="audit-feedback audit-failure"')
    expect(auditLab).toContain('最多 10 頁、發現深度最多 2 層')
  })

  it('keeps collection scope inside the approved source boundary', () => {
    expect(auditLab).toContain('不允許外部連結或子網域')
    expect(auditLab).toContain('擴大頁數，不擴大權限。')
    expect(auditLab).toContain('來源政策、網域、robots、條款、PII 與去重紀錄')
  })
})
