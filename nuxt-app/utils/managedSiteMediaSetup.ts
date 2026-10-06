export type ManagedSiteMediaStorageForm = {
  credentialReference: string
  bucket: string
  region: string
  prefix: string
  endpoint: string
  publicCdnOrigin: string
}

export type ManagedSiteMediaHealthProjection = {
  status: string
  health: { ready: boolean; mode: string; reason?: string }
  scannerHealth: { ready: boolean; mode: string; reason?: string }
}

export type ManagedSiteMediaSetupStatus = {
  configuration: 'not_checked' | 'configured'
  storage: 'not_checked' | 'verified' | 'blocked'
  scanner: 'not_checked' | 'verified' | 'quarantined'
}

function fixedHttpsOrigin(value: string): boolean {
  if (!value) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
  } catch { return false }
}

/** Builds the redacted control-plane request. Credential values are intentionally not part of this type. */
export function buildManagedSiteMediaStorageRequest(form: ManagedSiteMediaStorageForm):
  | { ok: true; credentialReference: string; configuration: { bucket: string; region: string; prefix: string; endpoint?: string; publicCdnOrigin?: string } }
  | { ok: false; message: string } {
  const credentialReference = form.credentialReference.trim()
  const bucket = form.bucket.trim()
  const region = form.region.trim()
  const prefix = form.prefix.trim().replace(/\/+$/u, '')
  const endpoint = form.endpoint.trim()
  const publicCdnOrigin = form.publicCdnOrigin.trim()
  if (!/^[A-Z][A-Z0-9_]{7,159}$/u.test(credentialReference)) return { ok: false, message: 'Credential reference 必須是伺服器上的大寫環境變數名稱，不能貼入 access key。' }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) return { ok: false, message: 'Bucket 名稱格式不正確。' }
  if (!/^[a-z0-9-]{3,32}$/u.test(region)) return { ok: false, message: 'Region 格式不正確。' }
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/u.test(prefix) || prefix.includes('..')) return { ok: false, message: 'Object prefix 格式不正確。' }
  if (!fixedHttpsOrigin(endpoint) || !fixedHttpsOrigin(publicCdnOrigin)) return { ok: false, message: 'Endpoint 與 CDN origin 必須是沒有 path、query 或帳密的固定 HTTPS origin。' }
  return {
    ok: true,
    credentialReference,
    configuration: { bucket, region, prefix, ...(endpoint ? { endpoint } : {}), ...(publicCdnOrigin ? { publicCdnOrigin } : {}) },
  }
}

export function projectManagedSiteMediaSetupStatus(configured: boolean, verification: ManagedSiteMediaHealthProjection | null): ManagedSiteMediaSetupStatus {
  return {
    configuration: configured ? 'configured' : 'not_checked',
    storage: verification ? verification.health.ready && verification.status === 'verified' ? 'verified' : 'blocked' : 'not_checked',
    scanner: verification ? verification.scannerHealth.ready ? 'verified' : 'quarantined' : 'not_checked',
  }
}
