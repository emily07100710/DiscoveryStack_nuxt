import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const seoComposable = readFileSync(join(process.cwd(), 'composables/usePageSeo.ts'), 'utf8')
const homePage = readFileSync(join(process.cwd(), 'pages/index.vue'), 'utf8')
const contentPage = readFileSync(join(process.cwd(), 'components/content/ContentPage.vue'), 'utf8')

describe('SEO JSON-LD SSR initialization contract', () => {
  it('evaluates JSON-LD only with SEO values initialized inside the composable', () => {
    expect(seoComposable).toContain('type SeoContext = {')
    expect(seoComposable).toContain('jsonLd?: (context: SeoContext)')
    expect(seoComposable).toContain('input.jsonLd?.({ baseUrl, absolute })')
  })

  it('does not capture destructured SEO return values inside homepage or content-page callbacks', () => {
    expect(homePage).toContain('jsonLd: ({ baseUrl }) => ({')
    expect(contentPage).toContain('jsonLd: ({ baseUrl, absolute }) => ({')
    expect(homePage).not.toContain('jsonLd: () => ({')
    expect(contentPage).not.toContain('jsonLd: () => ({')
  })
})
