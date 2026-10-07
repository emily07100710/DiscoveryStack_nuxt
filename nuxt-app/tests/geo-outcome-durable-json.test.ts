import { describe, expect, it } from 'vitest'
import { decodeDurableJson, encodeDurableJson, GEO_OUTCOME_EXACT_JSON_VERSION } from '../server/geo-outcome-model/durable-json'

describe('GEO durable exact JSON envelope', () => {
  it('round-trips precise nested numeric values and canonicalizes negative zero', () => {
    const input = {
      normalizationStatistics: { mean: [0.027397260273972678, 0.43434838152895533], standardDeviation: [1.0000000000000002, Number.MIN_VALUE] },
      training: { learningRate: 0.43434838152895533, l2: 0.010203040506070809, epochs: 17 },
      nested: [{ parameters: { intercept: -0.12345678901234566, weight: 1.0000000000000002 } }],
      negativeZero: -0,
    }
    const encoded = encodeDurableJson(input)
    expect(encoded.schemaVersion).toBe(GEO_OUTCOME_EXACT_JSON_VERSION)
    expect(decodeDurableJson(encoded, true)).toEqual({ ...input, negativeZero: 0 })
    const decoded = decodeDurableJson(encoded, true) as typeof input
    expect(decoded.normalizationStatistics.mean[0]).toBe(0.027397260273972678)
    expect(decoded.training.learningRate).toBe(0.43434838152895533)
    expect(decoded.nested[0]!.parameters.intercept).toBe(-0.12345678901234566)
    expect(Object.is(decoded.negativeZero, 0)).toBe(true)
  })

  it('preserves unmarked legacy values unless the caller requires an envelope', () => {
    const legacy = { values: [0.25, 0.125] }
    expect(decodeDurableJson(legacy)).toEqual(legacy)
    expect(() => decodeDurableJson(legacy, true)).toThrow(/missing durable exact JSON envelope/i)
    expect(() => decodeDurableJson(null, true)).toThrow(/missing durable exact JSON envelope/i)
  })

  it('rejects unknown markers, missing or extra envelope keys, and non-object envelopes', () => {
    expect(() => decodeDurableJson({ schemaVersion: 'geo-outcome-exact-json-v2', canonicalJson: '{}' }, true)).toThrow(/exact json envelope/i)
    expect(() => decodeDurableJson({ schemaVersion: GEO_OUTCOME_EXACT_JSON_VERSION, canonicalJson: '{}', extra: true }, true)).toThrow(/exact json envelope/i)
    expect(() => decodeDurableJson({ schemaVersion: GEO_OUTCOME_EXACT_JSON_VERSION }, true)).toThrow(/exact json envelope/i)
    expect(() => decodeDurableJson([], true)).toThrow(/missing durable exact json envelope/i)
  })

  it('rejects invalid JSON, duplicate keys, and valid-but-noncanonical JSON text', () => {
    const envelope = (canonicalJson: string) => ({ schemaVersion: GEO_OUTCOME_EXACT_JSON_VERSION, canonicalJson })
    expect(() => decodeDurableJson(envelope('{'), true)).toThrow(/exact json payload/i)
    expect(() => decodeDurableJson(envelope('{"a":1,"a":1}'), true)).toThrow(/exact json payload/i)
    expect(() => decodeDurableJson(envelope('{"b":1,"a":2}'), true)).toThrow(/exact json payload/i)
    expect(() => decodeDurableJson(envelope('{ "a": 1 }'), true)).toThrow(/exact json payload/i)
  })

  it('rejects non-finite source values and canonical payloads with non-finite JSON tokens', () => {
    expect(() => encodeDurableJson({ coefficient: Number.NaN })).toThrow(/non-finite/i)
    expect(() => encodeDurableJson({ intercept: Number.POSITIVE_INFINITY })).toThrow(/non-finite/i)
    expect(() => decodeDurableJson({ schemaVersion: GEO_OUTCOME_EXACT_JSON_VERSION, canonicalJson: '{"coefficient":NaN}' }, true)).toThrow(/exact json payload/i)
  })

  it('enforces the exact JSON payload byte limit using UTF-8 size', () => {
    const oversizedUtf8 = `"${'é'.repeat(524_289)}"`
    expect(Buffer.byteLength(oversizedUtf8, 'utf8')).toBeGreaterThan(1_048_576)
    expect(() => decodeDurableJson({ schemaVersion: GEO_OUTCOME_EXACT_JSON_VERSION, canonicalJson: oversizedUtf8 }, true)).toThrow(/oversized durable exact json/i)
    expect(() => encodeDurableJson({ text: 'é'.repeat(524_289) })).toThrow(/oversized durable exact json/i)
  })
})
