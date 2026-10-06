import type {WeeklyContentDependencies} from './service'
import {runWeeklyLineOutbox as sendOutbox} from './line-outbox'
import {isWeeklyLineAccessToken,normalizeWeeklyLinePublicOrigin,WEEKLY_LINE_USER_ID} from './line-transport'
export function isWeeklyLineConfigurationReady():boolean{
  try{return isWeeklyLineAccessToken(process.env.NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN || '') && WEEKLY_LINE_USER_ID.test(process.env.NUXT_WEEKLY_CONTENT_LINE_BOT_USER_ID || '') && (process.env.NUXT_WEEKLY_CONTENT_LINE_CHANNEL_SECRET || '').length>=16 && (process.env.NUXT_WEEKLY_CONTENT_TOKEN_KEY || '').length>=32 && Boolean(normalizeWeeklyLinePublicOrigin(process.env.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN || ''))}catch{return false}
}
export function runWeeklyLineOutbox(input:{ownerUserId:number;clientId?:number;maxMessages?:number},deps:WeeklyContentDependencies){
 return sendOutbox(input,{...deps,botUserId:process.env.NUXT_WEEKLY_CONTENT_LINE_BOT_USER_ID || '',publicOrigin:process.env.NUXT_WEEKLY_CONTENT_REVIEW_ORIGIN || '',channelAccessToken:process.env.NUXT_WEEKLY_CONTENT_LINE_ACCESS_TOKEN || '',brand:'搜尋王'})
}
