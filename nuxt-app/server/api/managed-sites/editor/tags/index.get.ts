import { requireEditorActor } from '../../../../managed-sites/page-editor/http'
import { listMediaOrganization } from '../../../../managed-sites/media-vault/organization'
export default defineEventHandler(async event => { const { mediaActor } = await requireEditorActor(event); const result = await listMediaOrganization(mediaActor); return { tags: result.tags } })
