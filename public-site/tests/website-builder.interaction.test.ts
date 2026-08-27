// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebsiteBuilderConcept from '../src/components/WebsiteBuilderConcept.vue'
import { publicApiFetch } from '../src/lib/publicApi'

vi.mock('../src/lib/publicApi', () => ({
  publicApiFetch: vi.fn(),
}))

const mockedPublicApiFetch = vi.mocked(publicApiFetch)

const successfulAnalysis = {
  finalUrl: 'https://example.com/',
  hostname: 'example.com',
  analysedAt: '2026-08-27T00:00:00.000Z',
  scope: 'public_homepage_only',
  scores: { overall: 82, seo: 84, geo: 80 },
  checks: {},
  recommendationKeys: ['clarify_page_topic'],
}

function mountBuilder() {
  return mount(WebsiteBuilderConcept, { attachTo: document.body })
}

async function enterNewBrief(wrapper: ReturnType<typeof mountBuilder>) {
  await wrapper.get('.entry-choice:nth-child(2)').trigger('click')
  await wrapper.get('.builder-primary').trigger('click')
  await wrapper.get('#builder-brand').setValue('山嶼牙醫診所')
  await wrapper.get('#builder-audience').setValue('第一次看牙的家庭')
  await wrapper.get('#builder-brief').setValue('我們提供安心、透明與兒童友善的家庭牙科照護。')
  await wrapper.get('#builder-action').setValue('預約第一次諮詢')
  await wrapper.get('.builder-primary').trigger('click')
}

async function reachPreview(wrapper: ReturnType<typeof mountBuilder>, type = 'brand-blog') {
  vi.useFakeTimers()
  await enterNewBrief(wrapper)
  const typeLabel = type === 'commerce' ? '簡易電商' : type === 'one-page' ? '一頁式網站' : '品牌＋部落格'
  await wrapper.findAll('.architecture-choice').find((node) => node.text().includes(typeLabel))!.trigger('click')
  await wrapper.get('.builder-primary').trigger('click')
  await wrapper.findAll('.theme-choice').find((node) => node.text().includes('理性清晰'))!.trigger('click')
  await wrapper.findAll('.module-grid button').find((node) => node.text().includes('AI 問答助手'))!.trigger('click')
  await wrapper.get('.builder-primary').trigger('click')
  vi.advanceTimersByTime(3600)
  await flushPromises()
  expect(wrapper.text()).toContain('這個方向，像你的品牌嗎？')
}

describe('website builder experience', () => {
  beforeEach(() => {
    mockedPublicApiFetch.mockReset()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('completes the new-site path through handoff without calling a private API', async () => {
    const wrapper = mountBuilder()
    await reachPreview(wrapper, 'one-page')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('我喜歡這個方向'))!.trigger('click')
    await wrapper.findAll('.plan-choice').find((node) => node.text().includes('GEO 持續成長'))!.trigger('click')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('規劃網域與上線'))!.trigger('click')
    await wrapper.findAll('.domain-choice').find((node) => node.text().includes('購買新網域'))!.trigger('click')
    await wrapper.get('#builder-domain').setValue('shanyu-dental.tw')
    await wrapper.get('.domain-form .builder-secondary').trigger('click')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('查看完整摘要'))!.trigger('click')
    await wrapper.get('.review-price input[type="checkbox"]').setValue(true)
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('保存這份預覽'))!.trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    await wrapper.find('.handoff-dialog .builder-primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('方向已經整理好了')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('沒有送出真實訂單')
  })

  it('runs an existing-site diagnosis through the public allowlist and only shows real response data', async () => {
    mockedPublicApiFetch.mockResolvedValueOnce(successfulAnalysis)
    const wrapper = mountBuilder()
    await wrapper.get('.entry-choice:nth-child(1)').trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.get('#builder-existing-url').setValue('https://example.com')
    await wrapper.get('.builder-secondary').trigger('click')
    await flushPromises()

    expect(mockedPublicApiFetch).toHaveBeenCalledWith('/api/site-analysis', expect.objectContaining({ body: { url: 'https://example.com/' } }))
    expect(wrapper.text()).toContain('82')
    expect(wrapper.text()).toContain('PUBLIC HOMEPAGE ONLY')
    expect(wrapper.text()).toContain('不是排名、流量或成效保證')
  })

  it('rejects incomplete URLs locally and never invents a diagnosis when the public API fails', async () => {
    mockedPublicApiFetch.mockRejectedValueOnce(new Error('unavailable'))
    const wrapper = mountBuilder()
    await wrapper.get('.entry-choice:nth-child(1)').trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.get('#builder-existing-url').setValue('example.com')
    await wrapper.get('.builder-secondary').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toContain('完整的公開')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()

    await wrapper.get('#builder-existing-url').setValue('https://example.com')
    await wrapper.get('.builder-secondary').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('無法安全讀取')
    expect(wrapper.text()).not.toContain('82')
  })

  it('blocks required steps, preserves brief data when going back, and follows the fixed generation order', async () => {
    vi.useFakeTimers()
    const wrapper = mountBuilder()
    await wrapper.get('.entry-choice:nth-child(2)').trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    expect(wrapper.text()).toContain('請先完成')

    await wrapper.get('#builder-brand').setValue('保留的品牌')
    await wrapper.get('#builder-audience').setValue('小型團隊')
    await wrapper.get('#builder-brief').setValue('保留的介紹')
    await wrapper.get('#builder-action').setValue('聯絡我們')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.findAll('.architecture-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.findAll('.theme-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    expect(wrapper.text()).toContain('理解品牌與訪客目標')
    vi.advanceTimersByTime(0)
    await flushPromises()
    expect(wrapper.text()).toContain('建立網站資訊架構')
    vi.advanceTimersByTime(760)
    await flushPromises()
    expect(wrapper.text()).toContain('安排 SEO／GEO 內容結構')
    vi.advanceTimersByTime(760 * 3 + 520)
    await flushPromises()
    expect(wrapper.text()).toContain('這個方向，像你的品牌嗎？')

    await wrapper.get('.builder-back').trigger('click')
    expect(wrapper.text()).toContain('你希望它給人的第一印象是什麼？')
    await wrapper.get('.builder-back').trigger('click')
    expect(wrapper.text()).toContain('網站要先幫你完成什麼？')
    await wrapper.get('.builder-back').trigger('click')
    expect((wrapper.get('#builder-brand').element as HTMLInputElement).value).toBe('保留的品牌')
  })

  it('renders different site types, reflects selected modules, switches device previews, and keeps domain as simulation', async () => {
    const wrapper = mountBuilder()
    await reachPreview(wrapper, 'commerce')
    expect(wrapper.text()).toContain('品牌 AI 助手')
    await wrapper.findAll('.viewport-switch button').find((node) => node.text() === '手機')!.trigger('click')
    expect(wrapper.find('.preview-browser-wrap.viewport-mobile').exists()).toBe(true)
    await wrapper.findAll('.generated-header nav button').find((node) => node.text() === '商品')!.trigger('click')
    expect(wrapper.text()).toContain('SHOPIFY READY / NOT CONNECTED')
    expect(wrapper.text()).toContain('商品先被看見')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('我喜歡這個方向'))!.trigger('click')
    await wrapper.findAll('.plan-choice')[0].trigger('click')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('規劃網域與上線'))!.trigger('click')
    await wrapper.findAll('.domain-choice')[0].trigger('click')
    await wrapper.get('#builder-domain').setValue('store.example.tw')
    await wrapper.get('.domain-form .builder-secondary').trigger('click')
    expect(wrapper.text()).toContain('目前只完成模擬，尚未確認可購買')
    expect(wrapper.text()).not.toContain('一定可買')
  })

  it('opens the handoff dialog, closes with Escape, and returns focus to the trigger', async () => {
    const wrapper = mountBuilder()
    await reachPreview(wrapper)
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('我喜歡這個方向'))!.trigger('click')
    await wrapper.findAll('.plan-choice')[0].trigger('click')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('規劃網域與上線'))!.trigger('click')
    await wrapper.findAll('.domain-choice')[0].trigger('click')
    await wrapper.get('#builder-domain').setValue('example.tw')
    await wrapper.get('.domain-form .builder-secondary').trigger('click')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('查看完整摘要'))!.trigger('click')
    await wrapper.get('.review-price input[type="checkbox"]').setValue(true)
    const trigger = wrapper.findAll('.builder-primary').find((node) => node.text().includes('保存這份預覽'))!
    ;(trigger.element as HTMLElement).focus()
    await trigger.trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[role="dialog"]')
    expect(document.activeElement).toBe(wrapper.get('.dialog-close').element)
    await dialog.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
  })

  it('cleans generation timers on unmount and disables motion semantics under reduced-motion', async () => {
    vi.useFakeTimers()
    const matchMedia = vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }))
    vi.stubGlobal('matchMedia', matchMedia)
    const wrapper = mountBuilder()
    await enterNewBrief(wrapper)
    await wrapper.findAll('.architecture-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.findAll('.theme-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    wrapper.unmount()
    vi.runAllTimers()
    expect(wrapper.exists()).toBe(false)
    vi.unstubAllGlobals()
  })
})
