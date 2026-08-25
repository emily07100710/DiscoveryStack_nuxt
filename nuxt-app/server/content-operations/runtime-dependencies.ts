import { randomBytes } from 'node:crypto'
import type { FirstPartyFetch, NonceProvider, ServerCredentialResolver } from '../first-party-publishing/types'
import { createBoundedFetch } from './bounded-fetch'
import { isRuntimeCredentialResolverAvailable, resolveServerCredential } from './credential-resolver'

export type ContentOperationsRuntimeDependencies = {
  fetchImpl: FirstPartyFetch
  serverCredentialResolver: ServerCredentialResolver
  nonceProvider: NonceProvider
}

export function createSecureFirstPartyNonce(): string {
  return randomBytes(24).toString('base64url')
}

export function getContentOperationsRuntimeDependencies(): ContentOperationsRuntimeDependencies {
  return {
    fetchImpl: createBoundedFetch(),
    serverCredentialResolver: resolveServerCredential,
    nonceProvider: createSecureFirstPartyNonce,
  }
}

export function runtimeCredentialResolverAvailable(): boolean {
  return isRuntimeCredentialResolverAvailable()
}
