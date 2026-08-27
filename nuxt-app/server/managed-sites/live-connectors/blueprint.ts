import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { SITE_MODULES, type SiteModule, type SiteSpec } from '../site-spec'
import type { ManagedSiteBlueprintProviderOutput, ManagedSiteBlueprintSectionV1, ManagedSiteBlueprintV1, ManagedSiteGeneratedFile, ManagedSiteGenerationRequest } from './types'

export const MANAGED_SITE_BLUEPRINT_MAX_BYTES = 256_000
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const ACTIVE_CONTENT = /<\s*\/?\s*(?:script|iframe|object|embed|base)|\bon[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous(?:\s+(?:system|developer))?|system|developer)\s+(?:instructions?|prompts?)/iu
const SAFE_ROUTE = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/u
const PAGE_KEYS = ['home', 'about', 'services', 'faq', 'contact', 'blog', 'shop'] as const
const SECTION_KINDS = ['hero', 'summary', 'services', 'about', 'contact', 'blog_index', 'shop_index', 'faq', 'module_slot'] as const
const MODULE_MODES: Record<SiteModule, 'safe_placeholder' | 'first_party'> = {
  managed_content_admin: 'first_party',
  bounded_ai_assistant: 'safe_placeholder',
  shopify_commerce: 'safe_placeholder',
  line_assisted_integration: 'safe_placeholder',
  google_booking_assisted_integration: 'safe_placeholder',
  geo_content_subscription: 'first_party',
  geo_measurement_dashboard: 'first_party',
  pwa_reference_only: 'safe_placeholder',
}

function blocked(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) }
function exact(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) blocked('Managed-site blueprint contains missing or unknown fields.') }
function text(value: unknown, label: string, maxBytes = 8_000): string {
  if (typeof value !== 'string') blocked(`${label} is invalid.`)
  const normalized = value.normalize('NFC').trim()
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || TEXT_CONTROL.test(normalized) || ACTIVE_CONTENT.test(normalized)) blocked(`${label} is unsafe or oversized.`)
  return normalized
}
function nullableText(value: unknown, label: string, maxBytes = 1_000): string | null { return value === null ? null : text(value, label, maxBytes) }
function route(value: unknown): string { const candidate = text(value, 'Blueprint route', 120); if (!SAFE_ROUTE.test(candidate) || candidate.includes('..') || candidate.includes('//')) blocked('Blueprint route is outside the fixed route allowlist.'); return candidate }
function safeHref(value: unknown): string | null {
  if (value === null) return null
  const candidate = text(value, 'Blueprint CTA href', 240)
  if (!/^(?:\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?|#[a-z][a-z0-9-]*)$/u.test(candidate)) blocked('Blueprint CTA URL is not an internal route or anchor.')
  return candidate
}
function expectedPageKeys(siteType: SiteSpec['siteType']): Array<typeof PAGE_KEYS[number]> {
  if (siteType === 'one_page') return ['home']
  if (siteType === 'brand_blog') return ['home', 'about', 'services', 'faq', 'contact', 'blog']
  return ['home', 'services', 'faq', 'contact', 'shop']
}
function expectedRoute(pageKey: typeof PAGE_KEYS[number]): string { return pageKey === 'home' ? '/' : `/${pageKey}` }

export function validateManagedSiteBlueprintProviderOutput(input: unknown, request: ManagedSiteGenerationRequest, providerKey: string): { output: ManagedSiteBlueprintProviderOutput; blueprint: ManagedSiteBlueprintV1; blueprintHash: string } {
  if (!record(input) || Buffer.byteLength(JSON.stringify(input), 'utf8') > MANAGED_SITE_BLUEPRINT_MAX_BYTES) blocked('Managed-site blueprint provider output is malformed or oversized.')
  exact(input, ['schemaVersion', 'providerKey', 'providerModel', 'providerRequestId', 'requestFingerprint', 'blueprint', 'blueprintHash'])
  if (input.schemaVersion !== 'managed-site-blueprint-provider-response-v1' || input.providerKey !== providerKey || input.requestFingerprint !== request.requestFingerprint) blocked('Managed-site blueprint provider identity is mismatched.')
  const providerModel = text(input.providerModel, 'Blueprint provider model', 128)
  const providerRequestId = text(input.providerRequestId, 'Blueprint provider request identity', 160)
  if (!record(input.blueprint)) blocked('Managed-site blueprint is missing.')
  const raw = input.blueprint
  exact(raw, ['schemaVersion', 'brandName', 'locale', 'siteType', 'navigation', 'pages', 'faq', 'selectedModulePlacements', 'seoGeo', 'provenance'])
  const spec = request.siteSpec as SiteSpec
  if (raw.schemaVersion !== 'managed-site-blueprint-v1' || raw.locale !== spec.locale || raw.siteType !== spec.siteType || text(raw.brandName, 'Blueprint brand', 160) !== spec.businessIdentity.brandName) blocked('Managed-site blueprint does not match the exact SiteSpec identity.')
  const pageKeys = expectedPageKeys(spec.siteType)
  if (!Array.isArray(raw.pages) || raw.pages.length !== pageKeys.length) blocked('Managed-site blueprint page coverage is incomplete or excessive.')
  const pages = raw.pages.map((item, pageIndex) => {
    if (!record(item)) blocked('Managed-site blueprint page is malformed.')
    exact(item, ['pageKey', 'route', 'title', 'description', 'sections'])
    const pageKey = item.pageKey
    if (typeof pageKey !== 'string' || !pageKeys.includes(pageKey as any) || pageKeys[pageIndex] !== pageKey || route(item.route) !== expectedRoute(pageKey as any)) blocked('Managed-site blueprint pages are not in the deterministic SiteSpec order.')
    if (!Array.isArray(item.sections) || item.sections.length < 1 || item.sections.length > 30) blocked('Managed-site blueprint sections are incomplete or excessive.')
    const sectionIds = new Set<string>()
    const sections = item.sections.map(section => {
      if (!record(section)) blocked('Managed-site blueprint section is malformed.')
      exact(section, ['sectionId', 'kind', 'heading', 'body', 'ctaLabel', 'ctaHref', 'moduleKey'])
      const sectionId = text(section.sectionId, 'Blueprint section id', 80)
      if (!/^[a-z][a-z0-9-]{0,79}$/u.test(sectionId) || sectionIds.has(sectionId)) blocked('Managed-site blueprint section identity is invalid or duplicated.')
      sectionIds.add(sectionId)
      if (typeof section.kind !== 'string' || !(SECTION_KINDS as readonly string[]).includes(section.kind)) blocked('Managed-site blueprint section kind is unsupported.')
      const moduleKey = section.moduleKey === null ? null : text(section.moduleKey, 'Blueprint module key', 96)
      if ((section.kind === 'module_slot') !== Boolean(moduleKey)) blocked('Managed-site module slots require exactly one module identity.')
      return { sectionId, kind: section.kind, heading: text(section.heading, 'Blueprint section heading', 300), body: text(section.body, 'Blueprint section body'), ctaLabel: nullableText(section.ctaLabel, 'Blueprint CTA label', 160), ctaHref: safeHref(section.ctaHref), moduleKey } as ManagedSiteBlueprintSectionV1
    })
    return { pageKey: pageKey as typeof PAGE_KEYS[number], route: expectedRoute(pageKey as any), title: text(item.title, 'Blueprint page title', 200), description: text(item.description, 'Blueprint page description', 500), sections }
  })
  if (!Array.isArray(raw.navigation) || raw.navigation.length !== pages.length) blocked('Managed-site blueprint navigation must exactly cover compiled pages.')
  const navigation = raw.navigation.map((item, index) => { if (!record(item)) blocked('Blueprint navigation is malformed.'); exact(item, ['label', 'route']); const expected = pages[index]?.route; if (!expected || route(item.route) !== expected) blocked('Blueprint navigation route does not match page order.'); return { label: text(item.label, 'Blueprint navigation label', 120), route: expected } })
  if (!Array.isArray(raw.selectedModulePlacements) || raw.selectedModulePlacements.length !== request.selectedModules.length) blocked('Blueprint module placement count does not match selected modules.')
  const selected = [...request.selectedModules].sort()
  const placements = raw.selectedModulePlacements.map(item => {
    if (!record(item)) blocked('Blueprint module placement is malformed.')
    exact(item, ['moduleKey', 'pageKey', 'sectionId', 'mode'])
    const moduleKey = text(item.moduleKey, 'Blueprint module placement key', 96)
    if (!(SITE_MODULES as readonly string[]).includes(moduleKey) || item.mode !== MODULE_MODES[moduleKey as SiteModule]) blocked('Blueprint module placement is unsupported or uses an unsafe mode.')
    const page = pages.find(candidate => candidate.pageKey === item.pageKey)
    if (!page || !page.sections.some(section => section.sectionId === item.sectionId && section.kind === 'module_slot' && section.moduleKey === moduleKey)) blocked('Blueprint module placement does not reference its exact allowlisted slot.')
    return { moduleKey, pageKey: String(item.pageKey), sectionId: String(item.sectionId), mode: item.mode as 'safe_placeholder' | 'first_party' }
  }).sort((left, right) => left.moduleKey.localeCompare(right.moduleKey))
  if (new Set(placements.map(item => item.moduleKey)).size !== placements.length || placements.some((item, index) => item.moduleKey !== selected[index])) blocked('Blueprint selected module coverage is missing, duplicated, or excessive.')
  if (!Array.isArray(raw.faq) || raw.faq.length > 20) blocked('Blueprint FAQ is oversized.')
  const faq = raw.faq.map(item => { if (!record(item)) blocked('Blueprint FAQ item is malformed.'); exact(item, ['question', 'answer']); return { question: text(item.question, 'Blueprint FAQ question', 400), answer: text(item.answer, 'Blueprint FAQ answer', 2_000) } })
  if (!record(raw.seoGeo)) blocked('Blueprint SEO/GEO structure is malformed.')
  exact(raw.seoGeo, ['summaryAnswer', 'canonicalPlaceholder', 'organizationName', 'evidenceLimitations', 'structuredDataKinds'])
  if (raw.seoGeo.canonicalPlaceholder !== '{{CANONICAL_ORIGIN}}') blocked('Blueprint canonical identity must remain an inert placeholder until release binding.')
  if (!Array.isArray(raw.seoGeo.evidenceLimitations) || raw.seoGeo.evidenceLimitations.length < 1 || raw.seoGeo.evidenceLimitations.length > 20) blocked('Blueprint evidence limitations are incomplete.')
  if (!Array.isArray(raw.seoGeo.structuredDataKinds) || raw.seoGeo.structuredDataKinds.some(item => !['Organization', 'Service', 'Product', 'FAQPage'].includes(String(item))) || new Set(raw.seoGeo.structuredDataKinds).size !== raw.seoGeo.structuredDataKinds.length) blocked('Blueprint structured metadata kinds are invalid.')
  if (!record(raw.provenance)) blocked('Blueprint provenance is malformed.')
  exact(raw.provenance, ['evidenceSnapshotHash', 'authoritySourceIds', 'providerContentHash'])
  if (raw.provenance.evidenceSnapshotHash !== request.evidenceConstraints.evidenceSnapshotHash || !Array.isArray(raw.provenance.authoritySourceIds) || JSON.stringify([...raw.provenance.authoritySourceIds].sort()) !== JSON.stringify([...request.evidenceConstraints.authoritySourceIds].sort()) || typeof raw.provenance.providerContentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.provenance.providerContentHash)) blocked('Blueprint provenance is not bound to the exact evidence request.')
  const blueprint: ManagedSiteBlueprintV1 = { schemaVersion: 'managed-site-blueprint-v1', brandName: spec.businessIdentity.brandName, locale: spec.locale, siteType: spec.siteType, navigation, pages, faq, selectedModulePlacements: placements, seoGeo: { summaryAnswer: text(raw.seoGeo.summaryAnswer, 'Blueprint GEO summary', 2_000), canonicalPlaceholder: '{{CANONICAL_ORIGIN}}', organizationName: text(raw.seoGeo.organizationName, 'Blueprint organization', 160), evidenceLimitations: raw.seoGeo.evidenceLimitations.map(item => text(item, 'Blueprint evidence limitation', 1_000)), structuredDataKinds: raw.seoGeo.structuredDataKinds as ManagedSiteBlueprintV1['seoGeo']['structuredDataKinds'] }, provenance: { evidenceSnapshotHash: String(raw.provenance.evidenceSnapshotHash), authoritySourceIds: [...request.evidenceConstraints.authoritySourceIds].sort(), providerContentHash: String(raw.provenance.providerContentHash) } }
  const blueprintHash = stableFingerprint(blueprint)
  if (input.blueprintHash !== blueprintHash) blocked('Blueprint hash does not match the deterministic structured result.')
  return { output: { schemaVersion: 'managed-site-blueprint-provider-response-v1', providerKey, providerModel, providerRequestId, requestFingerprint: request.requestFingerprint, blueprint, blueprintHash }, blueprint, blueprintHash }
}

function escapeHtml(value: string): string { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;') }
function sha256(value: string): string { return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex') }

export function compileManagedSiteBlueprint(blueprint: ManagedSiteBlueprintV1): ManagedSiteGeneratedFile[] {
  const navigation = blueprint.navigation.map(item => `<a href="${item.route}">${escapeHtml(item.label)}</a>`).join('')
  const files: ManagedSiteGeneratedFile[] = blueprint.pages.map(page => {
    const sections = page.sections.map(section => `<section id="${section.sectionId}" data-section-kind="${section.kind}"${section.moduleKey ? ` data-module-slot="${section.moduleKey}"` : ''}><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p>${section.ctaLabel && section.ctaHref ? `<a class="cta" href="${section.ctaHref}">${escapeHtml(section.ctaLabel)}</a>` : ''}${section.kind === 'module_slot' ? '<p class="module-note">Configuration is completed only through the private owner workbench. This preview performs no external action.</p>' : ''}</section>`).join('')
    const faq = page.pageKey === 'faq' ? `<section id="faq-items" data-schema-kind="FAQPage">${blueprint.faq.map(item => `<article><h2>${escapeHtml(item.question)}</h2><p>${escapeHtml(item.answer)}</p></article>`).join('')}</section>` : ''
    const metadata = escapeHtml(JSON.stringify({ canonical: blueprint.seoGeo.canonicalPlaceholder, kinds: blueprint.seoGeo.structuredDataKinds, evidenceLimitations: blueprint.seoGeo.evidenceLimitations }))
    const content = `---\nimport '../styles/site.css'\nconst managedMetadata = ${JSON.stringify(metadata)}\n---\n<!doctype html><html lang="${blueprint.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeHtml(page.description)}"><meta name="managed-site-structured-metadata" content={managedMetadata}></head><body><header><strong>${escapeHtml(blueprint.brandName)}</strong><nav aria-label="Primary">${navigation}</nav></header><main><h1>${escapeHtml(page.title)}</h1><p class="geo-summary">${escapeHtml(blueprint.seoGeo.summaryAnswer)}</p>${sections}${faq}</main><footer><p>${escapeHtml(blueprint.seoGeo.evidenceLimitations.join(' '))}</p></footer></body></html>`
    const path = page.pageKey === 'home' ? 'src/pages/index.astro' : `src/pages/${page.pageKey}.astro`
    return { path, mediaType: 'text/astro' as const, content, sha256: sha256(content) }
  })
  const css = ':root{font-family:system-ui,sans-serif;color:#17233b;background:#f7f5ef}body{margin:0}header,main,footer{max-width:72rem;margin:auto;padding:1.5rem}nav{display:flex;gap:1rem;flex-wrap:wrap}section{padding:2rem 0;border-bottom:1px solid #d8d4c8}.cta{display:inline-block;padding:.7rem 1rem;background:#315bd6;color:#fff}.module-note{font-size:.9rem;color:#536176}'
  files.push({ path: 'src/styles/site.css', mediaType: 'text/css', content: css, sha256: sha256(css) })
  const robots = 'User-agent: *\nDisallow: /\n# Preview candidate only. Release compiler replaces this policy after verified deployment.\n'
  files.push({ path: 'public/robots.txt', mediaType: 'text/markdown', content: robots, sha256: sha256(robots) })
  const llms = `${blueprint.brandName}\n\n${blueprint.seoGeo.summaryAnswer}\n\nLimitations:\n${blueprint.seoGeo.evidenceLimitations.map(item => `- ${item}`).join('\n')}`
  files.push({ path: 'public/llms.txt', mediaType: 'text/markdown', content: llms, sha256: sha256(llms) })
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

export function blueprintCompilerFingerprint(blueprint: ManagedSiteBlueprintV1, files: readonly ManagedSiteGeneratedFile[]): string {
  return stableFingerprint({ compilerVersion: 'managed-site-first-party-compiler-v1', blueprintHash: stableFingerprint(blueprint), files: files.map(file => ({ path: file.path, mediaType: file.mediaType, sha256: file.sha256 })) })
}
