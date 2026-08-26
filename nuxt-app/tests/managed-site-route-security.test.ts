import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const customerRoot = join(process.cwd(), 'server/api/managed-sites/customer')

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? routeFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('managed-site customer route security contract', () => {
  it('keeps every customer route private, uncached, non-referring, and non-indexable', () => {
    expect(existsSync(customerRoot)).toBe(true)
    const files = routeFiles(customerRoot)
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, relative(process.cwd(), file)).toMatch(/private, no-store/u)
      expect(source, relative(process.cwd(), file)).toMatch(/no-referrer/u)
      expect(source, relative(process.cwd(), file)).toMatch(/noindex, nofollow, noarchive/u)
      expect(source, relative(process.cwd(), file)).toMatch(/requireManagedSiteCustomer|acceptManagedSiteInvitation|revokeManagedSiteSession/u)
    }
  })

  it('keeps sensitive customer capabilities separated by fixed role permission gates', () => {
    const exportRoute = readFileSync(join(customerRoot, 'export.get.ts'), 'utf8')
    const assistantRoute = readFileSync(join(customerRoot, 'assistant.post.ts'), 'utf8')
    const revisionRoute = readFileSync(join(customerRoot, 'content-admin/revision.post.ts'), 'utf8')
    const reviewRoute = readFileSync(join(customerRoot, 'content-admin/review.post.ts'), 'utf8')
    expect(exportRoute).toContain("'data:export'")
    expect(assistantRoute).toContain("'content:read'")
    expect(revisionRoute).toContain("'content:write'")
    expect(reviewRoute).toContain("'content:review'")
  })
})
