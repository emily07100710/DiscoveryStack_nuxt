import { createError, getRequestHeader, getRequestURL, readBody, setResponseStatus, type H3Event } from 'h3'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { runSiteEvidenceScan, startSiteEvidenceScan } from '../../site-evidence'
import { requireOwner } from '../../utils/auth'

function assertSameOriginMutation(event: H3Event): void {
  const origin = getRequestHeader(event, 'origin') || ''
  const configured = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN || ''
  const expected = configured
    ? (() => { try { return new URL(configured).origin } catch { throw createError({ statusCode: 503, statusMessage: 'Private site-evidence origin is not configured correctly.' }) } })()
    : getRequestURL(event).origin
  if (!origin || (() => { try { return new URL(origin).origin } catch { return '' } })() !== expected) throw createError({ statusCode: 403, statusMessage: 'Site-evidence mutation requires an exact same-origin request.' })
  const fetchSite = getRequestHeader(event, 'sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') throw createError({ statusCode: 403, statusMessage: 'Cross-site site-evidence mutation is not allowed.' })
}

export default defineEventHandler(async event => {
  assertSameOriginMutation(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const scan = await startSiteEvidenceScan(await readBody(event), ownerUserId)
  void runSiteEvidenceScan(scan.id).catch(() => undefined)
  setResponseStatus(event, 202)
  return scan
})
