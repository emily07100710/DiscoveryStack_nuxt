import { fingerprint, SystemFactoryError } from './canonical'

export type SystemFactoryRuntimeAuthority = {
  schemaVersion: 'system-factory-runtime-authority-v1'
  frappeSourceCommit: string
  erpnextSourceCommit: string
  customAppContentSha256: string
  imageManifestDigest: string | null
  imageConfigDigest: string | null
  buildRecipeFingerprint: string
  productionApproved: boolean
  authorityFingerprint: string
}

export const REVIEWED_SOURCE_AUTHORITY = {
  frappeSourceCommit: '5cba016e86b54b57f34a3864282b92300ef20fb0',
  erpnextSourceCommit: 'b24c9eba551905e256e336ff170a91a92d197a2f',
} as const

export function createRuntimeAuthority(input: Omit<SystemFactoryRuntimeAuthority, 'schemaVersion' | 'authorityFingerprint'>): SystemFactoryRuntimeAuthority {
  for (const [label, value] of Object.entries({ frappeSourceCommit: input.frappeSourceCommit, erpnextSourceCommit: input.erpnextSourceCommit })) if (!/^[a-f0-9]{40}$/u.test(value)) throw new SystemFactoryError('RUNTIME_AUTHORITY', `${label} is invalid.`, 503)
  for (const [label, value] of Object.entries({ customAppContentSha256: input.customAppContentSha256, buildRecipeFingerprint: input.buildRecipeFingerprint })) if (!/^[a-f0-9]{64}$/u.test(value)) throw new SystemFactoryError('RUNTIME_AUTHORITY', `${label} is invalid.`, 503)
  for (const digest of [input.imageManifestDigest, input.imageConfigDigest]) if (digest !== null && !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new SystemFactoryError('RUNTIME_AUTHORITY', 'Runtime image digest is invalid.', 503)
  if (input.productionApproved && !input.imageManifestDigest) throw new SystemFactoryError('RUNTIME_AUTHORITY', 'Production authority requires an immutable image manifest digest.', 503)
  const draft = { schemaVersion: 'system-factory-runtime-authority-v1' as const, ...input }
  return { ...draft, authorityFingerprint: fingerprint(draft) }
}

export function assertLiveRuntimeAuthority(authority: SystemFactoryRuntimeAuthority, expectedFingerprint?: string): void {
  const rebuilt = createRuntimeAuthority({ frappeSourceCommit: authority.frappeSourceCommit, erpnextSourceCommit: authority.erpnextSourceCommit, customAppContentSha256: authority.customAppContentSha256, imageManifestDigest: authority.imageManifestDigest, imageConfigDigest: authority.imageConfigDigest, buildRecipeFingerprint: authority.buildRecipeFingerprint, productionApproved: authority.productionApproved })
  if (rebuilt.authorityFingerprint !== authority.authorityFingerprint || (expectedFingerprint && authority.authorityFingerprint !== expectedFingerprint)) throw new SystemFactoryError('AUTHORITY_DRIFT', 'Runtime authority fingerprint drifted.', 409)
  if (authority.frappeSourceCommit !== REVIEWED_SOURCE_AUTHORITY.frappeSourceCommit || authority.erpnextSourceCommit !== REVIEWED_SOURCE_AUTHORITY.erpnextSourceCommit || !authority.productionApproved || !authority.imageManifestDigest) throw new SystemFactoryError('RUNTIME_AUTHORITY_UNAPPROVED', 'Reviewed immutable production runtime authority is unavailable.', 503)
}

export function testRuntimeAuthority(seed = 'system-factory-test'): SystemFactoryRuntimeAuthority {
  return createRuntimeAuthority({ ...REVIEWED_SOURCE_AUTHORITY, customAppContentSha256: fingerprint({ seed, app: 'discovery_stack' }), imageManifestDigest: `sha256:${fingerprint({ seed, image: 'manifest' })}`, imageConfigDigest: `sha256:${fingerprint({ seed, image: 'config' })}`, buildRecipeFingerprint: fingerprint({ seed, recipe: 'reviewed-fixed-commands' }), productionApproved: true })
}

export function runtimeAuthorityFromEnvironment(): SystemFactoryRuntimeAuthority {
  const optionalDigest = (value: string | undefined) => value && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : null
  return createRuntimeAuthority({
    ...REVIEWED_SOURCE_AUTHORITY,
    customAppContentSha256: process.env.SYSTEM_FACTORY_CUSTOM_APP_SHA256 || fingerprint({ unavailable: 'custom-app-content-sha256' }),
    imageManifestDigest: optionalDigest(process.env.SYSTEM_FACTORY_IMAGE_MANIFEST_DIGEST),
    imageConfigDigest: optionalDigest(process.env.SYSTEM_FACTORY_IMAGE_CONFIG_DIGEST),
    buildRecipeFingerprint: process.env.SYSTEM_FACTORY_BUILD_RECIPE_FINGERPRINT || fingerprint({ unavailable: 'build-recipe-fingerprint' }),
    productionApproved: process.env.SYSTEM_FACTORY_RUNTIME_PRODUCTION_APPROVED === 'true',
  })
}
