import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { assertPublicHttpsUrl, normalizePublicHttpsOrigin } from '../../content-operations/normalization'
import type { ManagedSiteArtifactVaultBundle } from '../live-connectors/generation-service'
import { renderManagedSiteStaticAssets, type ManagedSiteStaticAsset } from '../live-connectors/internal-broker/static-renderer'
import type { ManagedSiteBlueprintV1 } from '../live-connectors/types'
import { renderManagedSiteMetadataHead as metadataHead } from '../seo-metadata'
import { buildManagedPageTransportEnvelope } from './transport'
import type { CompiledPageArtifact, ResponsiveMediaProjection } from './types'

const HTML = 'text/html; charset=utf-8'
const ARTICLE_TYPES = new Set(['article', 'faq', 'service_page'])
const MEDIA_REFERENCE = /^media-ref:([a-f0-9]{64}):([1-9]\d{0,5}):(jpeg|png|webp|avif)$/u
const SITE_STYLE = '*,*::before,*::after{box-sizing:border-box}:root{color-scheme:light}body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#fff;line-height:1.65}header,main,footer{width:min(72rem,calc(100% - 2rem));margin:auto}header{padding:1.25rem 0;border-bottom:1px solid #d9deea;display:flex;gap:1.5rem;align-items:center;justify-content:space-between}nav{display:flex;gap:1rem;flex-wrap:wrap}a{color:#3158a8}main{padding:3rem 0}section{padding:2rem 0;border-bottom:1px solid #edf0f5}h1,h2,h3{line-height:1.2}.block-grid,.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:1.25rem}.card{padding:1rem;border:1px solid #d9deea;border-radius:.6rem}.managed-media{margin:1rem 0}.managed-media img{display:block;width:100%;height:auto;border-radius:.5rem}.cta{display:inline-block;padding:.7rem 1rem;border:1px solid currentColor;border-radius:.4rem;margin:.25rem .5rem .25rem 0}.contact-form{display:grid;gap:1rem;max-width:38rem}.contact-form label{display:grid;gap:.35rem}.contact-form input,.contact-form textarea{font:inherit;padding:.7rem}.contact-form textarea{min-height:9rem}.hp-field{position:absolute;left:-9999px}.article-body{max-width:52rem}.article-body pre{white-space:pre-wrap;overflow-wrap:anywhere}.spacer{border:0}.divider-dots{text-align:center;letter-spacing:.5rem}footer{padding:2rem 0;color:#586174}'

export type ManagedSiteNativeArticle = {
  publicationId: string
  slug: string
  title: string
  body: string
  contentHash: string
  contentType: 'article' | 'faq' | 'service_page'
  language: 'en' | 'zh-hant'
  evidenceSnapshotHash: string
}

export type ManagedSiteMediaReferenceResolver = (reference: { sha256: string; width: number; format: string }) => string

function invalid(message: string): never {
  throw Object.assign(createError({ statusCode: 409, statusMessage: message }), { reasonCode: 'NATIVE_RENDER_INVALID' })
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;')
}

function safeHref(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\\u0000-\u001f\u007f]/u.test(value)) return '#'
  if (value.startsWith('/') && !value.startsWith('//')) return escapeHtml(value)
  if (value.startsWith('#')) return escapeHtml(value)
  try {
    const url = new URL(value)
    return ['https:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password ? escapeHtml(url.toString()) : '#'
  } catch { return '#' }
}

export function managedSitePageAssetPath(route: string): string {
  if (route === '/') return 'index.html'
  const normalized = route.replace(/^\/+|\/+$/gu, '')
  if (!normalized || normalized.includes('..') || !/^[a-z0-9][a-z0-9/_-]*$/u.test(normalized)) invalid('Managed page route is invalid for native static rendering.')
  return `${normalized}/index.html`
}

export function managedSiteArticleAssetPath(article: Pick<ManagedSiteNativeArticle, 'language' | 'contentType' | 'slug'>): string {
  const section = article.contentType === 'article' ? 'articles' : article.contentType === 'faq' ? 'faq' : 'services'
  if (!['en', 'zh-hant'].includes(article.language) || !ARTICLE_TYPES.has(article.contentType) || !/^[a-z0-9][a-z0-9-]{2,159}$/u.test(article.slug)) invalid('Managed article route identity is invalid.')
  return `${article.language}/${section}/${article.slug}/index.html`
}

export function managedSiteAssetPathname(assetPath: string): string {
  if (assetPath === 'index.html') return '/'
  if (!/^(?:[a-z0-9][a-z0-9_-]*\/)*index\.html$/u.test(assetPath)) invalid('Managed-site verification asset path is invalid.')
  return `/${assetPath.slice(0, -'index.html'.length)}`
}

function navigation(blueprint: ManagedSiteBlueprintV1): string {
  return blueprint.navigation.map(item => `<a href="${safeHref(item.route)}">${escapeHtml(item.label)}</a>`).join('')
}

function designCss(design?: CompiledPageArtifact['design']): string {
  if (!design) return ''
  const colors = { indigo_sand: ['#182b4b', '#f7f5ef', '#294f9b'], charcoal_ivory: ['#202124', '#fffdf7', '#3b4148'], forest_mist: ['#18382d', '#f2f7f3', '#246147'] }[design.palette]
  const width = { narrow: '52rem', standard: '72rem', wide: '88rem' }[design.maxWidth]
  const gap = { compact: '1.25rem', balanced: '2rem', airy: '3.5rem' }[design.spacing]
  const radius = { none: '0', soft: '.5rem', rounded: '1.25rem' }[design.radius]
  const size = { compact: '.95rem', balanced: '1rem', editorial: '1.125rem' }[design.typeScale]
  if (!colors || !width || !gap || !radius || !size || !['aa', 'aaa'].includes(design.contrast)) invalid('Managed page design tokens are invalid.')
  return `body{color:${colors[0]};background:${colors[1]};font-size:${size}}header,main,footer{width:min(${width},calc(100% - 2rem))}section{padding:${gap} 0}a{color:${colors[2]}}.card,.managed-media img,.cta{border-radius:${radius}}${design.contrast === 'aaa' ? 'body{color:#101820}a{color:#123667}' : ''}`
}

function pageShell(input: { blueprint: ManagedSiteBlueprintV1; canonicalOrigin: string; locale: string; title: string; description: string; canonicalPath: string; noindex: boolean; body: string; design?: CompiledPageArtifact['design']; article?: boolean; faq?: Array<{ question: string; answer: string }> }): string {
  return `<!doctype html><html lang="${input.locale === 'zh-hant' ? 'zh-Hant' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)} — ${escapeHtml(input.blueprint.brandName)}</title><meta name="description" content="${escapeHtml(input.description)}">${input.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}${metadataHead(input)}<style>${SITE_STYLE}${designCss(input.design)}</style></head><body><header><strong>${escapeHtml(input.blueprint.brandName)}</strong><nav aria-label="Primary">${navigation(input.blueprint)}</nav></header><main>${input.body}</main><footer>${escapeHtml(input.blueprint.seoGeo.evidenceLimitations.join(' · '))}</footer></body></html>`
}

function resolvedSources(media: ResponsiveMediaProjection, resolveMediaReference: ManagedSiteMediaReferenceResolver): { src: string; srcset: string } {
  const sources = media.srcset.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const match = /^(media-ref:[a-f0-9]{64}:[1-9]\d{0,5}:(?:jpeg|png|webp|avif))\s+([1-9]\d{0,5})w$/u.exec(part)
    if (!match) invalid('Compiled page media source is malformed.')
    const reference = MEDIA_REFERENCE.exec(match[1]!)
    if (!reference || Number(reference[2]) !== Number(match[2])) invalid('Compiled page media width identity is mismatched.')
    const url = resolveMediaReference({ sha256: reference[1]!, width: Number(reference[2]), format: reference[3]! })
    let parsed: URL
    try { parsed = new URL(assertPublicHttpsUrl(url, 'Resolved media URL')) } catch { invalid('Resolved media URL is malformed or not public.') }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) invalid('Resolved media URL is not a fixed public HTTPS object URL.')
    return { url: parsed.toString(), width: Number(reference[2]) }
  })
  if (!sources.length) invalid('Compiled page media has no resolvable source.')
  return { src: sources[sources.length - 1]!.url, srcset: sources.map(source => `${escapeHtml(source.url)} ${source.width}w`).join(', ') }
}

function mediaHtml(media: ResponsiveMediaProjection, resolver: ManagedSiteMediaReferenceResolver): string {
  const sources = resolvedSources(media, resolver)
  const alt = media.decorative ? '' : media.alt
  return `<figure class="managed-media"><img src="${escapeHtml(sources.src)}" srcset="${sources.srcset}" sizes="${escapeHtml(media.sizes)}" width="${media.width}" height="${media.height}" alt="${escapeHtml(alt)}" loading="${media.loading}" fetchpriority="${media.fetchPriority}"></figure>`
}

function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function records(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>> : [] }
function linkHtml(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const link = value as Record<string, unknown>
  return typeof link.label === 'string' && typeof link.href === 'string' ? `<a class="cta" href="${safeHref(link.href)}"${link.newTab === true ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(link.label)}</a>` : ''
}

function contactForm(endpoint: string, data: Readonly<Record<string, unknown>>): string {
  const fields = Array.isArray(data.fields) ? data.fields.filter(field => ['name', 'email', 'phone', 'message'].includes(String(field))) : []
  if (!['name', 'email', 'message'].every(required => fields.includes(required))) invalid('Published contact block is missing a field required by the first-party ingest endpoint.')
  const controls: Record<string, string> = {
    name: '<label>姓名 <input name="name" type="text" maxlength="160" required></label>',
    email: '<label>Email <input name="email" type="email" maxlength="320" required></label>',
    phone: '<label>電話（選填） <input name="phone" type="tel" maxlength="64"></label>',
    message: '<label>訊息 <textarea name="message" maxlength="2000" required></textarea></label>',
  }
  const consent = data.consentRequired === true ? '<label><span><input type="checkbox" name="contactConsent" value="yes" required> 我同意提供以上資料，供網站管理者回覆這次詢問。</span></label>' : ''
  return `<form class="contact-form" method="post" action="${escapeHtml(endpoint)}" accept-charset="utf-8">${fields.map(field => controls[String(field)]).join('')}${consent}<input type="text" name="companyFax" tabindex="-1" autocomplete="off" aria-hidden="true" class="hp-field"><button type="submit">送出</button></form>`
}

function blockHtml(block: CompiledPageArtifact['blocks'][number], resolver: ManagedSiteMediaReferenceResolver, formEndpoint: string | null, articles: ManagedSiteNativeArticle[]): string {
  const data = block.data
  const media = block.media.map(item => mediaHtml(item, resolver)).join('')
  const title = text(data.title)
  const description = text(data.description)
  if (block.type === 'hero') return `<section id="${escapeHtml(block.blockId)}" data-block-type="hero"><p>${escapeHtml(text(data.eyebrow))}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>${linkHtml(data.primaryLink)}${linkHtml(data.secondaryLink)}${media}</section>`
  if (block.type === 'rich_text') {
    const nodes = Array.isArray(data.nodes) ? data.nodes : []
    const content = nodes.map(node => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return ''
      const value = node as Record<string, unknown>
      if (value.type === 'heading') return `<h${value.level === 3 ? '3' : '2'}>${escapeHtml(text(value.text))}</h${value.level === 3 ? '3' : '2'}>`
      if (value.type === 'list' && Array.isArray(value.items)) { const tag = value.ordered === true ? 'ol' : 'ul'; return `<${tag}>${value.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>` }
      return `<p>${escapeHtml(text(value.text))}</p>`
    }).join('')
    return `<section id="${escapeHtml(block.blockId)}" data-block-type="rich_text">${content}${media}</section>`
  }
  if (block.type === 'faq') return `<section id="${escapeHtml(block.blockId)}" data-block-type="faq"><h2>${escapeHtml(title)}</h2>${records(data.items).map(item => `<details><summary>${escapeHtml(text(item.question))}</summary><p>${escapeHtml(text(item.answer))}</p></details>`).join('')}</section>`
  if (block.type === 'contact') {
    if (!formEndpoint) invalid('Published contact block has no exact first-party form endpoint.')
    return `<section id="${escapeHtml(block.blockId)}" data-block-type="contact"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>${contactForm(formEndpoint, data)}</section>`
  }
  if (block.type === 'article_list') {
    const limit = Number(data.limit)
    const items = articles.slice(0, Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 24) : 12).map(article => `<li><a href="/${article.language}/${article.contentType === 'article' ? 'articles' : article.contentType === 'faq' ? 'faq' : 'services'}/${escapeHtml(article.slug)}">${escapeHtml(article.title)}</a></li>`).join('')
    return `<section id="${escapeHtml(block.blockId)}" data-block-type="article_list"><h2>${escapeHtml(title)}</h2><ul>${items}</ul></section>`
  }
  if (block.type === 'gallery_grid') {
    const columns = Number.isInteger(data.columns) && Number(data.columns) >= 1 && Number(data.columns) <= 6 ? Number(data.columns) : 3
    const gap = { compact: '.5rem', balanced: '1.25rem', airy: '2rem' }[String(data.gap) as 'compact' | 'balanced' | 'airy'] || '1.25rem'
    const images = block.media.map(item => data.lightbox === true ? `<details><summary>放大圖片：${escapeHtml(item.decorative ? '裝飾圖片' : item.alt)}</summary>${mediaHtml(item, resolver)}</details>` : mediaHtml(item, resolver)).join('')
    return `<section id="${escapeHtml(block.blockId)}" data-block-type="gallery_grid">${title ? `<h2>${escapeHtml(title)}</h2>` : ''}<div class="media-grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,${Math.floor(70 / columns)}rem),1fr));gap:${gap}">${images}</div></section>`
  }
  if (block.type === 'carousel') {
    const slides = block.media.map((item, index) => `<div id="${escapeHtml(block.blockId)}-slide-${index + 1}" style="flex:0 0 100%;scroll-snap-align:start">${mediaHtml(item, resolver)}</div>`).join('')
    const controls = block.media.map((_, index) => `<a href="#${escapeHtml(block.blockId)}-slide-${index + 1}" aria-label="第 ${index + 1} 張圖片">${index + 1}</a>`).join(' ')
    return `<section id="${escapeHtml(block.blockId)}" data-block-type="carousel" role="region" aria-label="${escapeHtml(title || '圖片輪播')}">${title ? `<h2>${escapeHtml(title)}</h2>` : ''}<div tabindex="0" aria-label="可左右捲動的圖片" style="display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:1rem">${slides}</div><nav aria-label="選擇圖片">${controls}</nav></section>`
  }
  if (block.type === 'spacer') {
    const size = { xs: '.5rem', sm: '1rem', md: '2rem', lg: '4rem' }[String(data.size) as 'xs' | 'sm' | 'md' | 'lg'] || '2rem'
    return `<div id="${escapeHtml(block.blockId)}" class="spacer" style="height:${size}" aria-hidden="true"></div>`
  }
  if (block.type === 'divider') return `<div id="${escapeHtml(block.blockId)}" aria-hidden="true">${data.style === 'space' ? '<div style="height:1rem"></div>' : data.style === 'dots' ? '<p class="divider-dots">···</p>' : '<hr>'}</div>`
  if (block.type === 'booking_intent') {
    const services = Array.isArray(data.serviceKeys) ? data.serviceKeys.map(item => escapeHtml(item)).join('、') : ''
    return `<section id="${escapeHtml(block.blockId)}" data-block-type="booking_intent"><h2>${escapeHtml(title)}</h2><p>${services}</p><p>這是預約詢問，不代表時段已確認，也不會直接收取款項。</p>${formEndpoint ? contactForm(formEndpoint, { fields: ['name', 'email', 'phone', 'message'], consentRequired: true }) : '<p>請透過網站的聯絡方式確認服務及時段。</p>'}</section>`
  }
  const items = records(data.items || data.members)
  const cards = items.map(item => `<article class="card"><h3>${escapeHtml(text(item.title || item.name || item.person))}</h3><p>${escapeHtml(text(item.description || item.summary || item.quote || item.role || item.bio))}</p>${linkHtml(item.link)}${typeof item.href === 'string' ? `<a href="${safeHref(item.href)}">查看</a>` : ''}</article>`).join('')
  return `<section id="${escapeHtml(block.blockId)}" data-block-type="${escapeHtml(block.type)}"><h2>${escapeHtml(title || block.type.replaceAll('_', ' '))}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ''}${cards ? `<div class="block-grid">${cards}</div>` : ''}${linkHtml(data.link)}${linkHtml(data.primaryLink)}${linkHtml(data.secondaryLink)}${media}</section>`
}

function formEndpoint(blueprint: ManagedSiteBlueprintV1): string | null {
  const endpoints = new Set(blueprint.pages.flatMap(page => page.sections).filter(section => section.kind === 'contact_form' && section.formEndpoint !== null).map(section => section.formEndpoint!))
  if (endpoints.size > 1) invalid('Blueprint contains ambiguous contact form endpoints.')
  return [...endpoints][0] || null
}

function renderPage(blueprint: ManagedSiteBlueprintV1, canonicalOrigin: string, artifact: CompiledPageArtifact, resolver: ManagedSiteMediaReferenceResolver, articles: ManagedSiteNativeArticle[]): string {
  const envelope = buildManagedPageTransportEnvelope(artifact)
  if (!envelope || envelope.route !== artifact.route || envelope.artifactFingerprint !== artifact.artifactFingerprint) invalid('Managed page artifact failed strict transport validation.')
  const body = artifact.blocks.map(block => blockHtml(block, resolver, formEndpoint(blueprint), articles.filter(article => article.language === artifact.locale))).join('')
  const faq = artifact.blocks.filter(block => block.type === 'faq').flatMap(block => records(block.data.items).map(item => ({ question: text(item.question), answer: text(item.answer) })))
  return pageShell({ blueprint, canonicalOrigin, locale: artifact.locale, title: artifact.seo.title, description: artifact.seo.description, canonicalPath: artifact.route, noindex: artifact.seo.noindex, body, design: artifact.design, faq })
}

function renderPlainMarkdown(body: string): string {
  const lines = body.replace(/\r\n?/gu, '\n').split('\n')
  const output: string[] = []; let paragraph: string[] = []; let list: 'ul' | 'ol' | null = null
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${escapeHtml(paragraph.join(' '))}</p>`); paragraph = [] } }
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null } }
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
    const bullet = /^[-*]\s+(.+)$/u.exec(line)
    const ordered = /^\d+[.)]\s+(.+)$/u.exec(line)
    if (heading) { flushParagraph(); closeList(); const level = Math.min(heading[1]!.length + 1, 4); output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`); continue }
    if (bullet || ordered) { flushParagraph(); const next = bullet ? 'ul' : 'ol'; if (list !== next) { closeList(); output.push(`<${next}>`); list = next } output.push(`<li>${escapeHtml((bullet || ordered)![1])}</li>`); continue }
    if (!line.trim()) { flushParagraph(); closeList(); continue }
    paragraph.push(line.trim())
  }
  flushParagraph(); closeList()
  return output.join('')
}

function renderArticle(blueprint: ManagedSiteBlueprintV1, canonicalOrigin: string, article: ManagedSiteNativeArticle): string {
  if (createHash('sha256').update(article.body, 'utf8').digest('hex') !== article.contentHash || !/^[a-f0-9]{64}$/u.test(article.evidenceSnapshotHash) || !/^deliverable-[A-Za-z0-9._:-]{1,148}$/u.test(article.publicationId)) invalid('Managed article immutable content identity is mismatched.')
  const section = article.contentType === 'article' ? 'articles' : article.contentType === 'faq' ? 'faq' : 'services'
  const canonicalPath = `/${article.language}/${section}/${article.slug}`
  const body = `<article class="article-body" data-publication-id="${escapeHtml(article.publicationId)}" data-evidence-snapshot="${escapeHtml(article.evidenceSnapshotHash)}"><h1>${escapeHtml(article.title)}</h1>${renderPlainMarkdown(article.body)}</article>`
  return pageShell({ blueprint, canonicalOrigin, locale: article.language, title: article.title, description: article.body.replace(/[#*_`\n]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 300) || article.title, canonicalPath, noindex: false, body, article: article.contentType === 'article' })
}

export function renderManagedSiteNativeStaticAssets(input: { bundle: ManagedSiteArtifactVaultBundle; canonicalOrigin: string; pages: readonly CompiledPageArtifact[]; articles: readonly ManagedSiteNativeArticle[]; resolveMediaReference: ManagedSiteMediaReferenceResolver }): ManagedSiteStaticAsset[] {
  const canonicalOrigin = normalizePublicHttpsOrigin(input.canonicalOrigin)
  const assets = new Map(renderManagedSiteStaticAssets(input.bundle.blueprint, input.bundle.files, canonicalOrigin).map(asset => [asset.path, asset]))
  const routes = new Set<string>()
  for (const page of input.pages) {
    if (routes.has(page.route)) invalid('Managed page publication contains duplicate routes.')
    routes.add(page.route)
    const path = managedSitePageAssetPath(page.route)
    assets.set(path, { path, contentType: HTML, content: renderPage(input.bundle.blueprint, canonicalOrigin, page, input.resolveMediaReference, [...input.articles]) })
  }
  const articlePaths = new Set<string>()
  for (const article of input.articles) {
    const path = managedSiteArticleAssetPath(article)
    if (articlePaths.has(path) || assets.has(path)) invalid('Managed article publication contains a route collision.')
    articlePaths.add(path)
    assets.set(path, { path, contentType: HTML, content: renderArticle(input.bundle.blueprint, canonicalOrigin, article) })
  }
  const indexableRoutes = [...assets.values()].filter(asset => asset.contentType.startsWith('text/html') && !/<meta\s+name="robots"\s+content="[^"]*noindex/iu.test(asset.content)).map(asset => asset.path === 'index.html' ? '/' : `/${asset.path.slice(0, -'/index.html'.length)}`).sort()
  assets.set('sitemap.xml', { path: 'sitemap.xml', contentType: 'application/xml; charset=utf-8', content: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexableRoutes.map(route => `<url><loc>${escapeHtml(`${canonicalOrigin}${route}`)}</loc></url>`).join('')}</urlset>` })
  assets.set('robots.txt', { path: 'robots.txt', contentType: 'text/plain; charset=utf-8', content: `User-agent: *\nAllow: /\nSitemap: ${canonicalOrigin}/sitemap.xml\n` })
  return [...assets.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}
