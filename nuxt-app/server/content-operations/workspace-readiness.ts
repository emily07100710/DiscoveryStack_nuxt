import { normalizeCredentialReference, normalizeGa4PropertyId, normalizePageScope, normalizeSearchConsoleProperty } from '../measurement-collection/normalization'
import type { MeasurementConnectionRow } from '../measurement-collection/types'

export type OutcomeReadinessConnection = Pick<MeasurementConnectionRow, 'ownerUserId' | 'clientId' | 'publicationTargetId' | 'source' | 'status' | 'canonicalOrigin' | 'allowedPageScope' | 'credentialReference' | 'googleSearchConsoleProperty' | 'ga4PropertyId'>
export type OutcomeCollectionReadiness = { configured: boolean; status: 'configured' | 'not_configured' | 'unverified'; configuredConnectionCount: number }
export type ContentWorkspaceReadinessDependencies = {
  listMeasurementConnections?: (ownerUserId: number) => Promise<readonly OutcomeReadinessConnection[]>
  googleCredentialsConfigured?: boolean
}
type Scope = {
  clients: readonly { id: number; status: string; canonicalSiteOrigin: string }[]
  targets: readonly { id: number; clientId: number; status: string; targetOrigin: string }[]
}

/** Configuration projection only. It does not exchange credentials or call a provider. */
export function projectOutcomeCollectionReadiness(ownerUserId: number, connections: readonly OutcomeReadinessConnection[], scope: Scope, googleCredentialsConfigured: boolean): OutcomeCollectionReadiness {
  let configuredConnectionCount = 0
  for (const connection of connections) {
    if (connection.ownerUserId !== ownerUserId || connection.status !== 'configured' || !googleCredentialsConfigured || !normalizeCredentialReference(connection.credentialReference)) continue
    const client = scope.clients.find(candidate => candidate.id === connection.clientId && candidate.status === 'active')
    if (!client) continue
    const target = connection.publicationTargetId === null ? null : scope.targets.find(candidate => candidate.id === connection.publicationTargetId && candidate.clientId === client.id && candidate.status === 'active')
    if (connection.publicationTargetId !== null && !target) continue
    // A publication transport origin can be a provider API (for example api.github.com).
    // Collection is scoped to the customer's canonical website, never that transport.
    const expectedOrigin = client.canonicalSiteOrigin
    if (connection.canonicalOrigin !== expectedOrigin || !normalizePageScope(connection.allowedPageScope, expectedOrigin)) continue
    const searchProperty = normalizeSearchConsoleProperty(connection.googleSearchConsoleProperty, expectedOrigin)
    const domain = searchProperty?.startsWith('sc-domain:') ? searchProperty.slice('sc-domain:'.length) : null
    const host = new URL(expectedOrigin).hostname
    const validSource = connection.source === 'google_search_console' ? Boolean(searchProperty && (!domain || host === domain || host.endsWith(`.${domain}`)))
      : connection.source === 'first_party_analytics' && Boolean(normalizeGa4PropertyId(connection.ga4PropertyId))
    if (validSource) configuredConnectionCount++
  }
  return { configured: configuredConnectionCount > 0, status: configuredConnectionCount > 0 ? 'configured' : 'not_configured', configuredConnectionCount }
}

export async function getOutcomeCollectionReadiness(ownerUserId: number, scope: Scope, customRepository: boolean, dependencies: ContentWorkspaceReadinessDependencies = {}): Promise<OutcomeCollectionReadiness> {
  try {
    // An injected content repository must not silently invoke the production measurement DB.
    if (customRepository && !dependencies.listMeasurementConnections) return { configured: false, status: 'unverified', configuredConnectionCount: 0 }
    const listConnections = dependencies.listMeasurementConnections || (customRepository ? null : (await import('../measurement-collection/repository')).createMeasurementCollectionRepository().listConnections)
    const connections = listConnections ? await listConnections(ownerUserId) : []
    const googleConfigured = dependencies.googleCredentialsConfigured ?? (customRepository ? false : (await import('../measurement-collection/credentials')).isGoogleServiceAccountConfigured())
    return projectOutcomeCollectionReadiness(ownerUserId, connections, scope, googleConfigured)
  } catch {
    // Optional measurement state must not make the existing content workspace unavailable.
    return { configured: false, status: 'unverified', configuredConnectionCount: 0 }
  }
}
