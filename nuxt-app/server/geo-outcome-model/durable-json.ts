import { canonicalJson } from './canonical'

export const GEO_OUTCOME_EXACT_JSON_VERSION = 'geo-outcome-exact-json-v1'
const MAX_EXACT_JSON_BYTES = 1_048_576

export interface ExactJsonEnvelope {
  schemaVersion: typeof GEO_OUTCOME_EXACT_JSON_VERSION
  canonicalJson: string
}

function boundedCanonicalText(value: unknown): string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > MAX_EXACT_JSON_BYTES) {
    throw new Error('Corrupt or oversized durable exact JSON text.')
  }
  return value
}

/** Keep numeric bits inside JSON text: native MySQL JSON numbers can round at the last digit. */
export function encodeDurableJson(value: unknown): ExactJsonEnvelope {
  const text = boundedCanonicalText(canonicalJson(value))
  return { schemaVersion: GEO_OUTCOME_EXACT_JSON_VERSION, canonicalJson: text }
}

/** Legacy values are returned unchanged; the caller still validates their domain and immutable hash. */
export function decodeDurableJson(value: unknown, requireEnvelope = false): unknown {
  const marked = value && typeof value === 'object' && !Array.isArray(value) && 'schemaVersion' in value
  if (!marked) {
    if (requireEnvelope) throw new Error('Missing durable exact JSON envelope.')
    return value
  }
  const envelope = value as Record<string, unknown>
  if (envelope.schemaVersion !== GEO_OUTCOME_EXACT_JSON_VERSION || Object.keys(envelope).sort().join(',') !== 'canonicalJson,schemaVersion') {
    throw new Error('Corrupt durable exact JSON envelope.')
  }
  const text = boundedCanonicalText(envelope.canonicalJson)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
    if (canonicalJson(parsed) !== text) throw new Error('noncanonical')
  } catch {
    throw new Error('Corrupt durable exact JSON payload.')
  }
  return parsed
}
