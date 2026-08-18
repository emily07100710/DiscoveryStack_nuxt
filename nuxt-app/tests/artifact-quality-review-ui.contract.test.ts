import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const auditLab = readFileSync(new URL('../pages/audit-lab.vue', import.meta.url), 'utf8')

describe('artifact quality review UI contract', () => {
  it('shows a dedicated saving, success, and failure state for owner quality reviews', () => {
    expect(auditLab).toContain("const artifactQualityStatus = ref<'idle' | 'saving' | 'success' | 'error'>('idle')")
    expect(auditLab).toContain("artifactQualityStatus.value = 'saving'")
    expect(auditLab).toContain("artifactQualityStatus.value = 'success'")
    expect(auditLab).toContain("artifactQualityStatus.value = 'error'")
    expect(auditLab).toContain('正在儲存產物品質審核…')
    expect(auditLab).toContain('產物 #${artifactId} 已儲存為')
    expect(auditLab).toContain('function requestFailureMessage')
    expect(auditLab).toContain('failure.data?.statusMessage')
  })

  it('keeps the owner-only quality endpoint and reloads persisted artifacts after a successful review', () => {
    expect(auditLab).toContain('`/api/intelligence/artifacts/${artifactId}/quality`')
    expect(auditLab).toContain('await loadPublicArtifacts()')
  })
})
