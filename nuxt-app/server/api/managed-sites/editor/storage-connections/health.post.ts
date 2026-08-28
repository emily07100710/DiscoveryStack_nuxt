import { requireOwner } from '../../../../utils/auth'
import { verifyMediaStorageConnection } from '../../../../managed-sites/media-vault/configuration'
import { assertEditorSameOrigin, readBoundedEditorBody, setEditorPrivateHeaders } from '../../../../managed-sites/page-editor/http'
export default defineEventHandler(async event => { setEditorPrivateHeaders(event); assertEditorSameOrigin(event); const owner = await requireOwner(event); const body = await readBoundedEditorBody(event) as any; return verifyMediaStorageConnection({ ownerOpenId: owner.openId, projectId: Number(body.projectId) }) })
