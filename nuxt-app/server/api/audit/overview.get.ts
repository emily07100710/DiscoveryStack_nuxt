import { buildBaselineReadiness, buildPublicManifestReadiness } from '../../audit/baselines'
import { publicResearchCases } from '../../audit/researchCases'
import { getOwnerDatabaseUserId, getOwnerTrainingReadiness, listOwnerAuditWorkspaces } from '../../audit/repository'
import { getOwnerPublicManifestCandidateReadiness } from '../../public-intelligence/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const [workspaces, publicTraining, legacyTraining] = await Promise.all([
    listOwnerAuditWorkspaces(ownerUserId),
    getOwnerPublicManifestCandidateReadiness(ownerUserId),
    getOwnerTrainingReadiness(ownerUserId),
  ])
  const legacyReadiness = buildBaselineReadiness({
    ...legacyTraining,
    huggingFaceConfigured: Boolean(process.env.HUGGINGFACE_API_TOKEN),
  })
  return {
    owner: { name: owner.name, role: owner.role },
    workspaces,
    readiness: {
      ...buildPublicManifestReadiness(publicTraining),
      bgeM3: legacyReadiness.bgeM3,
    },
    researchCases: publicResearchCases,
  }
})
