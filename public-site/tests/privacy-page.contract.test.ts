import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicRoot = join(process.cwd(), 'dist')
const readPage = (locale: string) => readFileSync(join(publicRoot, locale, 'privacy', 'index.html'), 'utf8')

describe('Astro privacy pages', () => {
  it('keeps the stated public-site data boundaries in both languages', () => {
    const en = readPage('en')
    const zh = readPage('zh-hant')
    expect(en).toContain('does not retain raw HTML')
    expect(en).toContain('models are never deployed to the site automatically')
    expect(zh).toContain('不保存原始 HTML')
    expect(zh).toContain('模型也不會自動部署到網站')
  })

  it('links privacy and fit-review without linking private operations into public output', () => {
    for (const locale of ['en', 'zh-hant']) {
      const html = readPage(locale)
      expect(html).toContain(`/${locale}/privacy`)
      expect(html).toContain(`/${locale}#fit`)
      expect(html).not.toContain('/audit-lab')
      expect(html).not.toContain('/api/')
    }
  })
})
