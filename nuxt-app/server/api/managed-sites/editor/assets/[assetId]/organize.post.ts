import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { organizeMediaAsset } from '../../../../../managed-sites/media-vault/organization'
import { getDrizzleMediaVaultRepository } from '../../../../../managed-sites/media-vault/repository-drizzle'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { mediaActor } = await requireEditorActor(event, 'content:write'); const body = await readBoundedEditorBody(event) as any; return organizeMediaAsset(getDrizzleMediaVaultRepository(), mediaActor, { assetId: getRouterParam(event, 'assetId') || '', collectionId: body.collectionId ?? null, tagIds: body.tagIds, idempotencyKey: body.idempotencyKey }) })
