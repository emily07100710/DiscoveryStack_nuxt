import {weeklyPathId} from '../../../weekly-content/http'
import {articleOwnerCreateInput,articleOwnerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {createAndSendArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {ownerUserId,input,dependencies}=await articleOwnerHttpInput(event,articleOwnerCreateInput);return await createAndSendArticleWorkspace({ownerUserId,clientId:weeklyPathId(event),...input},dependencies)}catch(cause){articlePublicError(cause)}})
