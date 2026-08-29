import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { getDrizzleMediaVaultRepository } from '../../../../../managed-sites/media-vault/repository-drizzle'
import { updateMediaGovernance } from '../../../../../managed-sites/media-vault/service'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { mediaActor } = await requireEditorActor(event, 'content:write'); const body = await readBoundedEditorBody(event) as any; return updateMediaGovernance(getDrizzleMediaVaultRepository(), mediaActor, { assetId: getRouterParam(event, 'assetId') || '', visibility: body.visibility, rightsMetadata: body.rightsMetadata }) })
