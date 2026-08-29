import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { SystemFactoryError } from './canonical'

export type SignedEnvelopeHeaders = { timestamp: string; nonce: string; sender: string; receiver: string; keyId: string; bodySha256: string; signature: string }
export type NoncePort = { consume(input: { sender: string; receiver: string; keyId: string; nonce: string; expiresAt: Date }): Promise<true> }

function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function signingInput(method: string, path: string, headers: Omit<SignedEnvelopeHeaders, 'signature'>): string { return [method.toUpperCase(), path, headers.timestamp, headers.nonce, headers.sender, headers.receiver, headers.keyId, headers.bodySha256].join('\n') }
function validIdentity(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9:_-]{2,127}$/u.test(value) }

export function signEnvelope(input: { method: string; path: string; rawBody: string | Uint8Array; sender: string; receiver: string; keyId: string; key: string | Uint8Array; now?: Date; nonce?: string }): SignedEnvelopeHeaders {
  const timestamp = (input.now || new Date()).toISOString(); const nonce = input.nonce || `n_${randomBytes(24).toString('base64url')}`
  const unsigned = { timestamp, nonce, sender: input.sender, receiver: input.receiver, keyId: input.keyId, bodySha256: digest(input.rawBody) }
  if (![input.sender, input.receiver, input.keyId, nonce].every(validIdentity)) throw new SystemFactoryError('HMAC_IDENTITY', 'Signed-envelope identity is invalid.')
  return { ...unsigned, signature: createHmac('sha256', input.key).update(signingInput(input.method, input.path, unsigned)).digest('hex') }
}

export async function verifyRawEnvelopeBeforeLookup(input: { method: string; path: string; rawBody: string | Uint8Array; headers: SignedEnvelopeHeaders; expectedSender: string; expectedReceiver: string; expectedKeyId: string; key: string | Uint8Array; noncePort: NoncePort; now?: Date; maximumSkewMs?: number }): Promise<{ bodySha256: string; envelopeFingerprint: string }> {
  const { headers } = input
  if (![headers.sender, headers.receiver, headers.keyId, headers.nonce].every(validIdentity) || !/^[a-f0-9]{64}$/u.test(headers.bodySha256) || !/^[a-f0-9]{64}$/u.test(headers.signature)) throw new SystemFactoryError('HMAC_HEADERS', 'Signed-envelope headers are invalid.', 401)
  if (headers.sender !== input.expectedSender || headers.receiver !== input.expectedReceiver || headers.keyId !== input.expectedKeyId) throw new SystemFactoryError('HMAC_BINDING', 'Signed-envelope authority binding is invalid.', 401)
  const receivedBodyHash = digest(input.rawBody)
  if (!timingSafeEqual(Buffer.from(receivedBodyHash), Buffer.from(headers.bodySha256))) throw new SystemFactoryError('HMAC_BODY_HASH', 'Signed-envelope raw body hash is invalid.', 401)
  const expected = createHmac('sha256', input.key).update(signingInput(input.method, input.path, { timestamp: headers.timestamp, nonce: headers.nonce, sender: headers.sender, receiver: headers.receiver, keyId: headers.keyId, bodySha256: headers.bodySha256 })).digest('hex')
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(headers.signature))) throw new SystemFactoryError('HMAC_SIGNATURE', 'Signed-envelope signature is invalid.', 401)
  const at = Date.parse(headers.timestamp); const now = (input.now || new Date()).getTime(); const skew = input.maximumSkewMs || 300_000
  if (!Number.isFinite(at) || Math.abs(now - at) > skew) throw new SystemFactoryError('HMAC_STALE', 'Signed-envelope timestamp is stale.', 401)
  const consumed = await input.noncePort.consume({ sender: headers.sender, receiver: headers.receiver, keyId: headers.keyId, nonce: headers.nonce, expiresAt: new Date(at + skew) })
  if (consumed !== true) throw new SystemFactoryError('HMAC_NONCE', 'Signed-envelope nonce was not atomically consumed.', 409)
  return { bodySha256: receivedBodyHash, envelopeFingerprint: digest(signingInput(input.method, input.path, { timestamp: headers.timestamp, nonce: headers.nonce, sender: headers.sender, receiver: headers.receiver, keyId: headers.keyId, bodySha256: headers.bodySha256 })) }
}

export function responseReceiptFingerprint(input: { requestEnvelopeFingerprint: string; tenantBindingFingerprint: string; status: number; responseBody: unknown }): string {
  return digest(JSON.stringify({ ...input, responseBodyHash: digest(JSON.stringify(input.responseBody)) }))
}

export class MemoryNoncePort implements NoncePort {
  private seen = new Set<string>()
  async consume(input: { sender: string; receiver: string; keyId: string; nonce: string }): Promise<true> {
    const key = `${input.sender}:${input.receiver}:${input.keyId}:${input.nonce}`
    if (this.seen.has(key)) throw new SystemFactoryError('HMAC_REPLAY', 'Signed-envelope nonce was already consumed.', 409)
    this.seen.add(key); return true
  }
}
