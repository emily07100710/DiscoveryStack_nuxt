import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../managed-sites/page-editor/http'
import { completeMediaUpload } from '../../../../managed-sites/media-vault/service'
import { resolveEditorRuntime } from '../../../../managed-sites/page-editor/runtime'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { mediaActor } = await requireEditorActor(event, 'content:write'); const runtime = await resolveEditorRuntime(mediaActor); return completeMediaUpload({ repository: runtime.mediaRepository, storage: runtime.storage, scanner: runtime.scanner, processor: runtime.processor }, mediaActor, await readBoundedEditorBody(event) as any) })
