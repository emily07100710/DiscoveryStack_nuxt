import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const config = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')
const oauth = readFileSync(join(root, 'server/utils/oauth.ts'), 'utf8')
const login = readFileSync(join(root, 'server/api/auth/login.get.ts'), 'utf8')
const callback = readFileSync(join(root, 'server/api/auth/callback.get.ts'), 'utf8')
const auditLab = readFileSync(join(root, 'pages/audit-lab.vue'), 'utf8')
const dockerfile = readFileSync(join(root, '..', 'Dockerfile'), 'utf8')

describe('OAuth frontend-origin contract', () => {
  it('requires a configured HTTPS allowlist origin rather than trusting a request host', () => {
    expect(config).toContain("discoveryStackOauthAllowedOrigin: process.env.NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN || process.env.OAUTH_ALLOWED_ORIGIN || ''")
    expect(oauth).toContain("const configuredOrigin = typeof config.discoveryStackOauthAllowedOrigin === 'string' ? config.discoveryStackOauthAllowedOrigin : ''")
    expect(oauth).toContain('new URL(configuredOrigin).origin')
    expect(oauth).toContain("allowedOrigin.startsWith('https://')")
    expect(oauth).not.toContain('getRequestURL(event).origin')
  })

  it('binds the requested frontend origin, OAuth state, and callback URI to the same allowlist value', () => {
    expect(login).toContain('beginOAuthLogin(event, origin)')
    expect(login).toContain("setHeader(event, 'Cache-Control', 'no-store, max-age=0')")
    expect(login).toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Release', OAUTH_NITRO_RELEASE)")
    expect(login).toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Route', 'nuxt-origin-allowlist-v1')")
    expect(oauth).toContain("if (requestedOrigin !== allowedOrigin)")
    expect(oauth).toContain('const redirectUri = `${allowedOrigin}/api/oauth/callback`')
    expect(oauth).toContain('const expectedRedirect = `${allowedOrigin}/api/oauth/callback`')
    expect(readFileSync(join(root, 'server/api/oauth/callback.get.ts'), 'utf8')).toContain("export { default } from '../auth/callback.get'")
    expect(oauth).toContain('parsed.nonce !== expectedNonce')
    expect(oauth).toContain('axios.post<{ accessToken?: string }>')
    expect(oauth).toContain("clientId: appId, grantType: 'authorization_code', code, redirectUri: statePayload.redirectUri")
    expect(oauth).not.toContain("clientId: appId, grantType: 'authorization_code', code, state")
  })

  it('uses a short-lived Secure cross-site state cookie only for the OAuth callback and never exposes its nonce', () => {
    expect(oauth).toContain("sameSite: 'none'")
    expect(oauth).toContain("maxAge: OAUTH_STATE_MAX_AGE_SECONDS")
    expect(oauth).toContain("setHeader(event, 'X-DiscoveryStack-OAuth-State', expectedNonce ? 'cookie-present' : 'cookie-missing')")
    expect(oauth).not.toContain("setHeader(event, 'X-DiscoveryStack-OAuth-State', expectedNonce)")
  })

  it('mints the browser origin only in the explicit Audit Lab sign-in click handler', () => {
    expect(auditLab).toContain('const origin = window.location.origin')
    expect(auditLab).toContain('window.location.assign(`/api/auth/login?origin=${encodeURIComponent(origin)}`)')
    expect(auditLab).toContain('@click="startAuditSignIn"')
  })

  it('keeps callback failure diagnostics free of codes, tokens, and account data', () => {
    expect(callback).toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Callback', stage)")
    expect(callback).toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Callback', 'complete')")
    expect(callback).toContain("exchangeOAuthCode(event, code, state, (nextStage) => { stage = nextStage })")
    expect(callback).toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Owner', user.openId === config.ownerOpenId ? 'match' : 'mismatch')")
    expect(callback).not.toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Owner', user.openId)")
    expect(callback).not.toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Callback', code)")
    expect(callback).not.toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Callback', user.email)")
    expect(callback).not.toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Callback', exchange.accessToken)")
    expect(callback).toContain('console.error(`[DiscoveryStack OAuth] callback failed at stage=${stage}; error=${errorName}`)')
    expect(callback).not.toContain('console.error(error)')
    expect(callback).not.toContain('console.error(code)')
    expect(callback).not.toContain('console.error(user.email)')
  })

  it('bounds provider calls so a failed provider cannot leave the callback without a response', () => {
    expect(oauth).toContain("import axios from 'axios'")
    expect(oauth).not.toContain('$fetch<')
    expect(oauth).toContain('const OAUTH_PROVIDER_TIMEOUT_MS = 12_000')
    expect(oauth).toContain('timeout: OAUTH_PROVIDER_TIMEOUT_MS')
    expect(callback).toContain("setHeader(event, 'Cache-Control', 'no-store, max-age=0')")
    expect(callback).toContain("setHeader(event, 'X-DiscoveryStack-OAuth-Release', OAUTH_NITRO_RELEASE)")
    expect(callback).toContain("return { error: 'Private sign-in could not be completed.' }")
    expect(callback).toContain('setResponseStatus(event, statusCode)')
    expect(callback).toContain('return { error: callbackFailureMessage(stage) }')
  })

  it('requires the production image to build a clean Nitro artifact with the current OAuth release marker', () => {
    expect(dockerfile).toContain('rm -rf .nuxt .output')
    expect(dockerfile).toContain("grep -R -q 'nitro-oauth-20260816-r4' .output/server")
    expect(dockerfile).toContain('CMD ["node", ".output/server/index.mjs"]')
  })
})
