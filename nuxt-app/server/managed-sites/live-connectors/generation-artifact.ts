import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import type { ManagedSiteAdmittedManifest, ManagedSiteGeneratedFile, ManagedSiteGenerationProviderOutput } from './types'
import { canonicalArtifactCollisionKey, compareCodeUnits } from './canonical'

export const MANAGED_SITE_GENERATION_MAX_FILES = 100
export const MANAGED_SITE_GENERATION_MAX_FILE_BYTES = 200_000
export const MANAGED_SITE_GENERATION_MAX_TOTAL_BYTES = 2_000_000

const SHA256 = /^[a-f0-9]{64}$/u
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u
const CONTROL_EXCEPT_TEXT = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const PROMPT_INJECTION = /(?:ignore|disregard|override|forget)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|prompts?)|(?:system|developer)\s*prompt|reveal\s+(?:the\s+)?(?:secret|credential|prompt)|tool[_ -]?call|BEGIN\s+(?:SYSTEM|DEVELOPER)\s+MESSAGE/iu
const SECRET_MATERIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|authorization\s*[:=]\s*bearer\s+\S+|(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*["'][^"']{8,}["']/iu
const EXECUTABLE_HOOK = /<\s*(?:script|iframe|object|embed|base|meta\b[^>]*http-equiv)|\son[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|\b(?:eval|Function|child_process|spawn|execSync|process\.env|import\.meta\.env)\b/iu

const OUTPUT_KEYS = new Set(['schemaVersion', 'providerKey', 'providerModel', 'providerRequestId', 'requestFingerprint', 'files', 'manifestHash'])
const FILE_KEYS = new Set(['path', 'mediaType', 'content', 'sha256'])
const MEDIA_BY_EXTENSION: Record<string, ManagedSiteGeneratedFile['mediaType']> = {
  '.astro': 'text/astro',
  '.css': 'text/css',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/markdown',
  '.xml': 'text/html',
}

function blocked(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean { return Object.keys(value).every(key => allowed.has(key)) && Object.keys(value).length === allowed.size }
function sha256(value: string): string { return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex') }

function canonicalPath(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 240 || input !== input.normalize('NFKC')) blocked('Generated artifact path is invalid.')
  if (input.startsWith('/') || input.includes('\\') || input.includes('%') || input.includes('//') || input.includes('\u0000') || input.startsWith('.') || input.endsWith('/')) blocked('Generated artifact path is outside the allowlist.')
  const segments = input.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.') || segment.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))) blocked('Generated artifact path contains an unsafe segment.')
  if (/\[[^\]]+\]/u.test(input) || /(?:^|\/)(?:server|api|plugins?|middleware|scripts?|hooks?|node_modules)(?:\/|$)/iu.test(input)) blocked('Generated artifact path targets an executable or dynamic runtime surface.')
  const allowed = /^(?:src\/(?:pages|components|layouts)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.astro|src\/content\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md|src\/styles\/[A-Za-z0-9][A-Za-z0-9._/-]*\.css|public\/(?:robots\.txt|llms\.txt|sitemap\.xml|manifest\.json))$/u
  if (!allowed.test(input)) blocked('Generated artifact path is not in the managed template allowlist.')
  return input
}

function extension(path: string): string { return path.slice(path.lastIndexOf('.')).toLowerCase() }

function assertJsonSafe(content: string): void {
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { blocked('Generated JSON is malformed.') }
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12) blocked('Generated JSON nesting exceeds the safety limit.')
    if (Array.isArray(value)) { if (value.length > 500) blocked('Generated JSON array is oversized.'); value.forEach(item => visit(item, depth + 1)); return }
    if (plainRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype', 'scripts', 'dependencies', 'devDependencies', 'optionalDependencies'].includes(key) || /(?:secret|token|password|api.?key)/iu.test(key)) blocked('Generated JSON contains a forbidden key.')
        visit(item, depth + 1)
      }
      return
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) blocked('Generated JSON contains an unsupported value.')
  }
  visit(parsed, 0)
}

function validateFile(value: unknown): { file: ManagedSiteGeneratedFile; byteSize: number } {
  if (!plainRecord(value) || !exactKeys(value, FILE_KEYS)) blocked('Generated file schema is malformed or contains unknown fields.')
  const path = canonicalPath(value.path)
  const expectedMediaType = MEDIA_BY_EXTENSION[extension(path)]
  if (typeof value.mediaType !== 'string' || value.mediaType !== expectedMediaType) blocked('Generated file media type does not match its allowlisted path.')
  if (typeof value.content !== 'string' || value.content.length < 1 || value.content !== value.content.normalize('NFC') || CONTROL_EXCEPT_TEXT.test(value.content)) blocked('Generated file content is empty, binary, or not canonically encoded.')
  const byteSize = Buffer.byteLength(value.content, 'utf8')
  if (byteSize > MANAGED_SITE_GENERATION_MAX_FILE_BYTES) blocked('Generated file exceeds the per-file size limit.')
  const contentHash = sha256(value.content)
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256) || value.sha256 !== contentHash) blocked('Generated file content hash does not match the provider manifest.')
  if (PROMPT_INJECTION.test(value.content)) blocked('Generated artifact contains prompt-injection text.')
  if (SECRET_MATERIAL.test(value.content)) blocked('Generated artifact contains secret-like material.')
  if (EXECUTABLE_HOOK.test(value.content)) blocked('Generated artifact contains an executable hook or active-content primitive.')
  if (value.mediaType === 'application/json') assertJsonSafe(value.content)
  if ((value.mediaType === 'text/html' || value.mediaType === 'text/astro') && /<\s*form\b[^>]*(?:action|method)\s*=/iu.test(value.content)) blocked('Generated artifact contains an externally actionable form.')
  if (value.mediaType === 'text/markdown' && /\]\(\s*(?:javascript:|data:|file:)/iu.test(value.content)) blocked('Generated Markdown contains an unsafe link protocol.')
  return { file: { path, mediaType: value.mediaType as ManagedSiteGeneratedFile['mediaType'], content: value.content, sha256: contentHash }, byteSize }
}

export function computeManagedSiteProviderManifestHash(files: readonly Pick<ManagedSiteGeneratedFile, 'path' | 'mediaType' | 'sha256'>[]): string {
  return stableFingerprint([...files].map(file => ({ path: file.path, mediaType: file.mediaType, sha256: file.sha256 })).sort((left, right) => compareCodeUnits(left.path, right.path)))
}

export function admitManagedSiteGenerationOutput(input: unknown, expected: { requestFingerprint: string; providerKey: string }): { output: ManagedSiteGenerationProviderOutput; manifest: ManagedSiteAdmittedManifest; files: ManagedSiteGeneratedFile[] } {
  if (!plainRecord(input) || !exactKeys(input, OUTPUT_KEYS)) blocked('Generation provider response schema is malformed or contains unknown fields.')
  if (input.schemaVersion !== 'managed-site-generation-provider-response-v1') blocked('Generation provider response version is unsupported.')
  if (typeof input.providerKey !== 'string' || input.providerKey !== expected.providerKey || !PROVIDER_REFERENCE.test(input.providerKey)) blocked('Generation provider identity does not match the configured provider.')
  if (typeof input.providerModel !== 'string' || !MODEL_ID.test(input.providerModel)) blocked('Generation provider model identity is invalid.')
  if (typeof input.providerRequestId !== 'string' || !PROVIDER_REFERENCE.test(input.providerRequestId)) blocked('Generation provider request identity is invalid.')
  if (typeof input.requestFingerprint !== 'string' || input.requestFingerprint !== expected.requestFingerprint || !SHA256.test(input.requestFingerprint)) blocked('Generation provider response is not bound to the exact request.')
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MANAGED_SITE_GENERATION_MAX_FILES) blocked('Generation provider returned an invalid file count.')
  const admitted = input.files.map(validateFile)
  const collisionKeys = new Set<string>()
  for (const { file } of admitted) {
    const key = canonicalArtifactCollisionKey(file.path)
    if (collisionKeys.has(key)) blocked('Generation provider returned duplicate or case-colliding paths.')
    collisionKeys.add(key)
  }
  if (!admitted.some(({ file }) => file.path === 'src/pages/index.astro')) blocked('Generation candidate requires the fixed Astro entry page.')
  const totalBytes = admitted.reduce((sum, item) => sum + item.byteSize, 0)
  if (totalBytes > MANAGED_SITE_GENERATION_MAX_TOTAL_BYTES) blocked('Generation provider output exceeds the total size limit.')
  const files = admitted.map(item => item.file).sort((left, right) => compareCodeUnits(left.path, right.path))
  const providerManifestHash = computeManagedSiteProviderManifestHash(files)
  if (typeof input.manifestHash !== 'string' || input.manifestHash !== providerManifestHash) blocked('Generation provider manifest hash does not match deterministic file identity.')
  const contentHash = stableFingerprint(files.map(file => ({ path: file.path, sha256: file.sha256 })))
  const manifestWithoutHash = { schemaVersion: 'managed-site-generation-manifest-v1' as const, files: files.map(file => ({ path: file.path, mediaType: file.mediaType, byteSize: Buffer.byteLength(file.content, 'utf8'), sha256: file.sha256 })), fileCount: files.length, totalBytes, contentHash }
  const manifest: ManagedSiteAdmittedManifest = { ...manifestWithoutHash, manifestHash: stableFingerprint(manifestWithoutHash) }
  return {
    output: { schemaVersion: 'managed-site-generation-provider-response-v1', providerKey: input.providerKey, providerModel: input.providerModel, providerRequestId: input.providerRequestId, requestFingerprint: input.requestFingerprint, files, manifestHash: input.manifestHash },
    manifest,
    files,
  }
}
