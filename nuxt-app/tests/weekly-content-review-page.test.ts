import {describe,it,expect} from 'vitest'
import {renderWeeklyReviewPage,WEEKLY_REVIEW_HEADERS} from '../server/weekly-content/review-page'
const review = {requestId:'wcr_fixture',title:'來源清楚的文章',body:'內文',status:'pending' as const,expiresAt:'2026-10-06T00:00:00Z',contentHash:'a'.repeat(64),canRespond:true}
describe('customer draft preview is read only',()=>{
  it('escapes every dynamic title and body without scripts, forms or approval tokens',()=>{
    const html=renderWeeklyReviewPage({...review,title:'<script>alert(1)</script>',body:'<img src=x onerror=alert(1)> & "text"'})
    expect(html).toContain('&lt;script&gt;');expect(html).toContain('&lt;img')
    expect(html).not.toMatch(/<script|<form|<img|actionToken|token=/i)
    expect(html).toContain('請回到 LINE 聊天室')
    expect(WEEKLY_REVIEW_HEADERS).toMatchObject({'referrer-policy':'no-referrer','cache-control':'private, no-store, max-age=0'})
  })
  it('shows expired and changes requested status without offering a web approval action',()=>{
    expect(renderWeeklyReviewPage({...review,canRespond:false})).toContain('送審已失效')
    expect(renderWeeklyReviewPage({...review,status:'changes_requested'})).toContain('文章暫不發佈')
  })
})
