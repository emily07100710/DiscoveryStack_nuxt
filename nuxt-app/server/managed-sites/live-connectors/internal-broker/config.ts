const MAX_CONFIG_BYTES = 16 * 1024
const REFERENCE = /^(?:vault|secret-ref|kms|envref):[A-Za-z0-9][A-Za-z0-9._:/-]{2,154}$/u
const ACCOUNT_ID = /^[a-f0-9]{32}$/u
const PROJECT_PREFIX = /^[a-z0-9][a-z0-9-]{0,15}$/u

export type ManagedSiteInternalBrokerConfiguration = {
  deploymentCredentialReference: string
  dnsTlsCredentialReference: string
  cloudflare: { accountId: string; apiTokenReference: string; projectPrefix: string }
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
}

export function parseManagedSiteInternalBrokerConfiguration(raw = process.env.DISCOVERYSTACK_MANAGED_SITE_INTERNAL_BROKER_JSON): ManagedSiteInternalBrokerConfiguration | null {
  if (typeof raw !== 'string' || raw.length < 2 || Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!plain(parsed) || Object.keys(parsed).length !== 3 || !['deploymentCredentialReference', 'dnsTlsCredentialReference', 'cloudflare'].every(key => Object.hasOwn(parsed, key)) || !plain(parsed.cloudflare)) return null
  const cloudflare = parsed.cloudflare
  if (Object.keys(cloudflare).some(key => !['accountId', 'apiTokenReference', 'projectPrefix'].includes(key)) || !REFERENCE.test(String(parsed.deploymentCredentialReference || '')) || !REFERENCE.test(String(parsed.dnsTlsCredentialReference || '')) || !ACCOUNT_ID.test(String(cloudflare.accountId || '')) || !REFERENCE.test(String(cloudflare.apiTokenReference || ''))) return null
  const projectPrefix = cloudflare.projectPrefix === undefined ? 'ds' : String(cloudflare.projectPrefix)
  if (!PROJECT_PREFIX.test(projectPrefix)) return null
  return { deploymentCredentialReference: String(parsed.deploymentCredentialReference), dnsTlsCredentialReference: String(parsed.dnsTlsCredentialReference), cloudflare: { accountId: String(cloudflare.accountId), apiTokenReference: String(cloudflare.apiTokenReference), projectPrefix } }
}
