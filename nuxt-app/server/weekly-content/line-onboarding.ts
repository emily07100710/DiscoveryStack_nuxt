import { createError } from 'h3'
import { isWeeklyLineAccessToken, normalizeWeeklyLinePublicOrigin, type WeeklyLineReviewMessage } from './line-transport'

export const SEARCHKING_WELCOME_TEXT = '歡迎加入搜尋王 👑\n我們幫你每週準備一篇品牌文章，整理 SEO 與 AI 搜尋所需的內容。\n\n第一次使用，請開啟「綁定我的公司」，貼上服務窗口提供的一次性邀請碼，確認公司名稱後完成綁定。\n\n之後你會在這裡收到文章卡片：先閱讀全文，再按「同意發佈」或「要求修改」。只有你同意的那一版才會進入發文流程。\n\n還沒有邀請碼？請聯絡你的搜尋王服務窗口。'
export const WEEKLY_LINE_INTERACTION_COMMANDS = ['綁定我的公司', '我的公司', '查看待審文章', '使用說明'] as const
export type WeeklyLineInteraction = 'welcome' | 'connect' | 'companies' | 'reviews' | 'help'
export function weeklyLineInteractionForText(text: string): WeeklyLineInteraction | null {
  return ({ '綁定我的公司': 'connect', '我的公司': 'companies', '查看待審文章': 'reviews', '使用說明': 'help' } as Record<string, WeeklyLineInteraction>)[text.trim()] || null
}
export function weeklyLineConnectUrl(input: { publicOrigin: string; liffId?: string; liffEnabled?: boolean }): string {
  const origin = normalizeWeeklyLinePublicOrigin(input.publicOrigin)
  if (input.liffEnabled) {
    if (!/^[0-9]{8,15}-[A-Za-z0-9]{4,32}$/u.test(input.liffId || '')) throw createError({ statusCode: 503, statusMessage: 'LINE 客戶綁定設定尚未完成。' })
    return `https://liff.line.me/${input.liffId}`
  }
  return `${origin}/weekly-content/connect`
}
export function buildWeeklyLineWelcomeMessage(input: { publicOrigin: string; liffId?: string; liffEnabled?: boolean; interaction?: WeeklyLineInteraction }): WeeklyLineReviewMessage {
  const uri = weeklyLineConnectUrl(input)
  const kind = input.interaction || 'welcome'
  const copy: Record<WeeklyLineInteraction, { title: string; detail: string; button: string }> = {
    welcome: { title: '歡迎來到搜尋王', detail: '每週文章準備好後，我們會送來讓你閱讀。你按同意，才會發佈到你的網站。第一次使用，先用服務窗口提供的邀請碼綁定公司。', button: '綁定我的公司' },
    connect: { title: '把 LINE 連到你的公司', detail: '開啟綁定頁，登入 LINE 並貼上一次性邀請碼。請確認公司名稱與網站正確，再同意綁定。沒有邀請碼，請聯絡服務窗口。', button: '開始綁定' },
    companies: { title: '查看你綁定的公司', detail: '開啟客戶頁後，會核對你的 LINE 身分，只顯示你已綁定的公司。公司或收稿人需要更換，請聯絡服務窗口。', button: '查看我的公司' },
    reviews: { title: '本週文章在哪裡？', detail: '文章備妥後會收到獨立送審卡片。請從那張卡片閱讀全文，再按同意或要求修改。尚未收到時，可先確認公司是否已完成綁定。', button: '確認我的公司' },
    help: { title: '一篇文章，四個步驟', detail: '1 核准選題與資料\n2 每週 AI 寫稿與內容檢查\n3 LINE 閱讀並確認\n4 發佈到你的網站\n文章收錄與 AI 搜尋引用仍需持續觀測。', button: '查看我的公司' },
  }
  const selected = copy[kind]
  return { type: 'flex', altText: `搜尋王：${selected.title}`, contents: { type: 'bubble', styles: { header: { backgroundColor: '#08254C' } }, header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '搜尋王 · Discovery Stack', weight: 'bold', color: '#FFD257', size: 'md' }] }, body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [{ type: 'text', text: selected.title, weight: 'bold', size: 'lg', wrap: true }, { type: 'text', text: selected.detail, size: 'sm', color: '#536174', wrap: true }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'button', style: 'primary', color: '#08254C', action: { type: 'uri', label: selected.button, uri } }, { type: 'button', action: { type: 'message', label: '服務使用說明', text: '使用說明' } }] } } }
}
export type WeeklyLineReplyMessage = WeeklyLineReviewMessage | { type: 'text'; text: string }
export async function sendWeeklyLineReply(input: { replyToken: string; message: WeeklyLineReplyMessage }, deps: { channelAccessToken: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ accepted: boolean; errorCode?: string }> {
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(input.replyToken) || !isWeeklyLineAccessToken(deps.channelAccessToken)) return { accepted: false, errorCode: 'line_reply_not_configured' }
  let body: string
  try {
    if (input.message.type === 'text' ? typeof input.message.text !== 'string' || input.message.text.length < 1 || input.message.text.length > 5000 : input.message.type !== 'flex' || !input.message.altText || Array.from(input.message.altText).length > 400) throw new Error()
    body = JSON.stringify({ replyToken: input.replyToken, messages: [input.message] })
    if (Buffer.byteLength(body) > 16384) throw new Error()
  } catch { return { accepted: false, errorCode: 'line_reply_payload_invalid' } }
  const controller = new AbortController()
  const timeout = Number.isSafeInteger(deps.timeoutMs) ? Math.min(10000, Math.max(100, deps.timeoutMs!)) : 5000
  const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.()
  try {
    const response = await (deps.fetchImpl || fetch)('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.channelAccessToken}` }, body, redirect: 'error', signal: controller.signal })
    if (response.body) void response.body.cancel().catch(() => undefined)
    const id = response.headers.get('x-line-request-id') || ''
    return response.ok && /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? { accepted: true } : { accepted: false, errorCode: 'line_reply_outcome_unknown' }
  } catch { return { accepted: false, errorCode: 'line_reply_outcome_unknown' } }
  finally { clearTimeout(timer) }
}

// Reviewable deployment payload only. This function never creates or assigns a real rich menu.
export function buildSearchkingRichMenu() {
  return { size: { width: 2500, height: 843 }, selected: true, name: '搜尋王 客戶服務', chatBarText: '文章與公司', areas: [
    { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '綁定我的公司' } },
    { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'message', text: '我的公司' } },
    { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '使用說明' } },
  ] }
}
