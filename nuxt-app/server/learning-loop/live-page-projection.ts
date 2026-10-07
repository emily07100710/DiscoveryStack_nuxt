import { createHash } from 'node:crypto'
import { isOpaqueReference, isValidSha256, utf8ByteLength } from '../first-party-publishing/normalization'
import { scanOutcomeLearningPii } from '../outcome-learning/content-learning-runtime'

export type LiveDocumentInput = {
  publicationId: string
  draftId: string
  reviewId: string
  contentHash: string
  evidenceSnapshotHash: string
  title: string
  body: string
}

export type LivePageProjection = {
  contractVersion: 'learning-live-page-projection-v1'
  kind: 'controlled_document' | 'not_found'
  urlHash: string
  responseHash: string
  canonicalUrlHash: string | null
  publicationIdentityFingerprint: string | null
  titleHash: string | null
  bodyUnitHashes: string[]
  semanticBodyHash: string | null
  titleLength: number
  bodyTextLength: number
  headingCount: number
  linkCount: number
  projectionFingerprint: string
}

export type PlannedLiveAction = {
  contractVersion: 'learning-planned-live-action-v1'
  beforeProjectionFingerprint: string
  plannedProjectionFingerprint: string
  features: {
    newPage: number
    titleChanged: number
    paragraphsAdded: number
    paragraphsRemoved: number
    paragraphsReplaced: number
    paragraphsUnmodified: number
    beforeTextLength: number
    plannedTextLength: number
    beforeParagraphCount: number
    plannedParagraphCount: number
  }
  actionFingerprint: string
}

const PROJECTION_VERSION = 'learning-live-page-projection-v1' as const
const ACTION_VERSION = 'learning-planned-live-action-v1' as const
const SHA256 = /^[a-f0-9]{64}$/u
const MAX_SOURCE_BYTES = 256 * 1024
const MAX_UNITS = 512
const MAX_TEXT_LENGTH = 256 * 1024
const HASH_DOMAIN = 'discoverystack-learning-live-page-projection-v1'
const ACTION_DOMAIN = 'discoverystack-learning-planned-live-action-v1'

type Inline = { kind: 'text'; text: string } | { kind: 'strong' | 'emphasis'; children: Inline[] } | { kind: 'link'; href: string; children: Inline[] }
type Block = { kind: 'paragraph' | 'heading' | 'list_item'; level?: number; ordered?: boolean; children: Inline[] }
type NormalizedDocument = { title: string; titleHash: string; blocks: Block[]; unitHashes: string[]; semanticBodyHash: string; bodyTextLength: number; headingCount: number; linkCount: number; identityFingerprint: string }

function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function canonicalJson(value: unknown): string { return JSON.stringify(value) }
function codePointLength(value: string): number { return Array.from(value).length }
function safeText(value: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return undefined
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined
    }
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
  } catch { return undefined }
}

function exactArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))) return undefined
    const result: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch { return undefined }
}

function validUrl(value: unknown): value is string {
  try {
    if (typeof value !== 'string' || value.length > 4096 || !safeText(value)) return false
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.port === '' && url.hostname.includes('.') && value === url.href
  } catch { return false }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
}

function decodeEntities(value: string): string | undefined {
  let failed = false
  const remainder = value.replace(/&(#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|[a-z][a-z0-9]+);/giu, '')
  if (/&(?:#\w+|[a-z][a-z0-9]+);/iu.test(remainder)) return undefined
  const decoded = value.replace(/&(#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|[a-z][a-z0-9]+);/giu, (whole, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff) { failed = true; return whole }
      return String.fromCodePoint(number)
    }
    const result = ENTITIES[entity]
    if (result === undefined) { failed = true; return whole }
    return result
  })
  if (failed) return undefined
  return decoded.normalize('NFC')
}

function normalizeInline(raw: string, depth = 0): Inline[] | undefined {
  if (depth > 8 || raw.length > MAX_SOURCE_BYTES) return undefined
  const result: Inline[] = []
  let text = ''
  const flush = (): boolean => {
    if (!text) return true
    const decoded = decodeEntities(text)
    if (decoded === undefined || !safeText(decoded)) return false
    if (decoded) result.push({ kind: 'text', text: decoded })
    text = ''
    return true
  }
  for (let index = 0; index < raw.length;) {
    if (raw.startsWith('**', index)) {
      const end = raw.indexOf('**', index + 2)
      if (end <= index + 2 || !flush()) return undefined
      const children = normalizeInline(raw.slice(index + 2, end), depth + 1)
      if (!children?.length) return undefined
      result.push({ kind: 'strong', children }); index = end + 2; continue
    }
    if (raw[index] === '*') {
      const end = raw.indexOf('*', index + 1)
      if (end <= index + 1 || !flush()) return undefined
      const children = normalizeInline(raw.slice(index + 1, end), depth + 1)
      if (!children?.length) return undefined
      result.push({ kind: 'emphasis', children }); index = end + 1; continue
    }
    if (raw[index] === '[') {
      const labelEnd = raw.indexOf('](', index + 1)
      const hrefEnd = labelEnd < 0 ? -1 : raw.indexOf(')', labelEnd + 2)
      if (labelEnd < 0 || hrefEnd < 0 || labelEnd === index + 1 || !flush()) return undefined
      const hrefRaw = raw.slice(labelEnd + 2, hrefEnd)
      const href = decodeEntities(hrefRaw)
      if (!href || href.length > 2048 || /[\s<>"'`]/u.test(href) || !safeLink(href)) return undefined
      const children = normalizeInline(raw.slice(index + 1, labelEnd), depth + 1)
      if (!children?.length) return undefined
      result.push({ kind: 'link', href, children }); index = hrefEnd + 1; continue
    }
    if (raw[index] === '!') {
      if (raw[index + 1] === '[') return undefined
      text += raw[index++]!; continue
    }
    if (raw[index] === '\\' || raw[index] === '`') return undefined
    text += raw[index]
    index++
  }
  if (!flush()) return undefined
  return result.length ? result : undefined
}

function safeLink(href: string): boolean {
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') && !/[\u0000-\u0020]/u.test(href)) return true
  try {
    const url = new URL(href)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.port === '' && url.hostname.includes('.') && href === url.href
  } catch { return false }
}

function parseMarkdown(title: string, body: string): { title: string; blocks: Block[] } | undefined {
  if (typeof title !== 'string' || typeof body !== 'string' || utf8ByteLength(title) > 16_384 || utf8ByteLength(body) > MAX_SOURCE_BYTES || !safeText(title) || !safeText(body)) return undefined
  const normalizedTitle = decodeEntities(title.trim())
  if (!normalizedTitle || !normalizedTitle.trim() || normalizedTitle !== normalizedTitle.trim() || /[\r\n]/u.test(normalizedTitle)) return undefined
  const normalizedBody = body.replace(/\r\n?/gu, '\n')
  const lines = normalizedBody.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flushParagraph = (): boolean => {
    if (!paragraph.length) return true
    const line = paragraph.map(value => value.trim()).join(' ')
    paragraph = []
    const children = normalizeInline(line)
    if (!children) return false
    blocks.push({ kind: 'paragraph', children })
    return true
  }
  for (const line of lines) {
    if (!line.trim()) { if (!flushParagraph()) return undefined; continue }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading) {
      if (!flushParagraph()) return undefined
      const children = normalizeInline(heading[2]!.trim())
      if (!children) return undefined
      blocks.push({ kind: 'heading', level: heading[1]!.length, children }); continue
    }
    const item = /^(?:- |\* |\d+\. )(.+)$/u.exec(line)
    if (item) {
      if (!flushParagraph()) return undefined
      const children = normalizeInline(item[1]!.trim())
      if (!children) return undefined
      const ordered = /^\d+\. /u.test(line)
      blocks.push({ kind: 'list_item', ordered, children }); continue
    }
    if (/^(?:>|```|~~~|\s|\+\s|---+\s*$|___+\s*$|\*\*\*+\s*$|\|)/u.test(line) || /<\/?[A-Za-z!]/u.test(line)) return undefined
    paragraph.push(line)
  }
  if (!flushParagraph() || blocks.length === 0 || blocks.length > MAX_UNITS) return undefined
  return { title: normalizedTitle.normalize('NFC'), blocks }
}

function inlineText(inlines: readonly Inline[]): string { return inlines.map(item => item.kind === 'text' ? item.text : inlineText(item.children)).join('') }
function countLinks(inlines: readonly Inline[]): number { return inlines.reduce((count, item) => count + (item.kind === 'link' ? 1 : 0) + (item.kind === 'text' ? 0 : countLinks(item.children)), 0) }
function documentFromInput(value: unknown): NormalizedDocument | undefined {
  const input = exactRecord(value, ['publicationId', 'draftId', 'reviewId', 'contentHash', 'evidenceSnapshotHash', 'title', 'body'])
  if (!input || !isOpaqueReference(input.publicationId) || !isOpaqueReference(input.draftId) || !isOpaqueReference(input.reviewId) || !isValidSha256(input.contentHash) || !isValidSha256(input.evidenceSnapshotHash) || typeof input.title !== 'string' || typeof input.body !== 'string' || utf8ByteLength(input.title) > 16_384 || utf8ByteLength(input.body) > MAX_SOURCE_BYTES || !safeText(input.title) || !safeText(input.body) || sha(input.body) !== input.contentHash) return undefined
  const normalized = parseMarkdown(input.title as string, input.body)
  if (!normalized || scanOutcomeLearningPii({ title: normalized.title, body: normalized.blocks }) .status !== 'none_detected') return undefined
  const unitHashes = normalized.blocks.map(block => sha(canonicalJson(block)))
  const identityFingerprint = sha(`${HASH_DOMAIN}\nidentity\n${canonicalJson({ publicationId: input.publicationId, draftId: input.draftId, reviewId: input.reviewId, contentHash: input.contentHash, evidenceSnapshotHash: input.evidenceSnapshotHash })}`)
  return {
    title: normalized.title,
    titleHash: sha(normalized.title),
    blocks: normalized.blocks,
    unitHashes,
    semanticBodyHash: semanticHash(unitHashes),
    bodyTextLength: codePointLength(normalized.blocks.map(block => inlineText(block.children)).join('\n')),
    headingCount: normalized.blocks.filter(block => block.kind === 'heading').length,
    linkCount: normalized.blocks.reduce((sum, block) => sum + countLinks(block.children), 0),
    identityFingerprint,
  }
}

function projectionPayload(projection: Omit<LivePageProjection, 'projectionFingerprint'>): string {
  return `${HASH_DOMAIN}\nprojection\n${canonicalJson(projection)}`
}
function semanticHash(units: readonly string[]): string { return sha(`${HASH_DOMAIN}\nsemantic-body\n${canonicalJson(units)}`) }
function finishProjection(value: Omit<LivePageProjection, 'projectionFingerprint'>): LivePageProjection {
  return { ...value, projectionFingerprint: sha(projectionPayload(value)) }
}

export function projectExpectedLiveDocument(input: LiveDocumentInput, url: string): LivePageProjection | null {
  try {
    if (!validUrl(url)) return null
    const document = documentFromInput(input)
    if (!document) return null
    const urlHash = sha(url)
    return finishProjection({
      contractVersion: PROJECTION_VERSION,
      kind: 'controlled_document',
      urlHash,
      // This is a deterministic expected-representation digest, not the digest of any fetched response bytes.
      responseHash: sha(`${HASH_DOMAIN}\nexpected-response\n${urlHash}\n${document.identityFingerprint}\n${document.titleHash}\n${document.semanticBodyHash}`),
      canonicalUrlHash: urlHash,
      publicationIdentityFingerprint: document.identityFingerprint,
      titleHash: document.titleHash,
      bodyUnitHashes: document.unitHashes,
      semanticBodyHash: document.semanticBodyHash,
      titleLength: codePointLength(document.title),
      bodyTextLength: document.bodyTextLength,
      headingCount: document.headingCount,
      linkCount: document.linkCount,
    })
  } catch { return null }
}

type HtmlNode = { tag: string; attrs: Record<string, string>; children: Array<HtmlNode | string> }
const VOID_TAGS = new Set(['link', 'meta', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'embed', 'param', 'track', 'wbr'])
const FORBIDDEN_TAGS = new Set(['form', 'iframe', 'object', 'embed', 'template', 'noscript'])
const MAX_HTML_NODES = 8192
const MAX_HTML_DEPTH = 64

function tokenizeHtml(html: string): string[] | undefined {
  const tokens: string[] = []
  let index = 0
  while (index < html.length) {
    if (html[index] !== '<') {
      const end = html.indexOf('<', index)
      tokens.push(html.slice(index, end < 0 ? html.length : end))
      index = end < 0 ? html.length : end
      continue
    }
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4)
      if (end < 0) return undefined
      tokens.push(html.slice(index, end + 3))
      index = end + 3
      continue
    }
    let quote = ''
    let end = index + 1
    for (; end < html.length; end++) {
      const character = html[end]!
      if (quote) { if (character === quote) quote = ''; continue }
      if (character === '"' || character === "'") { quote = character; continue }
      if (character === '>') break
    }
    if (end >= html.length || quote) return undefined
    const token = html.slice(index, end + 1)
    tokens.push(token)
    const open = /^<\s*(script|style)(?:\s|>)/iu.exec(token)
    if (open && !/^<\s*\//u.test(token) && !/\/\s*>$/u.test(token)) {
      const tag = open[1]!.toLowerCase()
      const closing = new RegExp(`<\\/${tag}\\s*>`, 'iu')
      const match = closing.exec(html.slice(end + 1))
      if (!match) return undefined
      const closeStart = end + 1 + match.index
      if (closeStart > end + 1) tokens.push(html.slice(end + 1, closeStart))
      tokens.push(match[0])
      index = closeStart + match[0].length
      continue
    }
    index = end + 1
  }
  return tokens
}

function parseAttributes(source: string): Record<string, string> | undefined {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>
  let rest = source.trim()
  while (rest) {
    const match = /^([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'))?\s*/u.exec(rest)
    if (!match) return undefined
    const key = match[1]!.toLowerCase()
    if (Object.hasOwn(attrs, key)) return undefined
    const decoded = match[2] === undefined && match[3] === undefined ? '' : decodeEntities(match[2] ?? match[3]!)
    if (decoded === undefined || !safeText(decoded)) return undefined
    attrs[key] = decoded
    rest = rest.slice(match[0].length)
  }
  return attrs
}

function parseHtml(html: string): HtmlNode | undefined {
  if (typeof html !== 'string' || utf8ByteLength(html) > MAX_SOURCE_BYTES || !safeText(html)) return undefined
  const root: HtmlNode = { tag: '#root', attrs: Object.create(null) as Record<string, string>, children: [] }
  const stack: HtmlNode[] = [root]
  let sawDoctype = false
  const tokens = tokenizeHtml(html)
  if (!tokens || tokens.join('') !== html) return undefined
  let nodeCount = 0
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.startsWith('<!--')) {
      if (!token.endsWith('-->')) return undefined
      const comment: HtmlNode = { tag: '#comment', attrs: Object.create(null) as Record<string, string>, children: [] }
      stack.at(-1)!.children.push(comment)
      if (++nodeCount > MAX_HTML_NODES) return undefined
      continue
    }
    if (/^<!/u.test(token)) {
      if (sawDoctype || root.children.some(child => typeof child === 'string' || child.tag !== '#comment') || stack.length !== 1 || !/^<!doctype\s+html\s*>$/iu.test(token)) return undefined
      sawDoctype = true
      continue
    }
    if (token.startsWith('</')) {
      const close = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>$/u.exec(token)
      if (!close || stack.length <= 1 || stack.at(-1)!.tag !== close[1]!.toLowerCase()) return undefined
      stack.pop(); continue
    }
    if (token.startsWith('<')) {
      const open = /^<([A-Za-z][A-Za-z0-9-]*)([^>]*)>$/u.exec(token)
      if (!open) return undefined
      const tag = open[1]!.toLowerCase()
      if (FORBIDDEN_TAGS.has(tag)) return undefined
      const rawAttrs = open[2]!
      const selfClosing = /\/\s*$/u.test(rawAttrs)
      if (selfClosing && !VOID_TAGS.has(tag)) return undefined
      const attrs = parseAttributes(selfClosing ? rawAttrs.replace(/\/\s*$/u, '') : rawAttrs)
      if (!attrs) return undefined
      const node: HtmlNode = { tag, attrs, children: [] }
      stack.at(-1)!.children.push(node)
      if (++nodeCount > MAX_HTML_NODES) return undefined
      if (tag === 'script' || tag === 'style') {
        let closeIndex = -1
        for (let cursor = index + 1; cursor < tokens.length; cursor++) {
          if (new RegExp(`^<\\/${tag}\\s*>$`, 'iu').test(tokens[cursor]!)) { closeIndex = cursor; break }
        }
        if (closeIndex < 0) return undefined
        node.children.push(tokens.slice(index + 1, closeIndex).join(''))
        index = closeIndex
        continue
      }
      if (!VOID_TAGS.has(tag)) {
        if (stack.length >= MAX_HTML_DEPTH) return undefined
        stack.push(node)
      }
      continue
    }
    const decoded = decodeEntities(token)
    if (decoded === undefined || !safeText(decoded)) return undefined
    stack.at(-1)!.children.push(decoded)
  }
  if (stack.length !== 1) return undefined
  return root
}

function childNodes(node: HtmlNode): HtmlNode[] { return node.children.filter((child): child is HtmlNode => typeof child !== 'string') }
function containsNode(root: HtmlNode, target: HtmlNode): boolean { return root === target || childNodes(root).some(child => containsNode(child, target)) }
function findNodePath(root: HtmlNode, target: HtmlNode, path: HtmlNode[] = []): HtmlNode[] | undefined {
  const next = [...path, root]
  if (root === target) return next
  for (const child of childNodes(root)) {
    const found = findNodePath(child, target, next)
    if (found) return found
  }
  return undefined
}
function textOnly(node: HtmlNode): string | undefined {
  if (node.children.some(child => typeof child !== 'string')) return undefined
  return node.children.join('').normalize('NFC')
}
function parseHtmlInlines(nodes: Array<HtmlNode | string>, depth = 0): Inline[] | undefined {
  if (depth > 8) return undefined
  const result: Inline[] = []
  for (const node of nodes) {
    if (typeof node === 'string') { if (node) result.push({ kind: 'text', text: node }); continue }
    if (node.tag === 'strong' || node.tag === 'em') {
      if (Object.keys(node.attrs).length) return undefined
      const children = parseHtmlInlines(node.children, depth + 1)
      if (!children?.length) return undefined
      result.push({ kind: node.tag === 'strong' ? 'strong' : 'emphasis', children }); continue
    }
    if (node.tag === 'a') {
      const href = node.attrs.href
      if (Object.keys(node.attrs).length !== 1 || typeof href !== 'string' || !safeLink(href)) return undefined
      const children = parseHtmlInlines(node.children, depth + 1)
      if (!children?.length) return undefined
      result.push({ kind: 'link', href, children }); continue
    }
    return undefined
  }
  return result.length ? result : undefined
}

function attrsText(attrs: Record<string, string>): string { return Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join('') }
function escapeHtml(value: string): string { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;') }
function renderInline(items: readonly Inline[]): string {
  return items.map(item => {
    if (item.kind === 'text') return escapeHtml(item.text)
    if (item.kind === 'strong') return `<strong>${renderInline(item.children)}</strong>`
    if (item.kind === 'emphasis') return `<em>${renderInline(item.children)}</em>`
    if (item.kind === 'link') return `<a href="${escapeHtml(item.href)}">${renderInline(item.children)}</a>`
    return ''
  }).join('')
}
function renderBlocks(blocks: readonly Block[]): string {
  let output = ''
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]!
    if (block.kind === 'list_item') {
      const ordered = block.ordered === true
      const list: Block[] = []
      while (index < blocks.length) {
        const next = blocks[index]
        if (!next || next.kind !== 'list_item' || (next.ordered === true) !== ordered) break
        list.push(next)
        index++
      }
      const tag = ordered ? 'ol' : 'ul'
      output += `<${tag}>${list.map(item => `<li>${renderInline(item.children)}</li>`).join('')}</${tag}>`
      continue
    }
    index++
    if (block.kind === 'heading') output += `<h${block.level}>${renderInline(block.children)}</h${block.level}>`
    else output += `<p>${renderInline(block.children)}</p>`
  }
  return output
}

export function renderLiveContentArticle(input: LiveDocumentInput): string | null {
  try {
    const record = exactRecord(input, ['publicationId', 'draftId', 'reviewId', 'contentHash', 'evidenceSnapshotHash', 'title', 'body'])
    if (!record || !isOpaqueReference(record.publicationId) || !isOpaqueReference(record.draftId) || !isOpaqueReference(record.reviewId) || !isValidSha256(record.contentHash) || !isValidSha256(record.evidenceSnapshotHash) || typeof record.title !== 'string' || typeof record.body !== 'string' || utf8ByteLength(record.body) > MAX_SOURCE_BYTES || sha(record.body) !== record.contentHash) return null
    const document = documentFromInput(input)
    if (!document) return null
    return `<article${attrsText({ 'data-ds-live-content': 'v1', 'data-ds-publication-id': record.publicationId, 'data-ds-draft-id': record.draftId, 'data-ds-review-id': record.reviewId, 'data-ds-content-hash': record.contentHash, 'data-ds-evidence-hash': record.evidenceSnapshotHash })}><h1 data-ds-live-title="">${escapeHtml(document.title)}</h1><section data-ds-live-body="">${renderBlocks(document.blocks)}</section></article>`
  } catch { return null }
}

export function projectLivePage(value: { html: string; status: number; url: string }): LivePageProjection | null {
  try {
    const input = exactRecord(value, ['html', 'status', 'url'])
    if (!input || !validUrl(input.url) || typeof input.html !== 'string' || !Number.isSafeInteger(input.status)) return null
    if (utf8ByteLength(input.html) > MAX_SOURCE_BYTES) return null
    const urlHash = sha(input.url)
    const responseHash = sha(input.html)
    if (input.status === 404) return finishProjection({ contractVersion: PROJECTION_VERSION, kind: 'not_found', urlHash, responseHash, canonicalUrlHash: null, publicationIdentityFingerprint: null, titleHash: null, bodyUnitHashes: [], semanticBodyHash: null, titleLength: 0, bodyTextLength: 0, headingCount: 0, linkCount: 0 })
    if (input.status !== 200 || utf8ByteLength(input.html) > MAX_SOURCE_BYTES) return null
    const parsed = parseHtml(input.html)
    if (!parsed) return null
    const significant = (nodes: Array<HtmlNode | string>) => nodes.filter(node => typeof node === 'string' ? node.trim() !== '' : node.tag !== '#comment')
    const top = significant(parsed.children)
    const topNode = top[0]
    if (top.length !== 1 || !topNode || typeof topNode === 'string' || topNode.tag !== 'html') return null
    const htmlNode = topNode
    const htmlChildren = significant(htmlNode.children).filter((child): child is HtmlNode => typeof child !== 'string')
    const head = htmlChildren[0]
    const body = htmlChildren[1]
    if (htmlChildren.length !== 2 || !head || !body || head.tag !== 'head' || body.tag !== 'body') return null
    const headChildren = significant(head.children).filter((child): child is HtmlNode => typeof child !== 'string')
    if (headChildren.some(node => !['link', 'meta', 'title', 'script', 'style'].includes(node.tag))) return null
    if (headChildren.filter(node => node.tag === 'title').length > 1 || headChildren.filter(node => node.tag === 'title').some(title => title.children.some(child => typeof child !== 'string'))) return null
    const allLinksInHead = headChildren.filter(node => node.tag === 'link')
    if (!allLinksInHead.some(link => link.attrs.rel?.trim().toLowerCase() === 'canonical' && link.attrs.href === input.url)) return null
    const article = childNodes(parsed).flatMap(node => {
      const found: HtmlNode[] = []
      const scan = (item: HtmlNode) => { if (item.tag === 'article' && item.attrs['data-ds-live-content'] === 'v1') found.push(item); for (const child of childNodes(item)) scan(child) }
      scan(node); return found
    })[0]
    if (!article) return null
    const attrs = article.attrs
    const fakeInput: LiveDocumentInput = {
      publicationId: attrs['data-ds-publication-id'] ?? '', draftId: attrs['data-ds-draft-id'] ?? '', reviewId: attrs['data-ds-review-id'] ?? '',
      contentHash: attrs['data-ds-content-hash'] ?? '', evidenceSnapshotHash: attrs['data-ds-evidence-hash'] ?? '', title: '', body: '',
    }
    if (!isOpaqueReference(fakeInput.publicationId) || !isOpaqueReference(fakeInput.draftId) || !isOpaqueReference(fakeInput.reviewId) || !isValidSha256(fakeInput.contentHash) || !isValidSha256(fakeInput.evidenceSnapshotHash)) return null
    const markedTitle = childNodes(article).find(node => node.tag === 'h1' && Object.hasOwn(node.attrs, 'data-ds-live-title'))
    const markedBody = childNodes(article).find(node => node.tag === 'section' && Object.hasOwn(node.attrs, 'data-ds-live-body'))
    if (!markedTitle || !markedBody) return null
    const title = textOnly(markedTitle)
    if (title === undefined || !title || scanOutcomeLearningPii({ title }).status !== 'none_detected') return null
    const canonicalHref = findCanonical(parsed)
    if (!canonicalHref || canonicalHref !== input.url) return null
    const expectedAttrs = ['data-ds-live-content', 'data-ds-publication-id', 'data-ds-draft-id', 'data-ds-review-id', 'data-ds-content-hash', 'data-ds-evidence-hash']
    const articleChildren = significant(article.children)
    if (Object.keys(article.attrs).length !== expectedAttrs.length || expectedAttrs.some(key => !Object.hasOwn(article.attrs, key)) || articleChildren.length !== 2 || !articleChildren.includes(markedTitle) || !articleChildren.includes(markedBody) || markedTitle === markedBody || Object.keys(markedTitle.attrs).length !== 1 || Object.keys(markedBody.attrs).length !== 1) return null
    if (markedTitle.attrs['data-ds-live-title'] !== '' || markedBody.attrs['data-ds-live-body'] !== '') return null
    const allNodes: HtmlNode[] = []
    const walk = (node: HtmlNode) => { allNodes.push(node); for (const nested of childNodes(node)) walk(nested) }
    walk(parsed)
    const mains = allNodes.filter(node => node.tag === 'main' && containsNode(body, node))
    if (mains.length !== 1) return null
    const articlePath = findNodePath(parsed, article)
    if (!articlePath || articlePath.some(node => node.tag !== '#root' && (Object.hasOwn(node.attrs, 'hidden') || Object.hasOwn(node.attrs, 'inert') || node.attrs['aria-hidden']?.toLowerCase() === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$))/iu.test(node.attrs.style ?? '')))) return null
    if (allNodes.some(node => {
      const within = containsNode(article, node)
      if (node.tag === 'article' && node !== article) return true
      if (['script', 'style', '#comment'].includes(node.tag)) return within
      if (!within || node === article || node === markedTitle || node === markedBody) return false
      if (Object.hasOwn(node.attrs, 'hidden') || Object.hasOwn(node.attrs, 'style') || node.attrs['aria-hidden']?.toLowerCase() === 'true' || Object.keys(node.attrs).some(key => /^on/iu.test(key))) return true
      return false
    })) return null
    if (findCanonical(parsed) !== input.url || allNodes.filter(node => node.tag === 'article').length !== 1) return null
    // Extract semantic blocks against the actual tagged structure, then validate through an exact synthetic source.
    const blocks = extractBodyBlocks(markedBody)
    if (!blocks?.length || blocks.length > MAX_UNITS || scanOutcomeLearningPii({ title, body: blocks }).status !== 'none_detected') return null
    const hashes = blocks.map(block => sha(canonicalJson(block)))
    const identityFingerprint = sha(`${HASH_DOMAIN}\nidentity\n${canonicalJson({ publicationId: fakeInput.publicationId, draftId: fakeInput.draftId, reviewId: fakeInput.reviewId, contentHash: fakeInput.contentHash, evidenceSnapshotHash: fakeInput.evidenceSnapshotHash })}`)
    return finishProjection({ contractVersion: PROJECTION_VERSION, kind: 'controlled_document', urlHash, responseHash, canonicalUrlHash: urlHash, publicationIdentityFingerprint: identityFingerprint, titleHash: sha(title), bodyUnitHashes: hashes, semanticBodyHash: semanticHash(hashes), titleLength: codePointLength(title), bodyTextLength: codePointLength(blocks.map(block => inlineText(block.children)).join('\n')), headingCount: blocks.filter(block => block.kind === 'heading').length, linkCount: blocks.reduce((sum, block) => sum + countLinks(block.children), 0) })
  } catch { return null }
}

function findCanonical(root: HtmlNode): string | undefined {
  const links: HtmlNode[] = []
  const visit = (node: HtmlNode) => { if (node.tag === 'link' && node.attrs.rel?.trim().toLowerCase() === 'canonical') links.push(node); for (const child of childNodes(node)) visit(child) }
  visit(root)
  return links.length === 1 && Object.keys(links[0]!.attrs).length === 2 ? links[0]!.attrs.href : undefined
}

function extractBodyBlocks(body: HtmlNode): Block[] | undefined {
  const blocks: Block[] = []
  for (const child of body.children) {
    if (typeof child === 'string') { if (child.trim()) return undefined; continue }
    if (child.tag === 'p' && Object.keys(child.attrs).length === 0) {
      const children = parseHtmlInlines(child.children); if (!children) return undefined
      blocks.push({ kind: 'paragraph', children }); continue
    }
    if (/^h[1-6]$/u.test(child.tag) && Object.keys(child.attrs).length === 0) {
      const children = parseHtmlInlines(child.children); if (!children) return undefined
      blocks.push({ kind: 'heading', level: Number(child.tag[1]), children }); continue
    }
    if (child.tag === 'ul' || child.tag === 'ol') {
      if (Object.keys(child.attrs).length) return undefined
      for (const item of childNodes(child)) {
        if (item.tag !== 'li' || Object.keys(item.attrs).length) return undefined
        const children = parseHtmlInlines(item.children); if (!children) return undefined
        blocks.push({ kind: 'list_item', ordered: child.tag === 'ol', children })
      }
      if (child.children.some(item => typeof item === 'string' && item.trim())) return undefined
      continue
    }
    return undefined
  }
  return blocks
}

export function verifyLivePageProjection(value: unknown): value is LivePageProjection {
  try {
    const record = exactRecord(value, ['contractVersion', 'kind', 'urlHash', 'responseHash', 'canonicalUrlHash', 'publicationIdentityFingerprint', 'titleHash', 'bodyUnitHashes', 'semanticBodyHash', 'titleLength', 'bodyTextLength', 'headingCount', 'linkCount', 'projectionFingerprint'])
    if (!record || record.contractVersion !== PROJECTION_VERSION || record.kind !== 'controlled_document' && record.kind !== 'not_found' || typeof record.urlHash !== 'string' || !SHA256.test(record.urlHash) || typeof record.responseHash !== 'string' || !SHA256.test(record.responseHash)) return false
    const units = exactArray(record.bodyUnitHashes, MAX_UNITS)
    if (!units || units.some(hash => typeof hash !== 'string' || !SHA256.test(hash))) return false
    const titleLength = record.titleLength
    const bodyTextLength = record.bodyTextLength
    const headingCount = record.headingCount
    const linkCount = record.linkCount
    const numericFields = [titleLength, bodyTextLength, headingCount, linkCount]
    if (numericFields.some(field => typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0 || field > MAX_TEXT_LENGTH)) return false
    if (record.kind === 'not_found') {
      if (record.canonicalUrlHash !== null || record.publicationIdentityFingerprint !== null || record.titleHash !== null || record.semanticBodyHash !== null || units.length !== 0 || titleLength !== 0 || bodyTextLength !== 0 || headingCount !== 0 || linkCount !== 0) return false
    } else if (typeof record.canonicalUrlHash !== 'string' || !SHA256.test(record.canonicalUrlHash) || record.canonicalUrlHash !== record.urlHash || typeof record.publicationIdentityFingerprint !== 'string' || !SHA256.test(record.publicationIdentityFingerprint) || typeof record.titleHash !== 'string' || !SHA256.test(record.titleHash) || typeof record.semanticBodyHash !== 'string' || !SHA256.test(record.semanticBodyHash) || record.semanticBodyHash !== semanticHash(units as string[]) || units.length === 0 || typeof titleLength !== 'number' || typeof bodyTextLength !== 'number' || typeof headingCount !== 'number' || typeof linkCount !== 'number' || titleLength === 0 || titleLength > 16_384 || headingCount > units.length || linkCount > bodyTextLength) return false
    const { projectionFingerprint, ...payload } = record
    return typeof projectionFingerprint === 'string' && SHA256.test(projectionFingerprint) && sha(projectionPayload(payload as Omit<LivePageProjection, 'projectionFingerprint'>)) === projectionFingerprint
  } catch { return false }
}

export function livePageMatchesExpected(actual: LivePageProjection, expected: LivePageProjection): boolean {
  try {
    if (!verifyLivePageProjection(actual) || !verifyLivePageProjection(expected) || actual.kind !== 'controlled_document' || expected.kind !== 'controlled_document') return false
    return actual.urlHash === expected.urlHash && actual.canonicalUrlHash === expected.canonicalUrlHash && actual.publicationIdentityFingerprint === expected.publicationIdentityFingerprint && actual.titleHash === expected.titleHash && actual.semanticBodyHash === expected.semanticBodyHash && canonicalJson(actual.bodyUnitHashes) === canonicalJson(expected.bodyUnitHashes) && actual.titleLength === expected.titleLength && actual.bodyTextLength === expected.bodyTextLength && actual.headingCount === expected.headingCount && actual.linkCount === expected.linkCount
  } catch { return false }
}

function actionFrom(before: LivePageProjection, expected: LivePageProjection): PlannedLiveAction | null {
  if (!verifyLivePageProjection(before) || !verifyLivePageProjection(expected) || expected.kind !== 'controlled_document' || before.urlHash !== expected.urlHash || before.kind !== 'controlled_document' && before.kind !== 'not_found' || before.bodyUnitHashes.length + expected.bodyUnitHashes.length > MAX_UNITS) return null
  const prior = before.kind === 'not_found' ? [] : before.bodyUnitHashes
  const after = expected.bodyUnitHashes
  const width = after.length + 1
  const lcs = new Uint16Array((prior.length + 1) * width)
  for (let i = prior.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
    const pos = i * width + j
    lcs[pos] = prior[i] === after[j] ? 1 + lcs[(i + 1) * width + j + 1]! : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
  }
  let i = 0, j = 0, added = 0, removed = 0, replaced = 0, unchanged = 0
  let oldGap = 0, newGap = 0
  const flush = () => { const pairs = Math.min(oldGap, newGap); replaced += pairs; removed += oldGap - pairs; added += newGap - pairs; oldGap = 0; newGap = 0 }
  while (i < prior.length && j < after.length) {
    if (prior[i] === after[j]) { flush(); unchanged++; i++; j++ }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) { oldGap++; i++ }
    else { newGap++; j++ }
  }
  oldGap += prior.length - i; newGap += after.length - j; flush()
  const features = {
    newPage: before.kind === 'not_found' ? 1 : 0,
    titleChanged: before.kind === 'not_found' || before.titleHash !== expected.titleHash ? 1 : 0,
    paragraphsAdded: added, paragraphsRemoved: removed, paragraphsReplaced: replaced, paragraphsUnmodified: unchanged,
    beforeTextLength: before.kind === 'not_found' ? 0 : before.bodyTextLength,
    plannedTextLength: expected.bodyTextLength,
    beforeParagraphCount: prior.length,
    plannedParagraphCount: after.length,
  }
  const payload = { contractVersion: ACTION_VERSION, beforeProjectionFingerprint: before.projectionFingerprint, plannedProjectionFingerprint: expected.projectionFingerprint, features }
  return { ...payload, actionFingerprint: sha(`${ACTION_DOMAIN}\n${canonicalJson(payload)}`) }
}

export function buildPlannedLiveAction(before: LivePageProjection, expected: LivePageProjection): PlannedLiveAction | null {
  try { return actionFrom(before, expected) } catch { return null }
}

export function verifyPlannedLiveAction(value: unknown, before: LivePageProjection, expected: LivePageProjection): value is PlannedLiveAction {
  try {
    const record = exactRecord(value, ['contractVersion', 'beforeProjectionFingerprint', 'plannedProjectionFingerprint', 'features', 'actionFingerprint'])
    const features = record && exactRecord(record.features, ['newPage', 'titleChanged', 'paragraphsAdded', 'paragraphsRemoved', 'paragraphsReplaced', 'paragraphsUnmodified', 'beforeTextLength', 'plannedTextLength', 'beforeParagraphCount', 'plannedParagraphCount'])
    if (!record || !features || record.contractVersion !== ACTION_VERSION || typeof record.actionFingerprint !== 'string' || !SHA256.test(record.actionFingerprint)) return false
    const expectedAction = actionFrom(before, expected)
    const normalized = { contractVersion: record.contractVersion, beforeProjectionFingerprint: record.beforeProjectionFingerprint, plannedProjectionFingerprint: record.plannedProjectionFingerprint, features, actionFingerprint: record.actionFingerprint }
    return expectedAction !== null && canonicalJson(normalized) === canonicalJson(expectedAction)
  } catch { return false }
}
