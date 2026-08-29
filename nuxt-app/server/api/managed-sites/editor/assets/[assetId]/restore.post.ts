import { assertEditorSameOrigin, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { getDrizzleMediaVaultRepository } from '../../../../../managed-sites/media-vault/repository-drizzle'
import { restoreMediaAsset } from '../../../../../managed-sites/media-vault/service'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { mediaActor } = await requireEditorActor(event, 'content:write'); return restoreMediaAsset(getDrizzleMediaVaultRepository(), mediaActor, getRouterParam(event, 'assetId') || '') })
