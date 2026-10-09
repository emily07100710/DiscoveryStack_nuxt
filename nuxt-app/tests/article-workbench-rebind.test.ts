import {describe,expect,it,vi} from 'vitest'
import {guardArticleWorkspacesForRebind,type ArticleWorkspaceRow} from '../server/article-workbench/repository'
import {ARTICLE_NOW} from './article-workbench-fixture'

function fixture(rows:Partial<ArticleWorkspaceRow>[]){
  const updates:{patch:Record<string,unknown>}[]=[],where=vi.fn()
  const database={select:()=>({from:()=>({where:(predicate:unknown)=>{where(predicate);return {for:vi.fn(async()=>rows)}}})}),update:()=>({set:(patch:Record<string,unknown>)=>({where:async()=>{updates.push({patch})}})})}
  return {database,updates,where}
}
const input={ownerUserId:1,clientId:1,bindingId:11,now:ARTICLE_NOW}
describe('formal article replacement fencing in the existing binding transaction',()=>{
  it.each([
    {status:'processing',preparationStatus:'ready',notificationStatus:'sent'},
    {status:'preparing',preparationStatus:'processing',notificationStatus:'queued'},
    {status:'editing',preparationStatus:'ready',notificationStatus:'processing'},
  ])('blocks in-flight external work, even when the seven-day mandate has elapsed',async state=>{
    const f=fixture([{id:1,bindingFingerprint:'a'.repeat(64),expiresAt:new Date(ARTICLE_NOW.getTime()-1),...state} as Partial<ArticleWorkspaceRow>])
    await expect(guardArticleWorkspacesForRebind(f.database,input)).rejects.toMatchObject({statusCode:409,statusMessage:'ARTICLE_BINDING_DELIVERY_IN_PROGRESS'})
    expect(f.updates).toHaveLength(0)
  })
  it('revokes pending/approved/retry mandates but never touches a published article',async()=>{
    const f=fixture([
      {id:1,bindingFingerprint:'a'.repeat(64),status:'editing',preparationStatus:'ready',notificationStatus:'queued'},
      {id:2,bindingFingerprint:'a'.repeat(64),status:'approved',preparationStatus:'ready',notificationStatus:'sent'},
      {id:3,bindingFingerprint:'a'.repeat(64),status:'retry_wait',preparationStatus:'ready',notificationStatus:'sent'},
      {id:4,bindingFingerprint:'a'.repeat(64),status:'published',preparationStatus:'ready',notificationStatus:'sent'},
      {id:5,bindingFingerprint:'a'.repeat(64),status:'revoked',preparationStatus:'ready',notificationStatus:'failed'},
    ])
    await guardArticleWorkspacesForRebind(f.database,input)
    expect(f.where).toHaveBeenCalledTimes(1);expect(f.updates).toHaveLength(3)
    expect(f.updates.map(row=>row.patch.notificationStatus)).toEqual(['failed','sent','sent'])
    for(const row of f.updates)expect(row.patch).toMatchObject({status:'revoked',notificationErrorCode:'article_binding_changed',updatedAt:ARTICLE_NOW})
  })
  it('does nothing for a binding without formal workspaces',async()=>{const f=fixture([]);await guardArticleWorkspacesForRebind(f.database,input);expect(f.updates).toHaveLength(0)})
})
