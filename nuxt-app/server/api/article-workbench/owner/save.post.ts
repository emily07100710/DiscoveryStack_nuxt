import {articleOwnerSaveInput,articleOwnerHttpInput,articlePublicError} from '../../../article-workbench/http'
import {saveArticleWorkspace} from '../../../article-workbench/service'
export default defineEventHandler(async event=>{try{const {ownerUserId,input,dependencies}=await articleOwnerHttpInput(event,articleOwnerSaveInput);return await saveArticleWorkspace({...input,actor:{kind:'owner',ownerUserId}},dependencies)}catch(cause){articlePublicError(cause)}})
