// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gsap } from 'gsap'
import WebsiteBuilderConcept from '../src/components/WebsiteBuilderConcept.vue'
import { publicApiFetch } from '../src/lib/publicApi'

vi.mock('../src/lib/publicApi', () => ({
  publicApiFetch: vi.fn(),
}))

const mockedPublicApiFetch = vi.mocked(publicApiFetch)
const mountedBuilders: ReturnType<typeof mount>[] = []

function mountBuilder(withMotion = false) {
  const wrapper = mount(WebsiteBuilderConcept, {
    attachTo: document.body,
    props: { customerStartUrl: 'https://ops.example.com/customer/managed-sites/start' },
    ...(withMotion ? { global: { stubs: { transition: false } } } : {}),
  })
  mountedBuilders.push(wrapper)
  return wrapper
}

function motionGeometry(reduced = false) {
  const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = []
  const media = { matches: reduced, media: '(prefers-reduced-motion: reduce)', addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    observe = vi.fn()
    unobserve = vi.fn()
    constructor() { observers.push(this) }
  })
  const heightOf = (element: HTMLElement | null): number => {
    if (!element) return 0
    if (element.matches('.builder-stage-host, .generated-view-shell')) return parseFloat(element.style.height) || heightOf(element.querySelector<HTMLElement>(':scope > :not([data-stage-leaving])') ?? element.firstElementChild as HTMLElement | null)
    if (element.matches('.builder-step')) return element.getAttribute('aria-labelledby') === 'style-title' ? 840 : 620
    if (element.matches('.generated-main')) return element.classList.contains('page-services') ? 440 : 380
    if (element.matches('.service-overview-row')) return parseFloat(element.style.height) || ((element as HTMLDetailsElement).open ? 128 : 48)
    if (element.matches('.service-overview-row > summary')) return 48
    if (element.matches('.service-overview-detail')) return 80
    return 20
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = heightOf(this)
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) } as DOMRect
  })
  return { media, observers }
}

async function finishMotion(wrapper: ReturnType<typeof mountBuilder>) {
  const scope = wrapper.element as HTMLElement
  const hosts = scope.querySelectorAll<HTMLElement>('.builder-stage-host, .generated-view-shell')
  gsap.getTweensOf([...hosts]).forEach(tween => tween.progress(1))
  gsap.getTweensOf([...scope.querySelectorAll('*')]).forEach(tween => tween.progress(1))
  await flushPromises()
}

async function reachAnimatedPreview(wrapper: ReturnType<typeof mountBuilder>, still = false) {
  vi.useFakeTimers()
  await enterNewBrief(wrapper)
  await finishMotion(wrapper)
  await wrapper.findAll('.architecture-choice')[1].trigger('click')
  await wrapper.get('.builder-primary').trigger('click')
  await finishMotion(wrapper)
  await wrapper.findAll('.theme-choice')[0].trigger('click')
  if (still) await wrapper.findAll('.motion-choice')[0].trigger('click')
  await wrapper.get('.builder-primary').trigger('click')
  await finishMotion(wrapper)
  vi.advanceTimersByTime(3600)
  await flushPromises()
  await finishMotion(wrapper)
}

async function enterNewBrief(wrapper: ReturnType<typeof mountBuilder>) {
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
    delete document.documentElement.dataset.motionPaused
  })

  afterEach(() => {
    mountedBuilders.splice(0).forEach(wrapper => { if (wrapper.exists()) wrapper.unmount() })
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete document.documentElement.dataset.motionPaused
  })

  it('sends the chosen website direction through the public lead API only after contact consent', async () => {
    mockedPublicApiFetch.mockResolvedValueOnce({ received: true, duplicate: true }).mockResolvedValueOnce({ received: true, duplicate: false })
    const wrapper = mountBuilder()
    await reachPreview(wrapper, 'one-page')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('我喜歡這個方向'))!.trigger('click')
    await wrapper.findAll('.plan-choice').find((node) => node.text().includes('GEO 持續成長'))!.trigger('click')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('規劃網域與上線'))!.trigger('click')
    await wrapper.findAll('.domain-choice').find((node) => node.text().includes('購買新網域'))!.trigger('click')
    await wrapper.get('#builder-domain').setValue('shanyu-dental.tw')
    await wrapper.get('.domain-form .builder-secondary').trigger('click')
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('查看完整摘要'))!.trigger('click')
    expect(wrapper.get('.review-price').text()).toContain('58,800')
    expect(wrapper.get('.review-price').text()).toContain('規劃中功能只記錄需求')
    await wrapper.get('.review-price input[type="checkbox"]').setValue(true)
    await wrapper.findAll('.builder-primary').find((node) => node.text().includes('保存這份預覽'))!.trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    await wrapper.get('.handoff-contact').trigger('submit.prevent')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
    expect(wrapper.get('.handoff-contact [role="alert"]').text()).toContain('同意資料處理')
    await wrapper.get('.handoff-contact input[name="name"]').setValue('王小姐')
    await wrapper.get('.handoff-contact input[name="email"]').setValue('owner@example.tw')
    await wrapper.get('.handoff-contact input[name="company"]').setValue('山嶼牙醫診所')
    await wrapper.get('.handoff-consent input[type="checkbox"]').setValue(true)
    await wrapper.get('.handoff-contact').trigger('submit.prevent')
    await flushPromises()
    expect(wrapper.get('.handoff-contact [role="alert"]').text()).toContain('新調整尚未更新')
    expect(wrapper.text()).not.toContain('網站方向已送出')
    await wrapper.get('.handoff-contact').trigger('submit.prevent')
    await flushPromises()
    expect(mockedPublicApiFetch).toHaveBeenCalledWith('/api/leads', expect.objectContaining({ body: expect.objectContaining({ email: 'owner@example.tw', privacyConsent: true, message: expect.stringContaining('shanyu-dental.tw') }) }))
    expect(wrapper.text()).toContain('網站方向已送出')
    expect(wrapper.text()).toContain('尚未付款')
    expect(wrapper.get('[data-managed-site-start]').attributes('href')).toBe('https://ops.example.com/customer/managed-sites/start')
  })

  it('starts with a short brand brief and three customer-facing phases', () => {
    const wrapper = mountBuilder()

    expect(wrapper.get('#brief-title').text()).toBe('先說說你的生意。')
    expect(wrapper.findAll('.builder-progress button')).toHaveLength(3)
    expect(wrapper.get('.builder-progress button[aria-current="step"]').text()).toContain('建立網站')
    expect(wrapper.findAll('.builder-progress button').map(button => button.text())).toEqual([
      expect.stringContaining('建立網站'),
      expect.stringContaining('選擇方案'),
      expect.stringContaining('確認上線'),
    ])
    expect(wrapper.get('.builder-rail-top').text().replace(/\s/g, '')).toContain('01/03')
    expect(wrapper.find('.entry-choice').exists()).toBe(false)
    expect(wrapper.find('#builder-existing-url').exists()).toBe(false)
    expect(wrapper.find('.builder-back').exists()).toBe(false)
    expect(wrapper.findAll('.brief-grid input')).toHaveLength(3)
    expect(wrapper.find('.brief-grid textarea').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('公開診斷')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('validates reference URLs locally without analysing or reading the reference website', async () => {
    const wrapper = mountBuilder()
    await enterNewBrief(wrapper)
    await wrapper.findAll('.architecture-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.findAll('.theme-choice')[0].trigger('click')
    await wrapper.get('#builder-reference').setValue('example.com')
    await wrapper.get('#builder-reference').trigger('blur')

    expect(wrapper.get('[role="alert"]').text()).toContain('完整的公開 HTTPS 網址')
    expect(wrapper.get('.builder-primary').attributes('disabled')).toBeDefined()
    await wrapper.get('#builder-reference').setValue('https://example.com')
    await wrapper.get('#builder-reference').trigger('blur')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('.builder-primary').attributes('disabled')).toBeUndefined()
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('keeps chosen motion and the written style direction through preview, review and back navigation', async () => {
    vi.useFakeTimers()
    const wrapper = mountBuilder()
    const description = '深海軍藍搭配卡其，保留大量留白，細線粒子與節制的動畫。'
    expect(wrapper.get('.builder-experience').attributes('data-motion')).toBe('refined')
    await enterNewBrief(wrapper)
    await wrapper.findAll('.architecture-choice')[1].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await wrapper.findAll('.theme-choice')[0].trigger('click')
    await wrapper.findAll('.motion-choice').find(button => button.text().includes('互動層次'))!.trigger('click')
    await wrapper.get('#builder-style-description').setValue(description)
    expect(wrapper.get('.style-intent').text()).toContain('此預覽尚未連接 AI 風格判讀')
    expect(wrapper.get('.builder-experience').attributes('data-motion')).toBe('expressive')
    expect(wrapper.get('.builder-direction .motion-option-label').text()).toContain('互動層次')

    await wrapper.get('.builder-back').trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    expect((wrapper.get('#builder-style-description').element as HTMLTextAreaElement).value).toBe(description)
    expect(wrapper.findAll('.motion-choice').find(button => button.text().includes('互動層次'))!.attributes('aria-pressed')).toBe('true')
    await wrapper.get('.builder-primary').trigger('click')
    vi.advanceTimersByTime(3600)
    await flushPromises()
    expect(wrapper.get('.generated-preview').attributes('data-motion')).toBe('expressive')
    expect(wrapper.get('.builder-progress button[aria-current="step"]').text()).toContain('建立網站')

    await wrapper.get('.builder-back').trigger('click')
    expect((wrapper.get('#builder-style-description').element as HTMLTextAreaElement).value).toBe(description)
    expect(wrapper.get('.builder-experience').attributes('data-motion')).toBe('expressive')
    await wrapper.get('.builder-primary').trigger('click')
    vi.advanceTimersByTime(3600)
    await flushPromises()
    await wrapper.findAll('.builder-primary').find(button => button.text().includes('我喜歡這個方向'))!.trigger('click')
    expect(wrapper.get('.builder-progress button[aria-current="step"]').text()).toContain('選擇方案')
    expect(wrapper.get('.builder-rail-top').text().replace(/\s/g, '')).toContain('02/03')
    await wrapper.findAll('.plan-choice')[0].trigger('click')
    await wrapper.findAll('.builder-primary').find(button => button.text().includes('規劃網域與上線'))!.trigger('click')
    expect(wrapper.get('.builder-progress button[aria-current="step"]').text()).toContain('確認上線')
    expect(wrapper.get('.builder-rail-top').text().replace(/\s/g, '')).toContain('03/03')
    await wrapper.findAll('.domain-choice')[0].trigger('click')
    await wrapper.get('#builder-domain').setValue('style-preview.example.tw')
    await wrapper.get('.domain-form .builder-secondary').trigger('click')
    expect(wrapper.text()).toContain('尚未確認可購買')
    await wrapper.findAll('.builder-primary').find(button => button.text().includes('查看完整摘要'))!.trigger('click')
    expect(wrapper.get('.review-style-description').text()).toBe(description)
    expect(wrapper.get('.review-list').text()).toContain('互動層次')
    expect(wrapper.text()).toContain('這不是正式訂單')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('blocks required steps, preserves brief data when going back, and follows the fixed generation order', async () => {
    vi.useFakeTimers()
    const wrapper = mountBuilder()
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

  it('retargets panel height and keeps only the current step accessible after rapid back navigation', async () => {
    vi.useFakeTimers()
    motionGeometry()
    const wrapper = mountBuilder(true)
    await enterNewBrief(wrapper)
    await finishMotion(wrapper)
    await wrapper.findAll('.architecture-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    const host = wrapper.get('.builder-stage-host').element as HTMLElement
    expect(gsap.getTweensOf(host).some(tween => tween.vars.height === 840)).toBe(true)
    const leaving = wrapper.get('.builder-step[data-stage-leaving]')
    expect(leaving.attributes('aria-hidden')).toBe('true')
    expect((leaving.element as HTMLElement).inert).toBe(true)

    await wrapper.get('.builder-back').trigger('click')
    await finishMotion(wrapper)
    expect(wrapper.findAll('.builder-stage-host > .builder-step')).toHaveLength(1)
    expect(wrapper.find('[data-stage-leaving]').exists()).toBe(false)
    expect(host.style.height).toBe('')
    expect(document.activeElement).toBe(wrapper.get('#architecture-title').element)
    await wrapper.get('.builder-back').trigger('click')
    await finishMotion(wrapper)
    expect((wrapper.get('#builder-brand').element as HTMLInputElement).value).toBe('山嶼牙醫診所')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('keeps rapid preview page and device selections in sync with their pressed state', async () => {
    motionGeometry()
    const wrapper = mountBuilder(true)
    await reachAnimatedPreview(wrapper)
    await wrapper.findAll('.generated-header nav button').find(button => button.text() === '服務')!.trigger('click')
    await wrapper.findAll('.generated-header nav button').find(button => button.text() === '關於')!.trigger('click')
    await wrapper.findAll('.viewport-switch button').find(button => button.text() === '手機')!.trigger('click')
    await wrapper.findAll('.viewport-switch button').find(button => button.text() === '桌面')!.trigger('click')
    await finishMotion(wrapper)
    expect(wrapper.findAll('.generated-view-shell > .generated-main')).toHaveLength(1)
    expect(wrapper.get('.generated-main').classes()).toContain('page-about')
    expect(wrapper.get('.generated-header nav button[aria-pressed=true]').text()).toBe('關於')
    expect(wrapper.get('.viewport-switch button[aria-pressed=true]').text()).toBe('桌面')
    expect(wrapper.get('.preview-browser-wrap').classes()).toContain('viewport-desktop')
    expect(wrapper.get('.generated-view-shell').attributes('style') ?? '').not.toContain('height')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('settles rapid service disclosure intent and restores native content when global motion pauses', async () => {
    vi.useFakeTimers()
    const { observers } = motionGeometry()
    const wrapper = mountBuilder(true)
    const first = wrapper.findAll('.service-overview-row')[0]
    const second = wrapper.findAll('.service-overview-row')[1]
    const summary = first.get('summary')
    await summary.trigger('click')
    await summary.trigger('click')
    await summary.trigger('click')
    expect(summary.attributes('aria-expanded')).toBe('true')
    await second.get('summary').trigger('click')
    expect(summary.attributes('aria-expanded')).toBe('false')
    expect(second.get('summary').attributes('aria-expanded')).toBe('true')

    document.documentElement.dataset.motionPaused = 'true'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    await flushPromises()
    expect((first.element as HTMLDetailsElement).open).toBe(false)
    expect((second.element as HTMLDetailsElement).open).toBe(true)
    expect((second.element as HTMLElement).style.height).toBe('')
    expect((second.get('.service-overview-detail').element as HTMLElement).inert).not.toBe(true)
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)

    await enterNewBrief(wrapper)
    expect(wrapper.find('[data-stage-leaving]').exists()).toBe(false)
    expect(wrapper.get('.builder-stage-host').attributes('style') ?? '').not.toContain('height')
    document.documentElement.dataset.motionPaused = 'false'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    wrapper.unmount()
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('honours the selected static style when switching preview pages', async () => {
    motionGeometry()
    const wrapper = mountBuilder(true)
    await reachAnimatedPreview(wrapper, true)
    expect(wrapper.get('.generated-preview').attributes('data-motion')).toBe('none')
    await wrapper.findAll('.generated-header nav button').find(button => button.text() === '服務')!.trigger('click')
    expect(wrapper.findAll('.generated-view-shell > .generated-main')).toHaveLength(1)
    expect(wrapper.find('.generated-view-shell [data-stage-leaving]').exists()).toBe(false)
    expect(wrapper.get('.generated-view-shell').attributes('style') ?? '').not.toContain('height')
    expect(gsap.getTweensOf(wrapper.get('.generated-main').element)).toHaveLength(0)
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
  })

  it('skips panel animation under reduced motion and never allows cancelled generation to reopen the preview', async () => {
    vi.useFakeTimers()
    const { media } = motionGeometry(true)
    const wrapper = mountBuilder(true)
    await enterNewBrief(wrapper)
    await wrapper.findAll('.architecture-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    expect(wrapper.find('[data-stage-leaving]').exists()).toBe(false)
    expect(wrapper.get('.builder-stage-host').attributes('style') ?? '').not.toContain('height')
    expect(wrapper.findAll('.service-overview-row summary[aria-expanded]')).toHaveLength(0)

    media.matches = false
    await wrapper.findAll('.theme-choice')[0].trigger('click')
    await wrapper.get('.builder-primary').trigger('click')
    await finishMotion(wrapper)
    expect(wrapper.get('.generation-step').attributes('aria-busy')).toBe('true')
    await wrapper.get('.generation-step .builder-secondary').trigger('click')
    await finishMotion(wrapper)
    vi.advanceTimersByTime(5000)
    await flushPromises()
    expect(wrapper.get('#style-title').text()).toBe('你希望它給人的第一印象是什麼？')
    expect(wrapper.find('.generated-preview').exists()).toBe(false)
    expect(wrapper.get('.builder-progress button[aria-current=step]').text()).toContain('建立網站')
    expect(mockedPublicApiFetch).not.toHaveBeenCalled()
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
