import { describe, expect, it } from 'vitest'
import { buildPublicationIdentity } from '../server/content-operations/publication-identity'
import { PUBLICATION_PUBLIC_URL_NOT_CONFIGURED, publicationPublicOrigin, resolvePublicationPublicUrl } from '../server/content-operations/publication-public-url'

function input() {
  const client = { id: 20, ownerUserId: 10, canonicalSiteOrigin: 'https://client.acme.taipei' }
  const target = { id: 55, ownerUserId: 10, clientId: 20, transport: 'first_party_git', targetId: 'target-55', targetOrigin: 'https://api.github.com', contentRoot: 'content', status: 'active' }
  const entry = { id: 30, ownerUserId: 10, contentType: 'article', language: 'zh-hant' }
  const built = buildPublicationIdentity({ clientId: 20, entryId: 30, targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: 'content', contentType: 'article', language: 'zh-hant', title: 'Verified article', ownerScopeKey: 'owner-10' })
  if (!built.ok) throw new Error(built.reason)
  return { ownerUserId: 10, client, target, entry, identity: built.identity }
}
const absent = { configured: false, code: PUBLICATION_PUBLIC_URL_NOT_CONFIGURED }

describe('publication public URL authority', () => {
  it.each(['first_party_git', 'first_party_signed_api'])('derives only the formal Site Kit route for %s', transport => {
    const value = input(); value.target.transport = transport
    expect(resolvePublicationPublicUrl(value)).toEqual({ configured: true, publicationUrl: `https://client.acme.taipei/zh-hant/articles/${value.identity.slug}` })
    expect(resolvePublicationPublicUrl({ ...value, publicationUrl: null })).toEqual(resolvePublicationPublicUrl(value))
  })
  it.each([['article', 'articles'], ['faq', 'faq'], ['service_page', 'services']])('uses the formal %s public route', (contentType, section) => {
    const value = input(); value.entry.contentType = contentType; value.entry.language = 'en'
    const identity = { publicationId: 'publication-30', slug: 'verified-page', path: `content/en/${section}/verified-page.md` }
    expect(resolvePublicationPublicUrl({ ...value, identity })).toEqual({ configured: true, publicationUrl: `https://client.acme.taipei/en/${section}/verified-page` })
  })
  it.each(['http://client.acme.taipei/zh-hant/articles/a', 'https://other.acme.taipei/a', 'https://api.github.com/content/zh-hant/articles/a.md', 'https://client.acme.taipei/content/zh-hant/articles/a.md', 'https://client.acme.taipei/api/content-ingest', 'https://user:pass@client.acme.taipei/a', 'https://client.acme.taipei/a?q=1', 'https://client.acme.taipei/a#part', '//client.acme.taipei/a', ''])('rejects an untrusted saved URL instead of falling back: %s', publicationUrl => {
    expect(resolvePublicationPublicUrl({ ...input(), publicationUrl })).toEqual(absent)
  })
  it('revalidates saved URLs against the current owner/client binding and formal artifact route', () => {
    const value = input(); const publicationUrl = `https://client.acme.taipei/zh-hant/articles/${value.identity.slug}`
    expect(resolvePublicationPublicUrl({ ...value, publicationUrl })).toMatchObject({ configured: true })
    value.client.canonicalSiteOrigin = 'https://replacement.acme.taipei'
    expect(resolvePublicationPublicUrl({ ...value, publicationUrl })).toEqual(absent)
  })
  it.each(['client', 'target', 'entry'])('rejects a mismatched %s owner', key => {
    const value = input(); value[key as 'client' | 'target' | 'entry'].ownerUserId = 11
    expect(resolvePublicationPublicUrl(value)).toEqual(absent)
  })
  it('rejects stale target/client and malformed persisted artifact identity', () => {
    const value = input(); value.target.clientId = 21
    expect(resolvePublicationPublicUrl(value)).toEqual(absent)
    value.target.clientId = 20; value.identity.path = 'content/en/articles/wrong.md'
    expect(resolvePublicationPublicUrl(value)).toEqual(absent)
    expect(resolvePublicationPublicUrl({ ...input(), identity: null })).toEqual(absent)
  })
  it('cannot use an API transport origin as the client public origin', () => {
    const value = input(); value.client.canonicalSiteOrigin = 'https://api.github.com'
    expect(publicationPublicOrigin(value.ownerUserId, value.client, value.target)).toBeNull()
    expect(resolvePublicationPublicUrl(value)).toEqual(absent)
  })
  it('binds Next.js publication to the real journal permalink', () => {
    const value = input(); value.target.transport = 'first_party_signed_api'
    const nextjs = {...value,target:{...value.target,framework:'nextjs'}}
    expect(resolvePublicationPublicUrl(nextjs)).toEqual({configured:true,publicationUrl:`https://client.acme.taipei/journal/${value.identity.slug}/`})
    expect(resolvePublicationPublicUrl({...nextjs,publicationUrl:`https://client.acme.taipei/zh-hant/articles/${value.identity.slug}`})).toEqual(absent)
    expect(resolvePublicationPublicUrl({...nextjs,entry:{...nextjs.entry,contentType:'faq'}})).toEqual(absent)
  })
  it('allows a trusted saved CMS URL but never invents a CMS permalink', () => {
    const value = input(); value.target.transport = 'wordpress_rest'
    expect(resolvePublicationPublicUrl(value)).toEqual(absent)
    expect(resolvePublicationPublicUrl({ ...value, publicationUrl: 'https://client.acme.taipei/verified-wordpress-page' })).toEqual({ configured: true, publicationUrl: 'https://client.acme.taipei/verified-wordpress-page' })
  })
})
