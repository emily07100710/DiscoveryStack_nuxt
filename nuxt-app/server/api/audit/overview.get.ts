import { buildBaselineReadiness } from '../../audit/baselines'
import { publicResearchCases } from '../../audit/researchCases'
import { getOwnerDatabaseUserId, getOwnerTrainingReadiness, listOwnerAuditWorkspaces } from '../../audit/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const [workspaces, training] = await Promise.all([listOwnerAuditWorkspaces(ownerUserId), getOwnerTrainingReadiness(ownerUserId)])
  return {
    owner: { name: owner.name, role: owner.role },
    workspaces,
    readiness: buildBaselineReadiness({ ...training, huggingFaceConfigured: Boolean(process.env.HUGGINGFACE_API_TOKEN) }),
    researchCases: publicResearchCases,
  }
})
