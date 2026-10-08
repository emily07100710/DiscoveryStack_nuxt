/** The receiver has accepted a private draft, not published it. */
export interface FirstPartyDraftReceipt {
  readonly status: 'draft_received'
  readonly published: false
  readonly receiptScope: 'draft_ingest_outcome'
  readonly receiptIsCurrentState: false
  readonly publicationId: string
  readonly contentHash: string
  readonly postId: string
  readonly postVersion: 1
  readonly replayed: boolean
}

const KEYS = [
  'status', 'published', 'receiptScope', 'receiptIsCurrentState',
  'publicationId', 'contentHash', 'postId', 'postVersion', 'replayed',
] as const
const HASH = /^[a-f0-9]{64}$/u
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Strict, bounded and side-effect-free validation for the Do Alignment 202 receipt. */
export function normalizeFirstPartyDraftReceipt(value: unknown): FirstPartyDraftReceipt | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== KEYS.length || ownKeys.some(key => typeof key !== 'string' || !(KEYS as readonly string[]).includes(key))) return null
    const descriptors = KEYS.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (descriptors.some(descriptor => !descriptor || !('value' in descriptor) || descriptor.enumerable !== true)) return null
    const fields = Object.fromEntries(KEYS.map((key, index) => [key, descriptors[index]!.value])) as Record<(typeof KEYS)[number], unknown>
    if (fields.status !== 'draft_received' || fields.published !== false || fields.receiptScope !== 'draft_ingest_outcome' || fields.receiptIsCurrentState !== false || fields.postVersion !== 1 || typeof fields.replayed !== 'boolean') return null
    if (typeof fields.publicationId !== 'string' || fields.publicationId.length < 1 || fields.publicationId.length > 160 || !OPAQUE_ID.test(fields.publicationId)) return null
    if (typeof fields.contentHash !== 'string' || !HASH.test(fields.contentHash)) return null
    if (typeof fields.postId !== 'string' || fields.postId.length < 1 || fields.postId.length > 160 || !(OPAQUE_ID.test(fields.postId) || UUID.test(fields.postId))) return null
    return {
      status: 'draft_received', published: false, receiptScope: 'draft_ingest_outcome', receiptIsCurrentState: false,
      publicationId: fields.publicationId, contentHash: fields.contentHash, postId: fields.postId,
      postVersion: 1, replayed: fields.replayed,
    }
  } catch {
    // Proxies and hostile accessors are untrusted input too.
    return null
  }
}

export function hasFirstPartyDraftReceiptMarker(value: unknown): boolean {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    return Reflect.ownKeys(value).some(key => typeof key === 'string' && [
      'status', 'published', 'receiptScope', 'receiptIsCurrentState', 'postId', 'postVersion', 'replayed', 'receipt',
    ].includes(key))
  } catch {
    return true
  }
}
