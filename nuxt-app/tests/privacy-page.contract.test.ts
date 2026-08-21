import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const privacy = readFileSync(join(root, 'pages/privacy.vue'), 'utf8')
const layout = readFileSync(join(root, 'layouts/default.vue'), 'utf8')
const config = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')

describe('public privacy explanation', () => {
  it('explains the real public-check and consent boundaries in both languages', () => {
    expect(privacy).toContain('不保存原始 HTML')
    expect(privacy).toContain('does not retain raw HTML')
    expect(privacy).toContain('網站也不會自行持續抓取或自動重訓')
    expect(privacy).toContain('does not continuously crawl or retrain itself')
  })

  it('is reachable from the footer and prerendered for both languages', () => {
    expect(layout).toContain("'/zh-hant/privacy'")
    expect(layout).toContain("'/en/privacy'")
    expect(config).toContain("'/en/privacy', '/zh-hant/privacy'")
  })
})
