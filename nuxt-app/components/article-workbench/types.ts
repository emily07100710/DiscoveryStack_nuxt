// Browser-only DTOs. Content is structured data, never executable HTML.
export type ArticleRun = { text: string; bold?: boolean; italic?: boolean; color?: string }
export type ArticleTextBlock = { id: string; type: 'paragraph' | 'heading' | 'quote'; runs: ArticleRun[] }
export type ArticleImageBlock = { id: string; type: 'image'; mediaId: string; alt: string; caption: string; layout: 'auto' | 'wide' }
export type ArticleBlock = ArticleTextBlock | ArticleImageBlock
export type ArticleDocument = { schemaVersion: 1; title: string; slug: string; summary: string; category: string; takeaways: string[]; coverMediaId: string | null; blocks: ArticleBlock[] }
export type ArticleMedia = { id: string; sha256: string; version: number; mimeType: string; size: number; width: number; height: number; url: string }
export type ArticleWorkspace = {
  workspaceId: string; version: number; documentHash: string; document: ArticleDocument
  status: 'preparing' | 'editing' | 'changes_requested' | 'approved' | 'processing' | 'published' | 'retry_wait' | 'failed' | 'revoked'
  preparationStatus?: 'queued' | 'processing' | 'ready' | 'retry_wait' | 'failed'
  expiresAt: string; media: ArticleMedia[]; feedback: Array<{ note: string; createdAt: string; version: number }>
  publicationUrl: string | null; notificationStatus: string | null; canEdit: boolean; canApprove: boolean
  company?: { displayName: string; canonicalSiteOrigin: string }
}
export const articleStatus = (status: ArticleWorkspace['status']) => ({ preparing: '正在準備網站草稿', editing: '等待審稿', changes_requested: '已提出修改意見', approved: '已核准，等待發布', processing: '正在發布', published: '已發布', retry_wait: '等待管理者重試發布', failed: '發布未完成', revoked: '審稿權限已失效' })[status]
export const workspaceIdIsValid = (value: string) => /^aw_[A-Za-z0-9_-]{32}$/.test(value)
export const cloneDocument = (value: ArticleDocument): ArticleDocument => JSON.parse(JSON.stringify(value)) as ArticleDocument
export const documentSignature = (value: ArticleDocument) => JSON.stringify(value)
export function articleReadyForPublication(value: ArticleDocument | null): boolean {
  return !!value && !!value.title.trim() && !!value.summary.trim() && !!value.category.trim() && value.slug.length >= 3 && value.slug !== 'media' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) && value.blocks.some(block => block.type !== 'image' && block.runs.some(run => run.text.trim())) && value.blocks.every(block => block.type !== 'image' || !!block.alt.trim())
}
export function needsProgressReload(cause: unknown): boolean {
  const status = cause && typeof cause === 'object' && 'statusCode' in cause ? Number(cause.statusCode) : 0
  return status !== 422 && status !== 413
}
export const blockText = (block: ArticleTextBlock) => block.runs.map(run => run.text).join('')
export function plainArticleDocument(input: { title: string; body: string; slug: string; summary: string; category: string }, makeId: () => string): ArticleDocument {
  return { schemaVersion: 1, title: input.title.trim(), slug: input.slug.trim(), summary: input.summary.trim(), category: input.category.trim(), takeaways: [], coverMediaId: null, blocks: input.body.trim().split(/\n\s*\n/).filter(Boolean).map(text => ({ id: makeId(), type: 'paragraph', runs: [{ text: text.trim() }] })) }
}
export function safeArticleUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null } catch { return null }
}
export function workbenchError(cause: unknown): string {
  const status = cause && typeof cause === 'object' && 'statusCode' in cause ? Number(cause.statusCode) : 0
  return status === 401 ? 'LINE 登入已失效，請重新開啟審稿入口。' : status === 403 ? '目前 LINE 帳號沒有這篇文章的權限，或文章已鎖定。' : status === 409 ? '文章版本或狀態已更新。你的草稿仍保留在此頁；請先更新進度，再核對差異。' : status === 410 ? '這次審稿已過期，請向服務人員索取新的送審通知。' : status === 413 ? '內容或圖片超過限制，請縮短內容或換較小的圖片。' : status === 422 ? '請檢查標題、網址代稱、內容與圖片設定後再試。' : '目前無法確認操作結果。請先更新進度，不要重複提交。'
}
