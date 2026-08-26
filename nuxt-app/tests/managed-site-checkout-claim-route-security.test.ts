import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const routePath = join(process.cwd(), 'server/api/managed-sites/checkout-claim.post.ts')
const route = readFileSync(routePath, 'utf8')

describe('managed-site checkout claim route security contract', () => {
  it('requires the owner session and resolves the database owner from authenticated openId', () => {
    expect(route).toContain('requireOwner(event)')
    expect(route).toContain('getOwnerDatabaseUserId(owner.openId)')
    expect(route.indexOf('requireOwner(event)')).toBeLessThan(route.indexOf('readBody(event)'))
    expect(route).not.toMatch(/email.*owner|owner.*email/iu)
  })

  it('accepts exactly the five checkout lineage fields and delegates to the transactional claim service', () => {
    for (const field of ['previewId', 'previewAccessToken', 'quoteId', 'leadIntentId', 'draftOrderId']) expect(route).toContain(`'${field}'`)
    expect(route).toContain('Object.keys(body).some(key => !ALLOWED_FIELDS.has(key))')
    expect(route).toContain('claimManagedSiteCheckout(ownerUserId, body')
    expect(route).toContain('getPreviewRepository()')
  })

  it('does not return token/hash/session/SQL data and marks the response private', () => {
    expect(route).toContain("'Cache-Control', 'private, no-store, max-age=0'")
    expect(route).toContain("'Referrer-Policy', 'no-referrer'")
    expect(route).not.toMatch(/accessTokenHash|sessionToken|password|sqlError|stack/iu)
    expect(route).not.toContain('previewAccessToken:')
  })
})
