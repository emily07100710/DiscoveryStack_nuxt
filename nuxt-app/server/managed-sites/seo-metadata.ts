import { normalizePublicHttpsOrigin } from '../content-operations/normalization'
import type { ManagedSiteBlueprintV1 } from './live-connectors/types'

export const MANAGED_SITE_METADATA_VERSION = 'managed-site-canonical-jsonld-v1'

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;')
}

/** Metadata contains only the approved brand, displayed content, and bound production origin. */
export function renderManagedSiteMetadataHead(input: { blueprint: ManagedSiteBlueprintV1; canonicalOrigin: string; canonicalPath: string; title: string; locale: string; article?: boolean; faq?: Array<{ question: string; answer: string }> }): string {
  const origin = normalizePublicHttpsOrigin(input.canonicalOrigin)
  if (!/^\/(?:[a-z0-9][a-z0-9/_-]*)?$/u.test(input.canonicalPath) || input.canonicalPath.includes('//')) throw new Error('Managed-site canonical path is invalid.')
  const url = `${origin}${input.canonicalPath}`
  const organization = { '@type': 'Organization', '@id': `${origin}/#organization`, name: input.blueprint.seoGeo.organizationName, url: origin }
  const page = { '@type': input.article ? 'Article' : 'WebPage', '@id': url, url, name: input.title, ...(input.article ? { headline: input.title } : {}), inLanguage: input.locale === 'zh-hant' ? 'zh-Hant' : 'en', publisher: { '@id': organization['@id'] } }
  const graph: unknown[] = [organization, page]
  if (input.faq?.length) graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: input.faq.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })) })
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')
  return `<link rel="canonical" href="${escapeHtml(url)}"><meta property="og:url" content="${escapeHtml(url)}"><meta property="og:title" content="${escapeHtml(input.title)}"><meta property="og:type" content="${input.article ? 'article' : 'website'}"><script type="application/ld+json">${json}</script>`
}
