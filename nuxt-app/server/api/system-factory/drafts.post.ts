import { createSystemDraft } from '../../system-factory/service'
import { strictSystemFactoryBody, systemFactoryOwnerContext } from '../../system-factory/http'

export default defineEventHandler(async event => {
  const { ownerUserId } = await systemFactoryOwnerContext(event, true)
  const body = await strictSystemFactoryBody(event, ['requirements', 'clientId', 'websiteId', 'managedSiteProjectId', 'businessType', 'industry', 'preferredTemplate', 'requestedCapabilities', 'version', 'parentFingerprint', 'idempotencyKey'])
  return createSystemDraft(ownerUserId, body as any)
})
