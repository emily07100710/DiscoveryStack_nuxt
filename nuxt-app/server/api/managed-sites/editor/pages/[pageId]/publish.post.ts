import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { createPagePublicationIntent } from '../../../../../managed-sites/page-editor/engine'
import { getDrizzleMediaVaultRepository } from '../../../../../managed-sites/media-vault/repository-drizzle'
import { getDrizzlePageEditorRepository } from '../../../../../managed-sites/page-editor/repository-drizzle'
import { resolvePagePublicationAuthority } from '../../../../../managed-sites/page-editor/runtime'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { pageActor } = await requireEditorActor(event, 'content:publish'); const body = await readBoundedEditorBody(event) as any; const media = getDrizzleMediaVaultRepository(); const authority = await resolvePagePublicationAuthority(pageActor); return createPagePublicationIntent({ repository: getDrizzlePageEditorRepository(), actor: pageActor, pageId: getRouterParam(event, 'pageId') || '', expectedPageVersion: body.expectedPageVersion, resolveMedia: (_actor, binding) => media.findAsset(pageActor, binding.assetId), ...authority, idempotencyKey: body.idempotencyKey }) })
