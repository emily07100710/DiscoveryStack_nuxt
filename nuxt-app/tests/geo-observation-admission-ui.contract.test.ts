import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('../components/GeoObservationAdmission.vue', import.meta.url), 'utf8')

describe('Geo observation admission UI contract', () => {
  it('is owner-private, read/govern only, and keeps ML/provider activation outside the UI', () => {
    expect(component).toContain('/api/geo-outcome-model/admission/workspace')
    expect(component).toContain('/api/geo-outcome-model/admission/intake')
    expect(component).toContain('/api/geo-outcome-model/candidate-sets/review')
    expect(component).toContain('/api/geo-outcome-model/observations/${observation.observationFingerprint}/verify')
    expect(component).toContain('這不是 Colab、正式模型或訓練入口')
    expect(component).toContain('trainingAdmission !== false')
    expect(component).toContain('productionActivation !== false')
    expect(component).not.toMatch(/fetch\s*\(|\$fetch\([^\n]*provider|train(?:ing)?\s*\(/iu)
    expect(component).not.toMatch(/feature(?:Vector|Json|JSON|Inputs?)?\s*[:=]/iu)
  })

  it('requires explicit independent confirmations and keeps source binding limited to evidence verification', () => {
    expect(component).toContain('candidateSeenConfirmed.value')
    expect(component).toContain('!draft.confirmed')
    expect(component).toContain("action === 'verify_evidence' ? { sourceRecordId }")
    expect(component).toContain('sourceRecordId,\n    decision: \'revoke\'')
    expect(component).toContain('featureOrigin')
    expect(component).toContain('unknown_external')
    expect(component).toContain('實際可見且確認已檢索到的候選')
    expect(component).not.toContain('實際看見或檢索到的候選')
    expect(component).toContain("subtle.digest('SHA-256'")
    expect(component).toContain('item.citationStatus === \'not_cited\' && item.observation === null && hasCurrentCandidateSet(item.candidateSetFingerprint)')
    expect(component).not.toContain('localStorage')
  })

  it('uses bounded unknown response transport and maps errors to static UI copy', () => {
    expect(component).toContain('const requestAdmission = $fetch as unknown as AdmissionRequest')
    expect(component).toContain('function staticActionError(error: unknown): string')
    expect(component).toContain("status === 409 ? '資料已變更或請求識別衝突")
    expect(component).toContain('idempotencyKeys = new Map<string, string>()')
    expect(component).toContain('generation !== requestGeneration.value')
    expect(component).not.toContain('error.message')
    expect(component).not.toContain('error.data')
  })
})
