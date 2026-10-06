import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url)
const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts as Record<string, string>

describe('repository application entrypoints', () => {
  it('builds and checks the two real applications without invoking retired source paths', () => {
    expect(scripts.build).toBe('pnpm --dir public-site build && pnpm --dir nuxt-app build')
    expect(scripts.check).toBe('pnpm --dir public-site check && pnpm --dir nuxt-app typecheck')
    expect(scripts.start).toBe('NODE_ENV=production node nuxt-app/.output/server/index.mjs')
    for (const app of ['public-site', 'nuxt-app']) {
      expect(existsSync(fileURLToPath(new URL(`${app}/package.json`, root)))).toBe(true)
      expect(existsSync(fileURLToPath(new URL(`${app}/pnpm-lock.yaml`, root)))).toBe(true)
    }
    expect(Object.values(scripts).join('\n')).not.toContain('server/_core/index.ts')
    expect(Object.values(scripts).join('\n')).not.toContain('node dist/index.js')
  })

  it('keeps automatic migrations and real-provider opt-in tests outside the default workflow', () => {
    expect(scripts['db:push']).toBeUndefined()
    expect(scripts['db:generate']).toBe('pnpm --dir nuxt-app db:generate')
    expect(scripts.test).toBe('pnpm --dir public-site test && pnpm --dir nuxt-app test:safe')
    for (const name of ['build', 'start', 'check', 'test', 'db:generate']) {
      expect(scripts[name]).not.toMatch(/drizzle-kit (?:push|migrate)|DS_RUN_REAL_|test:external-credentials/u)
    }
  })
})
