import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const builder = readFileSync(join(root, 'scripts/create-visual-preview.mjs'), 'utf8')
const runtime = readFileSync(join(root, 'scripts/visual-preview-runtime.js'), 'utf8')

describe('Visual preview motion fallback contract', () => {
  it('injects only the isolated scroll runtime after stripping Nuxt hydration scripts', () => {
    expect(builder).toMatch(/application\\\/ld\\\+json/)
    expect(builder).toContain('/__preview/scroll-story.js')
    expect(builder).toContain("join(destination, '__raw')")
    expect(builder).toContain('findHtmlFiles')
    expect(builder).toContain('fallbackSource')
    expect(builder).toContain('fallbackRoutes')
    expect(builder).toContain('coreFallbackRoutes')
    expect(builder).toContain('/en/services/seo-geo-growth-system')
    expect(builder).toContain('withFallbackStyles')
    expect(builder).toContain('AbortSignal.timeout(5000)')
  })

  it('drives story state without a framework runtime and honors reduced motion', () => {
    expect(runtime).toMatch(/prefers-reduced-motion: reduce/)
    expect(runtime).toMatch(/requestAnimationFrame/)
    expect(runtime).toMatch(/--story-progress/)
    expect(runtime).toMatch(/is-active/)
    expect(runtime).toMatch(/pointermove/)
    expect(runtime).toMatch(/pointerType !== 'mouse'/)
    expect(runtime).toMatch(/--pointer-x/)
    expect(runtime).not.toMatch(/tabindex/)
  })

  it('keeps the floating AI QA dock operable even when story motion is disabled', () => {
    expect(runtime).toMatch(/const dock = document\.querySelector\('\.ai-qa-dock'\)/)
    expect(runtime).toMatch(/setDockOpen/)
    expect(runtime).toMatch(/launcher\.setAttribute\('aria-expanded'/)
    expect(runtime).toMatch(/event\.key === 'Escape'/)
    expect(runtime).toMatch(/launcher\.focus\(\)/)
    expect(runtime).toMatch(/get\('qa'\) === 'open'/)
    expect(runtime.indexOf('const dock')).toBeLessThan(runtime.indexOf("prefers-reduced-motion: reduce"))
  })

  it('keeps preview prompts and manual questions meaningfully responsive', () => {
    expect(runtime).toMatch(/promptButtons\.forEach/)
    expect(runtime).toMatch(/qaForm\?\.addEventListener\('submit'/)
    expect(runtime).toMatch(/previewAnswer/)
    expect(runtime).toMatch(/not a ranking promise/)
    expect(runtime).toMatch(/不是排名保證/)
  })
})
