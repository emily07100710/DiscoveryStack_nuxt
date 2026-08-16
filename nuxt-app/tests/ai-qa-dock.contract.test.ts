import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'components/landing/AiQaDock.vue'), 'utf8')
const verifier = readFileSync(join(process.cwd(), 'scripts/verify-floating-ai-qa-accessibility.mjs'), 'utf8')
const immersiveCss = readFileSync(join(process.cwd(), 'assets/css/immersive.css'), 'utf8')

describe('AI QA floating dock contract', () => {
  it('provides a labelled launcher and an independently controlled panel', () => {
    expect(source).toContain('class="qa-launcher"')
    expect(source).toContain('id="qa-launcher"')
    expect(source).toContain(':aria-controls="panelId"')
    expect(source).toContain('class="qa-assistant-icon"')
    expect(source).toContain(':aria-label="`AI QA — ${copy.launcher}`"')
    expect(source).toContain('class="qa-panel"')
    expect(source).toContain(':aria-hidden="!expanded"')
  })

  it('supports Escape close with focus return and keeps a gentle advisor tone', () => {
    expect(source).toContain('@keydown.esc="closeDock"')
    expect(source).toContain('launcher.value?.focus()')
    expect(source).toContain('A grounded starting point')
    expect(source).toContain('先提供可靠方向')
  })

  it('ships a repeatable browser verifier for Tab focus, mobile bounds and reduced motion', () => {
    expect(verifier).toContain("key: 'Tab'")
    expect(verifier).toContain("key: 'Escape'")
    expect(verifier).toContain("width: 375, height: 812")
    expect(verifier).toContain("prefers-reduced-motion")
  })

  it('keeps the text entry surface visually distinct from the AI QA panel', () => {
    expect(immersiveCss).toContain('.ai-qa-dock .qa-form{gap:.5rem;padding:.5rem;background:#edf1f7')
    expect(immersiveCss).toContain('.ai-qa-dock .qa-form input{border:1px solid rgba(77,93,173,.48);background:rgba(255,255,255,.82)')
    expect(immersiveCss).toContain('.ai-qa-dock .qa-form input::placeholder{color:#5e6b82')
    expect(immersiveCss).toContain('.ai-qa-dock .qa-form input:focus{outline:0;border-color:var(--cobalt-deep);background:#fffefa;box-shadow:0 0 0 3px rgba(77,93,173,.17)')
  })
})
