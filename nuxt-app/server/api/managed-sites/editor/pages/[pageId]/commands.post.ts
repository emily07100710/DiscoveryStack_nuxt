import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../../managed-sites/page-editor/http'
import { applyPageCommand } from '../../../../../managed-sites/page-editor/engine'
import { getDrizzlePageEditorRepository } from '../../../../../managed-sites/page-editor/repository-drizzle'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { pageActor } = await requireEditorActor(event, 'content:write'); return applyPageCommand(getDrizzlePageEditorRepository(), pageActor, getRouterParam(event, 'pageId') || '', await readBoundedEditorBody(event)) })
