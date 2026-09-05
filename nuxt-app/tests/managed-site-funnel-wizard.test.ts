import { describe, expect, it } from 'vitest'
import { FUNNEL_STEPS, MODULE_HELP, canAdvance, consentGateState, firstIncompleteStep, formatTwd, isScrolledToBottom, missingRequiredModulesForSiteType, normalizedModulesForSiteType, stepCompletion, type FunnelAnswersView } from '../utils/managedSiteFunnel'

function completeAnswers(): FunnelAnswersView {
  return {
    existingSite: { hasSite: false },
    company: { brandName: '好日工作室', whatWeDo: '協助小店整理品牌內容。', feelings: ['warm'], mainOffer: '品牌內容顧問', conversionGoals: ['increase_inquiries'] },
    contact: { contactName: '林小姐', email: 'hello@example.com' },
    style: { referenceUrls: [], stylePreset: 'warm', designTier: 'template' },
    siteType: 'brand_blog',
    modules: [],
    domain: { option: 'existing' },
    plan: { planKey: 'site_only' },
  }
}

describe('managed-site funnel wizard core', () => {
  it('requires a genuinely read and checked consent state', () => {
    expect(consentGateState({ scrolledToBottom: false, checked: false })).toMatchObject({ canTick: false, canSubmit: false, reason: expect.stringContaining('捲到最後') })
    expect(consentGateState({ scrolledToBottom: true, checked: false })).toMatchObject({ canTick: true, canSubmit: false, reason: expect.stringContaining('勾選') })
    expect(consentGateState({ scrolledToBottom: true, checked: true })).toEqual({ canTick: true, canSubmit: true, reason: '' })
    expect(consentGateState({ scrolledToBottom: false, checked: true }).canSubmit).toBe(false)
  })

  it('detects the bottom of both scrolling and short agreement panes', () => {
    expect(isScrolledToBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
    expect(isScrolledToBottom({ scrollTop: 597, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
    expect(isScrolledToBottom({ scrollTop: 560, clientHeight: 400, scrollHeight: 1000 })).toBe(false)
    expect(isScrolledToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 350 })).toBe(true)
  })

  it('gates every required step and finds the first incomplete step', () => {
    const complete = completeAnswers()
    expect(firstIncompleteStep({}, { accepted: false })).toBe(1)
    for (const step of [1, 2, 3, 4, 5, 7, 8]) {
      expect(canAdvance(step, {}, { accepted: false }), `step ${step} should be incomplete`).toBe(false)
      expect(canAdvance(step, complete, { accepted: true }), `step ${step} should be complete`).toBe(true)
    }
    expect(canAdvance(6, {}, { accepted: false })).toBe(true)
    expect(canAdvance(9, {}, { accepted: false })).toBe(false)
    expect(canAdvance(9, complete, { accepted: true })).toBe(true)
    expect(firstIncompleteStep(complete, { accepted: true })).toBe(9)
    expect(stepCompletion(2, { ...complete, contact: { contactName: '', email: '' } }, { accepted: true }).missing).toEqual(expect.arrayContaining(['聯絡人姓名', '聯絡 Email']))
    expect(canAdvance(2, { ...complete, contact: { contactName: '林小姐', email: 'hello@example.com', phone: '分機一' } }, { accepted: true })).toBe(false)
    expect(canAdvance(3, { ...complete, style: { designTier: 'template', referenceUrls: ['https://example.com', 'https://example.com/'] } }, { accepted: true })).toBe(false)
  })

  it('keeps exactly nine plain-language steps in order', () => {
    expect(FUNNEL_STEPS).toHaveLength(9)
    expect(FUNNEL_STEPS.map(item => item.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const item of FUNNEL_STEPS) {
      expect(item.title.trim()).not.toBe('')
      expect(item.help.trim()).not.toBe('')
    }
  })

  it('formats zero-decimal TWD without changing the unit', () => {
    expect(formatTwd(12000)).toBe('NT$12,000')
    expect(formatTwd(0)).toBe('NT$0')
    expect(formatTwd(5)).toBe('NT$5')
  })

  it('keeps module explanations free of embedded prices', () => {
    expect(JSON.stringify(MODULE_HELP)).not.toMatch(/\d{3,}/u)
  })

  it('restores the mandatory commerce module while allowing empty non-commerce modules', () => {
    expect(normalizedModulesForSiteType('simple_commerce', [])).toEqual(['shopify_commerce'])
    expect(normalizedModulesForSiteType('simple_commerce', ['contact_lead_capture'])).toEqual(['contact_lead_capture', 'shopify_commerce'])
    expect(missingRequiredModulesForSiteType('simple_commerce', [])).toEqual(['shopify_commerce'])
    expect(stepCompletion(5, { ...completeAnswers(), siteType: 'simple_commerce', modules: [] }, { accepted: true }).missing).toContain('商品與購物流程')
    expect(normalizedModulesForSiteType('brand_blog', [])).toEqual([])
    expect(missingRequiredModulesForSiteType('one_page', [])).toEqual([])
    expect(canAdvance(5, { ...completeAnswers(), siteType: 'brand_blog', modules: [] }, { accepted: true })).toBe(true)
  })
})
