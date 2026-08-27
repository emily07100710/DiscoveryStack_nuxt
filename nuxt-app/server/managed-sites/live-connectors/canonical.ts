/** Locale-independent UTF-16 code-unit ordering for persisted fingerprints. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** NFKC plus ASCII-only case folding; artifact paths are admitted as ASCII. */
export function canonicalArtifactCollisionKey(value: string): string {
  return value.normalize('NFKC').replace(/[A-Z]/gu, character => character.toLowerCase())
}
