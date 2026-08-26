import type { GoogleReadOnlyCredentialResolver } from './types'

/** V1 deliberately has no OAuth implementation; deployment injects a resolver at the integration boundary. */
export const unavailableGoogleCredentialResolver: GoogleReadOnlyCredentialResolver = async () => null

export type MeasurementCredentialDependencies = {
  googleCredentialResolver?: GoogleReadOnlyCredentialResolver
}

export function resolveCredentialDependencies(dependencies?: MeasurementCredentialDependencies): Required<MeasurementCredentialDependencies> {
  return { googleCredentialResolver: dependencies?.googleCredentialResolver || unavailableGoogleCredentialResolver }
}
