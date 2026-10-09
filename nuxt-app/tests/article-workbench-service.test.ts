import {beforeEach,describe,expect,it,vi} from 'vitest'
import {approveArticleWorkspace,createAndSendArticleWorkspace,feedbackArticleWorkspace,getArticleWorkspace,listArticleWorkspaces,publishArticleWorkspace,registerArticleMedia,retryArticleWorkspace,saveArticleWorkspace,sendRevisedArticleWorkspace,validateCustomerWorkspace} from '../server/article-workbench/service'
import {ArticleFixture,ARTICLE_DOCUMENT,ARTICLE_IDENTITY,ARTICLE_LINE_ID,ARTICLE_MEDIA,ARTICLE_NOW} from './article-workbench-fixture'

let fixture:ArticleFixture
beforeEach(()=>{fixture=new ArticleFixture()})
async function create(){return (await createAndSendArticleWorkspace(fixture.createInput(),fixture.deps)).workspace}
function mutation(workspace:{workspaceId:string;version:number},key='synthetic-operation-1'){return {workspaceId:workspace.workspaceId,expectedVersion:workspace.version,idempotencyKey:key,actor:fixture.actor()}}

describe('manual article authority and exact-version customer workbench',()=>{
  it('persists a seven-day exact owner mandate before preparation or LINE calls',async()=>{
    vi.mocked(fixture.deps.prepare).mockImplementation(async()=>{expect(fixture.state.workspaces).toHaveLength(1);expect(fixture.state.workspaces[0]).toMatchObject({status:'preparing',preparationStatus:'processing',sourceLabel:'owner_prepared_manual'});return {postId:'synthetic-post',postVersion:1}})
    const workspace=await create(),row=fixture.state.workspaces[0]!
    expect(workspace).toMatchObject({version:1,status:'editing',preparationStatus:'ready',notificationStatus:'sent',canEdit:true,canApprove:true})
    expect(row.expiresAt.getTime()-ARTICLE_NOW.getTime()).toBe(7*86400_000)
    expect(row.authority).toMatchObject({purpose:'owner_prepared_article_v1',ownerUserId:1,clientId:1,bindingId:11,bindingFingerprint:fixture.state.binding.bindingFingerprint,targetOrigin:'https://doalignment.com'})
    expect(fixture.deps.publish).not.toHaveBeenCalled()
    expect(fixture.state.revisions).toHaveLength(1)
    const serialized=JSON.stringify(workspace);expect(serialized).not.toContain(ARTICLE_LINE_ID);expect(serialized).not.toContain('credentialFingerprint');expect(serialized).not.toContain('ownerScopeKey');expect(serialized).not.toContain('authorityFingerprint')
  })
  it('deduplicates owner creation, remote prepare and LINE with the same durable key',async()=>{
    const first=await createAndSendArticleWorkspace(fixture.createInput(),fixture.deps),second=await createAndSendArticleWorkspace(fixture.createInput(),fixture.deps)
    expect(second.workspace.workspaceId).toBe(first.workspace.workspaceId);expect(second.replayed).toBe(true)
    expect(fixture.deps.prepare).toHaveBeenCalledTimes(1);expect(fixture.deps.notify).toHaveBeenCalledTimes(1)
    await expect(createAndSendArticleWorkspace({...fixture.createInput(),document:{...ARTICLE_DOCUMENT,title:'different'}},fixture.deps)).rejects.toMatchObject({statusCode:409})
  })
  it('preserves immutable authority and remote command on an unknown preparation outcome',async()=>{
    vi.mocked(fixture.deps.prepare).mockRejectedValueOnce(new Error('synthetic lost response'))
    const first=await create(),snapshot=structuredClone(fixture.state.workspaces[0]!.authority)
    expect(first.status).toBe('preparing');expect(first.preparationStatus).toBe('retry_wait');expect(fixture.deps.notify).not.toHaveBeenCalled()
    await expect(getArticleWorkspace({workspaceId:first.workspaceId,actor:fixture.actor()},fixture.deps)).rejects.toMatchObject({statusCode:503})
    fixture.deps.now=new Date(ARTICLE_NOW.getTime()+31_000)
    const retry=await retryArticleWorkspace({workspaceId:first.workspaceId,ownerUserId:1,confirmation:'RETRY_FORMAL_ARTICLE'},fixture.deps)
    expect(retry.workspace.status).toBe('editing');expect(fixture.state.workspaces[0]!.authority).toEqual(snapshot)
    expect(vi.mocked(fixture.deps.prepare).mock.calls[0]![0]).toEqual(vi.mocked(fixture.deps.prepare).mock.calls[1]![0])
  })
  it('records customer changes as a new revision and rejects stale concurrent saves',async()=>{
    const workspace=await create(),document={...ARTICLE_DOCUMENT,title:'changed title'}
    const results=await Promise.allSettled([saveArticleWorkspace({...mutation(workspace,'synthetic-save-1'),document},fixture.deps),saveArticleWorkspace({...mutation(workspace,'synthetic-save-2'),document:{...document,title:'other edit'}},fixture.deps)])
    expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(results.filter(row=>row.status==='rejected')).toHaveLength(1)
    expect(fixture.state.workspaces[0]!.version).toBe(2);expect(fixture.state.revisions).toHaveLength(2);expect(fixture.state.revisions[0]!.document).toEqual(ARTICLE_DOCUMENT)
    const replay=await saveArticleWorkspace({...mutation(workspace,'synthetic-save-1'),document},fixture.deps)
    expect(replay.replayed).toBe(true);expect(fixture.state.revisions).toHaveLength(2)
    await expect(saveArticleWorkspace({...mutation(workspace,'synthetic-save-1'),document:{...document,title:'collision'}},fixture.deps)).rejects.toMatchObject({statusCode:409})
  })
  it('stores feedback without AI, consent, or publication and supports owner edits on same workspace',async()=>{
    const workspace=await create(),input={...mutation(workspace),note:'請把第二段寫得親切一點。'}
    const first=await feedbackArticleWorkspace(input,fixture.deps),replay=await feedbackArticleWorkspace(input,fixture.deps)
    expect(first.workspace.status).toBe('changes_requested');expect(first.workspace.feedback).toHaveLength(1);expect(replay.replayed).toBe(true)
    expect(fixture.deps.publish).not.toHaveBeenCalled();expect(fixture.deps.prepare).toHaveBeenCalledTimes(1)
    const saved=await saveArticleWorkspace({...mutation(workspace,'synthetic-owner-save-1'),actor:{kind:'owner',ownerUserId:1},document:{...ARTICLE_DOCUMENT,title:'owner revision'}},fixture.deps)
    expect(saved.workspace).toMatchObject({workspaceId:workspace.workspaceId,version:2,status:'editing'});expect(saved.workspace.feedback).toHaveLength(1)
    const notice={workspaceId:workspace.workspaceId,ownerUserId:1,expectedVersion:2,confirmation:'SEND_REVISED_FORMAL_ARTICLE' as const}
    await sendRevisedArticleWorkspace(notice,fixture.deps);await sendRevisedArticleWorkspace(notice,fixture.deps)
    expect(fixture.deps.notify).toHaveBeenCalledTimes(2);expect(vi.mocked(fixture.deps.notify).mock.calls[1]![0].title).toBe('owner revision')
    expect(vi.mocked(fixture.deps.notify).mock.calls[1]![0].retryKey).not.toBe(vi.mocked(fixture.deps.notify).mock.calls[0]![0].retryKey)
  })
  it('allows only server-registered workspace images and hashes their immutable bytes',async()=>{
    const workspace=await create()
    await expect(saveArticleWorkspace({...mutation(workspace),document:{...ARTICLE_DOCUMENT,coverMediaId:ARTICLE_MEDIA.id}},fixture.deps)).rejects.toMatchObject({statusCode:422})
    await registerArticleMedia({workspaceId:workspace.workspaceId,actor:fixture.actor(),expectedVersion:1,media:ARTICLE_MEDIA},fixture.deps)
    await registerArticleMedia({workspaceId:workspace.workspaceId,actor:fixture.actor(),expectedVersion:1,media:ARTICLE_MEDIA},fixture.deps)
    expect(fixture.state.media).toHaveLength(1)
    const saved=await saveArticleWorkspace({...mutation(workspace),document:{...ARTICLE_DOCUMENT,coverMediaId:ARTICLE_MEDIA.id}},fixture.deps)
    expect(saved.workspace.documentHash).not.toBe(workspace.documentHash);expect(saved.workspace.media).toHaveLength(1)
    await expect(registerArticleMedia({workspaceId:workspace.workspaceId,actor:fixture.actor(),expectedVersion:2,media:{...ARTICLE_MEDIA,sha256:'c'.repeat(64)}},fixture.deps)).rejects.toMatchObject({statusCode:409})
    await expect(registerArticleMedia({workspaceId:workspace.workspaceId,actor:fixture.actor(),expectedVersion:2,media:{...ARTICLE_MEDIA,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',url:'https://foreign.invalid/pic'}},fixture.deps)).rejects.toMatchObject({statusCode:422})
  })
  it('approves exact current document/media and locks every future write permanently',async()=>{
    const workspace=await create(),input={...mutation(workspace),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH' as const}
    const result=await approveArticleWorkspace(input,fixture.deps)
    expect(result.workspace).toMatchObject({status:'published',canEdit:false,canApprove:false,publicationUrl:'https://doalignment.com/journal/synthetic-practice-note/'})
    expect(fixture.deps.publish).toHaveBeenCalledTimes(1);expect(fixture.state.operations.filter(row=>row.operation==='approve')).toHaveLength(1)
    expect(vi.mocked(fixture.deps.publish).mock.calls[0]![0]).toMatchObject({version:1,remotePostVersion:1,approval:{approvedDocumentVersion:1,approvedDocumentHash:workspace.documentHash}})
    await expect(saveArticleWorkspace({...mutation(workspace,'synthetic-after-approve-save'),document:ARTICLE_DOCUMENT},fixture.deps)).rejects.toMatchObject({statusCode:409})
    await expect(saveArticleWorkspace({...mutation(workspace,'synthetic-owner-after-save'),actor:{kind:'owner',ownerUserId:1},document:ARTICLE_DOCUMENT},fixture.deps)).rejects.toMatchObject({statusCode:409})
    await expect(feedbackArticleWorkspace({...mutation(workspace,'synthetic-after-feedback'),note:'change'},fixture.deps)).rejects.toMatchObject({statusCode:409})
    await expect(registerArticleMedia({workspaceId:workspace.workspaceId,actor:fixture.actor(),expectedVersion:1,media:ARTICLE_MEDIA},fixture.deps)).rejects.toMatchObject({statusCode:409})
    await expect(approveArticleWorkspace({...input,idempotencyKey:'synthetic-second-approve'},fixture.deps)).rejects.toMatchObject({statusCode:409})
    const replay=await approveArticleWorkspace(input,fixture.deps);expect(replay.replayed).toBe(true);expect(fixture.deps.publish).toHaveBeenCalledTimes(1)
  })
  it('rejects old version/hash approvals without publishing or locking a newer draft',async()=>{
    const workspace=await create()
    await saveArticleWorkspace({...mutation(workspace),document:{...ARTICLE_DOCUMENT,title:'newer'}},fixture.deps)
    await expect(approveArticleWorkspace({...mutation(workspace,'synthetic-stale-approve'),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH'},fixture.deps)).rejects.toMatchObject({statusCode:409})
    await expect(approveArticleWorkspace({...mutation({...workspace,version:2},'synthetic-wrong-hash'),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH'},fixture.deps)).rejects.toMatchObject({statusCode:409})
    expect(fixture.deps.publish).not.toHaveBeenCalled();expect(fixture.state.workspaces[0]!.approvedAt).toBeNull()
  })
  it('does not mistake owner identity, read tokens, or a different LINE identity for approval',async()=>{
    const workspace=await create()
    await expect(approveArticleWorkspace({...mutation(workspace),actor:{kind:'owner',ownerUserId:1},documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH'},fixture.deps)).rejects.toMatchObject({statusCode:403})
    await expect(getArticleWorkspace({workspaceId:workspace.workspaceId,actor:{kind:'customer',identity:{...ARTICLE_IDENTITY,lineUserId:`U${'f'.repeat(32)}`}}},fixture.deps)).rejects.toMatchObject({statusCode:403})
    expect(fixture.deps.publish).not.toHaveBeenCalled()
  })
  it('keeps approved content frozen through an unknown publication and bounded explicit owner retry',async()=>{
    const workspace=await create();vi.mocked(fixture.deps.publish).mockRejectedValueOnce(new Error('lost receipt'))
    const result=await approveArticleWorkspace({...mutation(workspace),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH'},fixture.deps)
    expect(result.workspace).toMatchObject({status:'retry_wait',canEdit:false,canApprove:false})
    fixture.deps.now=new Date(ARTICLE_NOW.getTime()+31_000)
    await retryArticleWorkspace({workspaceId:workspace.workspaceId,ownerUserId:1,confirmation:'RETRY_FORMAL_ARTICLE'},fixture.deps)
    expect(fixture.state.workspaces[0]!.status).toBe('published');expect(vi.mocked(fixture.deps.publish).mock.calls[0]![0]).toEqual(vi.mocked(fixture.deps.publish).mock.calls[1]![0])
  })
  it('reserves one publication lease when concurrent dispatchers race',async()=>{
    const workspace=await create();let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve})
    vi.mocked(fixture.deps.publish).mockImplementation(async input=>{await waiting;return {published:true,url:`https://doalignment.com/journal/${input.document.slug}/`,providerPostId:'synthetic-post'}})
    const first=approveArticleWorkspace({...mutation(workspace),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH'},fixture.deps)
    for(let i=0;i<20&&fixture.state.workspaces[0]!.status!=='processing';i++)await new Promise(resolve=>setTimeout(resolve,1))
    await publishArticleWorkspace(workspace.workspaceId,fixture.deps);release();await first
    expect(fixture.deps.publish).toHaveBeenCalledTimes(1)
  })
  it('fails closed for a changed binding, target, expired mandate or modified persisted document',async()=>{
    const workspace=await create(),approval={...mutation(workspace),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH' as const},saved=structuredClone(fixture.state)
    fixture.state.binding.bindingFingerprint='f'.repeat(64)
    await expect(approveArticleWorkspace(approval,fixture.deps)).rejects.toMatchObject({statusCode:409});fixture.state=structuredClone(saved)
    fixture.state.target!.credentialFingerprint='f'.repeat(64)
    await expect(approveArticleWorkspace(approval,fixture.deps)).rejects.toMatchObject({statusCode:409});fixture.state=structuredClone(saved)
    fixture.state.workspaces[0]!.document={...ARTICLE_DOCUMENT,title:'tampered'}
    await expect(approveArticleWorkspace(approval,fixture.deps)).rejects.toMatchObject({statusCode:409});fixture.state=structuredClone(saved)
    fixture.deps.now=new Date(ARTICLE_NOW.getTime()+7*86400_000)
    await expect(approveArticleWorkspace({...approval,actor:{kind:'customer',identity:{...ARTICLE_IDENTITY,expiresAtSeconds:Math.floor(fixture.deps.now.getTime()/1000)+3600}}},fixture.deps)).rejects.toMatchObject({statusCode:409})
    expect(fixture.deps.publish).not.toHaveBeenCalled()
  })
  it('requires target owner mandate rather than merely configured transport',async()=>{
    fixture.state.target=null
    await expect(create(),).rejects.toMatchObject({statusCode:503});expect(fixture.state.workspaces).toHaveLength(0);expect(fixture.deps.prepare).not.toHaveBeenCalled()
    fixture.state.target={targetId:'synthetic',ownerScopeKey:'synthetic',targetOrigin:'https://foreign.invalid',configurationFingerprint:'d'.repeat(64),credentialFingerprint:'e'.repeat(64)}
    await expect(create()).rejects.toMatchObject({statusCode:403});expect(fixture.deps.notify).not.toHaveBeenCalled()
  })
  it('limits publication attempts to three and does not retry automatically from customer replay',async()=>{
    const workspace=await create();vi.mocked(fixture.deps.publish).mockResolvedValue({published:false,retryable:true,errorCode:'synthetic_timeout'})
    const input={...mutation(workspace),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH' as const}
    await approveArticleWorkspace(input,fixture.deps)
    await approveArticleWorkspace(input,fixture.deps);expect(fixture.deps.publish).toHaveBeenCalledTimes(1)
    for(const seconds of [31,92,200]){fixture.deps.now=new Date(ARTICLE_NOW.getTime()+seconds*1000);await retryArticleWorkspace({workspaceId:workspace.workspaceId,ownerUserId:1,confirmation:'RETRY_FORMAL_ARTICLE'},fixture.deps)}
    expect(fixture.deps.publish).toHaveBeenCalledTimes(3);expect(fixture.state.workspaces[0]!.status).toBe('failed')
  })
  it('provides owner history but no cross-tenant lists or editable upload preflight after approval',async()=>{
    const workspace=await create()
    expect((await listArticleWorkspaces({ownerUserId:1,clientId:1},fixture.deps)).workspaces).toHaveLength(1)
    await expect(listArticleWorkspaces({ownerUserId:2,clientId:1},fixture.deps)).rejects.toMatchObject({statusCode:404})
    expect(await validateCustomerWorkspace({workspaceId:workspace.workspaceId,identity:ARTICLE_IDENTITY,expectedVersion:1},fixture.deps)).toMatchObject({remotePostId:'synthetic-post',remotePostVersion:1})
    await approveArticleWorkspace({...mutation(workspace),documentHash:workspace.documentHash,confirmation:'APPROVE_AND_PUBLISH'},fixture.deps)
    await expect(validateCustomerWorkspace({workspaceId:workspace.workspaceId,identity:ARTICLE_IDENTITY},fixture.deps)).rejects.toMatchObject({statusCode:409})
  })
})
