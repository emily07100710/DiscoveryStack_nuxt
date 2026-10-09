import {articleCustomerMediaPreview} from '../../../article-workbench/media-http'
import {articlePublicError} from '../../../article-workbench/http'
export default defineEventHandler(async event=>{try{return await articleCustomerMediaPreview(event)}catch(cause){articlePublicError(cause)}})
