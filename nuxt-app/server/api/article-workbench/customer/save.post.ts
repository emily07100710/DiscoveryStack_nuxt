import {articleSaveInput,articleCustomerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {saveArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {input,actor,dependencies}=await articleCustomerHttpInput(event,articleSaveInput);return await saveArticleWorkspace({workspaceId:input.workspaceId,expectedVersion:input.expectedVersion,document:input.document,idempotencyKey:input.idempotencyKey,actor},dependencies)}catch(cause){articlePublicError(cause)}})
