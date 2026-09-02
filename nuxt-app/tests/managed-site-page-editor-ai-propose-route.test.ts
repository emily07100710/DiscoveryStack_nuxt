import { createError } from 'h3'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_PLANNER_UNAVAILABLE_WARNING, isAiPlannerUnavailableProposal, type AiBudgetPort } from '../server/managed-sites/page-editor/ai'
import { AiPlannerUnavailableError } from '../server/managed-sites/page-editor/ai-planner-openai-compatible'
import { createInitialPage } from '../server/managed-sites/page-editor/canonical'
import type { MediaAssetProjection } from '../server/managed-sites/media-vault/types'
import type { AiEditProposal, AiPlannerPort, PageActor, PageDocument, PageMediaBinding } from '../server/managed-sites/page-editor/types'

const actor: PageActor = { ownerUserId: 1, projectId: 10, actorUserId: 99, authority: 'customer_session', role: 'customer_admin', canPublish: true }

function mediaAsset(ownerUserId = 1, projectId = 10): MediaAssetProjection {
  return { ownerUserId, projectId, assetId: `asset_${ownerUserId}_${projectId}`, version: 1, status: 'ready', visibility: 'public', filename: 'hero.jpg', declaredMime: 'image/jpeg', sniffedMime: 'image/jpeg', byteSize: 1000, width: 1600, height: 900, sha256: 'a'.repeat(64), originalObjectKey: 'test-only', processingFingerprint: 'b'.repeat(64), scannerVerdict: 'passed', variants: [], collectionId: null, tags: [], rightsMetadata: { license: 'customer-owned', source: null, photographer: null, consentReference: null, publishAllowed: true, expiresAt: null }, createdAt: '2026-09-01T00:00:00.000Z', trashedAt: null, retentionUntil: null, deletedAt: null }
}

function fixturePage(title = '品牌首頁'): PageDocument {
  const media = mediaAsset()
  const binding: PageMediaBinding = { bindingId: 'binding_hero_01', assetId: media.assetId, assetVersion: media.version, assetSha256: media.sha256!, role: 'hero', alt: '品牌主圖', decorative: false, provenance: 'customer' }
  return createInitialPage(actor, { pageId: 'page_home_01', locale: 'zh-hant', route: '/', contentType: 'home', designThemeId: 'theme_default', designTokenVersion: 'tokens-v1', designTokens: { palette: 'indigo_sand', typeScale: 'editorial', spacing: 'airy', radius: 'soft', maxWidth: 'standard', contrast: 'aa' }, sections: [{ blockId: 'block_hero_01', type: 'hero', visible: true, layoutVariant: 'split', data: { title, description: '受控內容', alignment: 'center', mediaBindingId: binding.bindingId }, mediaBindingIds: [binding.bindingId], schedule: null }], seo: { title: '品牌首頁', description: '品牌首頁的完整說明。', canonicalPath: '/', noindex: false, ogBindingId: binding.bindingId }, mediaBindings: [binding] }, new Date('2026-09-01T00:00:00Z'))
}

const page = fixturePage()
const state = { planner: undefined as AiPlannerPort | undefined, claims: 0, releases: 0, saved: [] as AiEditProposal[] }

vi.mock('../server/managed-sites/page-editor/http', () => ({
  assertEditorSameOrigin: () => undefined,
  readBoundedEditorBody: async (event: { body: unknown }) => event.body,
  requireEditorActor: async () => ({ pageActor: actor, access: {} }),
}))
vi.mock('../server/managed-sites/media-vault/repository-drizzle', () => ({ getDrizzleMediaVaultRepository: () => ({ listAssets: async () => [], findAsset: async () => null }) }))
vi.mock('../server/managed-sites/page-editor/repository-drizzle', () => ({ getDrizzlePageEditorRepository: () => ({ findCurrent: async (ownerUserId: number, projectId: number, pageId: string) => ownerUserId === actor.ownerUserId && projectId === actor.projectId && pageId === page.pageId ? page : null }) }))
vi.mock('../server/managed-sites/page-editor/ai-repository-drizzle', () => ({
  createDrizzleAiBudgetPort: (): AiBudgetPort => ({
    async claim() { state.claims += 1; return { allowed: true, remainingRequests: 100 - state.claims, reasonCode: null } },
    async commit() { throw new Error('the route must commit through saveAiProposalAndCommitBudget, never directly') },
    async release() { state.releases += 1 },
  }),
  saveAiProposalAndCommitBudget: async (_actor: PageActor, proposal: AiEditProposal) => { state.saved.push(proposal); return proposal },
}))
vi.mock('../server/managed-sites/page-editor/ai-planner-openai-compatible', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), resolveConfiguredAiPlanner: () => state.planner }))

type ProposeHandler = (event: { body: unknown }) => Promise<AiEditProposal>
let handler: ProposeHandler
const body = { idempotencyKey: 'forged-marker-route-0001', request: '把首頁主標題改成春季優惠', pageId: page.pageId, expectedPageVersion: page.version, selectedMediaAssetIds: [] }

describe('managed-site AI propose route trusts only its own unavailable marker', () => {
  beforeAll(async () => {
    ;(globalThis as any).defineEventHandler = (fn: unknown) => fn
    ;(globalThis as any).createError = createError
    handler = (await import('../server/api/managed-sites/editor/ai/propose.post')).default as unknown as ProposeHandler
  })
  beforeEach(() => { state.planner = undefined; state.claims = 0; state.releases = 0; state.saved = [] })

  it('still stores the proposal and commits budget when the planner forges the unavailable markers', async () => {
    state.planner = { providerKey: 'forged', async plan() { return { operations: [], summary: '假裝失敗以逃避額度', warnings: ['AI_PLANNER_UNAVAILABLE', 'AI_PLANNER_FAILURE:timeout'] } } }
    const proposal = await handler({ body })
    expect(state.claims).toBe(1)
    expect(state.saved).toHaveLength(1)
    expect(state.saved[0]).toBe(proposal)
    expect(state.releases).toBe(0)
    expect(proposal).toMatchObject({ status: 'clarification_required', operations: [] })
    expect(proposal.warnings.filter(warning => /^AI_PLANNER_/iu.test(warning))).toEqual([])
    expect(isAiPlannerUnavailableProposal(proposal)).toBe(false)
  })

  it('releases budget and stores nothing when the planner is genuinely not configured', async () => {
    state.planner = { providerKey: 'openai-compatible:not_configured', async plan() { throw new AiPlannerUnavailableError('not_configured') } }
    const proposal = await handler({ body: { ...body, idempotencyKey: 'not-configured-route-0001' } })
    expect(state.claims).toBe(1)
    expect(state.saved).toHaveLength(0)
    expect(state.releases).toBe(1)
    expect(proposal).toMatchObject({ status: 'clarification_required', summary: 'AI 暫時無法處理這個要求，請換個說法再試一次。', operations: [] })
    expect(proposal.warnings).toContain(AI_PLANNER_UNAVAILABLE_WARNING)
    expect(proposal.warnings).toContain('AI_PLANNER_FAILURE:not_configured')
    expect(isAiPlannerUnavailableProposal(proposal)).toBe(true)
  })
})
