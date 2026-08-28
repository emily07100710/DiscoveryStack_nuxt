import { requireOwner } from '../../../utils/auth'
import { configureMediaStorageConnection } from '../../../managed-sites/media-vault/configuration'
import { assertEditorSameOrigin, readBoundedEditorBody, setEditorPrivateHeaders } from '../../../managed-sites/page-editor/http'
export default defineEventHandler(async event => { setEditorPrivateHeaders(event); assertEditorSameOrigin(event); const owner = await requireOwner(event); const body = await readBoundedEditorBody(event) as any; return configureMediaStorageConnection({ ownerOpenId: owner.openId, projectId: Number(body.projectId), providerKey: body.providerKey, credentialReference: body.credentialReference ?? null, configuration: body.configuration }) })
