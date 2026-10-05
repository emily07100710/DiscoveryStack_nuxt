// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { gsap } from 'gsap'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { initFluidScenes, sceneBoundary } from '../src/lib/fluid-scenes'

type TriggerOptions = { trigger?: Element; start?: string; end?: string; scrub?: number; pin?: unknown }
type ControlledTrigger = { options: TriggerOptions; kill: Mock<(revert?: boolean, allowAnimation?: boolean) => void>; revert: Mock<() => void>; disable: Mock<(reset?: boolean) => void>; enable: Mock<(reset?: boolean) => void> }
type Registration = { animation: gsap.core.Tween | gsap.core.Timeline; trigger: ControlledTrigger }

/** Use GSAP's real rendering/revert, while scroll position is controlled by the test. */
function motionHarness() {
  const registrations: Registration[] = []
  const contexts: gsap.Context[] = []
  const attach = <T extends gsap.core.Tween | gsap.core.Timeline>(animation: T, options: TriggerOptions) => {
    const trigger: ControlledTrigger = { options, kill: vi.fn(), revert: vi.fn(), disable: vi.fn(), enable: vi.fn() }
    // Match ScrollTrigger.kill's ownership release instead of leaving a fake
    // trigger attached while GSAP's context is reverting the same animation.
    trigger.kill.mockImplementation((revert?: boolean, allowAnimation?: boolean) => {
      Object.assign(animation, { scrollTrigger: null })
      if (revert) animation.revert({ kill: false })
      if (!allowAnimation) animation.kill()
    })
    trigger.revert.mockImplementation(() => trigger.kill(true))
    Object.assign(animation, { scrollTrigger: trigger })
    registrations.push({ animation, trigger })
    return animation
  }
  const motion = {
    ...gsap,
    registerPlugin: vi.fn(),
    fromTo(target: gsap.TweenTarget, from: gsap.TweenVars, to: gsap.TweenVars) {
      const { scrollTrigger, ...properties } = to
      return attach(gsap.fromTo(target, from, { ...properties, paused: true }), scrollTrigger as TriggerOptions)
    },
    timeline(vars: gsap.TimelineVars) {
      const { scrollTrigger, ...properties } = vars
      return attach(gsap.timeline({ ...properties, paused: true }), scrollTrigger as TriggerOptions)
    },
    context(...args: Parameters<typeof gsap.context>) {
      const context = gsap.context(...args)
      vi.spyOn(context, 'revert')
      contexts.push(context)
      return context
    },
  } as unknown as typeof gsap
  return { motion, registrations, contexts }
}

class ObserverHarness {
  static instances: ObserverHarness[] = []
  observed = new Set<Element>()
  constructor() { ObserverHarness.instances.push(this) }
  observe(element: Element) { this.observed.add(element) }
  unobserve(element: Element) { this.observed.delete(element) }
  disconnect() { this.observed.clear() }
}

const seamMarkup = `<div data-scene-seam data-scene-target="#next" data-scene-direction="-1" style="--seam-strength:.17!important"><svg><path data-seam-surface d="original surface"/><path data-seam-thread/><circle cy="117"/><circle/><circle cy="119"/></svg></div><section id="next">Next scene</section>`
const assemblyMarkup = `<section data-fluid-assembly><a href="#next" class="studio-preview" style="--assembly-inset:2%;--assembly-radius:3px"><div class="premium-study-nav" style="opacity:.85">Menu</div><div class="premium-study-title" style="clip-path:inset(1%);color:navy">Readable title</div><div class="premium-study-art" style="--assembly-y:4px;--assembly-scale:.97;opacity:.8">Art</div><div class="premium-study-foot" style="opacity:.9">Footer</div><span id="inner">Preview</span></a><div class="studio-floating-note" style="opacity:.75">Brand</div><div class="studio-floating-note">Business</div></section><button id="outside">Next action</button>`

let scope: HTMLElement
let cleanup: (() => void) | undefined
let harness: ReturnType<typeof motionHarness>
const render = (registration: Registration, progress: number) => {
  registration.animation.progress(progress, false)
  gsap.ticker.sleep()
}
const styleSnapshot = (element: HTMLElement) => Object.fromEntries(Array.from(element.style).sort().map(name => [name, [element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]]))

beforeEach(() => {
  document.body.innerHTML = '<article class="premium-home"></article>'
  scope = document.querySelector<HTMLElement>('.premium-home')!
  harness = motionHarness()
  gsap.globalTimeline.clear()
  gsap.ticker.sleep()
  ObserverHarness.instances = []
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  gsap.globalTimeline.clear()
  gsap.ticker.sleep()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.motionPaused
})

describe('fluid scene boundary', () => {
  it('has flat endpoints, bounded geometry and reversible mirrored directions', () => {
    expect(sceneBoundary(-4)).toEqual(sceneBoundary(0))
    expect(sceneBoundary(4)).toEqual(sceneBoundary(1))
    expect(sceneBoundary(Number.NaN)).toEqual(sceneBoundary(0))
    expect(sceneBoundary(Number.POSITIVE_INFINITY)).toEqual(sceneBoundary(0))
    expect(sceneBoundary(0).strength).toBe(0)
    expect(sceneBoundary(1).strength).toBeCloseTo(0)
    expect(sceneBoundary(.5).strength).toBe(1)
    const outward = Array.from({ length: 21 }, (_, index) => sceneBoundary(index / 20, 1))
    const backward = Array.from({ length: 21 }, (_, index) => sceneBoundary((20 - index) / 20, 1)).reverse()
    outward.forEach((boundary, index) => {
      expect(boundary.strength).toBeGreaterThanOrEqual(0)
      expect(boundary.strength).toBeLessThanOrEqual(1)
      expect(boundary.edge).toBeGreaterThanOrEqual(99)
      expect(boundary.edge).toBeLessThanOrEqual(119)
      expect(boundary.crest).toBeGreaterThanOrEqual(27)
      expect(boundary.crest).toBeLessThanOrEqual(119)
      expect(boundary).toEqual(backward[index])
      const reversed = sceneBoundary(index / 20, -1)
      expect(reversed.strength).toBe(boundary.strength)
      expect(reversed.edge).toBe(boundary.edge)
      expect(reversed.crest).toBe(boundary.crest)
    })
    expect(sceneBoundary(.5, 1).path).toContain('M0 76.00')
    expect(sceneBoundary(.5, -1).path).toContain('1440 76.00')
  })

  it('renders actual GSAP progress in both directions and restores SVG/CSS on cleanup', () => {
    scope.innerHTML = seamMarkup
    const seam = scope.querySelector<HTMLElement>('[data-scene-seam]')!
    const surface = seam.querySelector('[data-seam-surface]')!
    const thread = seam.querySelector('[data-seam-thread]')!
    const circles = [...seam.querySelectorAll('circle')]
    cleanup = initFluidScenes(scope, harness.motion)
    expect(harness.registrations).toHaveLength(1)
    const registration = harness.registrations[0]!
    expect(registration.trigger.options).toMatchObject({ trigger: scope.querySelector('#next'), start: 'top 100%', end: 'top 24%', scrub: .5 })
    expect(registration.trigger.options).not.toHaveProperty('pin')
    render(registration, .25)
    const partial = surface.getAttribute('d')
    render(registration, .5)
    expect(surface.getAttribute('d')).toBe(`${sceneBoundary(.5, -1).path}V120H0Z`)
    expect(thread.getAttribute('d')).toBe(sceneBoundary(.5, -1).path)
    expect(seam.style.getPropertyValue('--seam-strength')).toBe('1.000')
    circles.forEach(circle => expect(Number(circle.getAttribute('cy'))).toBeGreaterThanOrEqual(0))
    render(registration, .25)
    expect(surface.getAttribute('d')).toBe(partial)
    cleanup()
    expect(surface.getAttribute('d')).toBe('original surface')
    expect(thread.hasAttribute('d')).toBe(false)
    expect(circles.map(circle => circle.getAttribute('cy'))).toEqual(['117', null, '119'])
    expect(seam.style.getPropertyValue('--seam-strength')).toBe('.17')
    expect(seam.style.getPropertyPriority('--seam-strength')).toBe('important')
    expect(registration.trigger.kill).toHaveBeenCalled()
    registration.animation.vars.onUpdate?.call(registration.animation)
    expect(surface.getAttribute('d')).toBe('original surface')
    cleanup = undefined
  })

  it('leaves incomplete or unrelated SSR content readable without creating a scene', () => {
    scope.innerHTML = '<div data-scene-seam data-scene-target="#missing"><svg><path data-seam-surface/></svg></div><section data-fluid-assembly><p>Visible preview introduction</p></section>'
    const original = scope.innerHTML
    cleanup = initFluidScenes(scope, harness.motion)
    expect(scope.innerHTML).toBe(original)
    expect(harness.registrations).toHaveLength(0)
    cleanup()
    expect(scope.innerHTML).toBe(original)
    cleanup = undefined
  })
})

describe('studio assembly', () => {
  it('assembles real layers and reveals the whole preview while keyboard focus is inside', () => {
    scope.innerHTML = assemblyMarkup
    cleanup = initFluidScenes(scope, harness.motion)
    const registration = harness.registrations[0]!
    const frame = scope.querySelector<HTMLElement>('.studio-preview')!
    const title = frame.querySelector<HTMLElement>('.premium-study-title')!
    const art = frame.querySelector<HTMLElement>('.premium-study-art')!
    const notes = [...scope.querySelectorAll<HTMLElement>('.studio-floating-note')]
    expect(registration.trigger.options).toMatchObject({ start: 'top 96%', end: 'top 20%', scrub: .65 })
    render(registration, 0)
    expect(parseFloat(frame.style.getPropertyValue('--assembly-inset'))).toBe(11)
    expect(Number(notes[0]!.style.opacity)).toBe(0)
    render(registration, .4)
    expect(parseFloat(frame.style.getPropertyValue('--assembly-inset'))).toBeLessThan(11)
    expect(Number(notes[0]!.style.opacity)).toBe(0)
    frame.focus()
    expect(document.activeElement).toBe(frame)
    expect(registration.trigger.disable).toHaveBeenCalledWith(false)
    expect(registration.animation.progress()).toBe(1)
    expect(parseFloat(frame.style.getPropertyValue('--assembly-inset'))).toBe(0)
    expect(frame.style.getPropertyValue('--assembly-scale')).toBe('')
    expect(Number(art.style.getPropertyValue('--assembly-scale'))).toBe(1)
    expect(title.style.clipPath).toBe('inset(0)')
    expect(Number(art.style.opacity)).toBe(1)
    notes.forEach(note => expect(Number(note.style.opacity)).toBe(1))
    frame.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: frame.querySelector('#inner') }))
    expect(registration.trigger.enable).not.toHaveBeenCalled()
    scope.querySelector<HTMLButtonElement>('#outside')!.focus()
    expect(registration.trigger.enable).toHaveBeenCalledWith(false)
  })

  it('restores existing styles and removes focus listeners during an interrupted assembly', () => {
    scope.innerHTML = assemblyMarkup
    const elements = [...scope.querySelectorAll<HTMLElement>('[style]'), scope.querySelectorAll<HTMLElement>('.studio-floating-note')[1]!]
    const originals = elements.map(styleSnapshot)
    cleanup = initFluidScenes(scope, harness.motion)
    const registration = harness.registrations[0]!
    render(registration, .6)
    cleanup()
    elements.forEach((element, index) => expect(styleSnapshot(element)).toEqual(originals[index]))
    expect(registration.trigger.kill).toHaveBeenCalled()
    const frame = scope.querySelector<HTMLElement>('.studio-preview')!
    frame.focus()
    expect(registration.trigger.disable).not.toHaveBeenCalled()
    cleanup = undefined
  })
})

/** Execute the real lifecycle source with controllable imports, as in the learning-engine tests. */
function premiumLifecycle() {
  const reduced = new EventTarget() as MediaQueryList
  Object.defineProperty(reduced, 'matches', { value: false, writable: true })
  const pointer = new EventTarget() as MediaQueryList
  Object.defineProperty(pointer, 'matches', { value: false })
  vi.stubGlobal('matchMedia', (query: string) => query.includes('reduced') ? reduced : pointer)
  vi.stubGlobal('ResizeObserver', ObserverHarness)
  vi.stubGlobal('IntersectionObserver', ObserverHarness)
  const source = readFileSync(resolve(process.cwd(), 'src/lib/premium-motion.ts'), 'utf8')
    .replace("import { initFluidScenes } from './fluid-scenes';", '')
    .replace(/^export /gm, '')
    .replace('    } catch {\n      teardownInner?.();', '    } catch (error) {\n      motionModules.errors.push(error);\n      teardownInner?.();')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^export\s*\{\s*\};?\s*$/gm, '')
    .replace('import("gsap")', 'Promise.resolve({ gsap: motionModules.gsap })')
    .replace('import("gsap/ScrollTrigger")', 'Promise.resolve({ ScrollTrigger: motionModules.ScrollTrigger })')
    .replace('import("lenis")', 'Promise.resolve({ default: motionModules.Lenis })')
  const run = new Function('initFluidScenes', 'motionModules', `${compiled}\nreturn initPremiumMotion;`)
  const errors: unknown[] = []
  const init = run(initFluidScenes, { gsap: harness.motion, ScrollTrigger: { refresh: vi.fn(), update: vi.fn() }, Lenis: class {}, errors }) as () => () => void
  return { init, reduced, errors }
}

describe('fluid scene lifecycle', () => {
  it('restores SSR styles on pause, rebuilds once and releases contexts/listeners on unmount', async () => {
    scope.innerHTML = seamMarkup + assemblyMarkup
    const frame = scope.querySelector<HTMLElement>('.studio-preview')!
    const original = styleSnapshot(frame)
    const { init, reduced, errors } = premiumLifecycle()
    cleanup = init()
    await vi.waitFor(() => { expect(errors).toEqual([]); expect(harness.registrations).toHaveLength(2) })
    render(harness.registrations[0]!, .5)
    render(harness.registrations[1]!, .4)
    document.documentElement.dataset.motionPaused = 'true'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    expect(styleSnapshot(frame)).toEqual(original)
    expect(harness.contexts[0]!.revert).toHaveBeenCalledOnce()
    harness.registrations.forEach(registration => expect(registration.trigger.kill).toHaveBeenCalled())
    document.documentElement.dataset.motionPaused = 'false'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    document.documentElement.dataset.motionPaused = 'true'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    document.documentElement.dataset.motionPaused = 'false'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    await vi.waitFor(() => expect(harness.registrations).toHaveLength(4))
    expect(harness.contexts).toHaveLength(2)
    Object.defineProperty(reduced, 'matches', { value: true })
    reduced.dispatchEvent(new Event('change'))
    expect(styleSnapshot(frame)).toEqual(original)
    expect(harness.contexts[1]!.revert).toHaveBeenCalledOnce()
    Object.defineProperty(reduced, 'matches', { value: false })
    reduced.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(harness.registrations).toHaveLength(6))
    document.dispatchEvent(new Event('astro:before-swap'))
    expect(harness.contexts[2]!.revert).toHaveBeenCalledOnce()
    expect(ObserverHarness.instances.every(observer => observer.observed.size === 0)).toBe(true)
    const count = harness.registrations.length
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    reduced.dispatchEvent(new Event('change'))
    frame.focus()
    await Promise.resolve()
    expect(harness.registrations).toHaveLength(count)
    expect(harness.registrations.at(-1)!.trigger.disable).not.toHaveBeenCalled()
    expect(styleSnapshot(frame)).toEqual(original)
  })

  it('keeps an already focused preview fully revealed after pause and resume', async () => {
    scope.innerHTML = assemblyMarkup
    const frame = scope.querySelector<HTMLElement>('.studio-preview')!
    const { init, errors } = premiumLifecycle()
    cleanup = init()
    await vi.waitFor(() => { expect(errors).toEqual([]); expect(harness.registrations).toHaveLength(1) })
    frame.focus()
    expect(harness.registrations[0]!.animation.progress()).toBe(1)
    document.documentElement.dataset.motionPaused = 'true'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    document.documentElement.dataset.motionPaused = 'false'
    document.dispatchEvent(new Event('discoverystack:motion-change'))
    await vi.waitFor(() => expect(harness.registrations).toHaveLength(2))
    const restarted = harness.registrations[1]!
    expect(document.activeElement).toBe(frame)
    expect(restarted.animation.progress()).toBe(1)
    expect(restarted.trigger.disable).toHaveBeenCalledWith(false)
    expect(parseFloat(frame.style.getPropertyValue('--assembly-inset'))).toBe(0)
  })
})
