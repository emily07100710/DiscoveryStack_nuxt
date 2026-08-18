import { buildPublicManifestReadiness } from '../../audit/baselines'
import { publicResearchCases } from '../../audit/researchCases'
import { getOwnerDatabaseUserId, listOwnerAuditWorkspaces } from '../../audit/repository'
import { getOwnerPublicManifestCandidateReadiness } from '../../public-intelligence/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const [workspaces, publicTraining] = await Promise.all([listOwnerAuditWorkspaces(ownerUserId), getOwnerPublicManifestCandidateReadiness(ownerUserId)])
  return {
    owner: { name: owner.name, role: owner.role },
    workspaces,
    readiness: buildPublicManifestReadiness(publicTraining),
    researchCases: publicResearchCases,
  }
})
