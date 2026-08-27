import { createError } from 'h3'
import { assertPublicHttpsUrl } from '../../content-operations/normalization'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import type { ManagedSiteCredentialResolver, ManagedSiteDeploymentAdapter, ManagedSiteDeploymentReceipt } from './types'

const RECEIPT_KEYS = new Set(['providerKey', 'providerEventId', 'providerDeploymentId', 'projectId', 'versionId', 'contentHash', 'canonicalDomain', 'deploymentUrl', 'status', 'exactResponseIdentity'])

function boundedReceipt(value: unknown): ManagedSiteDeploymentReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== RECEIPT_KEYS.size || Object.keys(value).some(key => !RECEIPT_KEYS.has(key))) throw createError({ statusCode: 502, statusMessage: 'Deployment provider returned a malformed receipt.' })
  return value as ManagedSiteDeploymentReceipt
}

/** Explicit production transport boundary. It sends only vault references and immutable identities, never source bytes or credentials in payloads. */
export function createSignedManagedSiteDeploymentAdapter(options: { endpointOrigin: string; providerKey: string; credentialReference: string; resolveCredential: ManagedSiteCredentialResolver; fetchImpl?: typeof fetch }): ManagedSiteDeploymentAdapter {
  const origin = assertPublicHttpsUrl(options.endpointOrigin, 'Managed deployment endpoint').replace(/\/$/u, '')
  if (!isOpaqueReference(options.providerKey, 96) || !isOpaqueReference(options.credentialReference, 160)) throw createError({ statusCode: 503, statusMessage: 'Managed deployment transport configuration is invalid.' })
  const fetchImpl = options.fetchImpl || fetch
  const execute = async (operation: 'preview' | 'production' | 'rollback', payload: Record<string, unknown>, timeoutMs: number): Promise<ManagedSiteDeploymentReceipt> => {
    const credential = await options.resolveCredential(options.credentialReference)
    if (!credential.ok) throw createError({ statusCode: 503, statusMessage: 'Managed deployment credential reference could not be resolved.' })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(`${origin}/v1/managed-sites/${operation}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.value}` }, body: JSON.stringify({ schemaVersion: 'discoverystack-managed-deployment-command-v1', providerKey: options.providerKey, operation, ...payload }) })
    } catch {
      throw Object.assign(new Error('deployment transport failed'), { code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_FAILURE', retryable: true })
    } finally { clearTimeout(timer) }
    if (!response.ok) throw Object.assign(new Error('deployment provider rejected command'), { code: response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UPSTREAM_FAILURE' : 'PROVIDER_REJECTED', retryable: response.status === 429 || response.status >= 500 })
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > 64_000) throw createError({ statusCode: 502, statusMessage: 'Deployment provider receipt exceeded the fixed response limit.' })
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw createError({ statusCode: 502, statusMessage: 'Deployment provider returned invalid JSON.' }) }
    return boundedReceipt(parsed)
  }
  return {
    async buildPreview(input) { return execute('preview', input as unknown as Record<string, unknown>, input.timeoutMs) },
    async deployProduction(input) { return execute('production', input as unknown as Record<string, unknown>, input.timeoutMs) },
    async rollback(input) { return execute('rollback', input as unknown as Record<string, unknown>, input.timeoutMs) },
  }
}
