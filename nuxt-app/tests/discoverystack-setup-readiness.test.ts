import { describe, expect, it, vi } from 'vitest'
import { getDiscoveryStackSetupReadiness } from '../server/managed-sites/setup-readiness'
import { MANAGED_SITE_CONNECTOR_CAPABILITIES, type ManagedSiteProviderReadiness } from '../server/managed-sites/live-connectors/types'

function environment(): Record<string, string> {
  return {
    DISCOVERYSTACK_PUBLIC_SITE_ORIGIN: 'https://synthetic-ds.taipei', NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN: 'https://ops.synthetic-ds.taipei',
    DATABASE_URL: 'mysql://local-fixture:synthetic-value@db.test/ds', JWT_SECRET: 'synthetic-session-value-'.repeat(3), OWNER_OPEN_ID: 'fixture-owner', OWNER_SIMPLE_LOGIN_PASSWORD: 'synthetic-password-for-tests',
    NUXT_MANAGED_SITE_EMAIL_API_KEY: 're_synthetic_resend_key', NUXT_MANAGED_SITE_EMAIL_FROM: 'DiscoveryStack <notifications@ds.test>',
    NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER: 'synthetic-email-pepper-'.repeat(3),
    NUXT_LLM_ENDPOINT: 'https://api.openai.com/v1', NUXT_LLM_API_KEY: 'synthetic-llm-value', NUXT_LLM_MODEL: 'fixture-model',
    NUXT_CONTENT_DRAFT_PROVIDER: 'openai_compatible', NUXT_PAGE_EDITOR_AI_PROVIDER: 'openai_compatible', NUXT_PAGE_EDITOR_PREVIEW_SECRET: 'synthetic-preview-value-'.repeat(3),
    NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED: 'true',
    DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN: 'https://ops.synthetic-ds.taipei', NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER: 'synthetic-pepper-value-'.repeat(3),
    NUXT_MEDIA_SCANNER_ENDPOINT: 'https://scanner.synthetic-ds.taipei/scan', NUXT_MEDIA_SCANNER_CREDENTIAL_REF: 'DS_MEDIA_SCANNER_BEARER', DS_MEDIA_SCANNER_BEARER: 'synthetic-scanner-bearer-value',
    DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON: JSON.stringify({ bucket: 'fixture-vault', region: 'auto', prefix: 'managed-sites', endpoint: 'https://fixture.r2.cloudflarestorage.com' }), AWS_ACCESS_KEY_ID: 'synthetic-access', AWS_SECRET_ACCESS_KEY: 'synthetic-aws-value',
    DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON: JSON.stringify({ 'envref:deployment-fixture': 'synthetic-deploy', 'envref:dns-fixture': 'synthetic-dns', 'envref:cloudflare-fixture': 'synthetic-cloudflare', 'envref:stripe-webhook': 'synthetic-webhook' }),
    DISCOVERYSTACK_MANAGED_SITE_INTERNAL_BROKER_JSON: JSON.stringify({ deploymentCredentialReference: 'envref:deployment-fixture', dnsTlsCredentialReference: 'envref:dns-fixture', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cloudflare-fixture', projectPrefix: 'ds' } }),
    DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS: 'https://api.resend.com,https://api.stripe.com,https://api.porkbun.com,https://managed-sites-broker.discoverystack.dev',
    DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS: 'https://checkout.stripe.com', DISCOVERYSTACK_PAYMENT_WEBHOOK_PROVIDER_KEY: 'stripe', DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF: 'envref:stripe-webhook',
    MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON: JSON.stringify({ com: { currency: 'USD', maxAmountMinor: 2000 } }),
  }
}
function providers(verified: boolean): ManagedSiteProviderReadiness {
  return { liveReady: verified, dryRunAllowed: true, mockedAllowed: false, truthfulBoundary: [], capabilities: MANAGED_SITE_CONNECTOR_CAPABILITIES.map(capability => ({ capability, providerKey: 'fixture-provider', status: verified ? 'verified' : 'configured', configured: true, verified, credentialReferenceConfigured: true, credentialResolvable: true, liveMutationAllowed: verified, missing: verified ? [] : ['verification_receipt'], blockedReasonCode: null, verifiedAt: verified ? new Date().toISOString() : null })) }
}
const check = (result: ReturnType<typeof getDiscoveryStackSetupReadiness>, id: string) => result.checks.find(item => item.id === id)!

describe('DiscoveryStack setup readiness', () => {
  it('does not consider an empty environment or missing provider rows ready', () => {
    const result = getDiscoveryStackSetupReadiness({ env: {} })
    expect(result.configurationReady).toBe(false)
    expect(result.providerVerificationComplete).toBe(false)
    expect(result.productionAccepted).toBe(false)
    expect(check(result, 'provider_payment').status).toBe('missing')
    expect(check(result, 'email').status).toBe('missing')
  })
  it('never calls a provider or emits secret values while projecting complete settings', () => {
    const network = vi.fn(() => { throw new Error('Network forbidden') })
    vi.stubGlobal('fetch', network)
    try {
      const env = environment()
      const result = getDiscoveryStackSetupReadiness({ env, providers: providers(true) })
      expect(result.configurationReady).toBe(true)
      expect(result.providerVerificationComplete).toBe(true)
      expect(result.productionAccepted).toBe(false)
      expect(network).not.toHaveBeenCalled()
      const output = JSON.stringify(result)
      for (const secret of ['synthetic-session', 'synthetic-password', 'synthetic_resend', 'synthetic-llm', 'synthetic-pepper', 'synthetic-aws', 'synthetic-deploy', 'synthetic-webhook', 'mysql://']) expect(output).not.toContain(secret)
    } finally { vi.unstubAllGlobals() }
  })
  it('keeps configured and server-verified providers distinct', () => {
    const result = getDiscoveryStackSetupReadiness({ env: environment(), providers: providers(false) })
    expect(result.configurationReady).toBe(true)
    expect(result.providerVerificationComplete).toBe(false)
    expect(check(result, 'provider_deployment').status).toBe('verification_required')
  })
  it('checks the same authoritative runtime session secret as the authentication service', () => {
    const env = environment()
    expect(check(getDiscoveryStackSetupReadiness({ env, runtimeConfig: { sessionSecret: 'short' } }), 'session').status).toBe('invalid')
    expect(check(getDiscoveryStackSetupReadiness({ env: { ...env, JWT_SECRET: 'short' }, runtimeConfig: { sessionSecret: 'synthetic-runtime-session-'.repeat(3) } }), 'session').status).toBe('configured')
  })
  it.each(['https://ds.test', 'https://172.16.0.1', 'https://[::1]', 'https://example.com'])('rejects a non-public origin %s without any network probe', value => {
    const result = getDiscoveryStackSetupReadiness({ env: { ...environment(), NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN: value } })
    expect(check(result, 'origins').status).toBe('invalid')
  })
  it('requires the OAuth allowlisted origin to match the private portal', () => {
    const env: Record<string, string> = { ...environment(), OWNER_SIMPLE_LOGIN_PASSWORD: '', OAUTH_SERVER_URL: 'https://oauth.synthetic-ds.taipei', VITE_OAUTH_PORTAL_URL: 'https://login.synthetic-ds.taipei', VITE_APP_ID: 'synthetic-app' }
    expect(check(getDiscoveryStackSetupReadiness({ env }), 'owner_login').status).toBe('missing')
    expect(check(getDiscoveryStackSetupReadiness({ env: { ...env, NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN: env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN! } }), 'owner_login').status).toBe('configured')
    expect(check(getDiscoveryStackSetupReadiness({ env: { ...env, NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN: 'https://other.synthetic-ds.taipei' } }), 'owner_login').status).not.toBe('configured')
  })
  it('recognizes the supported request-time OAuth aliases', () => {
    const env = { ...environment(), OWNER_SIMPLE_LOGIN_PASSWORD: '', NUXT_OAUTH_SERVER_URL: 'https://oauth.synthetic-ds.taipei', NUXT_OAUTH_PORTAL_URL: 'https://login.synthetic-ds.taipei', NUXT_OAUTH_APP_ID: 'synthetic-app', NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN: 'https://ops.synthetic-ds.taipei' }
    expect(check(getDiscoveryStackSetupReadiness({ env }), 'owner_login').status).toBe('configured')
  })
  it.each([
    ['DATABASE_URL', 'https://db.test/ds', 'database'],
    ['JWT_SECRET', 'short', 'session'],
    ['NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://ops.ds.test/path', 'origins'],
    ['OWNER_SIMPLE_LOGIN_PASSWORD', 'short', 'owner_login'],
    ['NUXT_LLM_ENDPOINT', 'https://untrusted.test/v1', 'ai'],
    ['NUXT_PAGE_EDITOR_PREVIEW_SECRET', 'short', 'editor_preview'],
    ['NUXT_MANAGED_SITE_EMAIL_CODE_PEPPER', 'short', 'email_codes'],
    ['NUXT_MEDIA_SCANNER_ENDPOINT', 'http://scanner.ds.test/scan', 'media_scanner'],
    ['NUXT_MEDIA_SCANNER_CREDENTIAL_REF', 'DS_ABSENT_SCANNER_VALUE', 'media_scanner'],
    ['NUXT_PAGE_EDITOR_AI_PROVIDER', 'unknown', 'ai_switches'],
    ['NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED', 'false', 'content_scheduler'],
    ['NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER', 'short', 'site_forms'],
    ['DISCOVERYSTACK_MANAGED_SITE_VAULT_JSON', '{}', 'vault'],
    ['DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON', '{malformed', 'credentials'],
    ['DISCOVERYSTACK_MANAGED_SITE_INTERNAL_BROKER_JSON', '{}', 'broker'],
    ['DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', 'https://api.stripe.com', 'provider_origins'],
    ['DISCOVERYSTACK_PAYMENT_WEBHOOK_CREDENTIAL_REF', 'envref:absent-fixture', 'webhook'],
    ['MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON', '{"com":{"currency":"USD","maxAmountMinor":0}}', 'domain_budget'],
    ['MANAGED_SITE_FUNNEL_DAILY_BUILD_LIMIT', '0', 'build_limit'],
  ])('flags an invalid %s setting without returning its value', (setting, value, id) => {
    const env = { ...environment(), [setting]: value }
    const result = getDiscoveryStackSetupReadiness({ env, providers: providers(true) })
    expect(check(result, id).status).toBe('invalid')
    expect(result.configurationReady).toBe(false)
  })
  it('detects a broker reference missing from a valid registry', () => {
    const env = environment()
    env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ 'envref:stripe-webhook': 'synthetic-webhook' })
    expect(check(getDiscoveryStackSetupReadiness({ env }), 'broker').status).toBe('invalid')
  })
})
