import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicRoot = join(process.cwd(), '.output/public')
const privateLayoutSource = readFiles(join(process.cwd(), 'layouts'), path => path.endsWith('.vue')).join('\n')

function readFiles(directory: string, predicate: (path: string) => boolean): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? readFiles(path, predicate) : predicate(path) ? [readFileSync(path, 'utf8')] : []
  })
}

describe('Private output boundary', () => {
  it('does not place private API calls or Audit Lab content in public prerendered HTML', () => {
    const publicHtml = readFiles(publicRoot, (path) => path.endsWith('.html') && /\/(en|zh-hant)\//.test(path)).join('\n')
    expect(publicHtml).not.toContain('/api/audit')
    expect(publicHtml).not.toContain('/api/intelligence')
    expect(publicHtml).not.toContain('Private Audit Lab')
  })

  it('does not serialize server secret names or values into shipped browser assets', () => {
    const output = readFiles(publicRoot, (path) => /\.(?:html|js|json)$/.test(path)).join('\n')
    for (const serverOnlyMarker of ['HUGGINGFACE_API_TOKEN', 'JWT_SECRET', 'DATABASE_URL', 'OAUTH_SERVER_URL', 'BUILT_IN_FORGE_API_KEY', 'ownerOpenId', 'sessionSecret']) expect(output).not.toContain(serverOnlyMarker)
  })

  it('does not ship a global reference to an unavailable manus-storage brand asset', () => {
    const publicHtml = readFiles(publicRoot, (path) => path.endsWith('.html')).join('\n')
    expect(privateLayoutSource).not.toContain('/manus-storage/')
    expect(publicHtml).not.toContain('/manus-storage/')
  })
})
