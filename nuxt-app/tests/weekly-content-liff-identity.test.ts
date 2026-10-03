import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyWeeklyLiffIdentity, WEEKLY_LIFF_VERIFY_ENDPOINT } from '../server/weekly-content/liff-identity'
const NOW = new Date('2026-10-04T00:00:00Z'), CHANNEL = '2001234567', USER = `U${'1'.repeat(32)}`, TOKEN = 'synthetic.header.signature'
const claims = () => ({ iss: 'https://access.line.me', aud: CHANNEL, sub: USER, exp: Math.floor(NOW.getTime()/1000)+1800, iat: Math.floor(NOW.getTime()/1000)-1800 })
const response = (body: unknown) => new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}})
afterEach(() => vi.useRealTimers())
describe('official LIFF ID token verification', () => {
  it('calls only the fixed POST form endpoint and projects only its verified identity', async () => {
    const fetchImpl=vi.fn<typeof fetch>(async()=>response({...claims(),name:'private-display',email:'private-email',picture:'private-photo'}))
    expect(await verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,fetchImpl})).toEqual({lineUserId:USER,channelId:CHANNEL,expiresAtSeconds:claims().exp})
    const [url,options]=fetchImpl.mock.calls[0]!
    if(!options)throw new Error('expected verification request options')
    expect(url).toBe(WEEKLY_LIFF_VERIFY_ENDPOINT);expect(options).toMatchObject({method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'}})
    expect(new URLSearchParams(String(options.body)).get('id_token')).toBe(TOKEN);expect(new URLSearchParams(String(options.body)).get('client_id')).toBe(CHANNEL)
  })
  it.each(['', 'token', 'a.b.c ', 'a.b.c\n', 'x'.repeat(8193)])('rejects malformed token before any provider for %s', async idToken => {
    const fetchImpl=vi.fn();await expect(verifyWeeklyLiffIdentity(idToken,{channelId:CHANNEL,fetchImpl})).rejects.toMatchObject({statusCode:401});expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('fails missing channel before provider', async()=>{const fetchImpl=vi.fn();await expect(verifyWeeklyLiffIdentity(TOKEN,{channelId:'',fetchImpl})).rejects.toMatchObject({statusCode:503});expect(fetchImpl).not.toHaveBeenCalled()})
  it.each([{iss:'https://other.line.taipei'},{aud:'2000000000'},{aud:[CHANNEL]},{sub:`u${'1'.repeat(32)}`},{sub:'forged-user'},{exp:Math.floor(NOW.getTime()/1000)},{iat:Math.floor(NOW.getTime()/1000)+1},{iat:'123'},{exp:1.5},{iat:Math.floor(NOW.getTime()/1000)-3600},{exp:Math.floor(NOW.getTime()/1000)+3601}])('rejects invalid issuer/audience/user/lifetime %j',async change=>{await expect(verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,fetchImpl:vi.fn(async()=>response({...claims(),...change}))})).rejects.toMatchObject({statusCode:401})})
  it.each([400,401,302,429,500])('never exposes or interprets provider error body for status %s',async status=>{await expect(verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,fetchImpl:vi.fn(async()=>new Response('private-provider-body',{status}))})).rejects.toMatchObject({statusCode:status>=500||status===429?503:401})})
  it('rejects malformed UTF-8/JSON and non-JSON successful response',async()=>{
    for(const res of [new Response('{broken',{headers:{'content-type':'application/json'}}),new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),new Response(JSON.stringify(claims()),{headers:{'content-type':'text/html'}})]) await expect(verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,fetchImpl:vi.fn(async()=>res)})).rejects.toMatchObject({statusCode:401})
  })
  it('rejects oversized advertised response without reading it',async()=>{const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({cancel});await expect(verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,fetchImpl:vi.fn(async()=>new Response(body,{headers:{'content-type':'application/json','content-length':'12289'}}))})).rejects.toMatchObject({statusCode:401});expect(cancel).toHaveBeenCalled()})
  it('stops and cancels a chunked raw response above 12KiB',async()=>{const cancel=vi.fn();let pulls=0;const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(7000))},cancel});await expect(verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,fetchImpl:vi.fn(async()=>new Response(body,{headers:{'content-type':'application/json'}}))})).rejects.toMatchObject({statusCode:401});expect(cancel).toHaveBeenCalled();expect(pulls).toBeLessThanOrEqual(3)})
  it('hard timeout also bounds a provider that ignores abort',async()=>{vi.useFakeTimers();const pending=verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,timeoutMs:100,fetchImpl:vi.fn(()=>new Promise<Response>(()=>{}))});const assertion=expect(pending).rejects.toMatchObject({statusCode:503});await vi.advanceTimersByTimeAsync(101);await assertion})
  it('hard timeout also cancels a stalled response stream',async()=>{vi.useFakeTimers();const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({cancel});const pending=verifyWeeklyLiffIdentity(TOKEN,{channelId:CHANNEL,now:NOW,timeoutMs:100,fetchImpl:vi.fn(async()=>new Response(body,{headers:{'content-type':'application/json'}}))});const assertion=expect(pending).rejects.toMatchObject({statusCode:503});await vi.advanceTimersByTimeAsync(101);await assertion;expect(cancel).toHaveBeenCalled()})
})
