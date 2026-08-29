import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { createPrivateMediaRead } from '../../../../../managed-sites/media-vault/service'
import { resolveEditorRuntime } from '../../../../../managed-sites/page-editor/runtime'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { mediaActor } = await requireEditorActor(event, 'content:read'); const body = await readBoundedEditorBody(event) as any; const runtime = await resolveEditorRuntime(mediaActor); return { authorization: await createPrivateMediaRead(runtime.storage, runtime.mediaRepository, mediaActor, getRouterParam(event, 'assetId') || '', typeof body.variantKey === 'string' ? body.variantKey : 'original') } })
