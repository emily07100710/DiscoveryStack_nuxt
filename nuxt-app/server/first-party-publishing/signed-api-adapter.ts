import { createHmac } from 'node:crypto'
import { isOpaqueReference, isValidSha256, strictTimestamp } from './normalization'
import { SIGNED_API_ENDPOINT_PATH } from './target-guard'
import { type FirstPartyAdapterInput, type FirstPartyAdapterResult, type FirstPartyDecisionCode, type SignedApiAdapterDependencies, type SignedApiResponsePayload } from './types'
import { validateFirstPartyAdapterBindings } from './adapter-validation'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_TOLERANCE_SECONDS = 300
const NONCE_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/

function blocked(code: FirstPartyDecisionCode, ...reasons: string[]): FirstPartyAdapterResult {
  return { status: 'blocked', code, reasons }
}

function failure(code: FirstPartyDecisionCode, reasons: string[], httpStatus?: number): FirstPartyAdapterResult {
  return { status: 'failure', code, reasons, ...(httpStatus === undefined ? {} : { httpStatus }) }
}

function validStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
}

function canonicalSignatureInput(input: FirstPartyAdapterInput, timestamp: string, nonce: string): string {
  return [
    input.command.commandVersion,
    input.target.targetId,
    input.publication.productionDeliverableId,
    input.command.idempotencyKey,
    input.publication.contentHash,
    input.publication.evidenceSnapshotHash,
    input.artifact.artifactFingerprint,
    timestamp,
    nonce,
  ].join('\n')
}

export function buildSignedApiSignature(input: FirstPartyAdapterInput, secret: string, timestamp: string, nonce: string): string {
  return createHmac('sha256', secret).update(canonicalSignatureInput(input, timestamp, nonce), 'utf8').digest('hex')
}

function statusFailure(status: number): FirstPartyAdapterResult {
  if (status === 401 || status === 403) return failure('REMOTE_UNAUTHORIZED', ['signed API rejected the server credential or policy'], status)
  if (status === 409 || status === 422) return failure('REMOTE_CONFLICT', ['signed API rejected the publication as a conflict'], status)
  if (status === 429) return failure('REMOTE_RATE_LIMITED', ['signed API rate limited the request'], status)
  if (status >= 500 && status <= 599) return failure('REMOTE_SERVER_ERROR', ['signed API returned a server failure'], status)
  if (status >= 400 && status <= 499) return failure('REMOTE_CONFLICT', ['signed API rejected the request'], status)
  if (status >= 300 && status <= 399) return blocked('REDIRECT_BLOCKED', 'signed API redirects are not followed')
  return blocked('RESPONSE_INVALID', 'signed API returned an unexpected status')
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function readJson(response: { text: () => Promise<string> }): Promise<SignedApiResponsePayload | undefined> {
  try {
    const raw = await response.text()
    const parsed: unknown = JSON.parse(raw)
    return readObject(parsed) as SignedApiResponsePayload | undefined
  } catch {
    return undefined
  }
}

export async function executeSignedApiPublish(input: FirstPartyAdapterInput, dependencies: SignedApiAdapterDependencies): Promise<FirstPartyAdapterResult> {
  try {
    const bindings = validateFirstPartyAdapterBindings(input, 'first_party_signed_api')
    if (bindings.status === 'blocked') return bindings
    input = { ...input, target: bindings.target, publication: bindings.publication, artifact: bindings.artifact, command: bindings.command, now: bindings.now, fetchImpl: dependencies.fetchImpl }
    if (!input.target.executionEnabled) return blocked('EXECUTION_DISABLED', 'target execution is disabled')
    if (input.target.transport !== 'first_party_signed_api') return blocked('UNSUPPORTED_ROUTE', 'signed API adapter requires first_party_signed_api')
    if (input.target.endpointPath !== SIGNED_API_ENDPOINT_PATH || input.command.transport !== 'first_party_signed_api') return blocked('UNSUPPORTED_ROUTE', 'signed API endpoint is not the fixed approved path')
    if (!isValidSha256(input.command.idempotencyKey) || !isValidSha256(input.publication.contentHash) || !isValidSha256(input.publication.evidenceSnapshotHash) || !isValidSha256(input.artifact.artifactFingerprint)) return blocked('IDEMPOTENCY_INVALID', 'signed API identity hashes are invalid')
    if (typeof dependencies.fetchImpl !== 'function') return blocked('EXECUTOR_NOT_CONFIGURED', 'fetch implementation is required')
    if (typeof dependencies.serverCredentialResolver !== 'function') return blocked('CREDENTIAL_MISSING', 'server credential resolver is required')
    if (typeof dependencies.nonceProvider !== 'function') return blocked('NONCE_INVALID', 'nonce provider is required')
    const current = strictTimestamp(input.now)
    if (!current.ok) return blocked('INVALID_TIMESTAMP', current.reason)
    const tolerance = dependencies.timestampToleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
    if (!Number.isSafeInteger(tolerance) || tolerance < 1 || tolerance > 3_600) return blocked('INVALID_INPUT', 'timestamp tolerance is outside the bounded policy')
    const resolved = await dependencies.serverCredentialResolver(input.target.credentialReference)
    if (!resolved.ok || typeof resolved.value !== 'string' || resolved.value.length < 1 || resolved.value.length > 1_024) return blocked('CREDENTIAL_MISSING', 'server credential could not be resolved')
    const secret = resolved.value
    const nonce = dependencies.nonceProvider()
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return blocked('NONCE_INVALID', 'nonce is invalid or not opaque')
    const timestamp = current.iso
    const serverNow = strictTimestamp(dependencies.serverNowProvider?.() ?? input.now)
    if (!serverNow.ok) return blocked('INVALID_TIMESTAMP', serverNow.reason)
    if (Math.abs(serverNow.milliseconds - current.milliseconds) > tolerance * 1000) return blocked('INVALID_TIMESTAMP', 'signed request timestamp exceeds the fixed tolerance')
    const signature = buildSignedApiSignature(input, secret, timestamp, nonce)
    const artifactBytes = input.artifact.frontmatter ? `${input.artifact.frontmatter}\n${input.artifact.body}` : input.artifact.body
    const body = JSON.stringify({
      commandVersion: input.command.commandVersion,
      targetId: input.target.targetId,
      publicationId: input.publication.productionDeliverableId,
      idempotencyKey: input.command.idempotencyKey,
      contentHash: input.publication.contentHash,
      evidenceSnapshotHash: input.publication.evidenceSnapshotHash,
      artifactFingerprint: input.artifact.artifactFingerprint,
      path: input.artifact.path,
      framework: input.target.framework,
      content: artifactBytes,
      timestamp,
      nonce,
    })
    const headers = {
      'content-type': 'application/json',
      'x-discoverystack-version': input.command.commandVersion,
      'x-discoverystack-publication-id': input.publication.productionDeliverableId,
      'x-discoverystack-idempotency-key': input.command.idempotencyKey,
      'x-discoverystack-timestamp': timestamp,
      'x-discoverystack-nonce': nonce,
      'x-discoverystack-signature': signature,
    }
    const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return blocked('INVALID_INPUT', 'timeoutMs is outside the bounded policy')
    const url = `${input.target.targetOrigin}${SIGNED_API_ENDPOINT_PATH}`
    const response = await dependencies.fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', timeoutMs })
    if (!validStatus(response.status)) return blocked('RESPONSE_INVALID', 'signed API response status is invalid')
    if (response.status < 200 || response.status > 299) return statusFailure(response.status)
    const payload = await readJson(response)
    if (!payload || payload.publicationId !== input.publication.productionDeliverableId || payload.contentHash !== input.publication.contentHash || !isOpaqueReference(payload.remoteRevision)) return blocked('REMOTE_IDENTITY_COLLISION', 'signed API response identity does not match the approved publication')
    return {
      status: 'ok',
      remoteState: 'updated',
      remote: {
        publicationId: input.publication.productionDeliverableId,
        contentHash: input.publication.contentHash,
        remoteRevision: payload.remoteRevision,
        path: input.artifact.path,
      },
    }
  } catch (error) {
    if (error instanceof Error && /timeout|abort/i.test(error.message)) return failure('TIMEOUT', ['signed API request timed out'])
    return failure('NETWORK_FAILURE', ['signed API request failed before a trusted response was received'])
  }
}
