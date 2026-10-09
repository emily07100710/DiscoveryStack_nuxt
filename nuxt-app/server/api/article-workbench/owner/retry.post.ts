import {articleOwnerRetryInput,articleOwnerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {retryArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {ownerUserId,input,dependencies}=await articleOwnerHttpInput(event,articleOwnerRetryInput);return await retryArticleWorkspace({ownerUserId,...input},dependencies)}catch(cause){articlePublicError(cause)}})
