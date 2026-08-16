import { getOwnerDatabaseUserId } from '../../audit/repository'
import { requireOwner } from '../../utils/auth'
import { listOwnerIngestionJobs } from '../../public-intelligence/ingestion-repository'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  return listOwnerIngestionJobs(await getOwnerDatabaseUserId(owner.openId))
})
