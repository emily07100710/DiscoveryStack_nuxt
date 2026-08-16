import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'assets/css/main.css'), 'utf8')

function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const sourceChannels = hex.match(/[a-f\d]{2}/gi)
    if (!sourceChannels || sourceChannels.length !== 3) throw new Error(`Expected a six-digit hex colour, received ${hex}.`)
    const channels = sourceChannels.map((channel) => Number.parseInt(channel, 16) / 255)
    const red = channels[0]!
    const green = channels[1]!
    const blue = channels[2]!
    const linear = [red, green, blue].map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    const linearRed = linear[0]!
    const linearGreen = linear[1]!
    const linearBlue = linear[2]!
    return 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue
  }
  const first = luminance(foreground)
  const second = luminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('Private-paper brand direction contract', () => {
  it('keeps the warm paper, deep ink and restrained brass palette available as global tokens', () => {
    expect(css).toContain('--bone:#f8f4eb')
    expect(css).toContain('--paper:#fdfbf6')
    expect(css).toContain('--ink:#16263f')
    expect(css).toContain('--gold:#b08d57')
    expect(css).toContain('--line:rgba(22,38,63,.1)')
  })

  it('adds a non-interactive paper grain layer above the canvas without covering the floating assistant', () => {
    expect(css).toContain('body::after')
    expect(css).toContain('pointer-events:none')
    expect(css).toContain('opacity:.028')
  })

  it('uses a fixed translucent paper header while reserving main-content space', () => {
    expect(css).toContain('.site-header{position:fixed')
    expect(css).toContain('.site-shell>main{padding-top:76px}')
    expect(css).toContain('backdrop-filter:blur(16px)')
  })

  it('keeps form focus and error states perceptible against light operational surfaces', () => {
    expect(contrastRatio('16263f', 'f8f4eb')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('8d3c47', 'e6eaf0')).toBeGreaterThanOrEqual(4.5)
    expect(css).toContain('.fit-review-form :is(input,textarea,select):focus-visible')
    expect(css).toContain('box-shadow:0 3px 0 var(--cobalt)')
    expect(css).toContain('.fit-review-form :is(input,textarea,select):user-invalid')
    expect(css).toContain('box-shadow:0 3px 0 rgba(141,60,71,.35)')
    expect(css).toContain('.fit-feedback.is-error{color:var(--danger);font-weight:600}')
  })
})
