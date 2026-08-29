import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../managed-sites/page-editor/http'
import { createMediaTag } from '../../../../managed-sites/media-vault/organization'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { mediaActor } = await requireEditorActor(event, 'content:write'); return createMediaTag(mediaActor, await readBoundedEditorBody(event) as any) })
