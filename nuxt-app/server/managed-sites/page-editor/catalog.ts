import { createError } from 'h3'
import { z } from 'zod'
import { BLOCK_TYPES, type BlockType, type PageBlock, type RichTextNode, type SafeLink } from './types'

const text = (max = 2000) => z.string().trim().min(1).max(max).refine(value => !/<[^>]*>|javascript\s*:|data\s*:/iu.test(value), 'Executable markup is not allowed')
const optionalText = (max = 2000) => z.string().trim().max(max).refine(value => !/<[^>]*>|javascript\s*:|data\s*:/iu.test(value), 'Executable markup is not allowed').optional()
const mediaBindingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u)
const link = z.object({ label: text(120), href: z.string().trim().min(1).max(2048), newTab: z.boolean().optional() }).strict()
const richNode = z.discriminatedUnion('type', [z.object({ type: z.literal('paragraph'), text: text(4000) }).strict(), z.object({ type: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), text: text(240) }).strict(), z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(text(500)).min(1).max(40) }).strict()])
const item = (fields: Record<string, z.ZodTypeAny>) => z.object(fields).strict()
const schemas: Record<BlockType, z.ZodTypeAny> = {
  hero: item({ eyebrow: optionalText(120), title: text(180), description: text(600), primaryLink: link.optional(), secondaryLink: link.optional(), alignment: z.enum(['left', 'center']), mediaBindingId: mediaBindingId.optional() }),
  rich_text: item({ nodes: z.array(richNode).min(1).max(80) }),
  image_text: item({ title: text(180), description: text(1600), link: link.optional(), mediaBindingId, imagePosition: z.enum(['left', 'right']) }),
  services: item({ title: text(180), description: optionalText(600), items: z.array(item({ id: text(80), title: text(160), description: text(800), link: link.optional(), mediaBindingId: mediaBindingId.optional() })).min(1).max(24) }),
  case_studies: item({ title: text(180), description: optionalText(600), items: z.array(item({ id: text(80), title: text(180), summary: text(800), href: z.string().max(2048).optional(), mediaBindingId: mediaBindingId.optional() })).min(1).max(100) }),
  gallery_grid: item({ title: optionalText(180), columns: z.number().int().min(1).max(6), gap: z.enum(['compact', 'balanced', 'airy']), aspect: z.enum(['natural', '1:1', '4:3', '3:2', '16:9', 'portrait']), captions: z.boolean(), lightbox: z.boolean(), mediaBindingIds: z.array(mediaBindingId).min(1).max(100) }),
  carousel: item({ title: optionalText(180), autoplay: z.literal(false), pauseControl: z.literal(true), mobileMode: z.enum(['single', 'scroll']), mediaBindingIds: z.array(mediaBindingId).min(1).max(30) }),
  team: item({ title: text(180), members: z.array(item({ id: text(80), name: text(120), role: text(120), bio: optionalText(600), mediaBindingId: mediaBindingId.optional() })).min(1).max(40) }),
  testimonials: item({ title: optionalText(180), items: z.array(item({ id: text(80), quote: text(1000), person: text(120), organization: optionalText(160) })).min(1).max(30) }),
  faq: item({ title: text(180), items: z.array(item({ id: text(80), question: text(240), answer: text(2000) })).min(1).max(50) }),
  cta: item({ title: text(180), description: optionalText(600), primaryLink: link, secondaryLink: link.optional() }),
  article_list: item({ title: text(180), source: z.enum(['latest', 'category', 'selected']), category: optionalText(120), limit: z.number().int().min(1).max(24) }),
  contact: item({ title: text(180), description: optionalText(800), fields: z.array(z.enum(['name', 'email', 'phone', 'message'])).min(1).max(4), consentRequired: z.literal(true) }),
  booking_intent: item({ title: text(180), description: optionalText(800), serviceKeys: z.array(text(80)).min(1).max(30), collectsPayment: z.literal(false) }),
  spacer: item({ size: z.enum(['xs', 'sm', 'md', 'lg']) }),
  divider: item({ style: z.enum(['line', 'dots', 'space']) }),
}

export const BLOCK_CATALOG: Record<BlockType, { layouts: readonly string[]; minItems: number; maxItems: number; semantic: string; limitations: string }> = {
  hero: { layouts: ['split', 'overlay', 'centered'], minItems: 1, maxItems: 1, semantic: 'single h1 and primary LCP media', limitations: 'One hero per page; no arbitrary overlay CSS.' }, rich_text: { layouts: ['prose', 'columns'], minItems: 1, maxItems: 80, semantic: 'safe structured prose', limitations: 'No raw HTML.' }, image_text: { layouts: ['split', 'stacked'], minItems: 1, maxItems: 1, semantic: 'figure with adjacent copy', limitations: 'One image role.' }, services: { layouts: ['cards', 'list', 'featured'], minItems: 1, maxItems: 24, semantic: 'service list', limitations: 'Fixed card fields.' }, case_studies: { layouts: ['cards', 'editorial', 'masonry'], minItems: 1, maxItems: 100, semantic: 'case study collection', limitations: 'Pagination after 100.' }, gallery_grid: { layouts: ['grid', 'masonry'], minItems: 1, maxItems: 100, semantic: 'figure gallery', limitations: 'One hundred assets per page.' }, carousel: { layouts: ['contained', 'edge'], minItems: 1, maxItems: 30, semantic: 'labelled region with controls', limitations: 'Autoplay disabled in V1.' }, team: { layouts: ['cards', 'portraits'], minItems: 1, maxItems: 40, semantic: 'people list', limitations: 'No identity inference.' }, testimonials: { layouts: ['cards', 'quotes'], minItems: 1, maxItems: 30, semantic: 'quotation list', limitations: 'Customer-provided claims only.' }, faq: { layouts: ['accordion', 'list'], minItems: 1, maxItems: 50, semantic: 'FAQ headings and answers', limitations: 'No executable embeds.' }, cta: { layouts: ['band', 'card'], minItems: 1, maxItems: 1, semantic: 'call to action', limitations: 'Safe links only.' }, article_list: { layouts: ['cards', 'list'], minItems: 1, maxItems: 24, semantic: 'article index', limitations: 'Canonical publication source only.' }, contact: { layouts: ['form', 'split'], minItems: 1, maxItems: 4, semantic: 'labelled contact form', limitations: 'Fixed fields and consent.' }, booking_intent: { layouts: ['form', 'card'], minItems: 1, maxItems: 30, semantic: 'booking intent form', limitations: 'No direct payment.' }, spacer: { layouts: ['default'], minItems: 1, maxItems: 1, semantic: 'presentational spacing', limitations: 'Bounded token sizes.' }, divider: { layouts: ['default'], minItems: 1, maxItems: 1, semantic: 'presentational separator', limitations: 'Fixed styles.' },
}

export function assertSafeLink(value: SafeLink): void {
  const href = value.href.trim()
  if (href.startsWith('/')) { if (href.startsWith('//') || href.includes('\\') || /[\u0000-\u001f]/u.test(href)) throw createError({ statusCode: 422, statusMessage: 'Internal link is unsafe.' }); return }
  let url: URL; try { url = new URL(href) } catch { throw createError({ statusCode: 422, statusMessage: 'Link is invalid.' }) }
  if (!['https:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) throw createError({ statusCode: 422, statusMessage: 'Link protocol is not allowlisted.' })
}
function walkLinks(value: unknown): void { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) { for (const child of value) walkLinks(child); return } const record = value as Record<string, unknown>; if (typeof record.href === 'string' && typeof record.label === 'string') assertSafeLink(record as unknown as SafeLink); for (const child of Object.values(record)) walkLinks(child) }

export function parseBlock(input: unknown): PageBlock {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError({ statusCode: 422, statusMessage: 'Page block must be a plain object.' })
  const value = input as Record<string, unknown>; const allowed = ['blockId', 'type', 'visible', 'layoutVariant', 'data', 'mediaBindingIds', 'schedule']; if (Object.keys(value).some(key => !allowed.includes(key))) throw createError({ statusCode: 422, statusMessage: 'Page block contains unknown fields.' })
  if (typeof value.blockId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u.test(value.blockId) || typeof value.type !== 'string' || !(BLOCK_TYPES as readonly string[]).includes(value.type) || typeof value.visible !== 'boolean') throw createError({ statusCode: 422, statusMessage: 'Page block identity, type or visibility is invalid.' })
  const type = value.type as BlockType; if (typeof value.layoutVariant !== 'string' || !BLOCK_CATALOG[type].layouts.includes(value.layoutVariant)) throw createError({ statusCode: 422, statusMessage: `Layout is not allowed for ${type}.` })
  const result = schemas[type].safeParse(value.data); if (!result.success) throw createError({ statusCode: 422, statusMessage: `${type} block data is invalid.` }); walkLinks(result.data)
  if (!Array.isArray(value.mediaBindingIds) || value.mediaBindingIds.length > 100 || value.mediaBindingIds.some(id => !mediaBindingId.safeParse(id).success) || new Set(value.mediaBindingIds).size !== value.mediaBindingIds.length) throw createError({ statusCode: 422, statusMessage: 'Page block media bindings are invalid.' })
  let schedule = null
  if (value.schedule !== null) { if (!value.schedule || typeof value.schedule !== 'object' || Array.isArray(value.schedule)) throw createError({ statusCode: 422, statusMessage: 'Scheduled visibility is invalid.' }); const parsed = z.object({ visibleFrom: z.string().datetime({ offset: true }).nullable(), visibleUntil: z.string().datetime({ offset: true }).nullable(), timezone: z.string().min(1).max(80) }).strict().safeParse(value.schedule); if (!parsed.success || parsed.data.visibleFrom && parsed.data.visibleUntil && Date.parse(parsed.data.visibleFrom) >= Date.parse(parsed.data.visibleUntil)) throw createError({ statusCode: 422, statusMessage: 'Scheduled visibility interval is invalid.' }); try { new Intl.DateTimeFormat('en', { timeZone: parsed.data.timezone }) } catch { throw createError({ statusCode: 422, statusMessage: 'Scheduled visibility timezone is invalid.' }) }; schedule = parsed.data }
  return { blockId: value.blockId, type, visible: value.visible, layoutVariant: value.layoutVariant, data: result.data as Readonly<Record<string, unknown>>, mediaBindingIds: [...value.mediaBindingIds] as string[], schedule }
}

export function richTextNodes(value: unknown): RichTextNode[] { const result = z.array(richNode).min(1).max(80).safeParse(value); if (!result.success) throw createError({ statusCode: 422, statusMessage: 'Rich text AST is invalid.' }); return result.data as RichTextNode[] }
