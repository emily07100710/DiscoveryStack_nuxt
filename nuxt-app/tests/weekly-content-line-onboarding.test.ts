import {createHmac} from 'node:crypto'
import {describe,it,expect,vi} from 'vitest'
import {buildWeeklyLineWelcomeMessage,buildSearchkingRichMenu,sendWeeklyLineReply,weeklyLineConnectUrl,SEARCHKING_WELCOME_TEXT} from '../server/weekly-content/line-onboarding'
import {processWeeklyLineWebhook} from '../server/weekly-content/line-webhook'
import {activateWeeklyReviewConfig,issueLineBindingInvite,createReviewRequest,deriveReviewTokens} from '../server/weekly-content/service'
import {encodeWeeklyLinePostback} from '../server/weekly-content/line-transport'
import {WeeklyFixture,WEEKLY_NOW} from './fixtures/weekly-content/repository'
const USER=`U${'1'.repeat(32)}`,BOT=`U${'2'.repeat(32)}`,SECRET='0'.repeat(32),ACCESS='synthetic-local-only-line-token'
const eid='01FZ74A0TDDPYRVKNK77XKC3ZR',reply='synthetic_reply_token_32_characters'
function event(patch:Record<string,unknown>={}){return {type:'follow',mode:'active',timestamp:WEEKLY_NOW.getTime(),source:{type:'user',userId:USER},webhookEventId:eid,replyToken:reply,...patch}}
function signed(events:unknown[],destination=BOT){const rawBody=Buffer.from(JSON.stringify({destination,events}));return {rawBody,signature:createHmac('sha256',SECRET).update(rawBody).digest('base64')}}
function setup(){const fixture=new WeeklyFixture();const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response('{}',{headers:{'x-line-request-id':'synthetic-accepted'}}));const getDependencies=vi.fn(async()=>fixture.deps());return {fixture,fetchImpl,getDependencies,options:{featureEnabled:true,channelSecret:SECRET,botUserId:BOT,getDependencies,onboarding:{publicOrigin:'https://preview.example.com',liffEnabled:true,liffId:'1234567890-AbCdEf12',channelAccessToken:ACCESS,fetchImpl}}}}
async function activate(f:WeeklyFixture){await activateWeeklyReviewConfig({ownerUserId:1,clientId:1,publicationTargetId:3,policyId:'policy-1',idempotencyKey:'synthetic-config'},f.deps())}
describe('搜尋王 customer welcome and signed interactions',()=>{
 it('provides honest branded copy and a fixed LIFF entry with no customer, invite or identity in URLs',()=>{
  const f=setup(),text=JSON.stringify(buildWeeklyLineWelcomeMessage(f.options.onboarding))
  expect(text).toContain('DS搜尋王');expect(text).toContain('#171A32');expect(text).toContain('#B9A477');expect(text).toContain('https://liff.line.me/1234567890-AbCdEf12');expect(text).toContain('邀請碼');expect(text).not.toContain(USER);expect(text).not.toContain('wli_');expect(SEARCHKING_WELCOME_TEXT).toContain('只有你同意的那一版');expect(SEARCHKING_WELCOME_TEXT).not.toContain('👑')
  expect(weeklyLineConnectUrl({publicOrigin:'https://preview.example.com'})).toBe('https://preview.example.com/weekly-content/connect')
 })
 it.each(['https://127.0.0.1','http://preview.example.com','https://preview.example.com/?key=secret'])('rejects unsafe configured origin %s before creating cards',origin=>expect(()=>weeklyLineConnectUrl({publicOrigin:origin})).toThrow())
 it('rejects invalid LIFF IDs instead of interpolating an arbitrary destination',()=>expect(()=>weeklyLineConnectUrl({publicOrigin:'https://preview.example.com',liffEnabled:true,liffId:'evil.example/?token=secret'})).toThrow())
 it('covers a bounded rich menu with three fixed safe commands, never a customer directory',()=>{
  const menu=buildSearchkingRichMenu();expect(menu.size).toEqual({width:2500,height:843});expect(menu.name).toBe('DS搜尋王 客戶服務');expect(menu.areas.map(a=>a.action.text)).toEqual(['綁定我的公司','我的公司','使用說明']);expect(menu.areas.reduce((n,a)=>n+a.bounds.width,0)).toBe(2500)
 })
 it('verifies exact signature and destination before resolving a repository or replying',async()=>{
  const f=setup();await expect(processWeeklyLineWebhook({...f.options,...signed([event()]),signature:'bad'})).rejects.toMatchObject({statusCode:401});await expect(processWeeklyLineWebhook({...f.options,...signed([event()],USER)})).rejects.toMatchObject({statusCode:400});expect(f.getDependencies).not.toHaveBeenCalled();expect(f.fetchImpl).not.toHaveBeenCalled()
 })
 it.each([{source:{type:'group',userId:USER,groupId:'private'}},{source:{type:'user',userId:`C${'1'.repeat(32)}`}},{mode:'standby'},{replyToken:'bad'}])('does not greet invalid or group identity %j',async patch=>{
  const f=setup();expect(await processWeeklyLineWebhook({...f.options,...signed([event(patch)])})).toEqual({status:'accepted',processed:0,ignored:1});expect(f.getDependencies).not.toHaveBeenCalled();expect(f.fetchImpl).not.toHaveBeenCalled()
 })
 it('deduplicates a real durable welcome event even if redelivery changes the reply token',async()=>{
  const f=setup();await processWeeklyLineWebhook({...f.options,...signed([event()])});await processWeeklyLineWebhook({...f.options,...signed([event({replyToken:'another_synthetic_reply_32_chars',deliveryContext:{isRedelivery:true}})])});expect(f.fixture.state.inbox).toHaveLength(1);expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  const [url,options]=f.fetchImpl.mock.calls[0]!;expect(url).toBe('https://api.line.me/v2/bot/message/reply');expect(options).toMatchObject({method:'POST',redirect:'error',headers:{authorization:`Bearer ${ACCESS}`}});const body=JSON.parse(options!.body as string);expect(body.replyToken).toBe(reply);expect(body.messages[0].type).toBe('flex');expect(body).not.toHaveProperty('to');expect(JSON.stringify(body)).not.toContain(USER)
 })
 it.each(['綁定我的公司','我的公司','查看待審文章','使用說明'])('handles only the fixed command %s with identity-protected LIFF entry',async command=>{
  const f=setup();await processWeeklyLineWebhook({...f.options,...signed([event({type:'message',message:{type:'text',text:command}})])});expect(f.fetchImpl).toHaveBeenCalledTimes(1);expect(f.fixture.state.binding).toBeNull();expect(f.fixture.state.requests).toHaveLength(0)
 })
 it('never turns arbitrary company names into bindings',async()=>{const f=setup();await processWeeklyLineWebhook({...f.options,...signed([event({type:'message',message:{type:'text',text:'我是 Do Alignment 管理者'}})])});expect(f.fetchImpl).not.toHaveBeenCalled();expect(f.fixture.state.binding).toBeNull()})
 it('stops configuration mistakes before dependencies, after signature verification',async()=>{
  const f=setup();await expect(processWeeklyLineWebhook({...f.options,onboarding:{...f.options.onboarding,liffId:'invalid'},...signed([event()])})).rejects.toMatchObject({statusCode:503});expect(f.getDependencies).not.toHaveBeenCalled();expect(f.fetchImpl).not.toHaveBeenCalled()
 })
 it('commits one binding and one confirmation reply without changing the customer selected by the owner invitation',async()=>{
  const f=setup();await activate(f.fixture);const invite=await issueLineBindingInvite({ownerUserId:1,clientId:1},f.fixture.deps());const e=event({type:'message',message:{type:'text',text:invite.invitationToken}});await processWeeklyLineWebhook({...f.options,onboarding:{...f.options.onboarding,liffEnabled:false},...signed([e])});await processWeeklyLineWebhook({...f.options,onboarding:{...f.options.onboarding,liffEnabled:false},...signed([e])});expect(f.fixture.state.binding?.clientId).toBe(1);expect(f.fixture.state.binding?.lineUserId).toBe(USER);expect(f.fetchImpl).toHaveBeenCalledTimes(1);expect(JSON.stringify(f.fetchImpl.mock.calls)).toContain('綁定已完成')
 })
 it('does not consume a pasted invitation in LIFF mode, and asks the sender to confirm the company in LIFF',async()=>{
  const f=setup();await activate(f.fixture);const invite=await issueLineBindingInvite({ownerUserId:1,clientId:1},f.fixture.deps());await processWeeklyLineWebhook({...f.options,...signed([event({type:'message',message:{type:'text',text:invite.invitationToken}})])});expect(f.fixture.state.binding).toBeNull();expect(f.fixture.state.invites[0]?.consumedAt).toBeNull();expect(f.fetchImpl).toHaveBeenCalledTimes(1);const payload=JSON.parse(f.fetchImpl.mock.calls[0]![1]!.body as string);expect(JSON.stringify(payload)).toContain('確認公司名稱');expect(JSON.stringify(payload)).not.toContain(invite.invitationToken)
 })
 it('fails closed for pasted invitations when LIFF confirmation is required but interactive replies are unavailable',async()=>{
  const f=setup();await activate(f.fixture);const invite=await issueLineBindingInvite({ownerUserId:1,clientId:1},f.fixture.deps());expect(await processWeeklyLineWebhook({...f.options,onboarding:undefined,requireLiffBindingConfirmation:true,...signed([event({type:'message',message:{type:'text',text:invite.invitationToken}})])})).toEqual({status:'accepted',processed:0,ignored:1});expect(f.fixture.state.binding).toBeNull();expect(f.fixture.state.invites[0]?.consumedAt).toBeNull();expect(f.getDependencies).not.toHaveBeenCalled()
 })
 it('keeps a committed exact approval when the convenience reply fails, without sending it twice',async()=>{
  const f=setup();await activate(f.fixture);const invite=await issueLineBindingInvite({ownerUserId:1,clientId:1},f.fixture.deps());await processWeeklyLineWebhook({...f.options,onboarding:{...f.options.onboarding,liffEnabled:false},...signed([event({type:'message',message:{type:'text',text:invite.invitationToken}})])});const created=await createReviewRequest({ownerUserId:1,clientId:1,entryId:8},f.fixture.deps());const req=f.fixture.state.requests[0]!;const tokens=deriveReviewTokens(req,f.fixture.deps().tokenKey);f.fetchImpl.mockClear();f.fetchImpl.mockRejectedValue(new Error(`private ${USER} ${ACCESS}`));const e=event({type:'postback',webhookEventId:'01FZ74A0TDDPYRVKNK77XKC3ZS',postback:{data:encodeWeeklyLinePostback(created.request.requestId,tokens.actionToken,'approved')}});expect(await processWeeklyLineWebhook({...f.options,...signed([e])})).toMatchObject({status:'accepted',processed:1});await processWeeklyLineWebhook({...f.options,...signed([e])});expect(f.fixture.state.consents).toHaveLength(1);expect(f.fixture.state.queued).toBe(1);expect(f.fetchImpl).toHaveBeenCalledTimes(1)
 })
 it('does not call LINE or load DB when the feature is disabled',async()=>{const f=setup();expect(await processWeeklyLineWebhook({...f.options,featureEnabled:false,...signed([event()])})).toEqual({status:'disabled',processed:0,ignored:0});expect(f.getDependencies).not.toHaveBeenCalled();expect(f.fetchImpl).not.toHaveBeenCalled()})
 it('returns a generic receipt outcome without provider body, credentials or recipient',async()=>{const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response('private-prose',{status:400}));const result=await sendWeeklyLineReply({replyToken:reply,message:{type:'text',text:'示意確認'}},{channelAccessToken:ACCESS,fetchImpl});expect(result).toEqual({accepted:false,errorCode:'line_reply_outcome_unknown'});expect(JSON.stringify(result)).not.toContain('private-prose')})
})
