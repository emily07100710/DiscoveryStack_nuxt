import { assertEditorSameOrigin, readBoundedEditorBody, requireEditorActor } from '../../../../managed-sites/page-editor/http'
import { createInitialPage } from '../../../../managed-sites/page-editor/canonical'
import { getDrizzlePageEditorRepository } from '../../../../managed-sites/page-editor/repository-drizzle'
export default defineEventHandler(async event => { assertEditorSameOrigin(event); const { pageActor } = await requireEditorActor(event, 'content:write'); const body = await readBoundedEditorBody(event) as any; const page = createInitialPage(pageActor, body); await getDrizzlePageEditorRepository().insertInitial(pageActor.ownerUserId, pageActor.projectId, page); return { page } })
