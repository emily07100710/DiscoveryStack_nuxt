import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const auditLab = readFileSync(new URL('../pages/audit-lab.vue', import.meta.url), 'utf8')
const repository = readFileSync(new URL('../server/public-intelligence/repository.ts', import.meta.url), 'utf8')

describe('immutable manifest evidence contract', () => {
  it('derives owner-visible governance summary from frozen dataset members using canonical identity', () => {
    expect(repository).toContain('manifestSummary: {')
    expect(repository).toContain('canonicalHumanAnnotationSourceUrl(member.artifactSourceUrl)')
    expect(repository).toContain('primaryJourneyStageCounts: stageCounts')
    expect(repository).toContain('qualityAndPii: { activeMemberCount, qualityPassedCount, piiClearCount')
    expect(repository).toContain("eq(publicIntelligenceDatasetMembers.memberStatus, 'included')")
  })

  it('keeps detailed immutable manifest evidence inside the Traditional Chinese owner audit interface', () => {
    expect(auditLab).toContain('不可變 manifest 證據')
    expect(auditLab).toContain('來源／授權')
    expect(auditLab).toContain('確定性分割')
    expect(auditLab).toContain('凍結成員／唯一文件')
    expect(auditLab).toContain('品質／PII')
    expect(auditLab).toContain('只在 owner 私有稽核實驗室顯示')
  })
})
