import {articleFeedbackInput,articleCustomerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {feedbackArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {input,actor,dependencies}=await articleCustomerHttpInput(event,articleFeedbackInput);return await feedbackArticleWorkspace({workspaceId:input.workspaceId,expectedVersion:input.expectedVersion,note:input.note,idempotencyKey:input.idempotencyKey,actor},dependencies)}catch(cause){articlePublicError(cause)}})
