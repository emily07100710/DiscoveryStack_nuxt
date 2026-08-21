import { describe, expect, it } from 'vitest'
import { leadDedupeKey, leadInputSchema, MODEL_IMPROVEMENT_CONSENT_VERSION, modelImprovementConsentReceipt } from '../server/utils/leadInput'

const validLead = {
  name: 'Rin Chen',
  email: 'RIN@EXAMPLE.COM',
  company: 'Signal Studio',
  website: '',
  packageInterest: 'clarify' as const,
  language: 'zh-hant' as const,
  message: '',
  privacyConsent: true as const,
  recontactConsent: false,
  companyFax: '',
}

describe('lead input boundary', () => {
  it('accepts a minimum consented lead and normalises the email address', () => {
    const parsed = leadInputSchema.parse(validLead)
    expect(parsed.email).toBe('rin@example.com')
    expect(parsed.privacyConsent).toBe(true)
  })

  it('rejects a request without explicit privacy consent', () => {
    const result = leadInputSchema.safeParse({ ...validLead, privacyConsent: false })
    expect(result.success).toBe(false)
  })

  it('keeps model improvement consent optional and false by default', () => {
    const parsed = leadInputSchema.parse(validLead)
    expect(parsed.modelImprovementConsent).toBe(false)
  })

  it('creates a versioned consent receipt only after an explicit opt-in', () => {
    const recordedAt = new Date('2026-08-22T00:00:00.000Z')
    expect(modelImprovementConsentReceipt(true, recordedAt)).toEqual({
      modelImprovementConsent: true,
      modelImprovementConsentVersion: MODEL_IMPROVEMENT_CONSENT_VERSION,
      modelImprovementConsentAt: recordedAt,
      modelImprovementConsentRevokedAt: null,
    })
    expect(modelImprovementConsentReceipt(false, recordedAt)).toMatchObject({
      modelImprovementConsent: false,
      modelImprovementConsentVersion: null,
      modelImprovementConsentAt: null,
    })
  })

  it('uses the same dedupe identity despite case and surrounding whitespace', () => {
    const base = leadDedupeKey({ email: 'rin@example.com', company: 'Signal Studio' })
    const duplicate = leadDedupeKey({ email: ' RIN@EXAMPLE.COM ', company: ' Signal Studio ' })
    expect(duplicate).toBe(base)
  })
})
