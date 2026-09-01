import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url).pathname
const knowledgeRouteRoot = `${root}server/api/knowledge`
function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? routeFiles(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [])
}

describe('Knowledge owner boundary and preview attachment', () => {
  it('protects every knowledge handler with owner authority and private headers', () => {
    const files = routeFiles(knowledgeRouteRoot).filter(path => !path.endsWith('/_helpers.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      expect(source).toContain('requireKnowledgeOwner')
      expect(source).toContain('setKnowledgePrivateApiHeaders')
      expect(source).not.toContain('console.log')
      if (path.endsWith('.post.ts')) expect(source).toContain('strictKeys')
    }
  })

  it('keeps structured data optional and cannot bypass existing delivery-preview guards', () => {
    const source = readFileSync(`${root}server/api/seo-geo/delivery-preview.post.ts`, 'utf8')
    expect(source).toContain('const preview = await prepareDeliveryPreview')
    expect(source).toContain('const plan = preview.planId')
    expect(source).toContain('try {')
    expect(source).toContain('composeContentStructuredData')
    expect(source).toContain('structuredData = null')
    expect(source).toContain('structuredData')
    expect(source).toContain('requireOwner(event)')
  })

  it('keeps the private owner page noindex and public CORS limited to its two existing paths', () => {
    const page = readFileSync(`${root}pages/audit-lab/knowledge.vue`, 'utf8')
    expect(page).toContain("definePageMeta({ layout: 'owner' })")
    expect(page).toContain("content: 'noindex,nofollow,noarchive'")
    const middleware = readFileSync(`${root}server/middleware/public-cors.ts`, 'utf8')
    const cors = readFileSync(`${root}server/utils/publicCors.ts`, 'utf8')
    expect(middleware).toContain("from '../utils/publicCors'")
    expect(middleware).not.toContain('/api/knowledge')
    expect(cors).toContain("'/api/leads'")
    expect(cors).toContain("'/api/site-analysis'")
    expect(cors).not.toContain('/api/knowledge')
    expect((cors.match(/\/api\//gu) || []).length).toBe(2)
    expect(existsSync(`${root}server/api/knowledge/structured-data-preview.post.ts`)).toBe(true)
  })
})
