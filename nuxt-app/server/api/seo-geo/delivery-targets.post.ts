import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { assertSafeHttpsOrigin } from '../../audit/targetGuard'
import { createDeliveryTarget } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ displayName: z.string().trim().min(2).max(160), adapter: z.enum(['manual_export', 'wordpress_rest', 'generic_http']), targetOrigin: z.string().trim().min(8).max(2048) })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the delivery target fields.', data: parsed.error.flatten().fieldErrors })
  let target
  try { target = assertSafeHttpsOrigin(parsed.data.targetOrigin) } catch (error) { throw createError({ statusCode: 422, statusMessage: error instanceof Error ? error.message : 'Delivery target must be a safe public HTTPS origin.' }) }
  return createDeliveryTarget({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), displayName: parsed.data.displayName, adapter: parsed.data.adapter, targetOrigin: new URL(target.normalizedUrl).origin })
})
