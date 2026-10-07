import { createError, getMethod, getRequestHeader, getRouterParam, setResponseHeaders } from 'h3'
import { readBoundedRequestRawBody } from '../../../utils/bounded-request-body'
import { managedSiteEmailEventsReadinessFromEnv } from '../../../managed-sites/email-events/configuration'
import { createEmailProviderEventsRepository } from '../../../managed-sites/email-events/repository'
import { RESEND_EVENTS_MAX_BYTES } from '../../../managed-sites/email-events/protocol'
import { processResendEmailProviderEvent } from '../../../managed-sites/email-events/service'
import { emailConfigurationFingerprint } from '../../../managed-sites/email-outbox/runtime'
import { handleEmailManualReviewMutation } from '../../../managed-sites/email-review/http'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const action = getRouterParam(event, 'action')
  if (action !== 'resend-webhook' && action !== 'manual-resolution') throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  if (getMethod(event) !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  if (action === 'manual-resolution') return handleEmailManualReviewMutation(event)
  const readiness = managedSiteEmailEventsReadinessFromEnv()
  if (!readiness.enabled || !readiness.configured) throw createError({ statusCode: 503, statusMessage: '郵件事件驗證尚未開通。' })
  if (getRequestHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw createError({ statusCode: 415, statusMessage: '郵件事件必須使用 JSON 原始內容。' })
  const rawBody = await readBoundedRequestRawBody(event, { maxBytes: RESEND_EVENTS_MAX_BYTES, oversizedMessage: '郵件事件內容過大。', invalidMessage: '郵件事件原始內容無法驗證。', invalidStatusCode: 400 })
  return processResendEmailProviderEvent({ rawBody, svixId: getRequestHeader(event, 'svix-id'), svixTimestamp: getRequestHeader(event, 'svix-timestamp'), svixSignature: getRequestHeader(event, 'svix-signature') }, {
    enabled: readiness.enabled, configured: readiness.configured,
    signingSecret: process.env.NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET,
    encryptionSecret: process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY,
    providerConfigurationFingerprint: emailConfigurationFingerprint(),
    // Resolve storage only after the raw-byte signature and supported schema have passed.
    getRepository: () => createEmailProviderEventsRepository(),
  })
})
