import { createError, getRequestHeader, getRequestURL, type H3Event } from 'h3'
import { requireOwner } from '../../utils/auth'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { readBoundedRequestBody } from '../../utils/bounded-request-body'
import { parseEmailManualReviewCommand } from './model'
import { createEmailManualReviewRepository } from './repository'
import { closeEmailManualReview } from './service'

export const EMAIL_MANUAL_REVIEW_MAX_BYTES = 2 * 1024

/** Exact browser-origin authority, not a provider webhook, URL path, or caller-owned scope. */
export function assertSameOriginEmailManualReview(event: H3Event): void {
  const configured = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  let expected: string
  try {
    if (process.env.NODE_ENV === 'production' && !configured) throw new Error('Missing private origin.')
    const url = new URL(configured || getRequestURL(event).origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid private origin.')
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('HTTPS private origin required.')
    expected = url.origin
  } catch {
    throw createError({ statusCode: 503, statusMessage: '私人後台網址尚未正確設定。' })
  }
  const origin = getRequestHeader(event, 'origin')
  if (!origin || origin !== expected) throw createError({ statusCode: 403, statusMessage: '郵件人工結案只能從同一個私人後台送出。' })
  const fetchSite = getRequestHeader(event, 'sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') throw createError({ statusCode: 403, statusMessage: '郵件人工結案不接受跨站請求。' })
}

export async function handleEmailManualReviewMutation(event: H3Event) {
  assertSameOriginEmailManualReview(event)
  const owner = await requireOwner(event)
  const enabled = process.env.NUXT_MANAGED_SITE_EMAIL_REVIEW_ENABLED === 'true'
  if (!enabled) throw createError({ statusCode: 503, statusMessage: '郵件人工結案功能尚未開通。' })
  if (getRequestHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw createError({ statusCode: 415, statusMessage: '郵件人工結案必須使用 JSON。' })
  // Invalid/cross-owner hints are rejected before even resolving the owner's database identity.
  const command = parseEmailManualReviewCommand(await readBoundedRequestBody(event, { maxBytes: EMAIL_MANUAL_REVIEW_MAX_BYTES, oversizedMessage: '郵件人工結案內容過大。', invalidMessage: '郵件人工結案資料格式不正確。', invalidStatusCode: 422 }))
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return closeEmailManualReview(ownerUserId, command, { enabled, getRepository: () => createEmailManualReviewRepository() })
}
