// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatformCarousel } from '../src/lib/platform-carousel'

let cleanup: (() => void) | undefined

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn() })))
  const html = readFileSync(join(process.cwd(), 'dist', 'zh-hant', 'index.html'), 'utf8')
  const section = new DOMParser().parseFromString(html, 'text/html').querySelector('.platform-marquee')
  document.body.innerHTML = section?.outerHTML || ''
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('platform logo cloud', () => {
  it('keeps all forty outbound links in one server-rendered group', () => {
    const root = document.querySelector<HTMLElement>('[data-platform-carousel]')!
    expect(root.querySelectorAll('.platform-grid')).toHaveLength(1)
    expect(root.querySelectorAll('.platform-grid a')).toHaveLength(40)
    expect(root.querySelector('[data-platform-tab]')).toBeNull()

    cleanup = initPlatformCarousel(root)
    expect(root.dataset.carouselReady).toBe('true')
    expect(root.dataset.rotating).toBe('false') // reduced-motion fixture
    expect(root.querySelectorAll('.platform-grid a[tabindex="-1"]')).toHaveLength(0)
  })

  it('selects and enlarges a brand on pointer or keyboard focus', () => {
    const root = document.querySelector<HTMLElement>('[data-platform-carousel]')!
    cleanup = initPlatformCarousel(root)
    const shopify = root.querySelector<HTMLAnchorElement>('.platform-logo-shopify')!
    shopify.dispatchEvent(new Event('pointerenter'))
    expect(shopify.closest('[data-platform-card]')?.getAttribute('data-active')).toBe('true')
    expect(root.querySelector('[data-platform-name]')?.textContent).toBe('Shopify')
    shopify.dispatchEvent(new Event('pointerleave'))
    expect(root.querySelector('[data-platform-name]')?.textContent).toContain('40 個平台')

    shopify.focus()
    expect(shopify.closest('[data-platform-card]')?.getAttribute('data-active')).toBe('true')
    expect(root.dataset.rotating).toBe('false')
  })

  it('offers a deliberate pause control and clears active state when focus leaves', () => {
    const root = document.querySelector<HTMLElement>('[data-platform-carousel]')!
    cleanup = initPlatformCarousel(root)
    const pause = root.querySelector<HTMLButtonElement>('[data-platform-pause]')!
    pause.click()
    expect(pause.getAttribute('aria-pressed')).toBe('true')
    expect(pause.textContent).toContain('繼續轉動')
    pause.click()
    expect(pause.getAttribute('aria-pressed')).toBe('false')
    expect(pause.textContent).toContain('暫停轉動')
  })
})
