import type { Capability, ExecutorAuthority, Framework, Transport } from './types'

export const CAPABILITY_MATRIX = [
  { framework: 'astro', transport: 'first_party_git', executor: 'first_party_git', authority: 'discoverystack_first_party', projection: 'first_party', requiresPublicHttps: true, requiresServiceReference: false },
  { framework: 'astro', transport: 'first_party_signed_api', executor: 'first_party_signed_api', authority: 'discoverystack_first_party', projection: 'first_party', requiresPublicHttps: true, requiresServiceReference: false },
  { framework: 'nuxt', transport: 'first_party_git', executor: 'first_party_git', authority: 'discoverystack_first_party', projection: 'first_party', requiresPublicHttps: true, requiresServiceReference: false },
  { framework: 'nuxt', transport: 'first_party_signed_api', executor: 'first_party_signed_api', authority: 'discoverystack_first_party', projection: 'first_party', requiresPublicHttps: true, requiresServiceReference: false },
  { framework: 'wordpress', transport: 'wordpress_rest', executor: 'wordpress_rest', authority: 'geoflow_content_engine', projection: 'geoflow', requiresPublicHttps: true, requiresServiceReference: false },
  { framework: 'php_agent', transport: 'geoflow_agent', executor: 'geoflow_agent', authority: 'geoflow_content_engine', projection: 'geoflow', requiresPublicHttps: true, requiresServiceReference: false },
  { framework: 'generic_http', transport: 'generic_http', executor: 'generic_http', authority: 'geoflow_content_engine', projection: 'geoflow', requiresPublicHttps: true, requiresServiceReference: false },
  { framework: 'geoflow_local', transport: 'geoflow_local', executor: 'geoflow_local', authority: 'geoflow_content_engine', projection: 'geoflow', requiresPublicHttps: false, requiresServiceReference: true },
  { framework: 'static_site', transport: 'geoflow_agent', executor: 'geoflow_agent', authority: 'geoflow_content_engine', projection: 'geoflow', requiresPublicHttps: true, requiresServiceReference: false },
] as const satisfies readonly Capability[]

export const FRAMEWORKS: readonly Framework[] = ['astro', 'nuxt', 'wordpress', 'php_agent', 'generic_http', 'geoflow_local', 'static_site']
export const TRANSPORTS: readonly Transport[] = ['first_party_git', 'first_party_signed_api', 'wordpress_rest', 'geoflow_agent', 'generic_http', 'geoflow_local']
export const EXECUTOR_AUTHORITIES: readonly ExecutorAuthority[] = ['discoverystack_first_party', 'geoflow_content_engine']

export const MIN_TARGETS = 1
export const MAX_TARGETS = 20
export const MIN_ID_LENGTH = 1
export const MAX_ID_LENGTH = 160
export const MAX_LABEL_LENGTH = 160
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200
export const MAX_OPAQUE_REFERENCE_LENGTH = 200
export const MAX_URL_LENGTH = 2048
export const MAX_EVENT_DETAIL_LENGTH = 1000
export const MAX_CONTENT_BYTES = 200_000
export const MAX_ATTEMPTS = 10
export const DEFAULT_MAXIMUM_ATTEMPTS = 3
export const HTTPS_PORT = '443'

export const IANA_SPECIAL_USE_LABELS = new Set([
  'alt',
  'arpa',
  'example',
  'example.com',
  'example.net',
  'example.org',
  'invalid',
  'local',
  'localhost',
  'onion',
  'test',
  'home.arpa',
  'resolver.arpa',
  'internal',
  'lan',
])

export const SENSITIVE_QUERY_TERMS = new Set([
  'access_token',
  'apikey',
  'api_key',
  'authorization',
  'client_secret',
  'credential',
  'credentials',
  'key',
  'password',
  'passwd',
  'private_key',
  'secret',
  'signature',
  'sig',
  'token',
])

export const OPAQUE_REFERENCE_PATTERN = /^ref-[A-Za-z0-9][A-Za-z0-9._:-]{0,195}$/
export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const REFERENCE_SECRET_PATTERN = /(?:token|credential|secret|password|api[_-]?key|authorization|bearer|private[_-]?key|ref-(?:sk[-_]|gh[pousr]_|github_pat_|akia|asia|aiza|ya29[.]|eyj))/i
