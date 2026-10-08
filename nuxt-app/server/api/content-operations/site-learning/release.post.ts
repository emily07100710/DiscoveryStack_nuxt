import { createError, defineEventHandler } from 'h3'
import { buildSiteLearningRelease } from '../../../content-operations/site-learning'
import { assertSiteLearningSameOrigin, exactSiteLearningRecord, positiveSiteLearningId, readSiteLearningBody, requireSiteLearningOwner, setSiteLearningPrivateHeaders, siteLearningOptions, siteLearningOwnerUserId, siteLearningPublicError } from './_route'

export default defineEventHandler(async event => {
  setSiteLearningPrivateHeaders(event)
  const owner = await requireSiteLearningOwner(event)
  try {
    assertSiteLearningSameOrigin(event)
    const body = await readSiteLearningBody(event, 512)
    try {
      exactSiteLearningRecord(body, [])
    } catch {
      const confirmed = exactSiteLearningRecord(body, ['confirmed'])
      if (confirmed.confirmed !== true) throw createError({ statusCode: 422 })
    }
    const ownerUserId = await siteLearningOwnerUserId(owner)
    return await buildSiteLearningRelease(ownerUserId, await siteLearningOptions())
  } catch (error) {
    siteLearningPublicError(error, '網站成效資料釋出目前無法完成；未授予訓練或正式部署權限。')
  }
})
