import {describe,expect,it,vi} from 'vitest'
import {activateWeeklyReviewConfig,claimLineBindingInvite,createReviewRequest,deriveReviewTokens,getApprovedReviewForPromotion,issueLineBindingInvite,replaceLineBinding,reviewFromVerifiedLine,REPLACE_LINE_RECIPIENT_CONFIRMATION} from '../server/weekly-content/service'
import {WeeklyFixture,WEEKLY_NOW,sha} from './fixtures/weekly-content/repository'

const USER=`U${'1'.repeat(32)}`
const OTHER=`U${'2'.repeat(32)}`
const identity=(id:string,lineUserId=USER)=>({lineUserId,webhookEventId:id,semanticFingerprint:sha(id)})
const replacement=(f:WeeklyFixture)=>replaceLineBinding({ownerUserId:1,clientId:1,confirmation:REPLACE_LINE_RECIPIENT_CONFIRMATION},f.deps())

async function ready() {
  const f=new WeeklyFixture()
  await activateWeeklyReviewConfig({ownerUserId:1,clientId:1,publicationTargetId:3,policyId:'policy-1',idempotencyKey:'replacement-fixture'},f.deps())
  const first=await issueLineBindingInvite({ownerUserId:1,clientId:1},f.deps())
  await claimLineBindingInvite({...identity('initial-bind'),invitationToken:first.invitationToken},f.deps())
  const originalBinding={...f.state.binding!}
  const opened=await createReviewRequest({ownerUserId:1,clientId:1,entryId:8},f.deps())
  const request=f.state.requests[0]!
  const actionToken=deriveReviewTokens(request,f.deps().tokenKey).actionToken
  await reviewFromVerifiedLine({...identity('initial-approval'),requestId:opened.request.requestId,actionToken,decision:'approved'},f.deps())
  return {f,request,actionToken,originalBinding}
}

describe('owner-authorized LINE recipient replacement',()=>{
  it('atomically revokes the current binding and old review lineage, cancels unsent notices, and issues one ten-minute identity invite',async()=>{
    const {f,request,originalBinding}=await ready()
    const stale=await issueLineBindingInvite({ownerUserId:1,clientId:1},f.deps())
    const result=await replacement(f)

    expect(Object.keys(result).sort()).toEqual(['expiresAt','invitationToken','purpose'])
    expect(result).toMatchObject({purpose:'identity_binding'})
    expect(result.invitationToken).toMatch(/^wli_[A-Za-z0-9_-]{32}$/)
    expect(Date.parse(result.expiresAt)-WEEKLY_NOW.getTime()).toBe(10*60_000)
    expect(JSON.stringify(result)).not.toContain(USER)
    expect(JSON.stringify(result)).not.toContain(originalBinding.bindingFingerprint)

    expect(f.state.binding).toMatchObject({id:originalBinding.id,lineUserId:USER,status:'revoked'})
    expect(f.state.binding?.bindingFingerprint).not.toBe(originalBinding.bindingFingerprint)
    expect(request.status).toBe('revoked')
    expect(f.state.consents).toHaveLength(1)
    expect(f.state.outbox[0]).toMatchObject({status:'cancelled',errorCode:'line_recipient_replaced',leaseToken:null,leaseExpiresAt:null,retryEligibleAt:null})
    const pending=f.state.invites.filter(row=>!row.consumedAt && row.expiresAt.getTime()>WEEKLY_NOW.getTime())
    expect(pending).toHaveLength(1)
    expect(pending[0]?.tokenHash).toBe(sha(result.invitationToken))
    expect(f.state.invites.find(row=>row.tokenHash===sha(stale.invitationToken))?.expiresAt).toEqual(WEEKLY_NOW)
    expect(f.repository.revokeBinding).toHaveBeenCalledWith(1,1,originalBinding.bindingFingerprint,expect.stringMatching(/^[a-f0-9]{64}$/),WEEKLY_NOW)
  })

  it('keeps old approval invalid after the same LINE account binds again because the binding lineage changes',async()=>{
    const {f,request,actionToken,originalBinding}=await ready()
    const invite=await replacement(f)
    await expect(getApprovedReviewForPromotion({ownerUserId:1,requestId:request.requestId},f.deps())).rejects.toThrow('WEEKLY_REQUEST_EXPIRED_OR_CHANGED')
    await claimLineBindingInvite({...identity('replacement-bind'),invitationToken:invite.invitationToken},f.deps())
    expect(f.state.binding).toMatchObject({status:'active',lineUserId:USER,id:originalBinding.id})
    expect(f.state.binding?.bindingFingerprint).not.toBe(originalBinding.bindingFingerprint)
    expect(f.state.binding?.bindingFingerprint).not.toBe(request.bindingFingerprint)
    await expect(reviewFromVerifiedLine({...identity('stale-action'),requestId:request.requestId,actionToken,decision:'approved'},f.deps())).rejects.toThrow('WEEKLY_REQUEST_EXPIRED_OR_CHANGED')
    await expect(getApprovedReviewForPromotion({ownerUserId:1,requestId:request.requestId},f.deps())).rejects.toThrow('WEEKLY_REQUEST_EXPIRED_OR_CHANGED')
    expect(f.state.consents).toHaveLength(1)
    expect(f.state.queued).toBe(1)
  })

  it('requires an exact confirmation, active owned client, and an existing active binding before any write',async()=>{
    for(const kind of ['confirmation','missing','revoked','paused','foreign-owner'] as const){
      const f=new WeeklyFixture()
      if(kind!=='missing')f.state.binding={id:30,ownerUserId:1,clientId:1,lineUserId:USER,bindingFingerprint:sha('binding'),status:kind==='revoked'?'revoked':'active',createdAt:WEEKLY_NOW,updatedAt:WEEKLY_NOW}
      if(kind==='paused')f.state.client.status='paused'
      if(kind==='foreign-owner')f.state.client.ownerUserId=2
      const input={ownerUserId:1,clientId:1,confirmation:kind==='confirmation'?'wrong':REPLACE_LINE_RECIPIENT_CONFIRMATION} as never
      await expect(replaceLineBinding(input,f.deps())).rejects.toThrow(kind==='confirmation'?'WEEKLY_LINE_REPLACEMENT_CONFIRMATION_REQUIRED':kind==='missing'||kind==='revoked'?'WEEKLY_ACTIVE_LINE_BINDING_REQUIRED':'WEEKLY_CLIENT_NOT_AVAILABLE')
      expect(f.state.invites).toHaveLength(0)
      expect(f.repository.revokeBinding).not.toHaveBeenCalled()
    }
  })

  it('rolls back every revocation when the fresh invite cannot be stored',async()=>{
    const {f,request,originalBinding}=await ready()
    vi.mocked(f.repository.insertInvitation).mockRejectedValueOnce(new Error('synthetic storage failure'))
    await expect(replacement(f)).rejects.toThrow('synthetic storage failure')
    expect(f.state.binding).toEqual(originalBinding)
    expect(f.state.requests.find(row=>row.id===request.id)?.status).toBe('approved')
    expect(f.state.outbox[0]?.status).toBe('queued')
    expect(f.state.invites.filter(row=>!row.consumedAt)).toHaveLength(0)
  })

  it('serializes duplicate owner replacement attempts so only one invite survives',async()=>{
    const {f}=await ready()
    const results=await Promise.allSettled([replacement(f),replacement(f)])
    expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(row=>row.status==='rejected')).toHaveLength(1)
    expect(f.state.binding?.status).toBe('revoked')
    expect(f.state.invites.filter(row=>!row.consumedAt && row.expiresAt>WEEKLY_NOW)).toHaveLength(1)
  })

  it('fails closed while publication or LINE delivery is already in flight',async()=>{
    for(const kind of ['publication','line-delivery'] as const){
      const {f,request,originalBinding}=await ready()
      if(kind==='publication')f.state.reserved=true
      else Object.assign(f.state.outbox[0]!,{status:'processing',leaseToken:'synthetic-lease',leaseExpiresAt:new Date(WEEKLY_NOW.getTime()+120_000)})
      await expect(replacement(f)).rejects.toThrow(kind==='publication'?'WEEKLY_PUBLICATION_ALREADY_RESERVED':'WEEKLY_LINE_DELIVERY_IN_PROGRESS')
      expect(f.state.binding).toEqual(originalBinding)
      expect(f.state.requests.find(row=>row.id===request.id)?.status).toBe('approved')
      expect(f.state.invites.filter(row=>!row.consumedAt)).toHaveLength(0)
    }
  })

  it('cancels only queued/retry notices and preserves sent or failed delivery history',async()=>{
    const {f,originalBinding}=await ready(),base=f.state.outbox[0]!
    f.state.outbox.push({...base,id:base.id+1,status:'sent',providerMessageId:'synthetic-provider-id',sentAt:WEEKLY_NOW})
    f.state.outbox.push({...base,id:base.id+2,status:'failed',errorCode:'synthetic-history'})
    await replacement(f)
    expect(f.state.outbox.map(row=>[row.status,row.errorCode])).toEqual([
      ['cancelled','line_recipient_replaced'],
      ['sent',null],
      ['failed','synthetic-history'],
    ])
    expect(f.repository.lockUnsentOutboxForBinding).toHaveBeenCalledWith(1,1,originalBinding.id)
  })

  it('permits the newly invited different verified LINE identity without returning either recipient id',async()=>{
    const {f}=await ready(),invite=await replacement(f)
    const result=await claimLineBindingInvite({...identity('different-recipient',OTHER),invitationToken:invite.invitationToken},f.deps())
    expect(result).toEqual({status:'bound',resultCode:'LINE_BOUND'})
    expect(f.state.binding).toMatchObject({status:'active',lineUserId:OTHER})
    expect(JSON.stringify(result)).not.toContain(USER)
    expect(JSON.stringify(result)).not.toContain(OTHER)
  })
})
