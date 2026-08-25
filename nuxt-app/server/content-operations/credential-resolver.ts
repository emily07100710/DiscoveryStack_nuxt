import { isOpaqueReference } from '../first-party-publishing/normalization'
import type { ServerCredentialResolution } from '../first-party-publishing/types'

const MAX_REGISTRY_BYTES = 32 * 1024
const MAX_REFERENCE_LENGTH = 128
const MAX_CREDENTIAL_LENGTH = 4096
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type CredentialRegistry = Record<string, string>

function hasPlainObjectPrototype(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseRegistry(raw: string | undefined): { ok: true; registry: CredentialRegistry } | { ok: false } {
  if (typeof raw !== 'string' || raw.length < 1 || Buffer.byteLength(raw, 'utf8') > MAX_REGISTRY_BYTES) return { ok: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (!hasPlainObjectPrototype(parsed)) return { ok: false }
  const registry: CredentialRegistry = Object.create(null) as CredentialRegistry
  for (const key of Object.keys(parsed)) {
    if (RESERVED_KEYS.has(key) || !isOpaqueReference(key, MAX_REFERENCE_LENGTH)) return { ok: false }
    const value = parsed[key]
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CREDENTIAL_LENGTH || CONTROL_CHARACTERS.test(value)) return { ok: false }
    registry[key] = value
  }
  return { ok: true, registry }
}

export function resolveServerCredential(credentialReference: string): ServerCredentialResolution {
  const parsed = parseRegistry(process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON)
  if (!parsed.ok) return { ok: false, reason: 'unavailable' }
  const value = parsed.registry[credentialReference]
  return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: 'missing' }
}

export function isRuntimeCredentialResolverAvailable(): boolean {
  return parseRegistry(process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON).ok
}

export function parseCredentialRegistryForTests(raw: string | undefined): { ok: true; references: string[] } | { ok: false } {
  const parsed = parseRegistry(raw)
  return parsed.ok ? { ok: true, references: Object.keys(parsed.registry) } : { ok: false }
}
