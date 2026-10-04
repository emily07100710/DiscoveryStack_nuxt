import { describe, expect, it, vi } from 'vitest'
import { getOutcomeCollectionReadiness, projectOutcomeCollectionReadiness, type OutcomeReadinessConnection } from '../server/content-operations/workspace-readiness'

const scope = { clients: [{ id: 10, status: 'active', canonicalSiteOrigin: 'https://site.customer-domain.com' }], targets: [{ id: 20, clientId: 10, status: 'active', targetOrigin: 'https://site.customer-domain.com' }] }
function connection(patch: Partial<OutcomeReadinessConnection> = {}): OutcomeReadinessConnection {
  return { ownerUserId: 1, clientId: 10, publicationTargetId: 20, source: 'first_party_analytics', status: 'configured', canonicalOrigin: 'https://site.customer-domain.com', allowedPageScope: ['https://site.customer-domain.com/page'], credentialReference: 'envref:google-service-account', googleSearchConsoleProperty: null, ga4PropertyId: '12345', ...patch }
}

describe('owner-scoped automatic outcome collection readiness', () => {
  it('does not substitute persistence capability for configured automatic collection', () => {
    expect(projectOutcomeCollectionReadiness(1, [], scope, true)).toEqual({ configured: false, status: 'not_configured', configuredConnectionCount: 0 })
    expect(projectOutcomeCollectionReadiness(1, [connection()], scope, false).configured).toBe(false)
    expect(projectOutcomeCollectionReadiness(1, [connection()], scope, true)).toEqual({ configured: true, status: 'configured', configuredConnectionCount: 1 })
  })

  it.each([
    { ownerUserId: 2 }, { clientId: 11 }, { status: 'paused' }, { status: 'revoked' }, { status: 'needs_reauthorization' },
    { publicationTargetId: 21 }, { credentialReference: null }, { credentialReference: 'sk-test-secret' }, { ga4PropertyId: 'not-a-property' },
    { canonicalOrigin: 'https://foreign.example' }, { allowedPageScope: ['https://foreign.example/page'] }, { allowedPageScope: ['https://site.customer-domain.com/page?token=secret'] },
    { source: 'llm_visibility' },
  ] satisfies Partial<OutcomeReadinessConnection>[])('rejects an unready or out-of-scope connection (%j)', patch => {
    expect(projectOutcomeCollectionReadiness(1, [connection(patch)], scope, true).configured).toBe(false)
  })

  it('accepts correctly scoped Search Console properties and rejects another domain', () => {
    expect(projectOutcomeCollectionReadiness(1, [connection({ source: 'google_search_console', googleSearchConsoleProperty: 'sc-domain:customer-domain.com', ga4PropertyId: null })], scope, true).configured).toBe(true)
    expect(projectOutcomeCollectionReadiness(1, [connection({ source: 'google_search_console', googleSearchConsoleProperty: 'sc-domain:evil.example', ga4PropertyId: null })], scope, true).configured).toBe(false)
  })

  it('does not treat paused clients or targets as ready; supports a valid client-level connection', () => {
    expect(projectOutcomeCollectionReadiness(1, [connection()], { ...scope, clients: [{ ...scope.clients[0]!, status: 'paused' }] }, true).configured).toBe(false)
    expect(projectOutcomeCollectionReadiness(1, [connection()], { ...scope, targets: [{ ...scope.targets[0]!, status: 'paused' }] }, true).configured).toBe(false)
    expect(projectOutcomeCollectionReadiness(1, [connection({ publicationTargetId: null })], scope, true).configured).toBe(true)
  })

  it('binds a target-specific connection to the customer website rather than the publication API', () => {
    const gitScope = { ...scope, targets: [{ ...scope.targets[0]!, targetOrigin: 'https://api.github.com' }] }
    expect(projectOutcomeCollectionReadiness(1, [connection()], gitScope, true).configured).toBe(true)
    expect(projectOutcomeCollectionReadiness(1, [connection({ canonicalOrigin: 'https://api.github.com', allowedPageScope: ['https://api.github.com/repos/customer/site'] })], gitScope, true).configured).toBe(false)
  })

  it('does not call a production DB for a custom content repository without a measurement dependency', async () => {
    expect(await getOutcomeCollectionReadiness(1, scope, true)).toEqual({ configured: false, status: 'unverified', configuredConnectionCount: 0 })
  })

  it('uses the exact owner in the injected read-only lookup, without credentials or provider calls', async () => {
    const lookup = vi.fn(async () => [connection()])
    expect(await getOutcomeCollectionReadiness(1, scope, true, { listMeasurementConnections: lookup, googleCredentialsConfigured: true })).toMatchObject({ configured: true, configuredConnectionCount: 1 })
    expect(lookup).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledWith(1)
  })

  it('fails closed with an unverified state and never returns a database error', async () => {
    const result = await getOutcomeCollectionReadiness(1, scope, true, { listMeasurementConnections: async () => { throw new Error('synthetic-secret-database-url') } })
    expect(result).toEqual({ configured: false, status: 'unverified', configuredConnectionCount: 0 })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
})
