type Motion = typeof import('gsap').gsap

/** A bounded shoreline: flat at both ends, reversible at any scroll position. */
export function sceneBoundary(progress: number, direction = 1) {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0))
  const strength = Math.sin(p * Math.PI) ** 2
  const bias = direction < 0 ? -1 : 1
  const edge = 119 - strength * 20
  const left = edge - strength * (bias > 0 ? 23 : 2)
  const right = edge - strength * (bias < 0 ? 23 : 2)
  const crest = edge - strength * 72
  const path = `M0 ${left.toFixed(2)}C240 ${left.toFixed(2)} 480 ${crest.toFixed(2)} 720 ${edge.toFixed(2)}S1200 ${right.toFixed(2)} 1440 ${right.toFixed(2)}`
  return { path, strength, edge, crest }
}

const restoreStyle = (element: HTMLElement | SVGElement, names: string[]) => {
  const values = names.map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)] as const)
  return () => values.forEach(([name, value, priority]) => value ? element.style.setProperty(name, value, priority) : element.style.removeProperty(name))
}

/** Scroll owns the scene; there is no wheel interception, pinning or background RAF. */
export function initFluidScenes(scope: HTMLElement, motion: Motion): () => void {
  const cleanups: (() => void)[] = []
  scope.querySelectorAll<HTMLElement>('[data-scene-seam]').forEach(seam => {
    const target = seam.dataset.sceneTarget ? scope.querySelector<HTMLElement>(seam.dataset.sceneTarget) : null
    const surface = seam.querySelector<SVGPathElement>('[data-seam-surface]')
    const thread = seam.querySelector<SVGPathElement>('[data-seam-thread]')
    const flecks = [...seam.querySelectorAll<SVGCircleElement>('circle')]
    if (!target || !surface || !thread) return
    const original = [surface.getAttribute('d'), thread.getAttribute('d')]
    const originalFlecks = flecks.map(fleck => fleck.getAttribute('cy'))
    const restore = restoreStyle(seam, ['--seam-strength'])
    const state = { progress: 0 }
    let disposed = false
    const draw = () => {
      if (disposed) return
      const { path, strength, edge, crest } = sceneBoundary(state.progress, Number(seam.dataset.sceneDirection))
      surface.setAttribute('d', `${path}V120H0Z`)
      thread.setAttribute('d', path)
      seam.style.setProperty('--seam-strength', strength.toFixed(3))
      flecks.forEach((fleck, index) => {
        const phase = index / Math.max(1, flecks.length - 1)
        const y = edge + (crest - edge) * Math.sin(phase * Math.PI) - strength * (5 + index % 4 * 3)
        fleck.setAttribute('cy', y.toFixed(2))
      })
    }
    const tween = motion.fromTo(state, { progress: 0 }, {
      progress: 1, ease: 'none', onUpdate: draw,
      scrollTrigger: { trigger: target, start: 'top 100%', end: 'top 24%', scrub: .5 },
    })
    cleanups.push(() => {
      disposed = true
      tween.scrollTrigger?.kill()
      tween.kill()
      original.forEach((value, index) => value === null ? [surface, thread][index]!.removeAttribute('d') : [surface, thread][index]!.setAttribute('d', value))
      flecks.forEach((fleck, index) => originalFlecks[index] === null ? fleck.removeAttribute('cy') : fleck.setAttribute('cy', originalFlecks[index]!))
      restore()
    })
  })

  // The existing concept is assembled from its real HTML parts, rather than
  // replacing it with a video or pretending to show a live customer dashboard.
  scope.querySelectorAll<HTMLElement>('[data-fluid-assembly]').forEach(scene => {
    const frame = scene.querySelector<HTMLElement>('.studio-preview')
    if (!frame) return
    const art = frame.querySelector<HTMLElement>('.premium-study-art')
    const title = frame.querySelector<HTMLElement>('.premium-study-title')
    const nav = frame.querySelector<HTMLElement>('.premium-study-nav')
    const foot = frame.querySelector<HTMLElement>('.premium-study-foot')
    const notes = [...scene.querySelectorAll<HTMLElement>('.studio-floating-note')]
    const restores = [restoreStyle(frame, ['--assembly-inset', '--assembly-radius'])]
    if (art) restores.push(restoreStyle(art, ['--assembly-y', '--assembly-scale', 'opacity']))
    notes.forEach(note => restores.push(restoreStyle(note, ['opacity'])))
    const timeline = motion.timeline({ scrollTrigger: { trigger: scene, start: 'top 96%', end: 'top 20%', scrub: .65 } })
    timeline.fromTo(frame, { '--assembly-inset': '11%', '--assembly-radius': '24px' }, { '--assembly-inset': '0%', '--assembly-radius': '0px', duration: .55, ease: 'power2.out' }, 0)
    if (nav) timeline.fromTo(nav, { opacity: .3 }, { opacity: 1, duration: .32 }, .14)
    if (title) timeline.fromTo(title, { clipPath: 'inset(0 0 100% 0)', y: 18 }, { clipPath: 'inset(0)', y: 0, duration: .4, ease: 'power3.out' }, .19)
    if (art) timeline.fromTo(art, { '--assembly-y': '40px', '--assembly-scale': .88, opacity: .25 }, { '--assembly-y': '0px', '--assembly-scale': 1, opacity: 1, duration: .5, ease: 'power2.out' }, .3)
    if (foot) timeline.fromTo(foot, { opacity: .25, y: 9 }, { opacity: 1, y: 0, duration: .28 }, .58)
    if (notes.length) timeline.fromTo(notes, { opacity: 0 }, { opacity: 1, duration: .25, stagger: .08 }, .66)
    const focus = () => { timeline.scrollTrigger?.disable(false); timeline.progress(1); }
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && frame.contains(event.relatedTarget)) return
      timeline.scrollTrigger?.enable(false)
    }
    frame.addEventListener('focusin', focus)
    frame.addEventListener('focusout', blur)
    if (frame.contains(document.activeElement)) focus()
    cleanups.push(() => {
      frame.removeEventListener('focusin', focus)
      frame.removeEventListener('focusout', blur)
      timeline.scrollTrigger?.kill()
      timeline.revert()
      restores.forEach(restore => restore())
    })
  })
  return () => cleanups.forEach(cleanup => cleanup())
}
