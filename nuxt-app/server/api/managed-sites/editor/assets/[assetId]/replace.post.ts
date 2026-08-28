import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { requestMediaReplacementIntent } from '../../../../../managed-sites/media-vault/service'
import { resolveEditorRuntime } from '../../../../../managed-sites/page-editor/runtime'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { mediaActor } = await requireEditorActor(event, 'content:write'); const runtime = await resolveEditorRuntime(mediaActor); return requestMediaReplacementIntent({ repository: runtime.mediaRepository, storage: runtime.storage }, mediaActor, getRouterParam(event, 'assetId') || '', await readBoundedEditorBody(event) as any) })
