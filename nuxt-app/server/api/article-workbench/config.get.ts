import {setResponseHeaders} from 'h3'
import {weeklyLiffConfiguration,WEEKLY_LIFF_HEADERS} from '../../weekly-content/liff-service'
import {articleReceiverRuntimeConfiguration} from '../../article-workbench/runtime'
import {isWeeklyLineAccessToken} from '../../weekly-content/line-transport'

export default defineEventHandler(event=>{
  setResponseHeaders(event,WEEKLY_LIFF_HEADERS)
  const configuration=weeklyLiffConfiguration()
  if(!configuration.enabled||!articleReceiverRuntimeConfiguration()||!isWeeklyLineAccessToken(process.env.NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN))return {enabled:false as const}
  return {enabled:true as const,liffId:configuration.liffId,origin:configuration.origin}
})
