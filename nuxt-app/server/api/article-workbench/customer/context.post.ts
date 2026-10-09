import {articleContextInput,articleCustomerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {getArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {input,actor,dependencies}=await articleCustomerHttpInput(event,articleContextInput);return await getArticleWorkspace({workspaceId:input.workspaceId,actor},dependencies)}catch(cause){articlePublicError(cause)}})
