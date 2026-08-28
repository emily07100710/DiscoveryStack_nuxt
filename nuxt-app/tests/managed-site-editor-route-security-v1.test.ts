import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MANAGED_SITE_ROLE_PERMISSIONS, roleAllows } from '../server/managed-sites/types'

const routeRoot = join(process.cwd(), 'server/api/managed-sites/editor')
const files = (directory: string): string[] => readdirSync(directory).filter(entry => !['node_modules', 'dist', '.astro', '.git'].includes(entry)).flatMap(entry => { const path = join(directory, entry); return statSync(path).isDirectory() ? files(path) : /\.(?:astro|ts|tsx|js|mjs|json)$/u.test(path) ? [path] : [] })

describe('managed-site private editor route security V1', () => {
  it('reconstructs session authority on every route and enforces same-origin on every mutation', () => {
    const routes = files(routeRoot); expect(routes.length).toBeGreaterThanOrEqual(30)
    for (const file of routes) { const source = readFileSync(file, 'utf8'); expect(source, relative(process.cwd(), file)).toMatch(/requireEditorActor|requireOwner/u); if (/\.(?:post|put|delete)\.ts$/u.test(file)) expect(source, relative(process.cwd(), file)).toContain('assertEditorSameOrigin') }
  })

  it('sets private no-store/noindex headers and rejects absent or cross-site origin before mutation', () => {
    const source = readFileSync(join(process.cwd(), 'server/managed-sites/page-editor/http.ts'), 'utf8'); expect(source).toContain("private, no-store, max-age=0"); expect(source).toContain('noindex, nofollow, noarchive'); expect(source).toContain("fetchSite === 'cross-site'"); expect(source).toContain('origin !== expected'); expect(source).toContain("access.project.status === 'suspended'")
  })

  it('separates viewer, editor and publisher capability without treating email as authority', () => {
    expect(roleAllows('reviewer', 'content:read')).toBe(true); expect(roleAllows('reviewer', 'content:write')).toBe(false); expect(roleAllows('editor', 'content:write')).toBe(true); expect(roleAllows('editor', 'content:publish')).toBe(false); expect(roleAllows('administrator', 'content:publish')).toBe(true); expect(MANAGED_SITE_ROLE_PERMISSIONS.owner).not.toContain('source:read'); const source = readFileSync(join(process.cwd(), 'server/managed-sites/page-editor/http.ts'), 'utf8'); expect(source).not.toMatch(/principalEmail.*authority|email.*roleAllows/iu)
  })

  it('keeps the public Astro package free of editor, storage and AI runtime imports', () => {
    const publicRoot = join(process.cwd(), '..', 'public-site'); const publicFiles = files(publicRoot).filter(file => /\.(?:astro|ts|tsx|js|mjs|json)$/u.test(file)); for (const file of publicFiles) { const source = readFileSync(file, 'utf8'); expect(source, relative(process.cwd(), file)).not.toMatch(/managed-sites\/page-editor|media-vault|@aws-sdk\/client-s3|sharp|SCOPED AI EDITOR/u) }
  })
})
