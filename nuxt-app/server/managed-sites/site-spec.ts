import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { MANAGED_SITE_CATALOG_VERSION, MANAGED_SITE_TYPES, type ManagedSiteType } from './types'

export const SITE_SPEC_VERSION = 'site-spec-v1'
export const STYLE_PROFILE_VERSION = 'style-profile-v1'
export const PREVIEW_TTL_MS = 1000 * 60 * 60 * 24

export const BUSINESS_GOALS = ['increase_inquiries', 'increase_bookings', 'sell_online', 'reduce_support', 'build_brand', 'improve_search_ai_understanding', 'membership_repurchase'] as const
export type BusinessGoal = typeof BUSINESS_GOALS[number]

export const SITE_MODULES = ['managed_content_admin', 'bounded_ai_assistant', 'shopify_commerce', 'line_assisted_integration', 'google_booking_assisted_integration', 'geo_content_subscription', 'geo_measurement_dashboard', 'pwa_reference_only'] as const
export type SiteModule = typeof SITE_MODULES[number]

export const STYLE_PREFERENCES = ['color', 'typography_mood', 'whitespace_density', 'homepage_structure', 'image_ratio', 'animation_rhythm'] as const
export type StylePreference = typeof STYLE_PREFERENCES[number]

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const PUBLIC_SPECIAL_USE = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.google.internal.', 'broadcasthost', 'ip6-allnodes', 'ip6-allrouters'])
const PRIVATE_IPV4 = /^(0\.|10\.|100\.(?:6[4-9]|[78]\d)\.|127\.|169\.254\.|192\.0\.0\.|192\.0\.2\.|192\.168\.|198\.18\.|198\.19\.|198\.51\.100\.|203\.0\.113\.|172\.(?:1[6-9]|2\d|3[01])\.)/
const PRIVATE_IPV6 = /^(?:::1|::ffff:|::ffff:0:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:|ff[0-9a-f]{2}:|2001:(?:0?0?0?0|0?0?0?2|0?0?0?10|0?0?0?20|0?0?0?30|db8|3f{2,3}):|100:)/i
const RESERVED_PUBLIC_SUFFIXES = ['.localhost', '.local', '.onion', '.test', '.invalid', '.example']
const SENSITIVE_QUERY_KEYS = /^(?:token|access_token|auth|authorization|password|passwd|secret|api[_-]?key|key|code|signature|sig)$/i

export type StyleReferenceInput = {
  url: string
  selectedPreferences: StylePreference[]
}

export type StyleProfile = {
  schemaVersion: typeof STYLE_PROFILE_VERSION
  sources: Array<{
    url: string
    selectedPreferences: StylePreference[]
    sourceHash: string
    capturedAt: string
    captureStatus: 'not_fetched'
  }>
  extractedFeatures: {
    palette: 'customer_selected_preference' | 'not_analyzed'
    typographyMood: 'customer_selected_preference' | 'not_analyzed'
    whitespaceDensity: 'customer_selected_preference' | 'not_analyzed'
    homepageStructure: 'customer_selected_preference' | 'not_analyzed'
    imageRatio: 'customer_selected_preference' | 'not_analyzed'
    animationRhythm: 'customer_selected_preference' | 'not_analyzed'
  }
  limitations: string[]
  profileFingerprint: string
}

export type SiteSpec = {
  schemaVersion: typeof SITE_SPEC_VERSION
  draftIdentity: string
  locale: 'en' | 'zh-hant'
  businessIdentity: {
    brandName: string
    audience: string
    brief: string
  }
  businessGoals: BusinessGoal[]
  siteType: ManagedSiteType
  pageCatalog: Array<'home' | 'about' | 'services' | 'faq' | 'contact' | 'blog' | 'shop'>
  navigation: Array<{ label: string; page: string }>
  designTokens: {
    colorPrimary: string
    colorAccent: string
    colorSurface: string
    colorText: string
    typographyMood: 'editorial' | 'modern' | 'warm' | 'technical'
    density: 'airy' | 'balanced' | 'compact'
    imageRatio: 'landscape' | 'square' | 'portrait'
    animationRhythm: 'still' | 'subtle' | 'expressive'
  }
  selectedModules: SiteModule[]
  seoGeoStructuralRequirements: {
    semanticHeadingHierarchy: true
    faqQuestionBlocks: boolean
    organizationSchema: true
    serviceSchema: boolean
    productSchema: boolean
    internalLinkPlan: true
    aiReadableSummary: true
  }
  approvedEvidenceReferences: Array<{ sourceId: number; artifactId?: number | null; locator?: string; artifactHash?: string; approvedAt?: string; purpose: 'diagnosis' | 'recommendation' | 'content_draft' }>
  contentProvenance: {
    source: 'customer_brief' | 'diagnosis_projection' | 'approved_evidence'
    evidenceSnapshotHash: string | null
  }
  diagnosisBinding: { diagnosisId: number; findingIds: string[] } | null
  styleReferenceProfile: StyleProfile | null
  limitations: string[]
  generatorVersion: string
  catalogVersion: typeof MANAGED_SITE_CATALOG_VERSION
  deterministicFingerprint: string
}

export type SiteBriefInput = {
  draftIdentity: string
  locale?: 'en' | 'zh-hant'
  brandName: string
  audience: string
  brief: string
  businessGoals: BusinessGoal[]
  siteType?: ManagedSiteType
  selectedModules?: SiteModule[]
  styleReferences?: StyleReferenceInput[]
  approvedEvidenceReferences?: Array<{ sourceId: number; artifactId?: number | null; locator?: string; artifactHash?: string; approvedAt?: string; purpose: 'diagnosis' | 'recommendation' | 'content_draft' }>
  diagnosisProjection?: { issueKeys: string[]; limitations: string[] }
  existingSiteUrl?: string
  diagnosisId?: number
  diagnosisFindingIds?: string[]
  resolvedEvidenceSnapshotHash?: string
  diagnosisBinding?: { diagnosisId: number; findingIds?: string[] }
}

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[]
}

function stringField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`${label} is invalid.`)
  return value.trim()
}

function assertHttpsPublicUrl(value: string, label: string, rejectSensitiveQuery: boolean): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { invalid(`${label} is invalid.`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) invalid(`${label} must be public HTTPS on the standard port.`)
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const queryKeys = [...parsed.searchParams.keys()]
  if (!hostname || PUBLIC_SPECIAL_USE.has(hostname) || RESERVED_PUBLIC_SUFFIXES.some(suffix => hostname === suffix.slice(1) || hostname.endsWith(suffix)) || PRIVATE_IPV4.test(hostname) || PRIVATE_IPV6.test(hostname) || hostname.includes(':') || !hostname.includes('.') || (rejectSensitiveQuery && queryKeys.some(key => SENSITIVE_QUERY_KEYS.test(key)))) invalid(`${label} is not an allowed public host.`)
  parsed.hash = ''
  return parsed.toString()
}

export function assertPublicReferenceUrl(value: string): string {
  return assertHttpsPublicUrl(value, 'Style reference URL', false)
}

export function assertExistingSiteUrl(value: string): string {
  return assertHttpsPublicUrl(value, 'Existing site URL', true)
}

export function normalizeStyleReferences(input: unknown): StyleReferenceInput[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input) || input.length > 3) invalid('At most three style reference URLs are allowed.')
  const normalized = input.map((item, index) => {
    if (!item || typeof item !== 'object') invalid(`Style reference ${index + 1} is invalid.`)
    const candidate = item as { url?: unknown; selectedPreferences?: unknown }
    const url = assertPublicReferenceUrl(stringField(candidate.url, `Style reference ${index + 1} URL`, 2048))
    if (!Array.isArray(candidate.selectedPreferences) || candidate.selectedPreferences.length < 1) invalid(`Style reference ${index + 1} must select at least one preference.`)
    const selectedPreferences = uniqueSorted(candidate.selectedPreferences.filter((value): value is StylePreference => typeof value === 'string') as StylePreference[])
    if (!selectedPreferences.every(value => (STYLE_PREFERENCES as readonly string[]).includes(value))) invalid(`Style reference ${index + 1} contains an unsupported preference.`)
    return { url, selectedPreferences }
  })
  const keys = normalized.map(item => item.url)
  if (new Set(keys).size !== keys.length) invalid('Style reference URLs must be unique.')
  return normalized
}

export function buildStyleProfile(input: unknown, capturedAt = new Date()): StyleProfile | null {
  const references = normalizeStyleReferences(input)
  if (!references.length) return null
  if (!Number.isFinite(capturedAt.getTime())) invalid('Style profile clock is invalid.')
  const sources = references.map(reference => ({ url: reference.url, selectedPreferences: reference.selectedPreferences, sourceHash: stableFingerprint(reference), capturedAt: capturedAt.toISOString(), captureStatus: 'not_fetched' as const }))
  const selected = new Set(sources.flatMap(source => source.selectedPreferences))
  const profile: StyleProfile = {
    schemaVersion: STYLE_PROFILE_VERSION,
    sources,
    extractedFeatures: {
      palette: selected.has('color') ? 'customer_selected_preference' : 'not_analyzed',
      typographyMood: selected.has('typography_mood') ? 'customer_selected_preference' : 'not_analyzed',
      whitespaceDensity: selected.has('whitespace_density') ? 'customer_selected_preference' : 'not_analyzed',
      homepageStructure: selected.has('homepage_structure') ? 'customer_selected_preference' : 'not_analyzed',
      imageRatio: selected.has('image_ratio') ? 'customer_selected_preference' : 'not_analyzed',
      animationRhythm: selected.has('animation_rhythm') ? 'customer_selected_preference' : 'not_analyzed',
    },
    limitations: ['No external fetch or crawler execution is performed in V1.', 'Only design characteristics are used; source code, copy, logo, images and scripts are never copied.', 'A preview is not a deployed customer website.'],
    profileFingerprint: stableFingerprint({ schemaVersion: STYLE_PROFILE_VERSION, sources, selected: [...selected].sort() }),
  }
  return profile
}

function defaultSiteType(goals: BusinessGoal[]): ManagedSiteType {
  if (goals.includes('sell_online')) return 'simple_commerce'
  if (goals.includes('build_brand') || goals.includes('membership_repurchase')) return 'brand_blog'
  return 'one_page'
}

function defaultModules(goals: BusinessGoal[], siteType: ManagedSiteType): SiteModule[] {
  const modules: SiteModule[] = ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard']
  if (goals.includes('reduce_support')) modules.push('bounded_ai_assistant')
  if (goals.includes('sell_online') || siteType === 'simple_commerce') modules.push('shopify_commerce')
  if (goals.includes('increase_bookings')) modules.push('google_booking_assisted_integration')
  return uniqueSorted(modules)
}

function tokens(profile: StyleProfile | null): SiteSpec['designTokens'] {
  const selected = new Set(profile?.sources.flatMap(source => source.selectedPreferences) || [])
  return {
    colorPrimary: selected.has('color') ? '#315bd6' : '#315bd6',
    colorAccent: selected.has('color') ? '#ff7a59' : '#ff7a59',
    colorSurface: '#f7f5ef',
    colorText: '#17233b',
    typographyMood: selected.has('typography_mood') ? 'editorial' : 'modern',
    density: selected.has('whitespace_density') ? 'airy' : 'balanced',
    imageRatio: selected.has('image_ratio') ? 'landscape' : 'landscape',
    animationRhythm: selected.has('animation_rhythm') ? 'subtle' : 'subtle',
  }
}

function pagesFor(siteType: ManagedSiteType, goals: BusinessGoal[]): SiteSpec['pageCatalog'] {
  const pages: SiteSpec['pageCatalog'] = ['home', 'services', 'contact']
  if (siteType === 'brand_blog' || goals.includes('build_brand')) pages.push('about', 'blog', 'faq')
  if (siteType === 'simple_commerce') pages.push('shop', 'faq')
  return uniqueSorted(pages) as SiteSpec['pageCatalog']
}

export function buildSiteSpec(input: unknown, capturedAt = new Date()): SiteSpec {
  if (!input || typeof input !== 'object') invalid('Site brief is invalid.')
  const candidate = input as Partial<SiteBriefInput>
  const draftIdentity = stringField(candidate.draftIdentity, 'Draft identity', 160)
  const brandName = stringField(candidate.brandName, 'Brand name', 160)
  const audience = stringField(candidate.audience, 'Audience', 300)
  const brief = stringField(candidate.brief, 'Business brief', 4000)
  if (!Array.isArray(candidate.businessGoals) || !candidate.businessGoals.length || candidate.businessGoals.length > BUSINESS_GOALS.length) invalid('At least one supported business goal is required.')
  const businessGoals = uniqueSorted(candidate.businessGoals.filter((value): value is BusinessGoal => typeof value === 'string') as BusinessGoal[])
  if (!businessGoals.every(value => (BUSINESS_GOALS as readonly string[]).includes(value))) invalid('Business goal is not supported.')
  const siteType = candidate.siteType || defaultSiteType(businessGoals)
  if (!(MANAGED_SITE_TYPES as readonly string[]).includes(siteType)) invalid('Site type is not available in V1.')
  const styleReferenceProfile = buildStyleProfile(candidate.styleReferences, capturedAt)
  const selectedModules = candidate.selectedModules ? uniqueSorted(candidate.selectedModules.filter((value): value is SiteModule => typeof value === 'string') as SiteModule[]) : defaultModules(businessGoals, siteType)
  if (!selectedModules.every(value => (SITE_MODULES as readonly string[]).includes(value))) invalid('Site module is not available in V1.')
  if (siteType === 'simple_commerce' && !selectedModules.includes('shopify_commerce')) invalid('Simple commerce requires the Shopify commerce module in V1.')
  const pages = pagesFor(siteType, businessGoals)
  const navigation = pages.map(page => ({ page, label: page === 'home' ? brandName : page.replace('_', ' ') }))
  const evidence = Array.isArray(candidate.approvedEvidenceReferences) ? candidate.approvedEvidenceReferences.map(reference => ({ sourceId: Number(reference.sourceId), artifactId: reference.artifactId === null || reference.artifactId === undefined ? null : Number(reference.artifactId), locator: typeof reference.locator === 'string' ? reference.locator : undefined, artifactHash: typeof reference.artifactHash === 'string' ? reference.artifactHash : undefined, approvedAt: typeof reference.approvedAt === 'string' ? reference.approvedAt : undefined, purpose: reference.purpose })) : []
  if (evidence.some(reference => !Number.isSafeInteger(reference.sourceId) || reference.sourceId < 1 || (reference.artifactId !== null && (!Number.isSafeInteger(reference.artifactId) || reference.artifactId < 1)) || !['diagnosis', 'recommendation', 'content_draft'].includes(reference.purpose))) invalid('Approved evidence reference is invalid.')
  const limitations = [
    'AI visibility, ranking, traffic, conversion and revenue are not guaranteed or inferred from this preview.',
    'External provider calls, domain purchase, DNS, payment and deployment are not executed in concept or preview mode.',
    ...(candidate.diagnosisProjection?.limitations || []),
  ].filter((value, index, list) => typeof value === 'string' && value.trim() && list.indexOf(value) === index).slice(0, 12)
  const resolvedEvidenceSnapshotHash = typeof candidate.resolvedEvidenceSnapshotHash === 'string' ? candidate.resolvedEvidenceSnapshotHash : null
  if (resolvedEvidenceSnapshotHash !== null && !/^[a-f0-9]{64}$/i.test(resolvedEvidenceSnapshotHash)) invalid('Resolved evidence snapshot hash is invalid.')
  const diagnosisBinding = candidate.diagnosisBinding ? { diagnosisId: Number(candidate.diagnosisBinding.diagnosisId), findingIds: Array.isArray(candidate.diagnosisBinding.findingIds) ? candidate.diagnosisBinding.findingIds.map(value => String(value)).sort() : [] } : null
  if (diagnosisBinding && (!Number.isSafeInteger(diagnosisBinding.diagnosisId) || diagnosisBinding.diagnosisId < 1 || new Set(diagnosisBinding.findingIds).size !== diagnosisBinding.findingIds.length)) invalid('Diagnosis binding is invalid.')
  const draft: Omit<SiteSpec, 'deterministicFingerprint'> = {
    schemaVersion: SITE_SPEC_VERSION,
    draftIdentity,
    locale: candidate.locale === 'en' ? 'en' : 'zh-hant',
    businessIdentity: { brandName, audience, brief },
    businessGoals,
    siteType,
    pageCatalog: pages,
    navigation,
    designTokens: tokens(styleReferenceProfile),
    selectedModules,
    seoGeoStructuralRequirements: {
      semanticHeadingHierarchy: true,
      faqQuestionBlocks: pages.includes('faq'),
      organizationSchema: true,
      serviceSchema: pages.includes('services'),
      productSchema: siteType === 'simple_commerce',
      internalLinkPlan: true,
      aiReadableSummary: true,
    },
    approvedEvidenceReferences: evidence,
    contentProvenance: { source: candidate.diagnosisProjection ? 'diagnosis_projection' : evidence.length ? 'approved_evidence' : 'customer_brief', evidenceSnapshotHash: resolvedEvidenceSnapshotHash },
    diagnosisBinding,
    styleReferenceProfile,
    limitations,
    generatorVersion: 'managed-site-generator-v1',
    catalogVersion: MANAGED_SITE_CATALOG_VERSION,
  }
  return { ...draft, deterministicFingerprint: stableFingerprint(draft) }
}

export function parseSiteSpecSnapshot(input: unknown): SiteSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Persisted SiteSpec is invalid.')
  const candidate = input as Partial<SiteSpec>
  if (candidate.schemaVersion !== SITE_SPEC_VERSION || typeof candidate.deterministicFingerprint !== 'string' || !candidate.businessIdentity || typeof candidate.businessIdentity !== 'object') invalid('Persisted SiteSpec version or identity is invalid.')
  if (!Array.isArray(candidate.businessGoals) || !candidate.businessGoals.length || candidate.businessGoals.some(value => typeof value !== 'string' || !(BUSINESS_GOALS as readonly string[]).includes(value))) invalid('Persisted SiteSpec business goals are invalid.')
  if (!Array.isArray(candidate.selectedModules) || !candidate.selectedModules.length || candidate.selectedModules.some(value => typeof value !== 'string' || !(SITE_MODULES as readonly string[]).includes(value))) invalid('Persisted SiteSpec modules are invalid.')
  if (new Set(candidate.selectedModules).size !== candidate.selectedModules.length) invalid('Persisted SiteSpec modules contain duplicates.')
  if (!candidate.siteType || !(MANAGED_SITE_TYPES as readonly string[]).includes(candidate.siteType)) invalid('Persisted SiteSpec site type is invalid.')
  if (!Array.isArray(candidate.approvedEvidenceReferences)) invalid('Persisted SiteSpec evidence references are invalid.')
  const evidenceKeys = candidate.approvedEvidenceReferences.map(reference => `${reference.sourceId}:${reference.artifactId ?? 'none'}`)
  if (new Set(evidenceKeys).size !== evidenceKeys.length) invalid('Persisted SiteSpec evidence references contain duplicates.')
  if (candidate.approvedEvidenceReferences.some(reference => !Number.isSafeInteger(reference.sourceId) || reference.sourceId < 1 || (reference.artifactId !== null && reference.artifactId !== undefined && (!Number.isSafeInteger(reference.artifactId) || reference.artifactId < 1)) || (reference.artifactHash !== undefined && !/^[a-f0-9]{64}$/i.test(reference.artifactHash)) || (reference.approvedAt !== undefined && (!Number.isFinite(Date.parse(reference.approvedAt)) || Date.parse(reference.approvedAt) > Date.now())) || !['diagnosis', 'recommendation', 'content_draft'].includes(reference.purpose))) invalid('Persisted SiteSpec evidence reference is invalid.')
  if (!candidate.contentProvenance || typeof candidate.contentProvenance !== 'object') invalid('Persisted SiteSpec content provenance is invalid.')
  const provenance = candidate.contentProvenance
  if (!['customer_brief', 'diagnosis_projection', 'approved_evidence'].includes(provenance.source)) invalid('Persisted SiteSpec provenance source is invalid.')
  if (provenance.source !== 'customer_brief' && (typeof provenance.evidenceSnapshotHash !== 'string' || !/^[a-f0-9]{64}$/i.test(provenance.evidenceSnapshotHash))) invalid('Persisted SiteSpec requires a canonical evidence snapshot hash.')
  if (provenance.source === 'customer_brief' && provenance.evidenceSnapshotHash !== null) invalid('Customer-brief SiteSpec cannot claim an evidence snapshot.')
  if (candidate.diagnosisBinding !== null) {
    if (!candidate.diagnosisBinding || !Number.isSafeInteger(candidate.diagnosisBinding.diagnosisId) || candidate.diagnosisBinding.diagnosisId < 1 || !Array.isArray(candidate.diagnosisBinding.findingIds) || new Set(candidate.diagnosisBinding.findingIds).size !== candidate.diagnosisBinding.findingIds.length) invalid('Persisted SiteSpec diagnosis binding is invalid.')
    if (provenance.source !== 'diagnosis_projection') invalid('Persisted SiteSpec diagnosis binding has an invalid provenance source.')
  }
  const { deterministicFingerprint, ...withoutFingerprint } = candidate as SiteSpec
  if (stableFingerprint(withoutFingerprint) !== deterministicFingerprint) invalid('Persisted SiteSpec fingerprint mismatch.')
  return candidate as SiteSpec
}

export function buildPreviewProjection(spec: SiteSpec, previewId: string, expiresAt = new Date(Date.now() + PREVIEW_TTL_MS)) {
  if (!previewId || !Number.isFinite(expiresAt.getTime())) invalid('Preview identity or expiry is invalid.')
  return {
    previewId,
    previewOnly: true as const,
    status: 'generated' as const,
    expiresAt: expiresAt.toISOString(),
    fingerprint: stableFingerprint({ previewId, specFingerprint: spec.deterministicFingerprint, expiresAt: expiresAt.toISOString() }),
    siteType: spec.siteType,
    brandName: spec.businessIdentity.brandName,
    pages: spec.pageCatalog,
    modules: spec.selectedModules,
    designTokens: spec.designTokens,
    limitations: spec.limitations,
    claims: { paymentVerified: false, domainPurchased: false, dnsVerified: false, deployed: false },
  }
}
