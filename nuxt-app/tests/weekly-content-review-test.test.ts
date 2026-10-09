import {createHmac} from 'node:crypto'
import {describe,expect,it,vi} from 'vitest'
import {buildReviewTestMessage,createAndSendReviewTest,getReviewTestPreview,listReviewTestsForOwner,reviewTestFromVerifiedLine,type ReviewTestDependencies} from '../server/weekly-content/review-test'
import {ReviewTestFixture,REVIEW_TEST_LINE_USER} from './fixtures/weekly-content/review-test-repository'
import {WEEKLY_KEY,WEEKLY_NOW,sha} from './fixtures/weekly-content/repository'

const INPUT={ownerUserId:1,clientId:1,title:'Do Alignment 測試文章',body:'這是一篇純文字測試稿。\n\n請確認閱讀、同意與退回流程。',idempotencyKey:'review-test-key-0001',confirmation:'SEND_REVIEW_TEST' as const}
const accepted=()=>({accepted:true as const,duplicate:false,providerMessageId:'synthetic-line-request'})
function setup(sender:ReviewTestDependencies['sender']=vi.fn(async()=>accepted()),now=WEEKLY_NOW){
  const fixture=new ReviewTestFixture()
  const deps:ReviewTestDependencies={repository:fixture.repository,weeklyRepository:()=>fixture.weekly.repository,featureEnabled:true,tokenKey:WEEKLY_KEY,publicOrigin:'https://synthetic-review.taipei',sender,now}
  return {fixture,deps,sender}
}

describe('isolated owner-prepared LINE review tests',()=>{
  it('creates and sends one 24-hour test without creating formal review, consent, outbox, policy, or publication authority',async()=>{
    const {fixture,deps,sender}=setup(),before={config:fixture.weekly.state.config,requests:fixture.weekly.state.requests.length,consents:fixture.weekly.state.consents.length,outbox:fixture.weekly.state.outbox.length,queued:fixture.weekly.state.queued}
    const result=await createAndSendReviewTest(INPUT,deps)
    expect(result.replayed).toBe(false)
    expect(result.test).toMatchObject({title:INPUT.title,status:'pending',notificationStatus:'sent'})
    expect(result.test.requestId).toMatch(/^wct_[A-Za-z0-9_-]{32}$/)
    expect(Date.parse(result.test.expiresAt)-WEEKLY_NOW.getTime()).toBe(24*60*60*1000)
    expect(Object.keys(result.test).sort()).toEqual(['createdAt','expiresAt','notificationStatus','requestId','status','title'])
    expect(JSON.stringify(result)).not.toContain(INPUT.body)
    expect(JSON.stringify(result)).not.toContain(REVIEW_TEST_LINE_USER)
    expect(fixture.rows[0]).toMatchObject({sourceLabel:'owner_prepared_sample',notificationAttemptCount:1,status:'pending',notificationStatus:'sent'})
    expect(fixture.rows[0]?.readTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(fixture.rows[0]?.actionTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(fixture.rows[0]).not.toHaveProperty('readToken')
    expect(fixture.rows[0]).not.toHaveProperty('actionToken')
    expect(sender).toHaveBeenCalledTimes(1)
    expect({config:fixture.weekly.state.config,requests:fixture.weekly.state.requests.length,consents:fixture.weekly.state.consents.length,outbox:fixture.weekly.state.outbox.length,queued:fixture.weekly.state.queued}).toEqual(before)
  })

  it('replays a sent idempotency key without sending again and rejects same-key content drift',async()=>{
    const {fixture,deps,sender}=setup()
    const first=await createAndSendReviewTest(INPUT,deps),replay=await createAndSendReviewTest(INPUT,deps)
    expect(replay).toEqual({...first,replayed:true})
    expect(sender).toHaveBeenCalledTimes(1)
    expect(fixture.rows).toHaveLength(1)
    await expect(createAndSendReviewTest({...INPUT,body:'不同內容'},deps)).rejects.toThrow('WEEKLY_REVIEW_TEST_IDEMPOTENCY_COLLISION')
    expect(sender).toHaveBeenCalledTimes(1)
    expect(fixture.rows).toHaveLength(1)
  })

  it('deduplicates identical active content after a browser reload changes the idempotency key',async()=>{
    const {fixture,deps,sender}=setup()
    const first=await createAndSendReviewTest(INPUT,deps)
    const replay=await createAndSendReviewTest({...INPUT,idempotencyKey:'review-test-key-after-reload'},deps)
    expect(replay).toEqual({...first,replayed:true})
    expect(fixture.rows).toHaveLength(1)
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent duplicate owner actions and never double-sends one request',async()=>{
    let release!:()=>void
    const sender=vi.fn(async()=>new Promise<ReturnType<typeof accepted>>(resolve=>{release=()=>resolve(accepted())}))
    const {fixture,deps}=setup(sender)
    const first=createAndSendReviewTest(INPUT,deps)
    while(sender.mock.calls.length===0)await Promise.resolve()
    const second=await createAndSendReviewTest(INPUT,deps)
    expect(second.test.notificationStatus).toBe('processing')
    expect(second.replayed).toBe(true)
    release();await expect(first).resolves.toMatchObject({test:{notificationStatus:'sent'},replayed:false})
    expect(sender).toHaveBeenCalledTimes(1)
    expect(fixture.rows).toHaveLength(1)
  })

  it('uses one fixed retry UUID and the same payload hash for explicit owner retries only',async()=>{
    const sender=vi.fn()
      .mockResolvedValueOnce({accepted:false,retryable:true,errorCode:'line_provider_unavailable'})
      .mockResolvedValueOnce(accepted())
    const {fixture,deps}=setup(sender)
    const first=await createAndSendReviewTest(INPUT,deps)
    expect(first.test.notificationStatus).toBe('retry_wait')
    const retryKey=fixture.rows[0]?.notificationRetryKey,payload=fixture.rows[0]?.notificationPayloadFingerprint
    const early=await createAndSendReviewTest(INPUT,deps)
    expect(early.test.notificationStatus).toBe('retry_wait')
    expect(sender).toHaveBeenCalledTimes(1)
    const later={...deps,now:new Date(WEEKLY_NOW.getTime()+31_000)}
    const retried=await createAndSendReviewTest(INPUT,later)
    expect(retried).toMatchObject({replayed:true,test:{notificationStatus:'sent'}})
    expect(sender).toHaveBeenCalledTimes(2)
    expect(sender.mock.calls[0]?.[0].retryKey).toBe(retryKey)
    expect(sender.mock.calls[1]?.[0].retryKey).toBe(retryKey)
    expect(fixture.rows[0]?.notificationPayloadFingerprint).toBe(payload)
    expect(fixture.rows[0]?.notificationAttemptCount).toBe(2)
  })

  it('caps delivery at three attempts and never has an automatic retry path',async()=>{
    const sender=vi.fn(async()=>({accepted:false as const,retryable:true,errorCode:'line_provider_unavailable'}))
    const {fixture,deps}=setup(sender)
    expect((await createAndSendReviewTest(INPUT,deps)).test.notificationStatus).toBe('retry_wait')
    expect((await createAndSendReviewTest(INPUT,{...deps,now:new Date(WEEKLY_NOW.getTime()+31_000)})).test.notificationStatus).toBe('retry_wait')
    expect((await createAndSendReviewTest(INPUT,{...deps,now:new Date(WEEKLY_NOW.getTime()+92_000)})).test.notificationStatus).toBe('failed')
    expect((await createAndSendReviewTest(INPUT,{...deps,now:new Date(WEEKLY_NOW.getTime()+10*60_000)})).test.notificationStatus).toBe('failed')
    expect(sender).toHaveBeenCalledTimes(3)
    expect(fixture.rows[0]?.notificationAttemptCount).toBe(3)
  })

  it('builds an explicit no-publication card and bounded preview URL/postbacks',()=>{
    const requestId=`wct_${'a'.repeat(32)}`
    const message=buildReviewTestMessage({requestId,readToken:createHmacToken('weekly-review-test-read-v1',requestId),actionToken:createHmacToken('weekly-review-test-action-v1',requestId),title:'測試文章',expiresAt:new Date(WEEKLY_NOW.getTime()+86_400_000),publicOrigin:'https://synthetic-review.taipei'})
    const serialized=JSON.stringify(message)
    expect(serialized).toContain('/weekly-content/test-review/wct_')
    expect(serialized).toContain('wct|wct_')
    expect(serialized).toContain('同意測試稿')
    expect(serialized).toContain('要求修改')
    expect(serialized).toContain('不會發布文章')
    expect(serialized).not.toContain('同意發佈')
  })

  it('serves the plaintext preview only for the exact token and current binding',async()=>{
    const {fixture,deps}=setup(),created=await createAndSendReviewTest(INPUT,deps),row=fixture.rows[0]!
    const readToken=createHmacToken('weekly-review-test-read-v1',row.requestId)
    expect(await getReviewTestPreview({requestId:created.test.requestId,readToken},deps)).toEqual({requestId:row.requestId,title:INPUT.title,body:INPUT.body,status:'pending',expiresAt:row.expiresAt.toISOString(),canRespond:true,sourceLabel:'owner_prepared_sample'})
    await expect(getReviewTestPreview({requestId:created.test.requestId,readToken:'z'.repeat(43)},deps)).rejects.toThrow('WEEKLY_REVIEW_TEST_NOT_FOUND')
    fixture.weekly.state.binding!.bindingFingerprint=sha('replacement-binding')
    await expect(getReviewTestPreview({requestId:created.test.requestId,readToken},deps)).rejects.toThrow('WEEKLY_REVIEW_TEST_EXPIRED_OR_CHANGED')
  })

  it('records one immutable verified decision in the existing inbox and rejects stale/rebound senders',async()=>{
    const {fixture,deps}=setup(),created=await createAndSendReviewTest(INPUT,deps),row=fixture.rows[0]!
    const actionToken=createHmacToken('weekly-review-test-action-v1',row.requestId)
    const input={requestId:created.test.requestId,actionToken,decision:'approved' as const,lineUserId:REVIEW_TEST_LINE_USER,webhookEventId:'review-test-decision-1',semanticFingerprint:sha('semantic-decision-1')}
    expect(await reviewTestFromVerifiedLine(input,deps)).toEqual({status:'approved',resultCode:'REVIEW_TEST_APPROVED'})
    expect(await reviewTestFromVerifiedLine(input,deps)).toEqual({status:'replayed',resultCode:'REVIEW_TEST_APPROVED'})
    expect(fixture.rows[0]).toMatchObject({status:'approved',decisionEventHash:sha(input.webhookEventId)})
    expect(fixture.rows[0]?.decisionActorFingerprint).toBe(sha(REVIEW_TEST_LINE_USER))
    expect(fixture.weekly.state.inbox).toHaveLength(1)
    expect(fixture.weekly.state.consents).toHaveLength(0)
    await expect(reviewTestFromVerifiedLine({...input,decision:'changes_requested',webhookEventId:'review-test-decision-2',semanticFingerprint:sha('semantic-decision-2')},deps)).rejects.toThrow('WEEKLY_REVIEW_TEST_ALREADY_DECIDED')
    expect(fixture.rows[0]?.status).toBe('approved')
  })

  it('fails decisions closed after binding rotation and never creates formal consent',async()=>{
    const {fixture,deps}=setup(),created=await createAndSendReviewTest(INPUT,deps),row=fixture.rows[0]!,actionToken=createHmacToken('weekly-review-test-action-v1',row.requestId)
    fixture.weekly.state.binding!.bindingFingerprint=sha('rotated')
    await expect(reviewTestFromVerifiedLine({requestId:created.test.requestId,actionToken,decision:'approved',lineUserId:REVIEW_TEST_LINE_USER,webhookEventId:'rotated-decision',semanticFingerprint:sha('rotated-decision')},deps)).rejects.toThrow('WEEKLY_REVIEW_TEST_EXPIRED_OR_CHANGED')
    expect(fixture.rows[0]?.status).toBe('pending')
    expect(fixture.weekly.state.inbox).toHaveLength(0)
    expect(fixture.weekly.state.consents).toHaveLength(0)
  })

  it('lists only safe owner-scoped progress fields',async()=>{
    const {deps}=setup(),created=await createAndSendReviewTest(INPUT,deps),listed=await listReviewTestsForOwner({ownerUserId:1,clientId:1},deps)
    expect(listed).toEqual({tests:[created.test]})
    const serialized=JSON.stringify(listed)
    expect(serialized).not.toContain(INPUT.body)
    expect(serialized).not.toContain(REVIEW_TEST_LINE_USER)
    expect(serialized).not.toContain('Token')
  })
})

function createHmacToken(purpose:string,requestId:string){return createHmac('sha256',WEEKLY_KEY).update(`${purpose}:${requestId}`).digest('base64url')}
