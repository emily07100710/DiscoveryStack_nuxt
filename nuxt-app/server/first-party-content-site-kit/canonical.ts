export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  try {
    if (value === null) return true
    if (typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!isJsonSafe(value[index], seen)) {
          seen.delete(value)
          return false
        }
      }
      seen.delete(value)
      return true
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      seen.delete(value)
      return false
    }
    const ownNames = Object.getOwnPropertyNames(value)
    if (Object.getOwnPropertySymbols(value).length > 0) {
      seen.delete(value)
      return false
    }
    const objectValue = value as Record<string, unknown>
    for (const key of ownNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !isJsonSafe(descriptor.value, seen)) {
        seen.delete(value)
        return false
      }
    }
    seen.delete(value)
    return true
  } catch {
    return false
  }
}

export function safeJsonStringify(value: unknown): string | undefined {
  if (!isJsonSafe(value)) return undefined
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : undefined
  } catch {
    return undefined
  }
}
