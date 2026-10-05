import { readMotionTokens } from './motion-tokens'

/** Shared shell enhancement. Native HTML remains the readable, operable fallback. */
const motionPaused = () => document.documentElement.dataset.motionPaused === 'true'
let activeCleanup: (() => void) | undefined

export function initShellDetails(scope: ParentNode, reduced: MediaQueryList): () => void {
  const timing = readMotionTokens()
  const disposers: (() => void)[] = []
  scope.querySelectorAll<HTMLDetailsElement>('details[data-shell-details]').forEach(details => {
    const summary = details.querySelector<HTMLElement>(':scope > summary')
    const panel = details.querySelector<HTMLElement>(':scope > .premium-price-detail')
    if (!summary || !panel) return
    const originalHeight = details.style.height
    const originalOverflow = details.style.overflow
    const originalExpanded = summary.getAttribute('aria-expanded')
    const originalInert = panel.inert
    let desired = details.open
    let animation: Animation | undefined
    let revision = 0
    const settle = () => {
      revision++
      animation?.cancel()
      animation = undefined
      details.open = desired
      details.style.height = originalHeight
      details.style.overflow = originalOverflow
      panel.inert = originalInert
      summary.setAttribute('aria-expanded', String(desired))
    }
    const toggle = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      const start = details.getBoundingClientRect().height
      animation?.cancel()
      desired = !desired
      const currentRevision = ++revision
      summary.setAttribute('aria-expanded', String(desired))
      details.open = true
      details.style.height = originalHeight
      const border = parseFloat(getComputedStyle(details).borderTopWidth) || 0
      const end = desired ? details.getBoundingClientRect().height : summary.getBoundingClientRect().height + border
      panel.inert = !desired
      if (reduced.matches || motionPaused() || typeof details.animate !== 'function') { settle(); return }
      details.style.overflow = 'hidden'
      details.style.height = `${start}px`
      try {
        animation = details.animate([{ height: `${start}px` }, { height: `${end}px` }], { duration: timing.panel, easing: timing.ease })
        animation.onfinish = () => { if (revision === currentRevision) settle() }
      } catch { settle() }
    }
    summary.setAttribute('aria-expanded', String(desired))
    summary.addEventListener('click', toggle)
    reduced.addEventListener('change', settle)
    document.addEventListener('discoverystack:motion-change', settle)
    disposers.push(() => {
      settle()
      summary.removeEventListener('click', toggle)
      reduced.removeEventListener('change', settle)
      document.removeEventListener('discoverystack:motion-change', settle)
      if (originalExpanded === null) summary.removeAttribute('aria-expanded')
      else summary.setAttribute('aria-expanded', originalExpanded)
    })
  })
  return () => disposers.forEach(dispose => dispose())
}

export function initShellMotion(): () => void {
  activeCleanup?.()
  const header = document.getElementById('siteHeader')
  const nav = document.getElementById('siteNav')
  const toggle = document.getElementById('navToggle')
  const pause = document.getElementById('site-motion-toggle')
  const rail = document.querySelector<HTMLElement>('.route-rail')
  const mobile = window.matchMedia('(max-width: 900px)')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const timing = readMotionTokens()
  const disposers: (() => void)[] = []
  const animations = new Set<Animation>()
  let disposed = false
  let open = false
  let scrollFrame = 0
  let oldOverflow = ''
  let oldPaddingRight = ''
  let oldInert: [HTMLElement, boolean][] = []
  const links = [...(nav?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
  const animate = (element: HTMLElement, frames: Keyframe[], duration: number, delay = 0) => {
    if (reduced.matches || motionPaused() || typeof element.animate !== 'function') return
    try {
      const animation = element.animate(frames, { duration, delay, easing: timing.ease, fill: 'backwards' })
      animations.add(animation)
      animation.onfinish = () => { animations.delete(animation); animation.cancel() }
    } catch { /* Keep the final, readable CSS state. */ }
  }
  const setOpen = (next: boolean, restoreFocus = false) => {
    next = next && mobile.matches
    if (next === open) return
    open = next
    nav?.classList.toggle('is-open', open)
    toggle?.setAttribute('aria-expanded', String(open))
    if (toggle) toggle.textContent = open ? toggle.dataset.openLabel || 'Close' : toggle.dataset.closedLabel || 'Menu'
    document.documentElement.dataset.menuOpen = String(open)
    if (nav && mobile.matches) nav.inert = !open
    if (open) {
      oldOverflow = document.body.style.overflow
      oldPaddingRight = document.body.style.paddingRight
      const gutter = window.innerWidth - document.documentElement.clientWidth
      document.body.style.overflow = 'hidden'
      if (gutter > 0) document.body.style.paddingRight = `${gutter}px`
      oldInert = [...document.querySelectorAll<HTMLElement>('main, .site-footer')].map(element => [element, Boolean(element.inert)])
      oldInert.forEach(([element]) => { element.inert = true })
      links.forEach((link, index) => animate(link, [{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'translateX(0)' }], timing.panel, index * timing.stagger))
      links[0]?.focus({ preventScroll: true })
    } else {
      document.body.style.overflow = oldOverflow
      document.body.style.paddingRight = oldPaddingRight
      oldInert.forEach(([element, inert]) => { element.inert = inert })
      oldInert = []
      if (restoreFocus) toggle?.focus({ preventScroll: true })
    }
    document.dispatchEvent(new CustomEvent('discoverystack:menu-change'))
  }
  const keydown = (event: KeyboardEvent) => {
    if (!open) return
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false, true); return }
    if (event.key !== 'Tab') return
    const targets = [...(header?.querySelectorAll<HTMLElement>('*') ?? [])].filter(element => element.matches('a[href], button:not(:disabled)'))
    const first = targets[0]
    const last = targets.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const toggleMenu = () => setOpen(!open)
  const focusGuard = (event: FocusEvent) => {
    if (open && event.target instanceof Node && !header?.contains(event.target)) links[0]?.focus({ preventScroll: true })
  }
  const closeLink = () => setOpen(false)
  const outside = (event: PointerEvent) => {
    if (open && event.target instanceof Node && !header?.contains(event.target)) setOpen(false, true)
  }
  const updateViewport = () => {
    if (!mobile.matches) setOpen(false)
    if (nav) nav.inert = mobile.matches && !open
    updateScroll()
  }
  const updateScroll = () => {
    header?.classList.toggle('is-stuck', window.scrollY > 12)
    if (rail) {
      const max = document.documentElement.scrollHeight - window.innerHeight
      rail.style.setProperty('--route-progress', `${max > 0 ? Math.min(100, window.scrollY / max * 100) : 0}%`)
    }
    scrollFrame = 0
  }
  const queueScroll = () => { if (!scrollFrame) scrollFrame = window.requestAnimationFrame(updateScroll) }
  const syncPause = () => {
    const paused = motionPaused()
    pause?.setAttribute('aria-pressed', String(paused))
    const label = pause?.querySelector('[data-motion-label]')
    const icon = pause?.querySelector('[data-motion-icon]')
    if (label) label.textContent = paused ? pause?.dataset.playLabel || 'Play motion' : pause?.dataset.pauseLabel || 'Pause motion'
    if (icon) icon.textContent = paused ? '▷' : 'Ⅱ'
    pause?.setAttribute('aria-label', label?.textContent || '')
    if (paused || reduced.matches) { animations.forEach(animation => animation.cancel()); animations.clear() }
  }
  const toggleMotion = () => {
    document.documentElement.dataset.motionPaused = String(!motionPaused())
    syncPause()
    document.dispatchEvent(new CustomEvent('discoverystack:motion-change'))
  }
  toggle?.addEventListener('click', toggleMenu)
  pause?.addEventListener('click', toggleMotion)
  links.forEach(link => link.addEventListener('click', closeLink))
  document.addEventListener('keydown', keydown)
  document.addEventListener('focusin', focusGuard)
  document.addEventListener('pointerdown', outside)
  document.addEventListener('discoverystack:motion-change', syncPause)
  reduced.addEventListener('change', syncPause)
  mobile.addEventListener('change', updateViewport)
  window.addEventListener('scroll', queueScroll, { passive: true })
  window.addEventListener('resize', queueScroll)
  updateViewport()
  syncPause()
  if (header) animate(header, [{ opacity: .3, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], 500)

  // Related pages and the shared footer have their own line / lateral rhythm.
  const revealTargets = [...document.querySelectorAll<HTMLElement>('.content-hero > *, .content-body > h2, .content-body > h3, .answer-block, .related-links, .site-footer .footer-statement, .site-footer .footer-col')]
  const reveals = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting || disposed) return
    reveals.unobserve(entry.target)
    const element = entry.target as HTMLElement
    const title = element.matches('h1,h2,h3,.footer-statement')
    const lateral = element.matches('.answer-block,.related-links')
    const transform = title ? 'translateY(18px)' : lateral ? 'translateX(-12px)' : 'translateY(8px)'
    animate(element, [{ opacity: title ? .35 : .6, transform, ...(title ? { clipPath: 'inset(0 0 80% 0)' } : {}) }, { opacity: 1, transform: 'translate(0)', clipPath: 'inset(0)' }], title ? timing.reveal : timing.reveal * .7)
  }), { threshold: .12 })
  revealTargets.forEach(element => reveals.observe(element))
  disposers.push(() => reveals.disconnect(), initShellDetails(document, reduced))

  const cleanup = () => {
    if (disposed) return
    disposed = true
    setOpen(false)
    if (nav) nav.inert = false
    window.cancelAnimationFrame(scrollFrame)
    animations.forEach(animation => animation.cancel())
    disposers.forEach(dispose => dispose())
    toggle?.removeEventListener('click', toggleMenu)
    pause?.removeEventListener('click', toggleMotion)
    links.forEach(link => link.removeEventListener('click', closeLink))
    document.removeEventListener('keydown', keydown)
    document.removeEventListener('focusin', focusGuard)
    document.removeEventListener('pointerdown', outside)
    document.removeEventListener('discoverystack:motion-change', syncPause)
    document.removeEventListener('astro:before-swap', cleanup)
    reduced.removeEventListener('change', syncPause)
    mobile.removeEventListener('change', updateViewport)
    window.removeEventListener('scroll', queueScroll)
    window.removeEventListener('resize', queueScroll)
    window.removeEventListener('pagehide', pageHide)
    if (activeCleanup === cleanup) activeCleanup = undefined
  }
  activeCleanup = cleanup
  const pageHide = (event: PageTransitionEvent) => {
    setOpen(false)
    animations.forEach(animation => animation.cancel())
    animations.clear()
    if (!event.persisted) cleanup()
  }
  document.addEventListener('astro:before-swap', cleanup)
  window.addEventListener('pagehide', pageHide)
  document.body.dataset.shellEnhanced = 'true'
  return cleanup
}
