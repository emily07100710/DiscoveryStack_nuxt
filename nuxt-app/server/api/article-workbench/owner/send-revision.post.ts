import {articleOwnerSendRevisionInput,articleOwnerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {sendRevisedArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {ownerUserId,input,dependencies}=await articleOwnerHttpInput(event,articleOwnerSendRevisionInput);return await sendRevisedArticleWorkspace({ownerUserId,...input},dependencies)}catch(cause){articlePublicError(cause)}})
