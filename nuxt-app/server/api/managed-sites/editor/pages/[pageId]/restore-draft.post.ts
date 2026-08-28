import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { restorePageVersion } from '../../../../../managed-sites/page-editor/engine'
import { getDrizzlePageEditorRepository } from '../../../../../managed-sites/page-editor/repository-drizzle'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { pageActor } = await requireEditorActor(event, 'content:write'); const body = await readBoundedEditorBody(event) as any; return restorePageVersion(getDrizzlePageEditorRepository(), pageActor, getRouterParam(event, 'pageId') || '', { version: body.version, expectedPageVersion: body.expectedPageVersion, idempotencyKey: body.idempotencyKey, reason: body.reason }) })
