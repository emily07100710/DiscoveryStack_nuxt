import {articleApproveInput,articleCustomerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {approveArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {input,actor,dependencies}=await articleCustomerHttpInput(event,articleApproveInput);return await approveArticleWorkspace({workspaceId:input.workspaceId,expectedVersion:input.expectedVersion,documentHash:input.documentHash,confirmation:input.confirmation,idempotencyKey:input.idempotencyKey,actor},dependencies)}catch(cause){articlePublicError(cause)}})
