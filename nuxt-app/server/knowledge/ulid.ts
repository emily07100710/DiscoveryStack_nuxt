import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encode(value: bigint, length: number): string {
  let remaining = value
  let result = ''
  for (let index = 0; index < length; index += 1) {
    result = CROCKFORD[Number(remaining & 31n)] + result
    remaining >>= 5n
  }
  return result
}

/** Generates a dependency-free 26-character ULID using a 48-bit timestamp and 80 cryptographic random bits. */
export function generateUlid(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281_474_976_710_655) throw new Error('ULID timestamp is outside the 48-bit range.')
  const randomness = randomBytes(10)
  let randomValue = 0n
  for (const byte of randomness) randomValue = (randomValue << 8n) | BigInt(byte)
  return `${encode(BigInt(now), 10)}${encode(randomValue, 16)}`
}
