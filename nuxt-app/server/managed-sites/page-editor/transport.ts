import { createHash } from 'node:crypto'
import { canonicalFingerprint } from './canonical'
import type { CompiledPageArtifact } from './types'

export const MANAGED_PAGE_TRANSPORT_VERSION = 'managed-site-page-transport-v1' as const

const SHA256 = /^[a-f0-9]{64}$/u
const ROUTE = /^\/(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9-]*$/u
const CONTENT_TYPES = new Set(['home', 'standard', 'services', 'cases', 'contact', 'articles'])
const ARTIFACT_KEYS = [
  'artifactFingerprint',
  'blocks',
  'contentType',
  'design',
  'generatedAt',
  'locale',
  'mediaSetFingerprint',
  'pageFingerprint',
  'pageId',
  'pageVersion',
  'route',
  'seo',
  'version',
] as const

export type ManagedPageTransportEnvelope = {
  version: typeof MANAGED_PAGE_TRANSPORT_VERSION
  route: string
  pageType: CompiledPageArtifact['contentType']
  artifact: CompiledPageArtifact
  mediaManifest: Array<{
    bindingId: string
    assetId: string
    assetVersion: number
    assetSha256: string
    sources: string
  }>
  artifactFingerprint: string
  transportFingerprint: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort(codeUnitCompare)
  const expected = [...keys].sort(codeUnitCompare)
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function strictTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function stableArtifact(artifact: CompiledPageArtifact) {
  return {
    version: artifact.version,
    pageId: artifact.pageId,
    pageVersion: artifact.pageVersion,
    route: artifact.route,
    locale: artifact.locale,
    contentType: artifact.contentType,
    design: artifact.design,
    blocks: artifact.blocks,
    seo: artifact.seo,
    pageFingerprint: artifact.pageFingerprint,
    mediaSetFingerprint: artifact.mediaSetFingerprint,
  }
}

function validateCompiledArtifact(value: unknown): CompiledPageArtifact | null {
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) return null
  if (value.version !== 'managed-site-page-artifact-v1') return null
  if (typeof value.pageId !== 'string' || value.pageId.length < 1 || value.pageId.length > 128) return null
  if (!Number.isSafeInteger(value.pageVersion) || Number(value.pageVersion) < 1) return null
  if (typeof value.route !== 'string' || value.route.length > 512 || !ROUTE.test(value.route) || value.route.includes('//')) return null
  if (value.locale !== 'zh-hant' && value.locale !== 'en') return null
  if (typeof value.contentType !== 'string' || !CONTENT_TYPES.has(value.contentType)) return null
  if (!Array.isArray(value.blocks) || value.blocks.length > 200 || !value.blocks.every(isRecord)) return null
  if (!isRecord(value.design) || !isRecord(value.seo) || value.seo.canonicalPath !== value.route) return null
  if (typeof value.pageFingerprint !== 'string' || !SHA256.test(value.pageFingerprint)) return null
  if (typeof value.mediaSetFingerprint !== 'string' || !SHA256.test(value.mediaSetFingerprint)) return null
  if (typeof value.artifactFingerprint !== 'string' || !SHA256.test(value.artifactFingerprint)) return null
  if (!strictTimestamp(value.generatedAt)) return null
  const artifact = value as unknown as CompiledPageArtifact
  if (canonicalFingerprint(stableArtifact(artifact)) !== artifact.artifactFingerprint) return null
  return artifact
}

function mediaManifest(artifact: CompiledPageArtifact): ManagedPageTransportEnvelope['mediaManifest'] {
  const entries = new Map<string, ManagedPageTransportEnvelope['mediaManifest'][number]>()
  for (const block of artifact.blocks) {
    for (const media of block.media) {
      const identity = `${media.bindingId}:${media.assetId}:${media.assetVersion}:${media.assetSha256}`
      const candidate = {
        bindingId: media.bindingId,
        assetId: media.assetId,
        assetVersion: media.assetVersion,
        assetSha256: media.assetSha256,
        sources: media.srcset,
      }
      const existing = entries.get(identity)
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) throw new Error('Managed page media identity is inconsistent.')
      entries.set(identity, candidate)
    }
  }
  return [...entries.values()].sort((left, right) => codeUnitCompare(left.bindingId, right.bindingId))
}

export function managedPageRouteSlug(route: string): string | null {
  if (route.length > 512 || !ROUTE.test(route) || route.includes('//')) return null
  if (route === '/') return 'index'
  const slug = route.split('/').filter(Boolean).join('--')
  return /^[a-z0-9][a-z0-9-]{0,127}$/u.test(slug) ? slug : null
}

export function buildManagedPageTransportEnvelope(artifactInput: unknown): ManagedPageTransportEnvelope | null {
  try {
    const artifact = validateCompiledArtifact(artifactInput)
    if (!artifact || !managedPageRouteSlug(artifact.route)) return null
    const stable = {
      version: MANAGED_PAGE_TRANSPORT_VERSION,
      route: artifact.route,
      pageType: artifact.contentType,
      artifact,
      mediaManifest: mediaManifest(artifact),
      artifactFingerprint: artifact.artifactFingerprint,
    }
    return { ...stable, transportFingerprint: canonicalFingerprint(stable) }
  } catch {
    return null
  }
}

export function serializeManagedPageTransport(artifactInput: unknown): string | null {
  const envelope = buildManagedPageTransportEnvelope(artifactInput)
  return envelope ? JSON.stringify(envelope) : null
}

export function parseManagedPageTransport(bytes: unknown): ManagedPageTransportEnvelope | null {
  try {
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > 8 * 1024 * 1024) return null
    const value = JSON.parse(bytes)
    if (!isRecord(value) || !hasExactKeys(value, ['version', 'route', 'pageType', 'artifact', 'mediaManifest', 'artifactFingerprint', 'transportFingerprint'])) return null
    const rebuilt = buildManagedPageTransportEnvelope(value.artifact)
    if (!rebuilt || JSON.stringify(rebuilt) !== bytes) return null
    return rebuilt
  } catch {
    return null
  }
}

export function managedPageTransportSha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}
