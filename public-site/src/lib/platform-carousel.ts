import { gsap } from 'gsap'

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const ROTATION_DEGREES_PER_MS = 0.005
const DRAG_DEGREES_PER_PIXEL = 0.22

/** One orbit contains every server-rendered platform; without JS it remains a readable directory. */
export function initPlatformCarousel(root: HTMLElement): () => void {
  if (root.dataset.carouselReady) return () => {}
  const stage = root.querySelector<HTMLElement>('[data-platform-stage]')
  const cards = [...root.querySelectorAll<HTMLElement>('[data-platform-card]')]
  const pause = root.querySelector<HTMLButtonElement>('[data-platform-pause]')
  const pauseText = root.querySelector<HTMLElement>('[data-platform-pause-text]')
  const name = root.querySelector<HTMLElement>('[data-platform-name]')
  const status = root.querySelector<HTMLElement>('[data-platform-status]')
  if (!stage || !pause || !pauseText || !name || !status || cards.length === 0) return () => {}

  const abort = new AbortController()
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const defaultName = name.textContent || ''
  const points = cards.map((_, index) => {
    const latitude = 1 - (index + .5) * 2 / cards.length
    const radius = Math.sqrt(1 - latitude * latitude)
    return { x: Math.cos(index * GOLDEN_ANGLE) * radius, y: latitude, z: Math.sin(index * GOLDEN_ANGLE) * radius }
  })
  let angle = 0
  let extentX = 225
  let extentY = 185
  let visible = true
  let hovered = false
  let focused = false
  let userPaused = false
  let ticking = false
  let active: HTMLElement | undefined
  let drag: { pointerId: number; x: number; y: number; startAngle: number; active: boolean } | undefined
  let suppressClickUntil = 0

  const isReduced = () => reduced?.matches === true || document.documentElement.dataset.motionPaused === 'true'
  const canRotate = () => visible && !document.hidden && !hovered && !focused && !userPaused && !isReduced() && !drag?.active
  const draw = () => {
    const radians = angle * Math.PI / 180
    const sine = Math.sin(radians)
    const cosine = Math.cos(radians)
    cards.forEach((card, index) => {
      const point = points[index]
      const x = point.x * cosine + point.z * sine
      const depth = point.z * cosine - point.x * sine
      const scale = .76 + (depth + 1) * .2
      card.style.transform = `translate3d(calc(-50% + ${(x * extentX).toFixed(1)}px), calc(-50% + ${(point.y * extentY).toFixed(1)}px), 0) scale(${scale.toFixed(3)})`
      card.style.opacity = String(Math.min(1, .62 + (depth + 1) * .19))
      card.style.zIndex = card === active ? '500' : String(Math.round((depth + 1) * 100))
    })
  }
  const tick = (_time: number, deltaTime: number) => {
    angle = (angle + Math.min(deltaTime, 64) * ROTATION_DEGREES_PER_MS) % 360
    draw()
  }
  const syncRotation = () => {
    const shouldTick = canRotate()
    if (shouldTick && !ticking) { gsap.ticker.add(tick); ticking = true }
    if (!shouldTick && ticking) { gsap.ticker.remove(tick); ticking = false }
    root.dataset.rotating = shouldTick ? 'true' : 'false'
  }
  const measure = () => {
    const width = stage.getBoundingClientRect().width || 960
    const height = stage.getBoundingClientRect().height || 440
    extentX = Math.min(225, width * .34)
    extentY = Math.min(185, height * .39)
    draw()
  }
  const choose = (card?: HTMLElement, announce = false) => {
    if (active === card) return
    if (active) delete active.dataset.active
    active = card
    if (active) {
      active.dataset.active = 'true'
      root.dataset.activeBrand = 'true'
      name.textContent = active.dataset.brandName || defaultName
      if (announce) status.textContent = name.textContent
    } else {
      delete root.dataset.activeBrand
      name.textContent = defaultName
    }
    draw()
  }

  stage.addEventListener('pointerenter', event => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') { hovered = true; syncRotation() }
  }, { signal: abort.signal })
  stage.addEventListener('pointerleave', () => { hovered = false; if (!focused) choose(); syncRotation() }, { signal: abort.signal })
  root.addEventListener('focusin', event => {
    focused = true
    const card = (event.target as Element).closest<HTMLElement>('[data-platform-card]')
    if (card) choose(card, true)
    syncRotation()
  }, { signal: abort.signal })
  root.addEventListener('focusout', event => {
    if (!root.contains(event.relatedTarget as Node | null)) { focused = false; choose(); syncRotation() }
    else if (!(event.relatedTarget as Element)?.closest?.('[data-platform-card]')) choose()
  }, { signal: abort.signal })
  cards.forEach(card => {
    const link = card.querySelector<HTMLAnchorElement>('a')
    link?.addEventListener('pointerenter', () => choose(card), { signal: abort.signal })
    link?.addEventListener('pointerleave', () => { if (!card.contains(document.activeElement)) choose() }, { signal: abort.signal })
  })

  pause.addEventListener('click', () => {
    userPaused = !userPaused
    pause.setAttribute('aria-pressed', String(userPaused))
    pauseText.textContent = userPaused ? pause.dataset.resumeLabel || '' : pause.dataset.pauseLabel || ''
    const glyph = pause.querySelector<HTMLElement>('[aria-hidden]')
    if (glyph) glyph.textContent = userPaused ? '▶' : 'Ⅱ'
    status.textContent = pauseText.textContent
    syncRotation()
  }, { signal: abort.signal })
  stage.addEventListener('dragstart', event => event.preventDefault(), { signal: abort.signal })
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startAngle: angle, active: false }
  }, { signal: abort.signal })
  stage.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.active && Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(dy)) {
      drag.active = true
      root.dataset.dragging = 'true'
      stage.setPointerCapture?.(event.pointerId)
      syncRotation()
    }
    if (!drag.active) return
    event.preventDefault()
    angle = drag.startAngle + dx * DRAG_DEGREES_PER_PIXEL
    draw()
  }, { signal: abort.signal })
  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.active) {
      suppressClickUntil = performance.now() + 300
      delete root.dataset.dragging
      if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId)
    }
    drag = undefined
    syncRotation()
  }
  stage.addEventListener('pointerup', endDrag, { signal: abort.signal })
  stage.addEventListener('pointercancel', endDrag, { signal: abort.signal })
  stage.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil && (event.target as Element).closest('a')) event.preventDefault()
  }, { signal: abort.signal })
  stage.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    angle += event.key === 'ArrowRight' ? 18 : -18
    draw()
  }, { signal: abort.signal })

  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined
  resize?.observe(stage)
  if (!resize) window.addEventListener('resize', measure, { signal: abort.signal })
  const intersection = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? true
    syncRotation()
  }, { rootMargin: '100px' }) : undefined
  intersection?.observe(stage)
  document.addEventListener('visibilitychange', syncRotation, { signal: abort.signal })
  document.addEventListener('discoverystack:motion-change', syncRotation, { signal: abort.signal })
  reduced?.addEventListener?.('change', syncRotation, { signal: abort.signal })
  measure()
  root.dataset.carouselReady = 'true'
  syncRotation()

  return () => {
    abort.abort()
    resize?.disconnect()
    intersection?.disconnect()
    if (ticking) gsap.ticker.remove(tick)
    delete root.dataset.carouselReady
  }
}
