import { stableFingerprint } from '../../../seo-geo-core/repository'
import type { ManagedSiteBlueprintV1, ManagedSiteGeneratedFile } from '../types'
import { renderManagedSiteContactForm } from '../blueprint'
import { normalizePublicHttpsOrigin } from '../../../content-operations/normalization'
import { MANAGED_SITE_METADATA_VERSION, renderManagedSiteMetadataHead } from '../../seo-metadata'
import type { CustomerSitePreset } from '../../site-spec'

const TEMPLATE_VERSION = 'managed-site-static-renderer-v3'
const STATIC_PRESETS = ['atelier', 'bloom', 'alignment'] as const satisfies readonly CustomerSitePreset[]
const STYLE = `
*,*::before,*::after{box-sizing:border-box}
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none;color-scheme:light}
html{scroll-behavior:smooth}
body{--canvas:#f5f0e8;--surface:#fffaf3;--surface-strong:#fff;--ink:#251d1a;--muted:#746862;--accent:#8c3f52;--accent-ink:#fff;--line:rgba(37,29,26,.16);--display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--radius:1.5rem;margin:0;color:var(--ink);background:var(--canvas);font-size:clamp(1rem,.96rem + .18vw,1.125rem);line-height:1.72;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration-color:color-mix(in srgb,var(--accent) 55%,transparent);text-underline-offset:.2em}
.site-preset--atelier{--canvas:#f3eee6;--surface:#fbf7f0;--surface-strong:#fffdf8;--ink:#251d1a;--muted:#766860;--accent:#914b5b;--accent-ink:#fffaf5;--line:rgba(37,29,26,.15);--display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--radius:.35rem}
.site-preset--bloom{--canvas:#eef3eb;--surface:#f8fbf4;--surface-strong:#fffdf7;--ink:#17362e;--muted:#60746c;--accent:#bd5f50;--accent-ink:#fffaf2;--line:rgba(23,54,46,.14);--display:ui-rounded,"Avenir Next",Avenir,"Trebuchet MS",sans-serif;--radius:2rem}
.site-preset--alignment{--canvas:#071722;--surface:#0d2331;--surface-strong:#122c3c;--ink:#eef7f4;--muted:#a7bdc1;--accent:#6de2c2;--accent-ink:#062019;--line:rgba(181,222,218,.2);--display:"Avenir Next",Avenir,"Segoe UI",sans-serif;--radius:0}
.site-shell{width:min(76rem,calc(100% - 3rem));margin-inline:auto}
.site-header{min-height:5.5rem;display:flex;align-items:center;justify-content:space-between;gap:2rem;border-bottom:1px solid var(--line)}
.brand{font-family:var(--display);font-size:clamp(1.05rem,.94rem + .55vw,1.45rem);font-weight:700;letter-spacing:.015em;text-decoration:none}
.site-nav{display:flex;align-items:center;justify-content:flex-end;gap:clamp(.75rem,2vw,1.75rem);flex-wrap:wrap}
.site-nav a{position:relative;color:var(--muted);font-size:.82rem;font-weight:700;letter-spacing:.09em;text-decoration:none;text-transform:uppercase}
.site-nav a::after{content:"";position:absolute;right:0;bottom:-.45rem;left:0;height:2px;background:var(--accent);transform:scaleX(0);transform-origin:left}
.site-nav a:hover,.site-nav a:focus-visible,.site-nav a[aria-current="page"]{color:var(--ink)}
.site-nav a:hover::after,.site-nav a:focus-visible::after,.site-nav a[aria-current="page"]::after{transform:scaleX(1)}
.site-main{padding-block:clamp(2rem,5vw,5rem) clamp(4rem,9vw,8rem)}
.hero{position:relative;isolation:isolate;display:grid;grid-template-columns:minmax(0,1.2fr) minmax(15rem,.8fr);align-items:center;gap:clamp(2rem,7vw,7rem);min-height:min(44rem,75vh);padding:clamp(2.5rem,7vw,7rem);overflow:hidden;border:1px solid var(--line);border-radius:calc(var(--radius) * 1.25);background:var(--surface)}
.hero::before{content:"";position:absolute;z-index:-1;inset:auto -12% -32% 42%;height:85%;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--accent) 18%,transparent),transparent 67%)}
.eyebrow,.section-index{margin:0 0 1rem;color:var(--accent);font-size:.72rem;font-weight:800;letter-spacing:.2em;text-transform:uppercase}
h1,h2,h3,p{margin-top:0}
h1,h2,h3{font-family:var(--display);line-height:1.02;text-wrap:balance}
h1{max-width:13ch;margin-bottom:1.5rem;font-size:clamp(3rem,7vw,6.8rem);font-weight:600;letter-spacing:-.055em}
h2{margin-bottom:1.15rem;font-size:clamp(2rem,3.7vw,3.6rem);font-weight:600;letter-spacing:-.035em}
h3{font-size:clamp(1.2rem,1.6vw,1.55rem);line-height:1.25}
.hero-lede{max-width:42rem;margin-bottom:0;color:var(--muted);font-size:clamp(1.06rem,1.4vw,1.32rem)}
.hero-art{position:relative;width:min(100%,24rem);aspect-ratio:4/5;justify-self:end;border:1px solid var(--line);border-radius:calc(var(--radius) * 1.5);background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 72%,var(--surface)),var(--surface-strong));box-shadow:0 2rem 5rem rgba(14,22,27,.14);overflow:hidden}
.hero-art span{position:absolute;display:block;border:1px solid color-mix(in srgb,var(--accent-ink) 55%,transparent);border-radius:999px}
.hero-art span:nth-child(1){width:64%;aspect-ratio:1;top:8%;left:9%}
.hero-art span:nth-child(2){width:46%;aspect-ratio:1;right:8%;bottom:10%;background:color-mix(in srgb,var(--surface-strong) 34%,transparent)}
.hero-art span:nth-child(3){width:1px;height:76%;top:12%;left:50%;border:0;background:color-mix(in srgb,var(--accent-ink) 56%,transparent)}
.content-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:clamp(1rem,2.5vw,2rem);padding-top:clamp(3rem,8vw,8rem)}
.content-card{min-width:0;padding:clamp(2rem,4.5vw,4.5rem);border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:0 1.25rem 4rem rgba(14,22,27,.055)}
.content-card:nth-child(3n+1){grid-column:span 2}
.content-card>p:not(.section-index),.faq-item p{max-width:48rem;color:var(--muted)}
.cta,.contact-form button{display:inline-flex;align-items:center;justify-content:center;min-height:3.15rem;margin-top:1rem;padding:.75rem 1.35rem;border:1px solid var(--accent);border-radius:999px;background:var(--accent);color:var(--accent-ink);font:inherit;font-size:.84rem;font-weight:800;letter-spacing:.08em;text-decoration:none;text-transform:uppercase;cursor:pointer}
.module-note{padding:1rem 1.15rem;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--accent) 9%,transparent);color:var(--muted);font-size:.9rem}
.faq-panel{grid-column:1/-1}
.faq-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
.faq-item{padding:1.5rem;border-top:1px solid var(--line)}
.contact-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;max-width:48rem;margin-top:2rem}
.contact-form label{display:grid;gap:.45rem;color:var(--muted);font-size:.82rem;font-weight:700;letter-spacing:.04em}
.contact-form label:has(textarea),.contact-form label:has(input[name="contactConsent"]),.contact-form button,.module-note{grid-column:1/-1}
.contact-form label>span{display:flex;align-items:flex-start;gap:.65rem;font-weight:500;letter-spacing:0;line-height:1.5}
.contact-form input,.contact-form textarea{width:100%;border:1px solid var(--line);border-radius:calc(var(--radius) * .5);outline:0;background:var(--surface-strong);color:var(--ink);font:inherit;padding:.85rem 1rem}
.contact-form input:focus,.contact-form textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.contact-form input[type="checkbox"]{width:1.1rem;margin-top:.2rem;accent-color:var(--accent)}
.contact-form textarea{min-height:10rem;resize:vertical}
.contact-form button:disabled,.contact-form--demo{opacity:.62}
.hp-field{position:absolute!important;left:-9999px!important}
.site-footer{display:grid;grid-template-columns:minmax(0,.5fr) minmax(0,1.5fr);gap:2rem;padding-block:2.5rem 4rem;border-top:1px solid var(--line);color:var(--muted);font-size:.82rem}
.site-footer strong{color:var(--ink);font-family:var(--display);font-size:1.1rem}
.site-footer p{margin:0}
.hero--compact{min-height:30rem;margin-top:clamp(2rem,6vw,6rem)}
.hero--compact .hero-copy{grid-column:1/-1}
.site-preset--atelier .hero{grid-template-columns:minmax(0,1.3fr) minmax(15rem,.7fr)}
.site-preset--atelier .content-card:nth-child(even){transform:translateY(clamp(0rem,2vw,1.5rem))}
.site-preset--bloom .site-header{border-bottom:0}
.site-preset--bloom .hero{grid-template-columns:1fr;text-align:center;border:0;border-radius:3.5rem;background:linear-gradient(145deg,var(--surface-strong),var(--surface))}
.site-preset--bloom .hero-copy{display:grid;justify-items:center}
.site-preset--bloom .hero-art{width:min(100%,36rem);aspect-ratio:16/5;justify-self:center;border-radius:999px}
.site-preset--bloom .content-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.site-preset--bloom .content-card,.site-preset--bloom .content-card:nth-child(3n+1){grid-column:span 1}
.site-preset--bloom .content-card{box-shadow:0 1.4rem 3.5rem rgba(42,76,62,.08)}
.site-preset--alignment{color-scheme:dark}
.site-preset--alignment .site-header{min-height:4.7rem}
.site-preset--alignment .brand,.site-preset--alignment .eyebrow,.site-preset--alignment .section-index,.site-preset--alignment .site-nav a{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace}
.site-preset--alignment .hero{grid-template-columns:minmax(0,.8fr) minmax(19rem,1.2fr);min-height:40rem;border-width:0 0 1px;border-radius:0;background:transparent}
.site-preset--alignment .hero-art{width:100%;aspect-ratio:16/10;border-radius:0;box-shadow:none;background:linear-gradient(135deg,var(--surface-strong),color-mix(in srgb,var(--accent) 24%,var(--surface)))}
.site-preset--alignment .content-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-top:1px solid var(--line);border-left:1px solid var(--line)}
.site-preset--alignment .content-card,.site-preset--alignment .content-card:nth-child(3n+1){grid-column:span 1;border-width:0 1px 1px 0;border-radius:0;box-shadow:none;background:transparent}
.site-preset--alignment .content-card:first-child{grid-column:span 2}
.site-preset--alignment .cta,.site-preset--alignment .contact-form button{border-radius:0}
@media(max-width:54rem){.site-shell{width:min(100% - 2rem,46rem)}.site-header{align-items:flex-start;flex-direction:column;gap:1rem;padding-block:1.25rem}.site-nav{justify-content:flex-start;gap:.75rem 1.1rem}.hero,.site-preset--atelier .hero,.site-preset--alignment .hero{grid-template-columns:1fr;min-height:auto;padding:clamp(2rem,8vw,4rem)}.hero-art,.site-preset--alignment .hero-art{width:min(100%,30rem);justify-self:start;aspect-ratio:16/10}.content-grid,.site-preset--bloom .content-grid,.site-preset--alignment .content-grid{grid-template-columns:1fr}.content-card,.content-card:nth-child(3n+1),.site-preset--bloom .content-card,.site-preset--alignment .content-card,.site-preset--alignment .content-card:first-child{grid-column:span 1}.site-preset--atelier .content-card:nth-child(even){transform:none}.faq-list{grid-template-columns:1fr}}
@media(max-width:36rem){.site-shell{width:min(100% - 1.25rem,32rem)}.site-main{padding-top:1rem}.hero,.site-preset--bloom .hero{padding:2rem 1.35rem;border-radius:calc(var(--radius) * .8)}h1{font-size:clamp(2.65rem,14vw,4.4rem)}.content-grid{padding-top:1.25rem}.content-card{padding:1.6rem 1.25rem}.contact-form{grid-template-columns:1fr}.contact-form label,.contact-form label:has(textarea),.contact-form label:has(input[name="contactConsent"]),.contact-form button{grid-column:1}.site-footer{grid-template-columns:1fr;gap:.75rem}}
`
export const STATIC_RENDERER_FINGERPRINT = `${TEMPLATE_VERSION}:${stableFingerprint({ style: STYLE, presets: STATIC_PRESETS, structure: 'shell-header-hero-card-grid-faq-footer-v3', metadata: MANAGED_SITE_METADATA_VERSION })}`

export type ManagedSiteStaticAsset = { path: string; contentType: string; content: string }
const PUBLIC_FILES = new Map([['public/robots.txt', 'text/plain; charset=utf-8'], ['public/llms.txt', 'text/plain; charset=utf-8'], ['public/sitemap.xml', 'application/xml; charset=utf-8'], ['public/manifest.json', 'application/manifest+json; charset=utf-8']])

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;')
}

function safeHref(value: string): string {
  const candidate = value.trim()
  if (/[\\\u0000-\u001f\u007f]/u.test(candidate) || candidate.startsWith('//')) return '#'
  if (candidate.startsWith('/') || candidate.startsWith('#')) return escapeHtml(candidate)
  try { const url = new URL(candidate); return url.protocol === 'https:' && !url.username && !url.password ? escapeHtml(url.toString()) : '#' } catch { return '#' }
}

function outputPath(route: string): string {
  if (route === '/') return 'index.html'
  const normalized = route.replace(/^\/+|\/+$/gu, '')
  if (!normalized || normalized.includes('..') || !/^[a-z0-9][a-z0-9/_-]*$/u.test(normalized)) throw new Error('Managed-site blueprint page route is invalid for static rendering.')
  return `${normalized}/index.html`
}

function resolveStaticPreset(preset?: CustomerSitePreset): CustomerSitePreset {
  return STATIC_PRESETS.find(candidate => candidate === preset) || 'atelier'
}

function renderPage(blueprint: ManagedSiteBlueprintV1, page: ManagedSiteBlueprintV1['pages'][number], preset: CustomerSitePreset, canonicalOrigin?: string): string {
  const pageLabel = blueprint.navigation.find(item => item.route === page.route)?.label || page.pageKey
  const navigation = blueprint.navigation.map(item => `<a href="${safeHref(item.route)}"${item.route === page.route ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`).join('')
  const sections = page.sections.map((section, index) => {
    // Upgrade the runtime HTML only; immutable vault compiler bytes stay unchanged.
    const form = renderManagedSiteContactForm(section)
    const contact = canonicalOrigin && section.formEndpoint !== null ? form.replace('<input type="text" name="companyFax"', '<label><span><input type="checkbox" name="contactConsent" value="yes" required> 我同意提供以上資料，供網站管理者回覆這次詢問。</span></label><input type="text" name="companyFax"') : form
    return `<section class="content-card" id="${escapeHtml(section.sectionId)}" data-section-kind="${section.kind}"><p class="section-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</p><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p>${section.ctaLabel && section.ctaHref ? `<a class="cta" href="${safeHref(section.ctaHref)}">${escapeHtml(section.ctaLabel)}</a>` : ''}${section.kind === 'module_slot' && section.moduleKey ? `<p class="module-note" data-module-placeholder="${escapeHtml(section.moduleKey)}">${escapeHtml(section.moduleKey)}</p>` : ''}${contact}</section>`
  }).join('')
  const faq = page.pageKey === 'faq' || page.sections.some(section => section.kind === 'faq') ? `<section class="content-card faq-panel"><p class="section-index">${blueprint.locale === 'zh-hant' ? '常見問題' : 'Questions &amp; answers'}</p><h2>FAQ</h2><div class="faq-list">${blueprint.faq.map(item => `<article class="faq-item"><h3>${escapeHtml(item.question)}</h3><p>${escapeHtml(item.answer)}</p></article>`).join('')}</div></section>` : ''
  const metadata = canonicalOrigin ? renderManagedSiteMetadataHead({ blueprint, canonicalOrigin, canonicalPath: page.route, title: page.title, locale: blueprint.locale, faq: faq ? blueprint.faq : [] }) : ''
  return `<!doctype html><html lang="${blueprint.locale === 'zh-hant' ? 'zh-Hant' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)} — ${escapeHtml(blueprint.brandName)}</title><meta name="description" content="${escapeHtml(page.description)}">${metadata}<style>${STYLE}</style></head><body class="site-preset--${preset}" data-site-preset="${preset}"><header class="site-header site-shell"><a class="brand" href="/">${escapeHtml(blueprint.brandName)}</a><nav class="site-nav" aria-label="Primary">${navigation}</nav></header><main class="site-main site-shell"><section class="hero" aria-labelledby="page-title"><div class="hero-copy"><p class="eyebrow">${escapeHtml(blueprint.brandName)} · ${escapeHtml(pageLabel)}</p><h1 id="page-title">${escapeHtml(page.title)}</h1><p class="hero-lede">${escapeHtml(page.description)}</p></div><div class="hero-art" aria-hidden="true"><span></span><span></span><span></span></div></section><div class="content-grid">${sections}${faq}</div></main><footer class="site-footer site-shell"><strong>${escapeHtml(blueprint.brandName)}</strong><p>${escapeHtml(blueprint.seoGeo.evidenceLimitations.join(' · '))}</p></footer></body></html>`
}

export function renderManagedSiteStaticAssets(blueprint: ManagedSiteBlueprintV1, files: readonly ManagedSiteGeneratedFile[] = [], canonicalOrigin?: string, customerSitePreset?: CustomerSitePreset): ManagedSiteStaticAsset[] {
  const origin = canonicalOrigin === undefined ? undefined : normalizePublicHttpsOrigin(canonicalOrigin)
  const preset = resolveStaticPreset(customerSitePreset)
  const assets = blueprint.pages.map(page => ({ path: outputPath(page.route), contentType: 'text/html; charset=utf-8', content: renderPage(blueprint, page, preset, origin) }))
  if (blueprint.selectedModulePlacements.some(item => item.moduleKey === 'contact_lead_capture')) assets.push({ path: 'thanks/index.html', contentType: 'text/html; charset=utf-8', content: `<!doctype html><html lang="${blueprint.locale === 'zh-hant' ? 'zh-Hant' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive"><title>謝謝你的訊息</title><style>${STYLE}</style></head><body class="site-preset--${preset}" data-site-preset="${preset}"><main class="site-main site-shell"><section class="hero hero--compact"><div class="hero-copy"><p class="eyebrow">${escapeHtml(blueprint.brandName)}</p><h1>謝謝你的訊息</h1><p class="hero-lede">我們已收到你的訊息，會儘快與你聯絡。</p></div></section></main></body></html>` })
  for (const file of files) {
    const contentType = PUBLIC_FILES.get(file.path)
    if (contentType && !(origin && ['public/robots.txt', 'public/sitemap.xml'].includes(file.path))) assets.push({ path: file.path.slice('public/'.length), contentType, content: file.content })
  }
  if (origin) {
    assets.push({ path: 'robots.txt', contentType: 'text/plain; charset=utf-8', content: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n` })
    assets.push({ path: 'sitemap.xml', contentType: 'application/xml; charset=utf-8', content: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${blueprint.pages.map(page => `<url><loc>${escapeHtml(`${origin}${page.route}`)}</loc></url>`).join('')}</urlset>` })
  }
  return assets.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}
