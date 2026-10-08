import { createError, defineEventHandler, getRouterParam } from 'h3'
import { recordSiteLearningOptIn } from '../../../../content-operations/site-learning'
import { assertSiteLearningSameOrigin, exactSiteLearningRecord, positiveSiteLearningId, readSiteLearningBody, requireSiteLearningOwner, setSiteLearningPrivateHeaders, siteLearningOptions, siteLearningOwnerUserId, siteLearningPublicError } from '../../site-learning/_route'

const HASH = /^[a-f0-9]{64}$/u

export default defineEventHandler(async event => {
  setSiteLearningPrivateHeaders(event)
  const owner = await requireSiteLearningOwner(event)
  try {
    assertSiteLearningSameOrigin(event)
    const rawId = getRouterParam(event, 'id')
    const entryId = rawId && /^[1-9]\d{0,11}$/u.test(rawId) ? Number(rawId) : 0
    if (!positiveSiteLearningId(entryId)) throw createError({ statusCode: 422 })
    const body = exactSiteLearningRecord(await readSiteLearningBody(event), ['targetRowId', 'expectedConfirmationFingerprint', 'authorizationId', 'expectedAuthorizationFingerprint', 'customerEvidenceConfirmed', 'scopeConfirmed', 'idempotencyKey'])
    if (!positiveSiteLearningId(body.targetRowId) || !positiveSiteLearningId(body.authorizationId)
      || typeof body.expectedConfirmationFingerprint !== 'string' || !HASH.test(body.expectedConfirmationFingerprint)
      || typeof body.expectedAuthorizationFingerprint !== 'string' || !HASH.test(body.expectedAuthorizationFingerprint)
      || body.customerEvidenceConfirmed !== true || body.scopeConfirmed !== true
      || typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/u.test(body.idempotencyKey)) throw createError({ statusCode: 422 })
    const ownerUserId = await siteLearningOwnerUserId(owner)
    return await recordSiteLearningOptIn(ownerUserId, entryId, {
      targetRowId: body.targetRowId,
      expectedConfirmationFingerprint: body.expectedConfirmationFingerprint,
      authorizationId: body.authorizationId,
      expectedAuthorizationFingerprint: body.expectedAuthorizationFingerprint,
      customerEvidenceConfirmed: true,
      scopeConfirmed: true,
      idempotencyKey: body.idempotencyKey,
    }, await siteLearningOptions())
  } catch (error) {
    siteLearningPublicError(error, '網站成效資料授權目前無法核實；沒有收集或訓練資料。')
  }
})
