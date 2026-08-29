import sharp from 'sharp'
import { createError } from 'h3'
import { hashBytes, MEDIA_LIMITS } from './validation'
import type { MediaImageProcessor, MediaInspection, MediaTransformation, MediaVariantOutput } from './types'

const FORMAT_MIME: Record<string, MediaInspection['mime']> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' }
function assertMetadata(metadata: sharp.Metadata): MediaInspection {
  const mime = metadata.format ? FORMAT_MIME[metadata.format] : undefined; const oriented = metadata.autoOrient || metadata; const width = Number(oriented.width); const height = Number(oriented.height); const frameCount = Number(metadata.pages || 1)
  if (!mime || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MEDIA_LIMITS.maxDimension || height > MEDIA_LIMITS.maxDimension || width * height > MEDIA_LIMITS.maxPixels || !Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 100) throw createError({ statusCode: 422, statusMessage: 'Image codec metadata is unsupported or exceeds decode limits.' })
  return { mime, width, height, frameCount, orientation: metadata.orientation || null, hasExif: Boolean(metadata.exif), hasGps: Boolean(metadata.exif && Buffer.from(metadata.exif).includes(Buffer.from('GPS'))) }
}
function positionedCrop(transformation: MediaTransformation, inspection: MediaInspection) { if (transformation.crop) return transformation.crop; return { x: 0, y: 0, width: inspection.width, height: inspection.height, aspect: 'free' as const } }
async function encode(input: { bytes: Uint8Array; inspection: MediaInspection; transformation: MediaTransformation; maxWidth: number; format: MediaVariantOutput['format']; key: MediaVariantOutput['key'] }): Promise<MediaVariantOutput> {
  const crop = positionedCrop(input.transformation, input.inspection); const width = Math.max(1, Math.min(crop.width, input.maxWidth)); const height = Math.max(1, Math.round(crop.height * (width / crop.width))); let pipeline = sharp(input.bytes, { animated: false, failOn: 'warning', limitInputPixels: MEDIA_LIMITS.maxPixels }).rotate().extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).resize({ width, height, fit: 'fill', withoutEnlargement: true })
  if (input.transformation.rotation) pipeline = pipeline.rotate(input.transformation.rotation)
  if (input.format === 'avif') pipeline = pipeline.avif({ quality: 68, effort: 5 }); else if (input.format === 'webp') pipeline = pipeline.webp({ quality: 78, effort: 4 }); else if (input.format === 'png') pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }); else pipeline = pipeline.jpeg({ quality: 84, progressive: true, mozjpeg: true })
  const result = await pipeline.toBuffer({ resolveWithObject: true }); const output = new Uint8Array(result.data); return { key: input.key, format: input.format, width: result.info.width, height: result.info.height, bytes: output, sha256: hashBytes(output), transformation: input.transformation }
}
export function createSharpMediaImageProcessor(): MediaImageProcessor {
  return {
    async inspect(bytes) { try { return assertMetadata(await sharp(bytes, { animated: true, failOn: 'warning', limitInputPixels: MEDIA_LIMITS.maxPixels }).metadata()) } catch (error) { if ((error as any)?.statusCode) throw error; throw createError({ statusCode: 422, statusMessage: 'Image codec could not safely decode the uploaded bytes.' }) } },
    async produceVariants(input) { const fallbackFormat: MediaVariantOutput['format'] = input.inspection.mime === 'image/png' ? 'png' : input.inspection.mime === 'image/avif' ? 'avif' : input.inspection.mime === 'image/webp' ? 'webp' : 'jpeg'; const specs: Array<[MediaVariantOutput['key'], number, MediaVariantOutput['format']]> = [['thumbnail', 240, 'webp'], ['small', 640, 'webp'], ['medium', 1280, 'webp'], ['large', 2048, 'avif'], ['original_policy', input.inspection.width, fallbackFormat]]; const outputs: MediaVariantOutput[] = []; for (const [key, maxWidth, format] of specs) outputs.push(await encode({ ...input, key, maxWidth, format })); return outputs },
  }
}
