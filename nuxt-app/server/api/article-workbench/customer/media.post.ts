import {articleCustomerUpload} from '../../../article-workbench/media-http'
import {articlePublicError} from '../../../article-workbench/http'
export default defineEventHandler(async event=>{try{return await articleCustomerUpload(event)}catch(cause){articlePublicError(cause)}})
