import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createOwnerPublicDatasetBuild } from '../../public-intelligence/repository'
import { requireOwner } from '../../utils/auth'

const datasetInput = z.object({ datasetName: z.string().trim().min(2).max(160), datasetVersion: z.string().trim().min(1).max(80), intendedUse: z.enum(['research', 'evaluation', 'training']), featureContractVersion: z.string().trim().min(1).max(80), labelTaxonomyVersion: z.string().trim().max(80).nullable().optional().default(null), splitVersion: z.string().trim().max(80).nullable().optional().default(null), artifactIds: z.array(z.number().int().positive()).min(1).max(10_000), reviewNote: z.string().trim().max(3000).nullable().optional().default(null) })
export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = datasetInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the dataset manifest fields.', data: parsed.error.flatten().fieldErrors })
  return createOwnerPublicDatasetBuild({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), ...parsed.data })
})
