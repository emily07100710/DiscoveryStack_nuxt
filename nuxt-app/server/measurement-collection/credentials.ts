import { createHash } from 'node:crypto'
import { SignJWT, importPKCS8 } from 'jose'
import type { FetchLike, GoogleReadOnlyCredentialResolver } from './types'

const MAX_SERVICE_ACCOUNT_BYTES = 32 * 1024
const MAX_CACHE_ENTRIES = 8
const CACHE_EARLY_REFRESH_MS = 60_000
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const CLIENT_EMAIL = /^[^\s@]{1,200}@[^\s@]{1,120}\.[^\s@]{1,40}$/u
const PRIVATE_KEY_ID = /^[A-Za-z0-9]{1,64}$/u

type GoogleServiceAccount = {
  clientEmail: string
  privateKey: string
  privateKeyId: string | null
}

type CachedGoogleCredential = {
  accessToken: string
  expiresAtMs: number
  grantedScopes: string[]
}

export type GoogleServiceAccountResolverOptions = {
  fetcher?: FetchLike
  now?: () => Date
  serviceAccountJson?: string
}

function hasPlainObjectPrototype(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ambientServiceAccountJson(): string {
  // Nitro's applyEnv runs destr() over every NUXT_-prefixed runtimeConfig override, so a
  // service account JSON arrives here already parsed into an object rather than the raw
  // string this module validates. Re-serialize that shape instead of stringifying it into
  // "[object Object]", keeping parseGoogleServiceAccount as the single validation path.
  let raw: unknown
  try { raw = useRuntimeConfig().googleServiceAccountJson } catch { raw = undefined }
  if (raw === undefined || raw === null || raw === '') raw = process.env.NUXT_GOOGLE_SERVICE_ACCOUNT_JSON
  if (typeof raw === 'string') return raw
  if (!hasPlainObjectPrototype(raw)) return ''
  try { return JSON.stringify(raw) } catch { return '' }
}

function parseGoogleServiceAccount(raw: string | undefined): GoogleServiceAccount | null {
  if (typeof raw !== 'string' || raw.length < 1 || Buffer.byteLength(raw, 'utf8') > MAX_SERVICE_ACCOUNT_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!hasPlainObjectPrototype(parsed)) return null
  if (parsed.type !== 'service_account') return null
  if (typeof parsed.client_email !== 'string' || CONTROL_CHARACTERS.test(parsed.client_email) || !CLIENT_EMAIL.test(parsed.client_email)) return null
  if (typeof parsed.private_key !== 'string' || parsed.private_key.length < 1 || parsed.private_key.length > 16_384 || !parsed.private_key.includes('-----BEGIN PRIVATE KEY-----') || !parsed.private_key.includes('-----END PRIVATE KEY-----')) return null
  const hasPrivateKeyId = Object.prototype.hasOwnProperty.call(parsed, 'private_key_id')
  if (hasPrivateKeyId && (typeof parsed.private_key_id !== 'string' || !PRIVATE_KEY_ID.test(parsed.private_key_id))) return null
  const hasTokenUri = Object.prototype.hasOwnProperty.call(parsed, 'token_uri')
  if (hasTokenUri && parsed.token_uri !== TOKEN_ENDPOINT) return null
  return { clientEmail: parsed.client_email, privateKey: parsed.private_key, privateKeyId: hasPrivateKeyId ? parsed.private_key_id as string : null }
}

function normalizedScopes(requiredScopes: readonly string[]): string[] {
  return [...new Set(requiredScopes.filter(scope => typeof scope === 'string' && scope.length > 0))].sort()
}

/** Kept for callers that explicitly disable Google credential resolution. */
export const unavailableGoogleCredentialResolver: GoogleReadOnlyCredentialResolver = async () => null

export function createGoogleServiceAccountCredentialResolver(options: GoogleServiceAccountResolverOptions = {}): GoogleReadOnlyCredentialResolver {
  const cache = new Map<string, CachedGoogleCredential>()
  const inFlight = new Map<string, Promise<CachedGoogleCredential | null>>()
  const now = options.now || (() => new Date())

  return async (_ownerUserId, _credentialReference, requiredScopes) => {
    try {
      // A deployment-level service account serves every connection reference.
      const serviceAccount = parseGoogleServiceAccount(options.serviceAccountJson === undefined ? ambientServiceAccountJson() : options.serviceAccountJson)
      const scopes = normalizedScopes(requiredScopes)
      if (!serviceAccount || scopes.length === 0) return null

      const nowMs = now().getTime()
      if (!Number.isFinite(nowMs)) return null
      const keyFingerprint = createHash('sha256').update(serviceAccount.privateKey).digest('hex')
      const key = `${serviceAccount.clientEmail}|${serviceAccount.privateKeyId ?? ''}|${keyFingerprint}|${scopes.join(' ')}`
      const cached = cache.get(key)
      if (cached && cached.expiresAtMs - nowMs > CACHE_EARLY_REFRESH_MS) return { accessToken: cached.accessToken, expiresAt: new Date(cached.expiresAtMs).toISOString(), grantedScopes: [...cached.grantedScopes] }

      let exchange = inFlight.get(key)
      if (!exchange) {
        const created = (async (): Promise<CachedGoogleCredential | null> => {
          try {
            let privateKey: Awaited<ReturnType<typeof importPKCS8>>
            try {
              privateKey = await importPKCS8(serviceAccount.privateKey, 'RS256')
            } catch {
              return null
            }
            const iatSeconds = Math.floor(nowMs / 1000)
            const protectedHeader = serviceAccount.privateKeyId ? { alg: 'RS256', typ: 'JWT', kid: serviceAccount.privateKeyId } : { alg: 'RS256', typ: 'JWT' }
            const assertion = await new SignJWT({ scope: scopes.join(' ') })
              .setProtectedHeader(protectedHeader)
              .setIssuer(serviceAccount.clientEmail)
              .setAudience(TOKEN_ENDPOINT)
              .setIssuedAt(iatSeconds)
              .setExpirationTime(iatSeconds + 3600)
              .sign(privateKey)

            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 10_000)
            let bytes: ArrayBuffer
            try {
              const fetcher = options.fetcher || fetch
              const response = await fetcher(TOKEN_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                redirect: 'error',
                signal: controller.signal,
                body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
              })
              if (!response.ok) return null
              bytes = await response.arrayBuffer()
            } finally {
              clearTimeout(timer)
            }
            if (bytes.byteLength > 64 * 1024) return null
            let body: unknown
            try {
              body = JSON.parse(new TextDecoder().decode(bytes))
            } catch {
              return null
            }
            if (!hasPlainObjectPrototype(body)) return null
            if (typeof body.access_token !== 'string' || body.access_token.length < 1 || body.access_token.length > 4096 || CONTROL_CHARACTERS.test(body.access_token)) return null
            if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) return null

            let grantedScopes: string[]
            if (!Object.prototype.hasOwnProperty.call(body, 'scope')) {
              grantedScopes = scopes
            } else {
              if (typeof body.scope !== 'string') return null
              grantedScopes = body.scope.split(/\s+/u).filter(Boolean)
              const grantedScopeSet = new Set(grantedScopes)
              if (!scopes.every(scope => grantedScopeSet.has(scope))) return null
            }

            const completedAtMs = now().getTime()
            if (!Number.isFinite(completedAtMs)) return null
            const expiresAtMs = completedAtMs + Math.min(3600, body.expires_in) * 1000
            const cachedCredential = { accessToken: body.access_token, expiresAtMs, grantedScopes }
            if (expiresAtMs - completedAtMs > CACHE_EARLY_REFRESH_MS) {
              cache.delete(key)
              cache.set(key, cachedCredential)
              while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string)
            }
            return cachedCredential
          } catch {
            return null
          }
        })()
        let tracked: Promise<CachedGoogleCredential | null>
        tracked = created.finally(() => {
          if (inFlight.get(key) === tracked) inFlight.delete(key)
        })
        inFlight.set(key, tracked)
        exchange = tracked
      }

      const credential = await exchange
      if (!credential) return null
      return { accessToken: credential.accessToken, expiresAt: new Date(credential.expiresAtMs).toISOString(), grantedScopes: [...credential.grantedScopes] }
    } catch {
      return null
    }
  }
}

export const runtimeGoogleServiceAccountCredentialResolver = createGoogleServiceAccountCredentialResolver()

export function isGoogleServiceAccountConfigured(): boolean {
  return parseGoogleServiceAccount(ambientServiceAccountJson()) !== null
}

export function parseGoogleServiceAccountForTests(raw: string | undefined): { ok: true; clientEmail: string; privateKeyId: string | null } | { ok: false } {
  const parsed = parseGoogleServiceAccount(raw)
  return parsed ? { ok: true, clientEmail: parsed.clientEmail, privateKeyId: parsed.privateKeyId } : { ok: false }
}

export type MeasurementCredentialDependencies = {
  googleCredentialResolver?: GoogleReadOnlyCredentialResolver
}

export function resolveCredentialDependencies(dependencies?: MeasurementCredentialDependencies): Required<MeasurementCredentialDependencies> {
  return { googleCredentialResolver: dependencies?.googleCredentialResolver || runtimeGoogleServiceAccountCredentialResolver }
}
