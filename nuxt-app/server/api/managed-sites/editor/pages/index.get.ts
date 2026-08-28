import { requireEditorActor } from '../../../../managed-sites/page-editor/http'
import { getDrizzlePageEditorRepository } from '../../../../managed-sites/page-editor/repository-drizzle'
export default defineEventHandler(async event => { const { pageActor } = await requireEditorActor(event); return { pages: await getDrizzlePageEditorRepository().listPages(pageActor.ownerUserId, pageActor.projectId) } })
