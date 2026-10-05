// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initShellMotion, initShellDetails } from '../src/lib/shell-motion'

let cleanup: (() => void) | undefined
let mobile: MediaQueryList
let reduced: MediaQueryList
let pending: { cancel: ReturnType<typeof vi.fn>; onfinish?: () => void }[]
let originalAnimate: PropertyDescriptor | undefined

beforeEach(() => {
  pending = []
  document.body.removeAttribute('style')
  const query = (matches: boolean) => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList
  mobile = query(true)
  reduced = query(false)
  vi.stubGlobal('matchMedia', (value: string) => value.includes('900px') ? mobile : reduced)
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(() => {
    const result = { cancel: vi.fn() }
    pending.push(result)
    return result as unknown as Animation
  }) })
  document.body.innerHTML = `<header id="siteHeader"><button id="navToggle" aria-expanded="false" data-open-label="Close" data-closed-label="Menu">Menu</button><button id="site-motion-toggle" data-pause-label="Pause" data-play-label="Play"><span data-motion-label>Pause</span></button><nav id="siteNav"><a href="#one">One</a><a href="#two">Two</a></nav></header><main><a href="#next">Content</a></main><footer class="site-footer"></footer>`
  document.documentElement.removeAttribute('data-motion-paused')
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-motion-paused')
  document.documentElement.removeAttribute('data-menu-open')
  vi.restoreAllMocks()
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  vi.unstubAllGlobals()
})

describe('shared navigation and motion controls', () => {
  it('keeps the closed mobile navigation inert and releases content on Escape', () => {
    cleanup = initShellMotion()
    const nav = document.getElementById('siteNav')!
    const toggle = document.getElementById('navToggle')!
    expect(nav.inert).toBe(true)
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(nav.inert).toBe(false)
    expect(document.querySelector('main')!.inert).toBe(true)
    expect(document.activeElement).toBe(nav.querySelector('a'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('main')!.inert).toBe(false)
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(toggle)
  })

  it('rapid menu toggles settle to the last request and cleanup restores scroll', () => {
    document.body.style.overflow = 'auto'
    cleanup = initShellMotion()
    const toggle = document.getElementById('navToggle')!
    toggle.click(); toggle.click(); toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    cleanup()
    expect(document.body.style.overflow).toBe('auto')
    expect(document.querySelector('main')!.inert).toBe(false)
    expect(document.getElementById('siteNav')!.inert).toBe(false)
  })

  it('loops keyboard focus inside the open menu and closes when a route is chosen', () => {
    cleanup = initShellMotion()
    const toggle = document.getElementById('navToggle')!
    toggle.click()
    const links = document.querySelectorAll<HTMLAnchorElement>('#siteNav a')
    links[1]!.focus()
    expect(document.activeElement).toBe(links[1])
    expect(document.querySelectorAll('#siteHeader a[href], #siteHeader button:not(:disabled)').length).toBe(4)
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(toggle)
    links[0]!.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.style.overflow).toBe('')
  })

  it('broadcasts a global pause and cancels nonessential in-flight shell effects', () => {
    cleanup = initShellMotion()
    const listener = vi.fn()
    document.addEventListener('discoverystack:motion-change', listener)
    const button = document.getElementById('site-motion-toggle')!
    button.click()
    expect(document.documentElement.dataset.motionPaused).toBe('true')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.textContent).toBe('Play')
    expect(pending.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    button.click()
    expect(document.documentElement.dataset.motionPaused).toBe('false')
    document.removeEventListener('discoverystack:motion-change', listener)
  })
})

describe('price details transitions', () => {
  function mountDetails() {
    document.body.innerHTML = '<details data-shell-details><summary>Plan</summary><div class="premium-price-detail"><a href="#fit">Contact</a></div></details>'
    const details = document.querySelector('details')!
    const summary = document.querySelector('summary')!
    vi.spyOn(details, 'getBoundingClientRect').mockImplementation(() => ({ height: details.open ? 180 : 50 }) as DOMRect)
    vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue({ height: 50 } as DOMRect)
    cleanup = initShellDetails(document, reduced)
    return { details, summary }
  }
  it('handles repeated reversals and releases the measuring height at completion', () => {
    const { details, summary } = mountDetails()
    summary.click(); summary.click(); summary.click()
    pending.at(-1)?.onfinish?.()
    expect(details.open).toBe(true)
    expect(details.style.height).toBe('')
    expect(details.style.overflow).toBe('')
    expect(summary.getAttribute('aria-expanded')).toBe('true')
  })
  it('settles immediately with reduced motion and retains native usable content', () => {
    Object.defineProperty(reduced, 'matches', { value: true })
    const { details, summary } = mountDetails()
    summary.click()
    expect(details.open).toBe(true)
    expect(pending).toHaveLength(0)
    summary.click()
    expect(details.open).toBe(false)
  })
})
