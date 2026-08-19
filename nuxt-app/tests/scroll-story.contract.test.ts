import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const story = readFileSync(join(root, 'components/landing/JourneySequence.vue'), 'utf8')
const home = readFileSync(join(root, 'pages/index.vue'), 'utf8')
const styles = readFileSync(join(root, 'assets/css/immersive.css'), 'utf8')
const globalStyles = readFileSync(join(root, 'assets/css/main.css'), 'utf8')

describe('Scroll-story contract', () => {
  it('keeps all four narrative scenes in SSR component markup', () => {
    expect(story).toMatch(/v-for="\(panel, index\) in panels"/)
    expect(story).toMatch(/const panels = \[/)
    expect((story.match(/number: '0[1-4]'/g) || [])).toHaveLength(4)
    expect(story).toMatch(/<h3>/)
    expect(story).toMatch(/<p>{{ copyFor\(panel\)\[2\] }}/)
  })

  it('uses client scroll state only as progressive enhancement and cleans up listeners', () => {
    expect(story).toMatch(/onMounted\(\(\) =>/)
    expect(story).toMatch(/window\.addEventListener\('scroll'/)
    expect(story).toMatch(/onBeforeUnmount\(\(\) =>/)
    expect(story).toMatch(/window\.removeEventListener\('scroll'/)
    expect(story).not.toMatch(/manus-storage/)
  })

  it('keeps cursor parallax constrained to fine-pointer, non-reduced-motion users', () => {
    expect(story).toMatch(/@pointermove="updatePointer"/)
    expect(story).toMatch(/window\.matchMedia\('\(pointer: fine\)'\)/)
    expect(story).toMatch(/prefers-reduced-motion: reduce/)
    expect(styles).toMatch(/--pointer-x:0/)
    expect(styles).toMatch(/calc\(var\(--pointer-x\) \* 18px\)/)
  })

  it('drives a reversible continuous scene turn from scroll progress', () => {
    expect(story).toContain("'--scene-turn': progress * 1")
    expect(styles).toContain('calc(var(--scene-turn) * -26%)')
    expect(styles).toContain('span:nth-child(4)')
  })

  it('keeps the visual motion opt-out and uses the department system instead of a decorative hero graph', () => {
    expect(styles).toMatch(/\.story-sticky/)
    expect(styles).toMatch(/prefers-reduced-motion:reduce/)
    expect(home).toMatch(/department-system/)
    expect(home).not.toMatch(/hero-constellation/)
    expect(home).not.toMatch(/discoverystack-growth-trace-hero/)
  })

  it('does not place the sticky story inside a vertical overflow container', () => {
    expect(globalStyles).toMatch(/\.site-shell \{ min-height:100svh; overflow-x:clip;/)
    expect(globalStyles).not.toContain('.site-shell { min-height:100svh; overflow:hidden;')
  })
})
