import { defineEventHandler } from 'h3'
import { getSiteLearningWorkspace } from '../../../content-operations/site-learning'
import { requireSiteLearningOwner, setSiteLearningPrivateHeaders, siteLearningOptions, siteLearningOwnerUserId, siteLearningPublicError } from './_route'

export default defineEventHandler(async event => {
  setSiteLearningPrivateHeaders(event)
  const owner = await requireSiteLearningOwner(event)
  try {
    const ownerUserId = await siteLearningOwnerUserId(owner)
    return await getSiteLearningWorkspace(ownerUserId, await siteLearningOptions())
  } catch (error) {
    siteLearningPublicError(error, '網站成效資料工作區目前無法讀取。')
  }
})
