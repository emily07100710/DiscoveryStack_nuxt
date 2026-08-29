import { aiEditRequestFingerprint, proposeAiWebsiteEdit } from '../../../../managed-sites/page-editor/ai'
import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../managed-sites/page-editor/http'
import { getDrizzleMediaVaultRepository } from '../../../../managed-sites/media-vault/repository-drizzle'
import { getDrizzlePageEditorRepository } from '../../../../managed-sites/page-editor/repository-drizzle'
import { createDrizzleAiBudgetPort, saveAiProposalAndCommitBudget } from '../../../../managed-sites/page-editor/ai-repository-drizzle'

export default defineEventHandler(async event => {
  assertEditorSameOrigin(event)
  const { pageActor } = await requireEditorActor(event, 'content:write')
  const body = await readBoundedEditorBody(event) as any
  if (typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(body.idempotencyKey)) throw createError({ statusCode: 422, statusMessage: 'AI proposal idempotency key is required.' })
  if (typeof body.request !== 'string' || !body.request.trim()) throw createError({ statusCode: 422, statusMessage: 'AI website edit request is required.' })
  const pages = getDrizzlePageEditorRepository()
  const page = await pages.findCurrent(pageActor.ownerUserId, pageActor.projectId, String(body.pageId || ''))
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Page was not found.' })
  if (body.expectedPageVersion !== page.version) throw createError({ statusCode: 409, statusMessage: 'AI proposal page version is stale.' })
  const media = getDrizzleMediaVaultRepository()
  const assets = await media.listAssets(pageActor)
  const selectedMediaAssetIds = Array.isArray(body.selectedMediaAssetIds) ? body.selectedMediaAssetIds : []
  const now = new Date()
  const budget = createDrizzleAiBudgetPort()
  const requestFingerprint = aiEditRequestFingerprint({ actor: pageActor, page, request: body.request, selectedMediaAssetIds })
  try {
    const proposal = await proposeAiWebsiteEdit({ actor: pageActor, page, request: body.request, approvedMedia: assets, resolveMedia: (_actor, binding) => media.findAsset(pageActor, binding.assetId), budget, selectedMediaAssetIds, idempotencyKey: body.idempotencyKey, deferBudgetCommit: true, now })
    return await saveAiProposalAndCommitBudget(pageActor, proposal, { idempotencyKey: body.idempotencyKey, requestFingerprint, now })
  } catch (error) {
    await budget.release?.(pageActor, { idempotencyKey: body.idempotencyKey, requestFingerprint, now }).catch(() => undefined)
    throw error
  }
})
