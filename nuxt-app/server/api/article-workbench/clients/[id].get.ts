import {requireWeeklyOwner,weeklyPathId} from '../../../weekly-content/http'
import {articlePublicError} from '../../../article-workbench/http'
import {articleWorkbenchRuntimeDependencies} from '../../../article-workbench/runtime'
import {listArticleWorkspaces} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const ownerUserId=await requireWeeklyOwner(event);return await listArticleWorkspaces({ownerUserId,clientId:weeklyPathId(event)},articleWorkbenchRuntimeDependencies())}catch(cause){articlePublicError(cause)}})
