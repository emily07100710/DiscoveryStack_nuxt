import { stableFingerprint } from '../../../seo-geo-core/repository'
import type { ManagedSiteBlueprintV1, ManagedSiteGeneratedFile } from '../types'
import { renderManagedSiteContactForm } from '../blueprint'

const TEMPLATE_VERSION = 'managed-site-static-renderer-v1'
const STYLE = '*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:#172033;background:#fff;line-height:1.65}header,main,footer{width:min(72rem,calc(100% - 2rem));margin:auto}header{padding:1.25rem 0;border-bottom:1px solid #d9deea;display:flex;gap:1.5rem;align-items:center;justify-content:space-between}nav{display:flex;gap:1rem;flex-wrap:wrap}a{color:#3158a8}main{padding:3rem 0}section{padding:2rem 0;border-bottom:1px solid #edf0f5}h1,h2{line-height:1.2}footer{padding:2rem 0;color:#586174}.cta{display:inline-block;padding:.7rem 1rem;border:1px solid currentColor;border-radius:.4rem}.contact-form{display:grid;gap:1rem;max-width:38rem}.contact-form label{display:grid;gap:.35rem}.contact-form input,.contact-form textarea{font:inherit;padding:.7rem}.contact-form textarea{min-height:9rem}.contact-form--demo{opacity:.65}.hp-field{position:absolute;left:-9999px}'
export const STATIC_RENDERER_FINGERPRINT = `${TEMPLATE_VERSION}:${stableFingerprint({ style: STYLE, structure: 'header-nav-main-sections-faq-footer' })}`

export type ManagedSiteStaticAsset = { path: string; contentType: string; content: string }
const PUBLIC_FILES = new Map([['public/robots.txt', 'text/plain; charset=utf-8'], ['public/llms.txt', 'text/plain; charset=utf-8'], ['public/sitemap.xml', 'application/xml; charset=utf-8'], ['public/manifest.json', 'application/manifest+json; charset=utf-8']])

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;')
}

function safeHref(value: string): string {
  const candidate = value.trim()
  if (candidate.startsWith('/') || candidate.startsWith('#')) return escapeHtml(candidate)
  try { const url = new URL(candidate); return url.protocol === 'https:' && !url.username && !url.password ? escapeHtml(url.toString()) : '#' } catch { return '#' }
}

function outputPath(route: string): string {
  if (route === '/') return 'index.html'
  const normalized = route.replace(/^\/+|\/+$/gu, '')
  if (!normalized || normalized.includes('..') || !/^[a-z0-9][a-z0-9/_-]*$/u.test(normalized)) throw new Error('Managed-site blueprint page route is invalid for static rendering.')
  return `${normalized}/index.html`
}

function renderPage(blueprint: ManagedSiteBlueprintV1, page: ManagedSiteBlueprintV1['pages'][number]): string {
  const navigation = blueprint.navigation.map(item => `<a href="${safeHref(item.route)}">${escapeHtml(item.label)}</a>`).join('')
  const sections = page.sections.map(section => `<section id="${escapeHtml(section.sectionId)}"><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p>${section.ctaLabel && section.ctaHref ? `<a class="cta" href="${safeHref(section.ctaHref)}">${escapeHtml(section.ctaLabel)}</a>` : ''}${section.kind === 'module_slot' && section.moduleKey ? `<p data-module-placeholder="${escapeHtml(section.moduleKey)}">${escapeHtml(section.moduleKey)}</p>` : ''}${renderManagedSiteContactForm(section)}</section>`).join('')
  const faq = page.pageKey === 'faq' || page.sections.some(section => section.kind === 'faq') ? `<section><h2>FAQ</h2>${blueprint.faq.map(item => `<article><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p></article>`).join('')}</section>` : ''
  return `<!doctype html><html lang="${blueprint.locale === 'zh-hant' ? 'zh-Hant' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)} — ${escapeHtml(blueprint.brandName)}</title><meta name="description" content="${escapeHtml(page.description)}"><style>${STYLE}</style></head><body><header><strong>${escapeHtml(blueprint.brandName)}</strong><nav aria-label="Primary">${navigation}</nav></header><main><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.description)}</p>${sections}${faq}</main><footer>${escapeHtml(blueprint.seoGeo.evidenceLimitations.join(' · '))}</footer></body></html>`
}

export function renderManagedSiteStaticAssets(blueprint: ManagedSiteBlueprintV1, files: readonly ManagedSiteGeneratedFile[] = []): ManagedSiteStaticAsset[] {
  const assets = blueprint.pages.map(page => ({ path: outputPath(page.route), contentType: 'text/html; charset=utf-8', content: renderPage(blueprint, page) }))
  if (blueprint.selectedModulePlacements.some(item => item.moduleKey === 'contact_lead_capture')) assets.push({ path: 'thanks/index.html', contentType: 'text/html; charset=utf-8', content: `<!doctype html><html lang="${blueprint.locale === 'zh-hant' ? 'zh-Hant' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive"><title>謝謝你的訊息</title><style>${STYLE}</style></head><body><main><h1>謝謝你的訊息</h1><p>我們已收到你的訊息，會儘快與你聯絡。</p></main></body></html>` })
  for (const file of files) {
    const contentType = PUBLIC_FILES.get(file.path)
    if (contentType) assets.push({ path: file.path.slice('public/'.length), contentType, content: file.content })
  }
  return assets.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}
