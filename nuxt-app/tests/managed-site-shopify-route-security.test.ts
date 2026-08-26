import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const shopifyRouteRoot = join(process.cwd(), 'server/api/managed-sites/projects/[id]/integrations/shopify')
const callbackPath = join(process.cwd(), 'server/api/managed-sites/shopify/callback.get.ts')

function source(path: string): string { return readFileSync(path, 'utf8') }

describe('managed-site Shopify route security contract', () => {
  it('uses POST initiation only and never reads a GET request body', () => {
    expect(existsSync(join(shopifyRouteRoot, 'authorize.post.ts'))).toBe(true)
    expect(existsSync(join(shopifyRouteRoot, 'authorize.get.ts'))).toBe(false)
    const initiation = source(join(shopifyRouteRoot, 'authorize.post.ts'))
    const callback = source(callbackPath)
    expect(initiation).toContain('readBody(event)')
    expect(callback).not.toContain('readBody(event)')
  })

  it('binds only high-entropy state in a secure host cookie and hides state from the normal response', () => {
    const initiation = source(join(shopifyRouteRoot, 'authorize.post.ts'))
    expect(initiation).toContain("'__Host-discoverystack-shopify-state'")
    expect(initiation).toContain('httpOnly: true')
    expect(initiation).toContain('secure: true')
    expect(initiation).toContain("sameSite: 'lax'")
    expect(initiation).toContain("path: '/'")
    expect(initiation).toContain('authorizationUrl: result.authorizationUrl')
    expect(initiation).not.toContain('state: result.state')
    expect(initiation).not.toMatch(/codeVerifier|nonce|credentialReference/u)
  })

  it('passes raw callback query into the verifier and deletes state only after successful completion', () => {
    const callback = source(callbackPath)
    expect(callback).toContain('event.node.req.url')
    expect(callback).toContain('rawQuery')
    expect(callback).toContain('createShopifyOAuthCallbackVerifier')
    expect(callback.indexOf('const result = await completeShopifyAuthorization')).toBeLessThan(callback.indexOf('deleteCookie(event'))
    expect(callback).not.toMatch(/nonce|codeVerifier|pkce/iu)
  })
})
