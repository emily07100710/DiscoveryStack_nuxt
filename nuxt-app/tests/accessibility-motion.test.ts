import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchSsrHtml, startSsrServer, stopSsrServer } from './helpers/ssr-server'

const root = process.cwd()
const mainCss = readFileSync(join(root, 'assets/css/main.css'), 'utf8')
const immersiveCss = readFileSync(join(root, 'assets/css/immersive.css'), 'utf8')

describe('Accessibility and motion baseline', () => {
  beforeAll(startSsrServer)
  afterAll(stopSsrServer)

  it('keeps the public home semantic and form-labelled in its SSR response', async () => {
    const { response, html } = await fetchSsrHtml('/en')
    expect(response.status).toBe(200)
    expect(html).toMatch(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)
    expect(html).toMatch(/<h2\b[^>]*>[\s\S]*?<\/h2>/i)
    expect(html).toMatch(/<label[^>]*>[\s\S]*?(?:Name|姓名|Website|網站|Email|電子郵件)[\s\S]*?<\/label>/i)
    const headings = [...html.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]))
    expect(headings[0]).toBe(1)
    expect(headings.some((level) => level === 2)).toBe(true)
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1]
      const current = headings[index]
      if (previous === undefined || current === undefined) throw new Error('Heading order could not be evaluated.')
      expect(current - previous).toBeLessThanOrEqual(1)
    }
  })

  it('provides visible keyboard focus for public and private forms', () => {
    expect(mainCss).toMatch(/:focus-visible/)
    expect(mainCss).toMatch(/box-shadow:[^;}]*var\(--cobalt\)/)
    expect(immersiveCss).toMatch(/\.qa-prompts button:focus-visible/)
  })

  it('gates scroll-driven motion behind prefers-reduced-motion', () => {
    expect(immersiveCss).toMatch(/@media\s*\(prefers-reduced-motion:no-preference\)/)
    expect(immersiveCss).toMatch(/animation-timeline:view\(\)/)
  })
})
