import type { SiteLearningCollectionProof } from '../content-operations/site-learning'

const KEYS = ['contractVersion', 'grantFingerprint', 'confirmationFingerprint', 'authorizationId', 'authorizationFingerprint', 'sourceFingerprint', 'grantedAt', 'approvedAt', 'expiresAt', 'retentionDays', 'consentVersion'] as const
const HASH = /^[a-f0-9]{64}$/u
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

/** Only preserves an exact, bounded proof issued by the server-owned consent resolver. */
export function normalizeSiteLearningCollectionProof(value: unknown): SiteLearningCollectionProof | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== KEYS.length || keys.some(key => typeof key !== 'string' || !KEYS.includes(key as typeof KEYS[number]))) return null
    const row: Record<string, unknown> = Object.create(null)
    for (const key of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return null
      row[key] = descriptor.value
    }
    if (row.contractVersion !== 'site-learning-collection-proof-v1'
      || !['grantFingerprint', 'confirmationFingerprint', 'authorizationFingerprint', 'sourceFingerprint'].every(key => typeof row[key] === 'string' && HASH.test(row[key] as string))
      || !Number.isSafeInteger(row.authorizationId) || Number(row.authorizationId) < 1
      || !iso(row.grantedAt) || !iso(row.approvedAt) || !iso(row.expiresAt)
      || Date.parse(row.approvedAt) > Date.parse(row.grantedAt) || Date.parse(row.grantedAt) >= Date.parse(row.expiresAt)
      || !Number.isSafeInteger(row.retentionDays) || Number(row.retentionDays) < 1 || Number(row.retentionDays) > 30
      || typeof row.consentVersion !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/u.test(row.consentVersion)) return null
    return row as SiteLearningCollectionProof
  } catch { return null }
}

export function sameSiteLearningCollectionProof(left: unknown, right: unknown): boolean {
  const a = normalizeSiteLearningCollectionProof(left), b = normalizeSiteLearningCollectionProof(right)
  return Boolean(a && b && KEYS.every(key => a[key] === b[key]))
}

export function siteLearningCaptureAllowed(proof: SiteLearningCollectionProof, capturedAt: unknown, confirmationFingerprint: string, now: Date): boolean {
  if (!iso(capturedAt) || !Number.isFinite(now.getTime()) || proof.confirmationFingerprint !== confirmationFingerprint) return false
  const captured = Date.parse(capturedAt), at = now.getTime()
  return captured >= Date.parse(proof.grantedAt) && captured >= Date.parse(proof.approvedAt) && captured < Date.parse(proof.expiresAt)
    && captured <= at && at < Date.parse(proof.expiresAt) && at - captured <= proof.retentionDays * 86_400_000
}

export function snapshotSiteLearningProof(value: unknown): SiteLearningCollectionProof | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, 'siteLearningCollectionProof')
    return descriptor && 'value' in descriptor ? normalizeSiteLearningCollectionProof(descriptor.value) : null
  } catch { return null }
}
