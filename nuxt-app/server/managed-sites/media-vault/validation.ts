import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { MEDIA_MIME_ALLOWLIST, MEDIA_VARIANT_KEYS, type MediaImageProcessor, type MediaInspection, type MediaSecurityScanner, type MediaTransformation, type MediaVariantOutput } from './types'

export const MEDIA_LIMITS = Object.freeze({ maxFileBytes: 50 * 1024 * 1024, maxBulkCount: 25, maxBulkBytes: 100 * 1024 * 1024, maxDimension: 12_000, maxPixels: 40_000_000, uploadTtlMs: 10 * 60 * 1000, trashRetentionMs: 30 * 24 * 60 * 60 * 1000 })
const MIME_EXTENSIONS: Record<string, readonly string[]> = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/avif': ['avif'] }
const DANGEROUS_EXTENSION = /\.(?:exe|dll|com|bat|cmd|ps1|sh|js|mjs|cjs|html?|svg|php\d*|jar|zip|rar|7z|gz|tar|pdf)(?:\.|$)/iu

export function hashBytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function sanitizeMediaFilename(value: unknown): string {
  if (typeof value !== 'string') throw createError({ statusCode: 422, statusMessage: 'Media filename is invalid.' })
  const basename = value.normalize('NFKC').replace(/\\/gu, '/').split('/').pop()?.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim() || ''
  if (!basename || basename === '.' || basename === '..' || basename.length > 255 || DANGEROUS_EXTENSION.test(basename)) throw createError({ statusCode: 422, statusMessage: 'Media filename is unsafe.' })
  const extension = basename.toLowerCase().split('.').pop() || ''
  if (!Object.values(MIME_EXTENSIONS).flat().includes(extension)) throw createError({ statusCode: 422, statusMessage: 'Media filename extension is not supported.' })
  return basename
}
export function extensionForMime(mime: string): string { const extension = MIME_EXTENSIONS[mime]?.[0]; if (!extension) throw createError({ statusCode: 422, statusMessage: 'Declared media MIME is not supported.' }); return extension }
export function validateUploadDeclaration(input: { filename: unknown; declaredMime: unknown; declaredBytes: unknown }): { filename: string; declaredMime: typeof MEDIA_MIME_ALLOWLIST[number]; declaredBytes: number } {
  const filename = sanitizeMediaFilename(input.filename)
  if (typeof input.declaredMime !== 'string' || !(MEDIA_MIME_ALLOWLIST as readonly string[]).includes(input.declaredMime)) throw createError({ statusCode: 422, statusMessage: 'Declared media MIME is not supported.' })
  if (!Number.isSafeInteger(input.declaredBytes) || Number(input.declaredBytes) < 1 || Number(input.declaredBytes) > MEDIA_LIMITS.maxFileBytes) throw createError({ statusCode: 413, statusMessage: 'Media file size exceeds the plan-safe upload limit.' })
  const extension = filename.toLowerCase().split('.').pop() || ''
  if (!MIME_EXTENSIONS[input.declaredMime]!.includes(extension)) throw createError({ statusCode: 422, statusMessage: 'Media filename extension and declared MIME do not match.' })
  return { filename, declaredMime: input.declaredMime as typeof MEDIA_MIME_ALLOWLIST[number], declaredBytes: Number(input.declaredBytes) }
}

function byte(bytes: Uint8Array, offset: number): number { return bytes[offset] ?? 0 }
function starts(bytes: Uint8Array, signature: readonly number[]): boolean { return signature.every((value, index) => byte(bytes, index) === value) }
function readU16BE(bytes: Uint8Array, offset: number): number { return (byte(bytes, offset) << 8) | byte(bytes, offset + 1) }
function readU32BE(bytes: Uint8Array, offset: number): number { return (byte(bytes, offset) * 0x1000000) + (byte(bytes, offset + 1) << 16) + (byte(bytes, offset + 2) << 8) + byte(bytes, offset + 3) }
function assertDimensions(width: number, height: number): void { if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MEDIA_LIMITS.maxDimension || height > MEDIA_LIMITS.maxDimension || width * height > MEDIA_LIMITS.maxPixels) throw createError({ statusCode: 422, statusMessage: 'Decoded image dimensions exceed the image-bomb guard.' }) }
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (byte(bytes, offset) !== 0xff) { offset++; continue }
    const marker = byte(bytes, offset + 1); offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    const length = readU16BE(bytes, offset)
    if (length < 2 || offset + length > bytes.length) break
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) return { height: readU16BE(bytes, offset + 3), width: readU16BE(bytes, offset + 5) }
    offset += length
  }
  throw createError({ statusCode: 422, statusMessage: 'JPEG dimensions could not be decoded safely.' })
}
function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  const kind = Buffer.from(bytes.subarray(12, 16)).toString('ascii')
  if (kind === 'VP8X' && bytes.length >= 30) return { width: 1 + byte(bytes, 24) + (byte(bytes, 25) << 8) + (byte(bytes, 26) << 16), height: 1 + byte(bytes, 27) + (byte(bytes, 28) << 8) + (byte(bytes, 29) << 16) }
  if (kind === 'VP8L' && bytes.length >= 25) { const bits = byte(bytes, 21) | (byte(bytes, 22) << 8) | (byte(bytes, 23) << 16) | (byte(bytes, 24) << 24); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 } }
  throw createError({ statusCode: 422, statusMessage: 'WebP dimensions could not be decoded safely.' })
}
function assertNotPolyglot(bytes: Uint8Array): void {
  const sample = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024))).toString('latin1').toLowerCase()
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x4d, 0x5a]) || starts(bytes, [0x7f, 0x45, 0x4c, 0x46]) || sample.includes('<script') || sample.includes('<?php') || sample.includes('<svg') || sample.includes('%pdf-')) throw createError({ statusCode: 422, statusMessage: 'Executable, archive, SVG or polyglot media content is rejected.' })
}

export function inspectMediaBytes(bytes: Uint8Array): MediaInspection {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > MEDIA_LIMITS.maxFileBytes) throw createError({ statusCode: 422, statusMessage: 'Media bytes are missing, truncated or oversized.' })
  assertNotPolyglot(bytes)
  let mime: MediaInspection['mime']; let width: number; let height: number
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && Buffer.from(bytes.subarray(12, 16)).toString('ascii') === 'IHDR') { mime = 'image/png'; width = readU32BE(bytes, 16); height = readU32BE(bytes, 20) }
  else if (starts(bytes, [0xff, 0xd8, 0xff])) { mime = 'image/jpeg'; ({ width, height } = jpegDimensions(bytes)) }
  else if (Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') { mime = 'image/webp'; ({ width, height } = webpDimensions(bytes)) }
  else if (Buffer.from(bytes.subarray(4, 8)).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(Buffer.from(bytes.subarray(8, 12)).toString('ascii'))) { mime = 'image/avif'; const ispe = Buffer.from(bytes).indexOf(Buffer.from('ispe')); if (ispe < 0 || ispe + 12 > bytes.length) throw createError({ statusCode: 422, statusMessage: 'AVIF dimensions could not be decoded safely.' }); width = readU32BE(bytes, ispe + 4); height = readU32BE(bytes, ispe + 8) }
  else throw createError({ statusCode: 422, statusMessage: 'Media magic bytes are not allowlisted.' })
  assertDimensions(width, height)
  const marker = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 256 * 1024))).toString('latin1')
  return { mime, width, height, frameCount: 1, orientation: null, hasExif: marker.includes('Exif'), hasGps: /GPS(?:Latitude|Longitude|Info)/u.test(marker) }
}

export function validateTransformation(input: unknown, width: number, height: number): MediaTransformation {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as any : {}
  const rotation = value.rotation ?? 0
  if (![0, 90, 180, 270].includes(rotation)) throw createError({ statusCode: 422, statusMessage: 'Media rotation is invalid.' })
  let focalPoint: MediaTransformation['focalPoint']; if (value.focalPoint !== undefined) { const x = Number(value.focalPoint?.x); const y = Number(value.focalPoint?.y); if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw createError({ statusCode: 422, statusMessage: 'Media focal point is outside normalized bounds.' }); focalPoint = { x, y } }
  let crop: MediaTransformation['crop']; if (value.crop !== undefined) { const { x, y, width: cropWidth, height: cropHeight, aspect } = value.crop; if (![x, y, cropWidth, cropHeight].every(Number.isInteger) || x < 0 || y < 0 || cropWidth < 1 || cropHeight < 1 || x + cropWidth > width || y + cropHeight > height || !['free', '1:1', '4:3', '3:2', '16:9', 'portrait'].includes(aspect)) throw createError({ statusCode: 422, statusMessage: 'Media crop is outside decoded image bounds.' }); const expected: Record<string, number> = { '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, portrait: 3 / 4 }; if (aspect !== 'free' && Math.abs(cropWidth / cropHeight - expected[aspect]!) > .02) throw createError({ statusCode: 422, statusMessage: 'Media crop bounds do not match the selected aspect preset.' }); crop = { x, y, width: cropWidth, height: cropHeight, aspect } }
  return { ...(crop ? { crop } : {}), ...(focalPoint ? { focalPoint } : {}), rotation, stripMetadata: true, preserveOrientation: true }
}

export function createUnavailableProductionScanner(policy: 'quarantine' | 'owner_review' = 'quarantine'): MediaSecurityScanner { return { async scan() { return { verdict: policy === 'owner_review' ? 'owner_review' : 'not_configured', reasonCode: 'SCANNER_NOT_CONFIGURED', scannerReference: null } } } }
export function createPassingTestScanner(): MediaSecurityScanner { return { async scan(input) { return { verdict: 'passed', reasonCode: null, scannerReference: `mock-scan:${input.sha256.slice(0, 24)}` } } } }

/** Test-only processor. It proves deterministic lineage, never claims real codec conversion. */
export function createDeterministicTestImageProcessor(): MediaImageProcessor {
  return {
    async inspect(bytes) { return inspectMediaBytes(bytes) },
    async produceVariants(input) {
      const outputs: MediaVariantOutput[] = []
      const sourceWidth = input.transformation.crop?.width || input.inspection.width; const sourceHeight = input.transformation.crop?.height || input.inspection.height
      for (const [index, key] of MEDIA_VARIANT_KEYS.entries()) {
        const max = [240, 640, 1280, 2048, sourceWidth][index]!
        const scale = Math.min(1, max / sourceWidth); const width = Math.max(1, Math.round(sourceWidth * scale)); const height = Math.max(1, Math.round(sourceHeight * scale))
        const marker = Buffer.from(`\nDS-MOCK-VARIANT:${key}:${width}x${height}:${JSON.stringify(input.transformation)}`)
        const bytes = new Uint8Array(Buffer.concat([Buffer.from(input.bytes), marker])); outputs.push({ key, format: input.inspection.mime === 'image/png' ? 'png' : input.inspection.mime === 'image/avif' ? 'avif' : input.inspection.mime === 'image/webp' ? 'webp' : 'jpeg', width, height, bytes, sha256: hashBytes(bytes), transformation: input.transformation })
      }
      return outputs
    },
  }
}
