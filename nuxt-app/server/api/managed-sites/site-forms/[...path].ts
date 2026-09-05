import { createError, getHeader, getMethod, getRequestURL, send, sendRedirect, setResponseHeaders, type H3Event } from 'h3'
import { ingestManagedSiteContactForm } from '../../../managed-sites/contact-form/ingest-service'

export const MANAGED_SITE_CONTACT_FORM_MAX_BYTES = 16 * 1024
const prefix = '/api/managed-sites/site-forms'

function oversized(): never { throw createError({ statusCode: 413, statusMessage: '聯絡表單內容超過大小限制。' }) }

export async function readBoundedManagedSiteContactFormBody(event: H3Event): Promise<Buffer> {
  const announced = String(getHeader(event, 'content-length') || '').trim()
  if (/^\d+$/u.test(announced) && Number(announced) > MANAGED_SITE_CONTACT_FORM_MAX_BYTES) oversized()
  const cached = event._requestBody
  if (typeof cached === 'string' || Buffer.isBuffer(cached) || cached instanceof Uint8Array || cached instanceof ArrayBuffer) {
    const bytes = Buffer.isBuffer(cached) ? cached : cached instanceof ArrayBuffer ? Buffer.from(new Uint8Array(cached)) : Buffer.from(cached)
    if (bytes.byteLength > MANAGED_SITE_CONTACT_FORM_MAX_BYTES) oversized()
    return bytes
  }
  const webBody = event.web?.request?.body
  if (webBody) {
    const reader = webBody.getReader()
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.byteLength
      if (total > MANAGED_SITE_CONTACT_FORM_MAX_BYTES) { await reader.cancel(); oversized() }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of event.node.req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.byteLength
    if (total > MANAGED_SITE_CONTACT_FORM_MAX_BYTES) { event.node.req.pause(); oversized() }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  const pathname = getRequestURL(event).pathname
  const matched = /^\/api\/managed-sites\/site-forms\/([a-f0-9]{64})\/submit$/u.exec(pathname)
  if (!pathname.startsWith(prefix) || !matched) throw createError({ statusCode: 404, statusMessage: '聯絡表單不存在或尚未啟用。' })
  if (getMethod(event) !== 'POST') throw createError({ statusCode: 404, statusMessage: '聯絡表單不存在或尚未啟用。' })
  const rawBody = await readBoundedManagedSiteContactFormBody(event)
  const contentType = String(getHeader(event, 'content-type') || '').toLowerCase()
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/u.test(contentType)) throw createError({ statusCode: 415, statusMessage: '聯絡表單內容格式不支援。' })
  const result = await ingestManagedSiteContactForm(event, matched[1]!, rawBody)
  if (result.status === 303) return sendRedirect(event, result.location, 303)
  return send(event, result.html, 'text/html; charset=utf-8')
})
