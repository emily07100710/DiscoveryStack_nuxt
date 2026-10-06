import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ManagedSiteEmailOutboxContext, ManagedSiteEmailMessage } from './types'

const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_SERIALIZED_ENVELOPE_BYTES = 256 * 1024
const MAX_ENCRYPTED_PAYLOAD_CHARS = 350 * 1024
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function privateFingerprint(value: unknown, secret: string): string {
  return createHmac('sha256', fingerprintKeyFromSecret(secret)).update(canonicalJson(value)).digest('hex')
}

function keyFromSecret(secret: string): Buffer {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 4096) throw new Error('invalid encryption configuration')
  const masterKey = createHash('sha256').update(secret, 'utf8').digest()
  return createHmac('sha256', masterKey).update('AES-256-GCM/discoverystack/managed-site-email-outbox/v1', 'utf8').digest()
}

function fingerprintKeyFromSecret(secret: string): Buffer {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 4096) throw new Error('invalid encryption configuration')
  const masterKey = createHash('sha256').update(secret, 'utf8').digest()
  return createHmac('sha256', masterKey).update('HMAC-SHA256/discoverystack/managed-site-email-outbox/fingerprint/v1', 'utf8').digest()
}

export function validateMessage(message: ManagedSiteEmailMessage): void {
  if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(key => !['to', 'subject', 'text', 'replyTo', 'idempotencyKey'].includes(key))) throw new Error('invalid message')
  if (typeof message.to !== 'string' || message.to.length > 320 || !ADDRESS.test(message.to) || CONTROL.test(message.to)) throw new Error('invalid message')
  if (typeof message.subject !== 'string' || !message.subject.trim() || message.subject !== message.subject.trim() || Buffer.byteLength(message.subject, 'utf8') > 200 || CONTROL.test(message.subject)) throw new Error('invalid message')
  if (typeof message.text !== 'string' || !message.text || Buffer.byteLength(message.text, 'utf8') > MAX_MESSAGE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message.text)) throw new Error('invalid message')
  if (message.replyTo !== undefined && (typeof message.replyTo !== 'string' || message.replyTo.length > 320 || !ADDRESS.test(message.replyTo) || CONTROL.test(message.replyTo))) throw new Error('invalid message')
  if (typeof message.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/u.test(message.idempotencyKey)) throw new Error('invalid message')
}

export function validateContext(context: ManagedSiteEmailOutboxContext): void {
  if (!context || typeof context !== 'object' || !(context.expiresAt instanceof Date) || !Number.isFinite(context.expiresAt.getTime())) throw new Error('invalid context')
  const exactKeys = (value: object, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
  if (!exactKeys(context, ['purpose', 'ownerUserId', 'projectId', 'authority', 'expiresAt'])) throw new Error('invalid context')
  const id = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value)
  if (context.purpose === 'inbox_verification') {
    if (context.ownerUserId !== null || (context.projectId !== null && !id(context.projectId)) || !exactKeys(context.authority, ['funnelSessionId', 'bindingId', 'codeHash']) || !id(context.authority.funnelSessionId) || !id(context.authority.bindingId) || !hash(context.authority.codeHash)) throw new Error('invalid context')
  } else if (context.purpose === 'customer_reaccess') {
    if (!Number.isSafeInteger(context.ownerUserId) || context.ownerUserId <= 0 || context.projectId !== null || !exactKeys(context.authority, ['bindings']) || !Array.isArray(context.authority.bindings) || context.authority.bindings.length < 1 || context.authority.bindings.length > 10) throw new Error('invalid context')
    const seen = new Set<number>()
    for (const binding of context.authority.bindings) {
      if (!binding || !exactKeys(binding, ['projectId', 'invitationId', 'membershipId', 'tokenHash']) || !id(binding.projectId) || !id(binding.invitationId) || !id(binding.membershipId) || !hash(binding.tokenHash) || seen.has(binding.projectId)) throw new Error('invalid context')
      seen.add(binding.projectId)
    }
  } else {
    if (!Number.isSafeInteger(context.ownerUserId) || context.ownerUserId <= 0 || !Number.isSafeInteger(context.projectId) || context.projectId <= 0) throw new Error('invalid context')
    const keys = context.purpose === 'member_invitation' ? ['invitationId', 'tokenHash'] : context.purpose === 'contact_form_forward' ? ['submissionId', 'bindingId', 'dedupeKey'] : context.purpose === 'workspace_ready' ? ['releaseId', 'draftOrderId', 'membershipId', 'paymentReceiptFingerprint', 'workspaceReceiptFingerprint', 'productionReceiptFingerprint', 'requestFingerprint'] : []
    if (!keys.length || !exactKeys(context.authority, keys) || keys.some(key => ['tokenHash', 'dedupeKey', 'paymentReceiptFingerprint', 'workspaceReceiptFingerprint', 'productionReceiptFingerprint', 'requestFingerprint'].includes(key) ? !hash((context.authority as Record<string, unknown>)[key]) : !id((context.authority as Record<string, unknown>)[key]))) throw new Error('invalid context')
  }
}

export function encryptPayload(input: { secret: string; id: string; ownerUserId: number | null; projectId: number | null; purpose: string; authorityFingerprint: string; payloadFingerprint: string; contextFingerprint: string; providerConfigurationFingerprint: string; payload: { context: ManagedSiteEmailOutboxContext; message: ManagedSiteEmailMessage } }): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(input.secret), iv)
  const aad = canonicalJson({ id: input.id, ownerUserId: input.ownerUserId, projectId: input.projectId, purpose: input.purpose, authorityFingerprint: input.authorityFingerprint, payloadFingerprint: input.payloadFingerprint, contextFingerprint: input.contextFingerprint, providerConfigurationFingerprint: input.providerConfigurationFingerprint })
  cipher.setAAD(Buffer.from(aad))
  const serialized = Buffer.from(canonicalJson(input.payload), 'utf8')
  if (serialized.length > MAX_SERIALIZED_ENVELOPE_BYTES) throw new Error('payload envelope too large')
  const ciphertext = Buffer.concat([cipher.update(serialized), cipher.final()])
  const encoded = `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`
  if (encoded.length > MAX_ENCRYPTED_PAYLOAD_CHARS) throw new Error('encrypted payload too large')
  return encoded
}

export function decryptPayload(input: { secret: string; encryptedPayload: string; id: string; ownerUserId: number | null; projectId: number | null; purpose: string; authorityFingerprint: string; payloadFingerprint: string; contextFingerprint: string; providerConfigurationFingerprint: string }): { context: ManagedSiteEmailOutboxContext; message: ManagedSiteEmailMessage } {
  if (typeof input.encryptedPayload !== 'string' || input.encryptedPayload.length > MAX_ENCRYPTED_PAYLOAD_CHARS || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/u.test(input.encryptedPayload)) throw new Error('invalid ciphertext')
  const parts = input.encryptedPayload.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('invalid ciphertext')
  const iv = Buffer.from(parts[1]!, 'base64url')
  const body = Buffer.from(parts[2]!, 'base64url')
  const tag = Buffer.from(parts[3]!, 'base64url')
  if (iv.length !== 12 || tag.length !== 16 || body.length > MAX_SERIALIZED_ENVELOPE_BYTES) throw new Error('invalid ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(input.secret), iv)
  decipher.setAAD(Buffer.from(canonicalJson({ id: input.id, ownerUserId: input.ownerUserId, projectId: input.projectId, purpose: input.purpose, authorityFingerprint: input.authorityFingerprint, payloadFingerprint: input.payloadFingerprint, contextFingerprint: input.contextFingerprint, providerConfigurationFingerprint: input.providerConfigurationFingerprint })))
  decipher.setAuthTag(tag)
  const serialized = Buffer.concat([decipher.update(body), decipher.final()])
  if (serialized.length > MAX_SERIALIZED_ENVELOPE_BYTES) throw new Error('payload envelope too large')
  const raw = serialized.toString('utf8')
  const parsed = JSON.parse(raw) as { context: ManagedSiteEmailOutboxContext & { expiresAt: string | Date }; message: ManagedSiteEmailMessage }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'context') || !Object.hasOwn(parsed, 'message')) throw new Error('invalid envelope')
  parsed.context.expiresAt = new Date(parsed.context.expiresAt)
  validateContext(parsed.context)
  validateMessage(parsed.message)
  if (Object.getPrototypeOf(parsed.message) !== Object.prototype || Object.keys(parsed.message).some(key => !['to', 'subject', 'text', 'replyTo', 'idempotencyKey'].includes(key))) throw new Error('invalid message envelope')
  const actualPayload = privateFingerprint({ context: parsed.context, message: parsed.message }, input.secret)
  const expectedPayload = Buffer.from(actualPayload, 'hex')
  const givenPayload = Buffer.from(input.payloadFingerprint, 'hex')
  if (expectedPayload.length !== givenPayload.length || !timingSafeEqual(expectedPayload, givenPayload)) throw new Error('payload mismatch')
  return parsed
}
