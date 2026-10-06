import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compileManagedSiteBlueprint } from '../server/managed-sites/live-connectors/blueprint'
import type { ManagedSiteArtifactVaultBundle } from '../server/managed-sites/live-connectors/generation-service'
import type { ManagedSiteBlueprintV1 } from '../server/managed-sites/live-connectors/types'
import { canonicalFingerprint } from '../server/managed-sites/page-editor/canonical'
import {
  managedSiteArticleAssetPath,
  renderManagedSiteNativeStaticAssets,
  type ManagedSiteNativeArticle,
} from '../server/managed-sites/page-editor/static-renderer'
import type { CompiledPageArtifact, ResponsiveMediaProjection } from '../server/managed-sites/page-editor/types'

const CANONICAL_ORIGIN = 'https://customer-studio.tw'
const CONTACT_ENDPOINT = 'https://ops.customer-studio.tw/api/managed-sites/contact/form-token-001'
const MEDIA_SHA256 = 'a'.repeat(64)

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function blueprint(): ManagedSiteBlueprintV1 {
  return {
    schemaVersion: 'managed-site-blueprint-v1',
    brandName: 'Customer Studio',
    locale: 'zh-hant',
    siteType: 'brand_blog',
    navigation: [
      { label: '首頁', route: '/' },
      { label: '服務', route: '/services' },
      { label: '聯絡', route: '/contact' },
    ],
    pages: [
      {
        pageKey: 'home', route: '/', title: 'Customer Studio 首頁', description: '首頁說明。',
        sections: [{ sectionId: 'home-hero', kind: 'hero', heading: 'BASE HOME MUST REMAIN', body: '未編輯的原始首頁內容。', ctaLabel: '看服務', ctaHref: '/services', moduleKey: null, formEndpoint: null }],
      },
      {
        pageKey: 'services', route: '/services', title: '原始服務頁', description: '原始服務說明。',
        sections: [{ sectionId: 'base-services', kind: 'services', heading: 'BASE SERVICE MUST BE REPLACED', body: '這段應被目前已編輯版本取代。', ctaLabel: null, ctaHref: null, moduleKey: null, formEndpoint: null }],
      },
      {
        pageKey: 'contact', route: '/contact', title: '聯絡 Customer Studio', description: '留下這次詢問所需資料。',
        sections: [{ sectionId: 'contact-form', kind: 'contact_form', heading: '聯絡我們', body: '網站管理員會回覆這次詢問。', ctaLabel: null, ctaHref: null, moduleKey: 'contact_lead_capture', formEndpoint: CONTACT_ENDPOINT }],
      },
    ],
    faq: [{ question: '內容會自動發布嗎？', answer: '不會，仍需通過審核與發布授權。' }],
    selectedModulePlacements: [{ moduleKey: 'contact_lead_capture', pageKey: 'contact', sectionId: 'contact-form', mode: 'first_party' }],
    seoGeo: {
      summaryAnswer: 'Customer Studio 提供可追溯的網站內容服務。',
      canonicalPlaceholder: '{{CANONICAL_ORIGIN}}',
      organizationName: 'Customer Studio',
      evidenceLimitations: ['尚未取得成效證據。'],
      structuredDataKinds: ['Organization', 'Service'],
    },
    provenance: { evidenceSnapshotHash: 'b'.repeat(64), authoritySourceIds: ['source-customer'], providerContentHash: 'c'.repeat(64) },
  }
}

function bundle(site = blueprint()): ManagedSiteArtifactVaultBundle {
  // The renderer consumes only the already-admitted immutable blueprint and files.
  return { blueprint: site, files: compileManagedSiteBlueprint(site) } as unknown as ManagedSiteArtifactVaultBundle
}

function media(): ResponsiveMediaProjection {
  return {
    bindingId: 'binding-service-hero',
    assetId: 'asset-service-hero',
    assetVersion: 3,
    assetSha256: 'd'.repeat(64),
    alt: '團隊討論網站內容',
    decorative: false,
    loading: 'eager',
    fetchPriority: 'high',
    width: 1280,
    height: 720,
    srcset: `media-ref:${MEDIA_SHA256}:640:webp 640w, media-ref:${MEDIA_SHA256}:1280:avif 1280w`,
    sizes: '(max-width: 800px) 100vw, 1280px',
    focalPoint: { x: 0.5, y: 0.4 },
  }
}

function compiled(input: {
  route: string
  contentType?: string
  noindex?: boolean
  title?: string
  includeMedia?: boolean
}): CompiledPageArtifact {
  const projectedMedia = input.includeMedia ? [media()] : []
  const blocks: CompiledPageArtifact['blocks'] = [{
    blockId: `block-${input.route.replaceAll('/', '-') || 'home'}`,
    type: 'rich_text',
    visible: true,
    layoutVariant: 'prose',
    data: { nodes: [{ type: 'heading', level: 2, text: 'EDITED CURRENT SERVICE PAGE' }, { type: 'paragraph', text: '這是客戶目前發布的頁面版本。' }] },
    mediaBindingIds: projectedMedia.map(item => item.bindingId),
    schedule: null,
    responsive: { desktop: 'prose-readable', tablet: 'prose-readable', mobile: 'prose-mobile' },
    media: projectedMedia,
  }]
  const stable = {
    version: 'managed-site-page-artifact-v1' as const,
    pageId: `page-${sha256(input.route).slice(0, 20)}`,
    pageVersion: 7,
    route: input.route,
    locale: 'zh-hant',
    contentType: input.contentType || 'services',
    design: {
      palette: 'forest_mist' as const,
      typeScale: 'editorial' as const,
      spacing: 'airy' as const,
      radius: 'rounded' as const,
      maxWidth: 'wide' as const,
      contrast: 'aaa' as const,
    },
    blocks,
    seo: {
      title: input.title || '目前服務頁',
      description: '目前已核准並發布的服務內容。',
      canonicalPath: input.route,
      noindex: input.noindex ?? false,
      ogBindingId: null,
    },
    pageFingerprint: sha256(`page:${input.route}:7`),
    mediaSetFingerprint: canonicalFingerprint(projectedMedia),
  }
  return { ...stable, artifactFingerprint: canonicalFingerprint(stable), generatedAt: '2031-02-03T04:05:06.000Z' }
}

function article(input: Pick<ManagedSiteNativeArticle, 'publicationId' | 'slug' | 'contentType' | 'language'> & { title: string; body: string; evidence: string }): ManagedSiteNativeArticle {
  return {
    publicationId: input.publicationId,
    slug: input.slug,
    title: input.title,
    body: input.body,
    contentHash: sha256(input.body),
    contentType: input.contentType,
    language: input.language,
    evidenceSnapshotHash: sha256(input.evidence),
  }
}

function publicMediaUrl(reference: { sha256: string; width: number; format: string }): string {
  return `https://cdn.customer-studio.tw/media/${reference.sha256}/${reference.width}.${reference.format}`
}

function asset(assets: ReturnType<typeof renderManagedSiteNativeStaticAssets>, path: string) {
  const found = assets.find(item => item.path === path)
  if (!found) throw new Error(`Missing fixture asset ${path}`)
  return found
}

describe('managed-site native whole-site static renderer', () => {
  it('rebuilds the complete site from base pages, the current edited page, and three immutable articles', () => {
    const editedServices = compiled({
      route: '/services',
      noindex: true,
      includeMedia: true,
      title: '目前服務 </script><script>alert("metadata")</script>',
    })
    const articles = [
      article({ publicationId: 'deliverable-article-001', slug: 'answer-first-content', contentType: 'article', language: 'zh-hant', title: '答案型內容', body: '# 第一篇\n\n以公開證據回答問題。', evidence: 'evidence-article' }),
      article({ publicationId: 'deliverable-faq-002', slug: 'frequent-questions', contentType: 'faq', language: 'zh-hant', title: '常見問題', body: '# 第二篇\n\n- 不保證排名\n- 先由人審核', evidence: 'evidence-faq' }),
      article({ publicationId: 'deliverable-service-003', slug: 'managed-website-service', contentType: 'service_page', language: 'en', title: 'Managed website service', body: '# Third publication\n\nA separately approved service page.', evidence: 'evidence-service' }),
    ]
    expect(new Set(articles.map(item => item.publicationId)).size).toBe(3)
    expect(new Set(articles.map(item => item.contentHash)).size).toBe(3)

    const assets = renderManagedSiteNativeStaticAssets({
      bundle: bundle(),
      canonicalOrigin: `${CANONICAL_ORIGIN}/`,
      pages: [editedServices],
      articles,
      resolveMediaReference: publicMediaUrl,
    })

    const home = asset(assets, 'index.html').content
    const services = asset(assets, 'services/index.html').content
    const contact = asset(assets, 'contact/index.html').content
    expect(home).toContain('BASE HOME MUST REMAIN')
    expect(home).not.toContain('EDITED CURRENT SERVICE PAGE')
    expect(services).toContain('EDITED CURRENT SERVICE PAGE')
    expect(services).not.toContain('BASE SERVICE MUST BE REPLACED')

    expect(contact).toContain(`method="post" action="${CONTACT_ENDPOINT}"`)
    expect(contact).toContain('name="contactConsent" value="yes" required')
    expect(contact).toContain('name="companyFax"')

    expect(services).toContain(`src="${publicMediaUrl({ sha256: MEDIA_SHA256, width: 1280, format: 'avif' })}"`)
    expect(services).toContain(`${publicMediaUrl({ sha256: MEDIA_SHA256, width: 640, format: 'webp' })} 640w`)
    expect(services).not.toContain('media-ref:')
    expect(services).toContain('body{color:#101820}')
    expect(services).toContain('header,main,footer{width:min(88rem,calc(100% - 2rem))}')
    expect(services).toContain('section{padding:3.5rem 0}')
    expect(services).toContain('.card,.managed-media img,.cta{border-radius:1.25rem}')

    for (const rendered of [home, services, contact, ...articles.map(item => asset(assets, managedSiteArticleAssetPath(item)).content)]) {
      expect(rendered.match(/<link rel="canonical"/gu)).toHaveLength(1)
      expect(rendered.match(/<meta property="og:url"/gu)).toHaveLength(1)
      expect(rendered.match(/<script type="application\/ld\+json">/gu)).toHaveLength(1)
    }
    const jsonLdBytes = /<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(services)?.[1]
    expect(jsonLdBytes).toBeTruthy()
    expect(jsonLdBytes).toContain('\\u003c/script\\u003e')
    expect(jsonLdBytes).not.toContain('</script>')
    const jsonLd = JSON.parse(jsonLdBytes!) as { '@graph': Array<Record<string, unknown>> }
    expect(jsonLd['@graph'][1]).toMatchObject({ name: '目前服務 </script><script>alert("metadata")</script>', url: `${CANONICAL_ORIGIN}/services` })

    for (const item of articles) {
      const rendered = asset(assets, managedSiteArticleAssetPath(item)).content
      expect(rendered).toContain(`data-publication-id="${item.publicationId}"`)
      expect(rendered).toContain(item.body.split('\n').at(-1)!.replace(/^[-*]\s+/u, '').replace('&', '&amp;'))
    }

    const thanks = asset(assets, 'thanks/index.html').content
    const sitemap = asset(assets, 'sitemap.xml').content
    const robots = asset(assets, 'robots.txt').content
    expect(thanks).toContain('noindex, nofollow, noarchive')
    expect(sitemap).toContain(`<loc>${CANONICAL_ORIGIN}/</loc>`)
    expect(sitemap).toContain(`<loc>${CANONICAL_ORIGIN}/contact</loc>`)
    for (const item of articles) expect(sitemap).toContain(`<loc>${CANONICAL_ORIGIN}/${managedSiteArticleAssetPath(item).replace(/\/index\.html$/u, '')}</loc>`)
    expect(sitemap).not.toContain(`${CANONICAL_ORIGIN}/services`)
    expect(sitemap).not.toContain('/thanks')
    expect(sitemap).not.toContain('{{CANONICAL_ORIGIN}}')
    expect(robots).toBe(`User-agent: *\nAllow: /\nSitemap: ${CANONICAL_ORIGIN}/sitemap.xml\n`)
  })

  it('fails closed when a compiled media reference resolves to a private CDN URL', () => {
    expect(() => renderManagedSiteNativeStaticAssets({
      bundle: bundle(),
      canonicalOrigin: CANONICAL_ORIGIN,
      pages: [compiled({ route: '/services', includeMedia: true })],
      articles: [],
      resolveMediaReference: () => 'https://127.0.0.1/private/media.webp',
    })).toThrow('Resolved media URL is malformed or not public.')
  })

  it('rejects stale artifact fingerprints, duplicate page routes, and page/article path collisions', () => {
    const current = compiled({ route: '/services' })
    const tampered = structuredClone(current)
    tampered.blocks[0]!.data = { nodes: [{ type: 'paragraph', text: 'tampered after approval' }] }
    expect(() => renderManagedSiteNativeStaticAssets({ bundle: bundle(), canonicalOrigin: CANONICAL_ORIGIN, pages: [tampered], articles: [], resolveMediaReference: publicMediaUrl }))
      .toThrow('Managed page artifact failed strict transport validation.')

    expect(() => renderManagedSiteNativeStaticAssets({ bundle: bundle(), canonicalOrigin: CANONICAL_ORIGIN, pages: [current, structuredClone(current)], articles: [], resolveMediaReference: publicMediaUrl }))
      .toThrow('Managed page publication contains duplicate routes.')

    const collisionPage = compiled({ route: '/zh-hant/articles/collision', contentType: 'articles' })
    const collisionArticle = article({ publicationId: 'deliverable-collision-004', slug: 'collision', contentType: 'article', language: 'zh-hant', title: 'Collision', body: 'Collision body.', evidence: 'collision-evidence' })
    expect(() => renderManagedSiteNativeStaticAssets({ bundle: bundle(), canonicalOrigin: CANONICAL_ORIGIN, pages: [collisionPage], articles: [collisionArticle], resolveMediaReference: publicMediaUrl }))
      .toThrow('Managed article publication contains a route collision.')
  })
})
