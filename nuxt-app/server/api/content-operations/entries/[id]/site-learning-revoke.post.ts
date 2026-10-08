import { createError, defineEventHandler, getRouterParam } from 'h3'
import { revokeSiteLearningOptIn } from '../../../../content-operations/site-learning'
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
    const body = exactSiteLearningRecord(await readSiteLearningBody(event, 512), ['targetRowId', 'expectedGrantFingerprint', 'confirmed', 'idempotencyKey'])
    if (!positiveSiteLearningId(body.targetRowId) || typeof body.expectedGrantFingerprint !== 'string' || !HASH.test(body.expectedGrantFingerprint)
      || body.confirmed !== true || typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/u.test(body.idempotencyKey)) throw createError({ statusCode: 422 })
    const ownerUserId = await siteLearningOwnerUserId(owner)
    return await revokeSiteLearningOptIn(ownerUserId, entryId, {
      targetRowId: body.targetRowId,
      expectedGrantFingerprint: body.expectedGrantFingerprint,
      confirmed: true,
      idempotencyKey: body.idempotencyKey,
    }, await siteLearningOptions())
  } catch (error) {
    siteLearningPublicError(error, '撤銷網站成效資料授權目前無法完成；既有資料不會被宣稱已刪除。')
  }
})
