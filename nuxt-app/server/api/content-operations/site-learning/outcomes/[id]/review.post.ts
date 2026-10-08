import { createError, defineEventHandler, getRouterParam } from 'h3'
import { reviewSiteLearningOutcome } from '../../../../../content-operations/site-learning'
import { assertSiteLearningSameOrigin, exactSiteLearningRecord, positiveSiteLearningId, readSiteLearningBody, requireSiteLearningOwner, setSiteLearningPrivateHeaders, siteLearningOptions, siteLearningOwnerUserId, siteLearningPublicError } from '../../_route'

const HASH = /^[a-f0-9]{64}$/u

export default defineEventHandler(async event => {
  setSiteLearningPrivateHeaders(event)
  const owner = await requireSiteLearningOwner(event)
  try {
    assertSiteLearningSameOrigin(event)
    const rawId = getRouterParam(event, 'id')
    const assessmentId = rawId && /^[1-9]\d{0,11}$/u.test(rawId) ? Number(rawId) : 0
    if (!positiveSiteLearningId(assessmentId)) throw createError({ statusCode: 422 })
    const body = exactSiteLearningRecord(await readSiteLearningBody(event), ['expectedAssessmentFingerprint', 'expectedGrantFingerprint', 'decision', 'piiReviewed', 'limitationsUnderstood', 'idempotencyKey'])
    if (typeof body.expectedAssessmentFingerprint !== 'string' || !HASH.test(body.expectedAssessmentFingerprint)
      || typeof body.expectedGrantFingerprint !== 'string' || !HASH.test(body.expectedGrantFingerprint)
      || typeof body.decision !== 'string' || !['approve', 'reject'].includes(body.decision) || body.piiReviewed !== true || body.limitationsUnderstood !== true
      || typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/u.test(body.idempotencyKey)) throw createError({ statusCode: 422 })
    const ownerUserId = await siteLearningOwnerUserId(owner)
    return await reviewSiteLearningOutcome(ownerUserId, assessmentId, {
      expectedAssessmentFingerprint: body.expectedAssessmentFingerprint,
      expectedGrantFingerprint: body.expectedGrantFingerprint,
      decision: body.decision,
      piiReviewed: true,
      limitationsUnderstood: true,
      idempotencyKey: body.idempotencyKey,
    }, await siteLearningOptions())
  } catch (error) {
    siteLearningPublicError(error, '成效資料審查目前無法完成；未准入訓練。')
  }
})
