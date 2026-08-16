import { z } from 'zod'
import { requireOwner } from '../../utils/auth'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { getOwnerProviderStatus, saveOwnerProviderCredentials } from '../../public-intelligence/provider-repository'

const providerSettingsSchema = z.object({
  firecrawlApiKey: z.string().trim().max(500).optional(),
  huggingFaceApiToken: z.string().trim().max(500).optional(),
  huggingFaceNamespace: z.string().trim().max(200).optional(),
}).refine(value => Boolean(value.firecrawlApiKey || value.huggingFaceApiToken || value.huggingFaceNamespace), { message: 'Enter at least one provider setting.' })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const body = await readBody(event)
  const input = providerSettingsSchema.parse(body || {})
  await saveOwnerProviderCredentials({ ownerUserId, ...input })
  return { ok: true, status: await getOwnerProviderStatus(ownerUserId) }
})
