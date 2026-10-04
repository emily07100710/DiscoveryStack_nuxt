import type { WeeklyPublicReview } from './types'
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export const WEEKLY_REVIEW_HEADERS = {
  'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const
/** Read-only and script-free. Approval is available only in the authenticated LINE conversation. */
export function renderWeeklyReviewPage(review: WeeklyPublicReview): string {
  const status = review.status === 'approved' ? '你已同意這個版本' : review.status === 'changes_requested' ? '你已要求修改，文章暫不發佈' : review.canRespond ? '等待你確認' : '這份送審已失效，請回 LINE 取得新的版本'
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>${escape(review.title)}｜搜尋王文章送審</title><style>body{margin:0;background:#f4f5f8;color:#17233d;font:18px/1.8 system-ui,sans-serif}main{max-width:800px;margin:32px auto;padding:32px;background:#fff;border-radius:16px}h1{font-size:30px;line-height:1.4}p{margin:0 0 16px}.status{padding:16px;background:#edf4ff;border-radius:8px}.body{white-space:pre-wrap;overflow-wrap:anywhere}.brand{font-weight:700;color:#3559a5}@media(max-width:600px){main{margin:0;padding:24px;border-radius:0}}</style></head><body><main><p class="brand">搜尋王 · 每週文章送審</p><p class="status">${escape(status)}。請回到 LINE 聊天室按「同意發佈」或「要求修改」。</p><h1>${escape(review.title)}</h1><article class="body">${escape(review.body)}</article></main></body></html>`
}
