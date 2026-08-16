import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const VAULT_VERSION = 'v1'
const IV_BYTES = 12

function masterKey(masterSecret: string) {
  if (!masterSecret || masterSecret.length < 16) throw createError({ statusCode: 503, statusMessage: 'Provider vault is not configured. Set a strong server session secret first.' })
  return createHash('sha256').update(`discoverystack-provider-vault:${masterSecret}`).digest()
}

function encode(value: Buffer) { return value.toString('base64url') }
function decode(value: string) { return Buffer.from(value, 'base64url') }

export function encryptProviderSecret(value: string, masterSecret: string) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', masterKey(masterSecret), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VAULT_VERSION, encode(iv), encode(tag), encode(encrypted)].join('.')
}

export function decryptProviderSecret(payload: string | null | undefined, masterSecret: string) {
  if (!payload) return null
  const [version, iv, tag, encrypted] = payload.split('.')
  if (version !== VAULT_VERSION || !iv || !tag || !encrypted) throw createError({ statusCode: 503, statusMessage: 'Stored provider credential cannot be decrypted.' })
  const decipher = createDecipheriv('aes-256-gcm', masterKey(masterSecret), decode(iv))
  decipher.setAuthTag(decode(tag))
  return Buffer.concat([decipher.update(decode(encrypted)), decipher.final()]).toString('utf8')
}

export function runtimeProviderMasterSecret() {
  const runtime = useRuntimeConfig()
  return String(runtime.sessionSecret || '')
}

export function redactProviderSecret(value: string | null | undefined) {
  if (!value) return { configured: false, last4: null }
  return { configured: true, last4: value.slice(-4) }
}
