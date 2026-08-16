import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runner = readFileSync(join(root, 'scripts/managed-nuxt-dev.mjs'), 'utf8')
const staticPreview = readFileSync(join(root, 'scripts/managed-static-preview.mjs'), 'utf8')

describe('Managed preview runner contract', () => {
  it('uses a static preview server for the managed dev entry and retains Nuxt dev as a diagnostic command', () => {
    expect(packageJson.scripts.dev).toBe('node scripts/create-visual-preview.mjs && node scripts/managed-static-preview.mjs')
    expect(packageJson.scripts['dev:nuxt']).toBe('node scripts/managed-nuxt-dev.mjs')
    expect(runner).toMatch(/nuxt', 'dev', '--host', host, '--port', port/)
    expect(runner).toMatch(/const host = process\.env\.HOST \|\| '0\.0\.0\.0'/)
    expect(runner).toMatch(/const port = process\.env\.PORT \|\| '3000'/)
  })

  it('restarts an unexpected child exit but forwards normal shutdown signals', () => {
    expect(runner).toMatch(/setTimeout\(start, 1000\)/)
    expect(runner).toMatch(/process\.on\('SIGTERM'/)
    expect(runner).toMatch(/process\.on\('SIGINT'/)
    expect(runner).toMatch(/child\.kill\(signal\)/)
  })

  it('keeps the preview root aligned with the Nuxt default locale route', () => {
    expect(staticPreview).toMatch(/pathname === '\/'/)
    expect(staticPreview).toMatch(/Location: '\/en'/)
  })

  it('keeps an isolated raw Nuxt hydration path available without replacing the visual fallback', () => {
    expect(staticPreview).toContain("const nuxtHydrationRoot = join(process.cwd(), '.output', 'public')")
    expect(staticPreview).toMatch(/url\.searchParams\.has\('nuxt'\)/)
  })
})
