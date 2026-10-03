import { normalizePublicHttpsOrigin } from './normalization'
import { publicationPathFor, validatePersistedPublicationIdentity, type PublicationIdentity } from './publication-identity'

export const PUBLICATION_PUBLIC_URL_NOT_CONFIGURED = 'PUBLICATION_PUBLIC_URL_NOT_CONFIGURED'
type ClientBinding = { id: number; ownerUserId: number; canonicalSiteOrigin: string }
type TargetBinding = { id: number; ownerUserId: number; clientId: number; transport: string; framework?: string; targetId: string; targetOrigin: string; contentRoot: string; status: string }
type EntryBinding = { id: number; ownerUserId: number; contentType: string; language: string }
type ArtifactIdentity = Pick<PublicationIdentity, 'publicationId' | 'slug' | 'path'> & Partial<Pick<PublicationIdentity, 'identityFingerprint'>>
type PublicUrlResult = { configured: true; publicationUrl: string } | { configured: false; code: typeof PUBLICATION_PUBLIC_URL_NOT_CONFIGURED }
const missing = (): PublicUrlResult => ({ configured: false, code: PUBLICATION_PUBLIC_URL_NOT_CONFIGURED })

// The client's stored public origin is authority; publisher/API origins are transport only.
export function publicationPublicOrigin(ownerUserId: number, client: ClientBinding | null | undefined, target?: TargetBinding | null): string | null {
  try {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || !client || client.ownerUserId !== ownerUserId || !Number.isSafeInteger(client.id) || client.id < 1) return null
    if (target && (target.ownerUserId !== ownerUserId || target.clientId !== client.id || target.status === 'revoked')) return null
    const origin = normalizePublicHttpsOrigin(client.canonicalSiteOrigin)
    if (origin === 'https://api.github.com') return null
    return origin
  } catch { return null }
}

export function resolvePublicationPublicUrl(input: {
  ownerUserId: number; client: ClientBinding | null | undefined; entry: EntryBinding; target: TargetBinding;
  identity?: ArtifactIdentity | null; publicationUrl?: string | null;
}): PublicUrlResult {
  try {
    const { ownerUserId, client, entry, target, identity, publicationUrl } = input
    const origin = publicationPublicOrigin(ownerUserId, client, target)
    if (!origin || !client || entry.ownerUserId !== ownerUserId || !Number.isSafeInteger(entry.id) || entry.id < 1) return missing()
    const firstParty = target.transport === 'first_party_git' || target.transport === 'first_party_signed_api'
    let expectedPage: string | null = null
    if (firstParty) {
      if (!identity || identity.publicationId !== `publication-${entry.id}` || !['article', 'faq', 'service_page'].includes(entry.contentType) || !['en', 'zh-hant'].includes(entry.language)) return missing()
      const identityInput = { clientId: client.id, entryId: entry.id, targetId: target.targetId, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, contentType: entry.contentType as 'article' | 'faq' | 'service_page', language: entry.language as 'en' | 'zh-hant', title: 'Public route validation', ownerScopeKey: `owner-${ownerUserId}` }
      const expectedArtifactPath = publicationPathFor(target.contentRoot, identityInput, identity.slug)
      if (!expectedArtifactPath || identity.path !== expectedArtifactPath) return missing()
      if (identity.identityFingerprint !== undefined && !validatePersistedPublicationIdentity({ ...identityInput, existingIdentity: identity as PublicationIdentity }).ok) return missing()
      const section = entry.contentType === 'article' ? 'articles' : entry.contentType === 'faq' ? 'faq' : 'services'
      if (target.framework === 'nextjs') {
        if (target.transport !== 'first_party_signed_api' || entry.contentType !== 'article') return missing()
        expectedPage = `${origin}/journal/${identity.slug}/`
      } else expectedPage = `${origin}/${entry.language}/${section}/${identity.slug}`
    }
    // Other CMS routes require a trusted, saved URL; never invent a permalink.
    const candidate = publicationUrl === null || publicationUrl === undefined ? expectedPage : publicationUrl
    if (typeof candidate !== 'string' || candidate.length < 1 || candidate.length > 2048 || candidate.trim() !== candidate || /[\\\x00-\x20\x7f]/u.test(candidate)) return missing()
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash || url.pathname.startsWith('/api/') || /\.(?:md|json)$/iu.test(url.pathname)) return missing()
    if (expectedPage && url.toString() !== expectedPage) return missing()
    if (!firstParty && !['wordpress_rest', 'geoflow_agent', 'generic_http', 'geoflow_local'].includes(target.transport)) return missing()
    return { configured: true, publicationUrl: url.toString() }
  } catch { return missing() }
}
