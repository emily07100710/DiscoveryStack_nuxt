import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const nuxtConfig = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')
const ownerLayout = readFileSync(join(root, 'layouts/owner.vue'), 'utf8')

describe('public/private split runtime origin contract', () => {
  it('uses one public runtimeConfig key for Nuxt and the owner exit link', () => {
    expect(nuxtConfig).toContain('discoveryStackPublicSiteOrigin: process.env.DISCOVERYSTACK_PUBLIC_SITE_ORIGIN || \'\'')
    expect(nuxtConfig).toContain('discoveryStackPublicSiteOrigin: process.env.DISCOVERYSTACK_PUBLIC_SITE_ORIGIN || \'https://www.example.com\'')
    expect(ownerLayout).toContain('config.public.discoveryStackPublicSiteOrigin')
    expect(nuxtConfig).not.toContain('publicSiteOrigin:')
    expect(ownerLayout).not.toContain('config.public.publicSiteOrigin')
  })

  it('keeps the public origin environment variable server-owned by the private app', () => {
    expect(nuxtConfig).toContain('process.env.DISCOVERYSTACK_PUBLIC_SITE_ORIGIN')
    expect(ownerLayout).not.toContain('process.env.')
  })
})
