// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FitReviewFormIsland from '../src/components/FitReviewFormIsland.vue'
import AutomaticSiteAnalysis from '../src/components/AutomaticSiteAnalysis.vue'
import { publicApiFetch } from '../src/lib/publicApi'

vi.mock('../src/lib/publicApi', () => ({
  publicApiFetch: vi.fn(),
}))

const mockedPublicApiFetch = vi.mocked(publicApiFetch)

async function fillFitReview(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('#f-name').setValue('Ada Lovelace')
  await wrapper.get('#f-email').setValue('ada@example.com')
  await wrapper.get('#f-company').setValue('Analytical Engines')
  await wrapper.get('input[name="privacy"]').setValue(true)
}

const analysisResult = {
  finalUrl: 'https://example.com/',
  hostname: 'example.com',
  analysedAt: '2026-08-24T00:00:00.000Z',
  scope: 'public_homepage_only' as const,
  scores: { overall: 82, seo: 84, geo: 80, brandContent: 81, ux: 83 },
  checks: {},
  recommendationKeys: ['clarify_page_topic' as const],
}

describe('public forms', () => {
  beforeEach(() => mockedPublicApiFetch.mockReset())
  afterEach(() => vi.useRealTimers())

  it('shows validation feedback before Fit Review submits', async () => {
    const wrapper = mount(FitReviewFormIsland, { props: { locale: 'en' } })

    await wrapper.get('form').trigger('submit.prevent')

    expect(wrapper.get('#formStatus').text()).toBe('Please fill in name, email, company, and check privacy consent.')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('shows success feedback after Fit Review /api/leads resolves', async () => {
    mockedPublicApiFetch.mockResolvedValueOnce({ ok: true })
    const wrapper = mount(FitReviewFormIsland, { props: { locale: 'en' } })

    await fillFitReview(wrapper)
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    expect(mockedPublicApiFetch).toHaveBeenCalledWith('/api/leads', expect.objectContaining({ body: expect.objectContaining({ name: 'Ada Lovelace', privacyConsent: true }) }))
    expect(wrapper.get('#formStatus').text()).toBe('Received. The right department will follow up with your context.')
  })

  it('shows generic feedback after Fit Review /api/leads rejects', async () => {
    mockedPublicApiFetch.mockRejectedValueOnce(new Error('server unavailable'))
    const wrapper = mount(FitReviewFormIsland, { props: { locale: 'en' } })

    await fillFitReview(wrapper)
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    expect(wrapper.get('#formStatus').text()).toBe('We could not send this right now. Please try again shortly.')
  })

  it('rejects an incomplete public analysis URL locally', async () => {
    const wrapper = mount(AutomaticSiteAnalysis, { props: { locale: 'en' } })

    await wrapper.get('#analysis-url').setValue('example.com')
    await wrapper.get('form').trigger('submit.prevent')

    expect(wrapper.get('[role="alert"]').text()).toBe('Enter a complete public http:// or https:// URL.')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('renders the analysis score after /api/site-analysis succeeds', async () => {
    vi.useFakeTimers()
    mockedPublicApiFetch.mockResolvedValueOnce(analysisResult)
    const wrapper = mount(AutomaticSiteAnalysis, { props: { locale: 'en' } })

    await wrapper.get('#analysis-url').setValue('https://example.com')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()
    vi.advanceTimersByTime(3000)
    await flushPromises()

    expect(mockedPublicApiFetch).toHaveBeenCalledWith('/api/site-analysis', expect.objectContaining({ body: { url: 'https://example.com/' } }))
    expect(wrapper.text()).toContain('82')
    expect(wrapper.text()).toContain('Acquisition foundation score')
  })

  it('returns the generic scan error after /api/site-analysis rejects', async () => {
    vi.useFakeTimers()
    mockedPublicApiFetch.mockRejectedValueOnce(new Error('scan failed'))
    const wrapper = mount(AutomaticSiteAnalysis, { props: { locale: 'en' } })

    await wrapper.get('#analysis-url').setValue('https://example.com')
    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()
    vi.advanceTimersByTime(3000)
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe('We could not safely read that public homepage. Check that the URL opens publicly and try again shortly.')
  })
})
