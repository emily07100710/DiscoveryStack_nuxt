<script setup lang="ts">
import ArticlePreview from '../../components/article-workbench/ArticlePreview.vue'
import { articleReadyForPublication, articleStatus, blockText, cloneDocument, documentSignature, needsProgressReload, safeArticleUrl, workbenchError, workspaceIdIsValid } from '../../components/article-workbench/types'
import type { ArticleDocument, ArticleMedia, ArticleTextBlock, ArticleWorkspace } from '../../components/article-workbench/types'
definePageMeta({ i18n: false, layout: false, alias: ['/weekly-content/connect/workbench'] })
useHead({ title: '文章審稿工作台｜搜尋王', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }, { name: 'referrer', content: 'no-referrer' }] })
type Config = { enabled: false } | { enabled: true; liffId: string; origin: string }
type LiffSdk = { init(options: { liffId: string }): Promise<void>; isLoggedIn(): boolean; login(options: { redirectUri: string }): void; getIDToken(): string | null; getContext(): { scope?: string[] } | null }
type Response = { workspace: ArticleWorkspace; replayed: boolean }
const fetchArticle = $fetch as <T>(path: string, options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }) => Promise<T>
const state = ref<'loading' | 'login' | 'ready' | 'disabled' | 'error'>('loading')
const workspace = ref<ArticleWorkspace | null>(null), draft = ref<ArticleDocument | null>(null)
const mode = ref<'preview' | 'editor'>('preview'), mobilePreview = ref(false), busy = ref(false), message = ref(''), failed = ref(false)
const rightsConfirmed = ref(false), approvalConfirmed = ref(false), feedbackNote = ref(''), showFeedback = ref(false), conflict = ref(false), conflictRefreshed = ref(false)
const imageUrls = ref<Record<string, string>>({}), imageLoading = ref(false), selectedMediaId = ref(''), uploadInput = ref<HTMLInputElement | null>(null)
let sdk: LiffSdk | undefined, config: Extract<Config, { enabled: true }> | undefined, workspaceId = '', savedSignature = '', active = true
const operationKeys = new Map<string, string>()
const dirty = computed(() => !!draft.value && documentSignature(draft.value) !== savedSignature)
const canEdit = computed(() => !!workspace.value?.canEdit && !busy.value && !conflict.value)
const missingImages = computed(() => !draft.value ? false : [draft.value.coverMediaId, ...draft.value.blocks.filter(block => block.type === 'image').map(block => block.mediaId)].some(id => !!id && !imageUrls.value[id]))
const publicationReady = computed(() => articleReadyForPublication(draft.value))
const canApprove = computed(() => !!workspace.value?.canApprove && !dirty.value && !conflict.value && !busy.value && !missingImages.value && publicationReady.value && approvalConfirmed.value)
const publicationUrl = computed(() => safeArticleUrl(workspace.value?.publicationUrl))
const expiry = computed(() => workspace.value ? new Date(workspace.value.expiresAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '')
const takeawaysText = computed({ get: () => draft.value?.takeaways.join('\n') || '', set: value => { if (draft.value) draft.value.takeaways = value.split('\n').map(text => text.trim()).filter(Boolean) } })
watch(draft, () => { approvalConfirmed.value = false }, { deep: true })
function cleanHistory() { window.history.replaceState(null, '', '/weekly-content/connect/workbench') }
function preventDraftLoss(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
function idToken() { const value = sdk?.getIDToken(); if (!value) throw new Error('login required'); return value }
function login() { if (sdk && config && workspaceId) sdk.login({ redirectUri: `${config.origin}/weekly-content/connect/workbench?workspaceId=${encodeURIComponent(workspaceId)}` }) }
function operationKey(action: string, payload: unknown) { const signature = JSON.stringify([action, workspaceId, payload]); let key = operationKeys.get(signature); if (!key) { key = crypto.randomUUID(); operationKeys.set(signature, key) } return key }
async function loadSdk(): Promise<LiffSdk> {
  const loaded = () => (window as unknown as { liff?: LiffSdk }).liff
  if (loaded()) return loaded()!
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script'), timer = window.setTimeout(() => { script.remove(); reject(new Error('sdk unavailable')) }, 10000)
    script.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js'; script.async = true; script.charset = 'utf-8'; script.referrerPolicy = 'no-referrer'
    script.onload = () => { window.clearTimeout(timer); resolve() }; script.onerror = () => { window.clearTimeout(timer); script.remove(); reject(new Error('sdk unavailable')) }; document.head.appendChild(script)
  })
  if (!loaded()) throw new Error('sdk unavailable')
  return loaded()!
}
function adopt(result: Response, preserveDraft = false) {
  workspace.value = result.workspace
  savedSignature = documentSignature(result.workspace.document)
  if (!preserveDraft || !result.workspace.canEdit || (draft.value && documentSignature(draft.value) === savedSignature)) { draft.value = cloneDocument(result.workspace.document); conflict.value = false; conflictRefreshed.value = false }
  else { conflict.value = true; conflictRefreshed.value = true }
  approvalConfirmed.value = false
}
async function loadImages(media: ArticleMedia[]) {
  imageLoading.value = true
  try {
    for (const item of media) {
      if (!active) return
      if (imageUrls.value[item.id]) continue
      try {
        const result = await fetchArticle<{ mimeType: 'image/webp'; bytesBase64: string }>('/api/article-workbench/customer/media-preview', { method: 'POST', body: { idToken: idToken(), workspaceId, mediaId: item.id } })
        if (!active) return
        if (result.mimeType !== 'image/webp' || result.bytesBase64.length > 750000) continue
        const binary = atob(result.bytesBase64), bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
        imageUrls.value = { ...imageUrls.value, [item.id]: URL.createObjectURL(new Blob([bytes], { type: result.mimeType })) }
      } catch { /* Missing previews stay visibly unavailable; never authenticate an image with a URL token. */ }
    }
  } finally { imageLoading.value = false }
}
async function refreshProgress() {
  if (busy.value) return
  busy.value = true; failed.value = false; message.value = ''
  try {
    const preserve = dirty.value
    const result = await fetchArticle<Response>('/api/article-workbench/customer/context', { method: 'POST', body: { idToken: idToken(), workspaceId } })
    adopt(result, preserve); await loadImages(result.workspace.media)
    message.value = conflict.value ? '已載入最新版本，你的未儲存草稿仍保留。請比較預覽後，選擇重新編輯或套用你的草稿。' : '文章與發布進度已更新。'
  } catch (cause) { failed.value = true; message.value = workbenchError(cause) } finally { busy.value = false }
}
function useServerVersion() { if (!workspace.value || busy.value || !conflictRefreshed.value) return; draft.value = cloneDocument(workspace.value.document); conflict.value = false; conflictRefreshed.value = false; approvalConfirmed.value = false; message.value = '已改用伺服器上的最新版本。' }
function keepLocalDraft() { if (!workspace.value?.canEdit || busy.value || !conflictRefreshed.value) return; conflict.value = false; conflictRefreshed.value = false; mode.value = 'editor'; message.value = '你的草稿已套用到最新版本。請再次核對內容，儲存後才能核准。' }
async function save() {
  if (!canEdit.value || !workspace.value || !draft.value || !dirty.value) return
  busy.value = true; failed.value = false; message.value = ''
  const payload = { expectedVersion: workspace.value.version, document: cloneDocument(draft.value) }
  try { const result = await fetchArticle<Response>('/api/article-workbench/customer/save', { method: 'POST', body: { idToken: idToken(), workspaceId, ...payload, idempotencyKey: operationKey('save', payload) } }); adopt(result); message.value = `第 ${result.workspace.version} 版已儲存。請切回預覽，核對最終內容再核准。`; mode.value = 'preview' }
  catch (cause) { failed.value = true; message.value = workbenchError(cause); conflict.value = needsProgressReload(cause); conflictRefreshed.value = false } finally { busy.value = false }
}
async function sendFeedback() {
  if (!canEdit.value || !workspace.value || !feedbackNote.value.trim() || dirty.value) return
  busy.value = true; failed.value = false; message.value = ''
  const payload = { expectedVersion: workspace.value.version, note: feedbackNote.value.trim() }
  try { const result = await fetchArticle<Response>('/api/article-workbench/customer/feedback', { method: 'POST', body: { idToken: idToken(), workspaceId, ...payload, idempotencyKey: operationKey('feedback', payload) } }); adopt(result); feedbackNote.value = ''; showFeedback.value = false; message.value = '修改意見已送出，文章暫不發布。服務人員會依意見改稿；新版仍需你重新確認。' }
  catch (cause) { failed.value = true; message.value = workbenchError(cause); conflict.value = needsProgressReload(cause); conflictRefreshed.value = false } finally { busy.value = false }
}
async function approve() {
  if (!canApprove.value || !workspace.value) return
  busy.value = true; failed.value = false; message.value = ''
  const payload = { expectedVersion: workspace.value.version, documentHash: workspace.value.documentHash, confirmation: 'APPROVE_AND_PUBLISH' }
  try { const result = await fetchArticle<Response>('/api/article-workbench/customer/approve', { method: 'POST', body: { idToken: idToken(), workspaceId, ...payload, idempotencyKey: operationKey('approve', payload) } }); adopt(result); mode.value = 'preview'; message.value = result.workspace.status === 'published' ? '文章已發布，可開啟網站核對。' : '這一版已核准並鎖定，系統將嘗試發布到公司網站。請更新進度確認結果。' }
  catch (cause) { failed.value = true; message.value = workbenchError(cause); conflict.value = needsProgressReload(cause); conflictRefreshed.value = false; approvalConfirmed.value = false } finally { busy.value = false }
}
function changeText(block: ArticleTextBlock, event: Event) { if (!canEdit.value) return; block.runs = [{ text: (event.target as HTMLTextAreaElement).value }] }
function setEmphasis(block: ArticleTextBlock, key: 'bold' | 'italic') { if (!canEdit.value) return; const enabled = !block.runs.every(run => run[key]); block.runs = block.runs.map(run => ({ ...run, [key]: enabled })) }
function addBlock(type: 'paragraph' | 'heading' | 'quote') { if (canEdit.value && draft.value && draft.value.blocks.length < 100) draft.value.blocks.push({ id: crypto.randomUUID(), type, runs: [{ text: '' }] }) }
function moveBlock(index: number, direction: number) { if (!canEdit.value || !draft.value) return; const next = index + direction; if (next < 0 || next >= draft.value.blocks.length) return; const blocks = draft.value.blocks; [blocks[index], blocks[next]] = [blocks[next]!, blocks[index]!] }
function removeBlock(index: number) { if (canEdit.value && draft.value && draft.value.blocks.length > 1) draft.value.blocks.splice(index, 1) }
function insertImage() { if (!canEdit.value || !draft.value || !selectedMediaId.value || !workspace.value?.media.some(item => item.id === selectedMediaId.value)) return; draft.value.blocks.push({ id: crypto.randomUUID(), type: 'image', mediaId: selectedMediaId.value, alt: '', caption: '', layout: 'auto' }); selectedMediaId.value = '' }
async function resizeImage(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) throw new Error('invalid image')
  const bitmap = await createImageBitmap(file)
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 50_000_000) throw new Error('invalid image')
    const ratio = Math.min(1, 1920 / bitmap.width, 1920 / bitmap.height), canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(bitmap.width * ratio)); canvas.height = Math.max(1, Math.floor(bitmap.height * ratio))
    const context = canvas.getContext('2d'); if (!context) throw new Error('image unavailable'); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const quality of [.82, .67, .5, .35]) { const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality)); if (blob && blob.type === 'image/webp' && blob.size <= 512 * 1024) return blob }
    throw new Error('image too large')
  } finally { bitmap.close() }
}
async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file || !canEdit.value || !workspace.value || !rightsConfirmed.value || dirty.value || workspace.value.media.length >= 10) return
  busy.value = true; failed.value = false; message.value = ''
  try {
    const blob = await resizeImage(file), bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
    const payload = { expectedVersion: workspace.value.version, filename: 'article-image.webp', mimeType: blob.type, bytesBase64: btoa(binary), rightsConfirmed: true }
    const result = await fetchArticle<Response>('/api/article-workbench/customer/media', { method: 'POST', body: { idToken: idToken(), workspaceId, ...payload, idempotencyKey: operationKey('media', payload) } })
    adopt(result); await loadImages(result.workspace.media); mode.value = 'editor'; message.value = '圖片已安全儲存。請選為封面或插入內文，填寫圖片描述後儲存這一版。'
  } catch (cause) { failed.value = true; message.value = cause instanceof Error && ['invalid image', 'image too large', 'image unavailable'].includes(cause.message) ? '請選 JPEG、PNG 或 WebP 圖片（原檔不超過 12 MB）。若仍過大，請先裁切或縮小圖片。' : workbenchError(cause) } finally { busy.value = false }
}
onMounted(async () => {
  window.addEventListener('beforeunload', preventDraftLoss)
  try {
    const readWorkspaceId = () => { const params = new URLSearchParams(window.location.search); const direct = params.get('workspaceId') || new URLSearchParams(window.location.hash.slice(1)).get('workspaceId'); if (direct) return direct; const liffState = params.get('liff.state'); if (!liffState) return ''; try { return new URL(liffState, window.location.origin).searchParams.get('workspaceId') || '' } catch { return '' } }
    const initialWorkspaceId = readWorkspaceId()
    const result = await fetchArticle<Config>('/api/article-workbench/config')
    if (!result.enabled) { cleanHistory(); state.value = 'disabled'; return }
    if (window.location.origin !== result.origin) throw new Error('origin not configured')
    config = result; sdk = await loadSdk(); await sdk.init({ liffId: result.liffId }); workspaceId = readWorkspaceId() || initialWorkspaceId; cleanHistory()
    if (!workspaceIdIsValid(workspaceId)) throw new Error('workspace missing')
    if (!sdk.isLoggedIn()) { state.value = 'login'; return }
    const scopes = sdk.getContext()?.scope || []; if (!scopes.includes('openid') || scopes.some(scope => scope !== 'openid')) throw new Error('scope not configured')
    const response = await fetchArticle<Response>('/api/article-workbench/customer/context', { method: 'POST', body: { idToken: idToken(), workspaceId } })
    if (!active) return
    adopt(response); state.value = 'ready'; await loadImages(response.workspace.media)
  } catch (cause) { cleanHistory(); state.value = 'error'; message.value = workbenchError(cause) }
})
onBeforeUnmount(() => { active = false; window.removeEventListener('beforeunload', preventDraftLoss); for (const url of Object.values(imageUrls.value)) URL.revokeObjectURL(url); imageUrls.value = {}; draft.value = null; workspace.value = null; workspaceId = ''; sdk = undefined; operationKeys.clear(); feedbackNote.value = '' })
</script>

<template>
  <main class="workbench-page">
    <header class="workbench-header"><div class="brand"><img src="/brand/searchking-avatar-v1.png" alt="搜尋王" width="40" height="40"><div><strong>搜尋王</strong><span>文章審稿工作台</span></div></div><span class="formal-chip">正式文章</span></header>
    <section v-if="state !== 'ready'" class="entry-card"><p class="eyebrow">REVIEW YOUR STORY</p><h1>把最後一版，確認好。</h1><p v-if="state === 'loading'" role="status">正在確認你的 LINE 身分與文章權限…</p><template v-else-if="state === 'login'"><p>請用已連結公司帳號的 LINE 登入。此頁不會公開文章內容。</p><button @click="login">用 LINE 登入審稿</button></template><p v-else-if="state === 'disabled'">正式審稿入口尚未開放，請聯絡服務人員。</p><p v-else>請從最新的 LINE 送審通知重新開啟；不要使用其他人的連結。</p></section>
    <template v-else-if="workspace && draft">
      <section class="workspace-heading"><div><p class="eyebrow">{{ workspace.company?.displayName || '你的公司文章' }}</p><h1>閱讀、調整，再確認發布。</h1><p>{{ workspace.company?.canonicalSiteOrigin }}</p></div><div class="status-box"><span class="status-dot" :class="workspace.status"></span><strong>{{ articleStatus(workspace.status) }}</strong><span>第 {{ workspace.version }} 版</span></div></section>
      <p v-if="message" class="notice" :class="{ error: failed }" role="status">{{ message }}</p>
      <aside v-if="conflict && workspace.canEdit" class="conflict-card"><strong>先核對版本，再繼續。</strong><p>未儲存草稿仍保留在此頁。重新讀取最新進度後，可改用伺服器版本，或將你的草稿套用到最新版本再儲存。</p><button class="secondary" :disabled="busy" @click="refreshProgress">讀取最新進度</button><button class="secondary" :disabled="busy || !conflictRefreshed" @click="useServerVersion">改用最新版本</button><button :disabled="busy || !conflictRefreshed" @click="keepLocalDraft">保留我的草稿繼續編輯</button></aside>
      <div class="workspace-layout">
        <section class="document-panel">
          <nav class="view-tabs" aria-label="審稿模式"><button :class="{ active: mode === 'preview' }" @click="mode = 'preview'">閱讀預覽</button><button v-if="workspace.canEdit" :disabled="busy || conflict" :class="{ active: mode === 'editor' }" @click="mode = 'editor'">編輯文字與配圖</button><label v-if="mode === 'preview'" class="mobile-toggle"><input v-model="mobilePreview" type="checkbox">手機預覽</label></nav>
          <div v-if="mode === 'preview' || !workspace.canEdit" class="preview-wrap"><ArticlePreview :document="draft" :media="[]" :image-urls="imageUrls" :compact="mobilePreview"/><p v-if="imageLoading" class="subtle" role="status">正在載入私人圖片預覽…</p></div>
          <form v-else class="editor" @submit.prevent="save">
            <fieldset :disabled="!canEdit"><legend>文章基本資料</legend><label>文章標題<input v-model="draft.title" maxlength="160" required></label><label>文章摘要<textarea v-model="draft.summary" rows="3" maxlength="500"></textarea><small>放在文章列表的簡短介紹。</small></label><div class="field-pair"><label>分類<input v-model="draft.category" maxlength="40"></label><label>網址代稱<input v-model="draft.slug" maxlength="100" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required autocomplete="off"><small>英文小寫、數字與連字號，例如 first-private-class。</small></label></div><label>文章重點（每行一點，最多三點）<textarea v-model="takeawaysText" rows="3" maxlength="720"></textarea></label></fieldset>
            <fieldset :disabled="!canEdit"><legend>段落編排</legend><div v-for="(block, index) in draft.blocks" :key="block.id" class="block-editor"><div class="block-toolbar"><span>{{ index + 1 }} · {{ block.type === 'image' ? '圖片' : block.type === 'heading' ? '小標題' : block.type === 'quote' ? '引言' : '段落' }}</span><div><button type="button" class="icon-button" :disabled="index === 0" aria-label="往上移動" @click="moveBlock(index, -1)">↑</button><button type="button" class="icon-button" :disabled="index === draft.blocks.length - 1" aria-label="往下移動" @click="moveBlock(index, 1)">↓</button><button type="button" class="icon-button remove" :disabled="draft.blocks.length <= 1" aria-label="移除這個區塊" @click="removeBlock(index)">移除</button></div></div>
                <template v-if="block.type === 'image'"><img v-if="imageUrls[block.mediaId]" class="editor-image" :src="imageUrls[block.mediaId]" :alt="block.alt"><label>圖片描述<input v-model="block.alt" maxlength="240" placeholder="簡單描述圖片內容，方便無障礙閱讀"></label><label>圖片圖說<input v-model="block.caption" maxlength="500"></label><label>圖片版型<select v-model="block.layout"><option value="auto">保持原始比例</option><option value="wide">滿版寬度</option></select></label></template>
                <template v-else><label>文字類型<select v-model="block.type"><option value="paragraph">一般段落</option><option value="heading">小標題</option><option value="quote">引言</option></select></label><label :for="`text-${block.id}`" class="sr-only">第 {{ index + 1 }} 段文字</label><textarea :id="`text-${block.id}`" :value="blockText(block)" rows="5" maxlength="24000" @input="changeText(block, $event)"></textarea><div class="text-tools"><button class="secondary" type="button" @click="setEmphasis(block, 'bold')">粗體</button><button class="secondary" type="button" @click="setEmphasis(block, 'italic')">斜體</button><small>格式套用整段；重新輸入文字會改為一般文字。</small></div></template>
              </div><div class="add-controls"><button type="button" class="secondary" :disabled="draft.blocks.length >= 100" @click="addBlock('paragraph')">＋段落</button><button type="button" class="secondary" :disabled="draft.blocks.length >= 100" @click="addBlock('heading')">＋小標題</button><button type="button" class="secondary" :disabled="draft.blocks.length >= 100" @click="addBlock('quote')">＋引言</button></div></fieldset>
            <fieldset :disabled="!canEdit"><legend>封面與內文配圖</legend><p class="subtle">最多 10 張。圖片只供這篇文章使用；請先儲存文字修改，再上傳圖片。</p><label class="check-label"><input v-model="rightsConfirmed" type="checkbox">我有權使用與發布這些圖片，且已取得必要同意。</label><input ref="uploadInput" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" aria-label="選擇文章圖片" :disabled="!rightsConfirmed || dirty || workspace.media.length >= 10" @change="uploadImage"><button type="button" class="secondary" :disabled="!rightsConfirmed || dirty || workspace.media.length >= 10" @click="uploadInput?.click()">上傳圖片（自動縮圖）</button><p v-if="dirty" class="subtle">有未儲存修改，請先按「儲存這一版」。</p><div v-if="workspace.media.length" class="media-library"><label v-for="item in workspace.media" :key="item.id" class="media-option"><input v-model="selectedMediaId" type="radio" :value="item.id" name="article-image"><img v-if="imageUrls[item.id]" :src="imageUrls[item.id]" alt="選擇配圖"><span v-else>圖片載入中</span><small>{{ item.width }} × {{ item.height }}</small></label></div><div v-if="workspace.media.length" class="image-actions"><button class="secondary" type="button" :disabled="!selectedMediaId" @click="draft.coverMediaId = selectedMediaId">設為封面</button><button class="secondary" type="button" :disabled="!selectedMediaId || draft.blocks.length >= 100" @click="insertImage">插入內文</button><button v-if="draft.coverMediaId" class="secondary" type="button" @click="draft.coverMediaId = null">移除封面</button></div></fieldset>
            <button type="submit" :disabled="!canEdit || !dirty" class="save-button">{{ busy ? '處理中…' : '儲存這一版' }}</button>
          </form>
        </section>
        <aside class="review-panel">
          <section class="decision-card"><p class="eyebrow">FINAL CHECK</p><h2>{{ workspace.canEdit ? '這一版，準備好了嗎？' : '這一版已鎖定' }}</h2><template v-if="workspace.canEdit"><p>核准後將正式發布到公司網站。文字、封面與配圖一起核准；核准後不能再修改此版本。</p><p v-if="!publicationReady" class="unsaved">請先補齊標題、摘要、分類、網址與正文，並為每張內文圖片填寫描述。</p><p v-if="missingImages" class="unsaved">文章配圖尚未完整載入，請更新進度並核對所有圖片；目前不開放核准。</p><p v-if="dirty" class="unsaved">你有未儲存的修改，請先儲存並重新預覽。</p><label class="check-label"><input v-model="approvalConfirmed" type="checkbox" :disabled="dirty || busy || conflict || missingImages || !publicationReady || !workspace.canApprove">我已確認第 {{ workspace.version }} 版文字與配圖，授權正式發布到公司網站。</label><button class="approve-button" :disabled="!canApprove" @click="approve">確認並正式發布</button><button class="feedback-toggle secondary" :disabled="!canEdit || dirty" @click="showFeedback = !showFeedback">{{ showFeedback ? '收起修改意見' : '請服務人員協助修改' }}</button><form v-if="showFeedback" class="feedback-form" @submit.prevent="sendFeedback"><label>希望怎麼調整？<textarea v-model="feedbackNote" rows="5" maxlength="3000" placeholder="例如：語氣再親切一點、第二段縮短，或換成工作室照片。" :disabled="!canEdit"></textarea></label><p class="subtle">此處交由服務人員改稿，不會立即自動改寫或發布。新版仍需你確認。</p><button :disabled="!canEdit || dirty || !feedbackNote.trim()" type="submit">送出修改意見</button></form></template><template v-else><p>核准後一般修改按鈕會關閉。系統只會發布你確認的版本，不會把後續改動套進去。</p><a v-if="publicationUrl" :href="publicationUrl" target="_blank" rel="noopener noreferrer" class="published-link">開啟已發布文章 ↗</a><p v-else>尚未取得已公開文章網址；請更新進度確認發布結果。</p></template><button class="secondary refresh-button" :disabled="busy" @click="refreshProgress">{{ busy ? '處理中…' : '更新文章與發布進度' }}</button><p class="subtle">審稿期限：{{ expiry }}（台灣時間）</p></section>
          <section v-if="workspace.feedback.length" class="feedback-history"><h2>修改意見紀錄</h2><article v-for="(item, index) in workspace.feedback" :key="index"><span>第 {{ item.version }} 版</span><p>{{ item.note }}</p><small>{{ new Date(item.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) }}</small></article></section>
          <p class="privacy-note">文章與圖片僅向目前綁定的 LINE 審核人員開放。沒有核准，不會發布；這不是先前的流程測試稿。</p>
        </aside>
      </div>
    </template>
    <p v-if="message && state !== 'ready'" class="notice error" role="alert">{{ message }}</p>
  </main>
</template>

<style scoped>
.workbench-page{min-height:100vh;background:#f5f6f1;color:#26382e;padding:0 24px 48px;font-family:inherit;line-height:1.65}.workbench-header{max-width:1180px;margin:auto;padding:22px 0;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dde4da}.brand{display:flex;align-items:center;gap:12px}.brand img{border-radius:12px}.brand div{display:grid}.brand strong{font-size:16px;letter-spacing:.06em}.brand span{font-size:12px;color:#7a857d}.formal-chip{font-size:12px;padding:6px 12px;border:1px solid #ccd9cf;border-radius:30px;color:#4d6d59}.workspace-heading{max-width:1180px;margin:32px auto 26px;display:flex;align-items:center;justify-content:space-between;gap:20px}.eyebrow{font-size:12px;letter-spacing:.12em;font-weight:700;color:#78917f;margin:0 0 12px}.workspace-heading h1{font-size:clamp(24px,3vw,32px);margin:0;font-weight:650;letter-spacing:-.025em}.workspace-heading p:last-child{font-size:13px;overflow-wrap:anywhere;color:#778479;margin-bottom:0}.status-box{display:grid;grid-template-columns:10px 1fr;align-items:center;gap:4px 8px;font-size:13px;flex-shrink:0}.status-box>span:last-child{grid-column:2;color:#8a948c;font-size:12px}.status-dot{width:7px;height:7px;border-radius:100%;background:#b19a60}.status-dot.published{background:#6b9b76}.workspace-layout{max-width:1180px;margin:auto;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}.document-panel,.decision-card,.feedback-history{background:#fff;border:1px solid #e0e6dc;border-radius:18px}.document-panel{overflow:hidden}.view-tabs{padding:14px 18px;border-bottom:1px solid #e7ece3;display:flex;align-items:center;flex-wrap:wrap;gap:7px}.view-tabs button{background:transparent;color:#718074;padding:9px 12px;margin:0;font-size:13px}.view-tabs button.active{background:#edf2e9;color:#315d40}.mobile-toggle{display:flex;gap:5px;align-items:center;font-size:12px;color:#73806e;margin:0 0 0 auto}.preview-wrap{padding:38px 42px}.review-panel{position:sticky;top:20px}.decision-card,.feedback-history{padding:24px}.decision-card h2{font-size:20px;line-height:1.5;margin:0 0 14px}.decision-card p{font-size:14px;color:#748075}.check-label{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:1.8}.check-label input{width:17px;height:17px;flex-shrink:0;margin-top:4px;accent-color:#426e4f}.approve-button,.feedback-toggle,.refresh-button{width:100%;margin-top:14px}.approve-button{background:#416c4e}.refresh-button{margin-top:20px}.unsaved{background:#faf4e5;padding:12px;border-radius:10px;color:#8c7138!important}.privacy-note{font-size:12px;line-height:1.8;color:#8a9489;padding:0 12px}.subtle{font-size:12px;color:#879284;line-height:1.8}.notice,.conflict-card{max-width:1180px;box-sizing:border-box;margin:0 auto 22px;background:#eaf2e7;color:#426444;border-radius:12px;padding:14px 18px;font-size:14px}.notice.error{background:#faeee9;color:#925442}.conflict-card{background:#fff8e9;color:#856632}.conflict-card p{font-size:14px}.entry-card{max-width:580px;margin:60px auto;padding:40px;background:#fff;border-radius:20px;border:1px solid #e0e6dc}.entry-card h1{font-size:30px;line-height:1.4}.entry-card p{color:#758171}.editor{padding:26px}.editor fieldset{border:0;margin:0 0 30px;padding:0;min-width:0}.editor legend{font-size:16px;font-weight:700;margin-bottom:16px}.editor label,.feedback-form label{display:grid;gap:7px;font-size:13px;font-weight:600;margin:14px 0}.editor .check-label{display:flex;font-weight:400}.field-pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}input:not([type=checkbox]):not([type=radio]),textarea,select{box-sizing:border-box;width:100%;background:#fcfdfb;border:1px solid #d0dbcc;border-radius:8px;color:#334432;padding:10px 12px;font:inherit;font-size:15px;line-height:1.65}textarea{resize:vertical}input:focus-visible,textarea:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #92b08f;outline-offset:3px}small{font-size:11px;font-weight:400;color:#88917f}.block-editor{padding:16px;border:1px solid #e1e7dc;background:#fbfcf8;border-radius:12px;margin-bottom:14px}.block-toolbar{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#7d8d75}.block-toolbar>div{display:flex;gap:5px}.block-editor>textarea{background:white}.block-editor label{margin:10px 0}.icon-button{padding:5px 8px!important;font-size:12px!important;background:#edf2e6!important;color:#6c805c!important;margin:0!important}.icon-button.remove{color:#9a6652!important}.text-tools{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:10px}.text-tools button{padding:5px 10px;font-size:12px;margin:0}.add-controls{display:flex;flex-wrap:wrap;gap:7px}.add-controls button{margin:0;font-size:12px}.editor-image{max-width:100%;max-height:300px;border-radius:8px;margin-top:10px}.media-library{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}.editor .media-option{position:relative;border:1px solid #d8e2ce;border-radius:10px;padding:8px;margin:0;background:#fff}.media-option input{position:absolute;top:8px;left:8px;accent-color:#416c4e}.media-option img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px}.media-option small{text-align:center}.image-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.image-actions button{margin:0;font-size:12px}.save-button{width:100%}.feedback-history{margin-top:18px}.feedback-history h2{font-size:16px;margin:0 0 16px}.feedback-history article{border-top:1px solid #e4eadf;padding-top:12px;margin-top:12px}.feedback-history span{font-size:12px;color:#8d997f}.feedback-history p{font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.published-link{display:block;background:#e7f1e4;color:#3c6441;padding:12px;border-radius:10px;text-decoration:none;font-size:14px;text-align:center}button{background:#426b4b;color:#fff;border:0;border-radius:9px;padding:11px 14px;cursor:pointer;font:inherit;font-size:14px;font-weight:600}button:disabled{opacity:.48;cursor:not-allowed}.secondary{background:#eef2e9;color:#617653}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:940px){.workspace-layout{grid-template-columns:minmax(0,1fr) 290px;gap:16px}.preview-wrap{padding:30px 26px}.decision-card{padding:20px}}@media(max-width:760px){.workbench-page{padding:0 16px 32px}.workbench-header{padding:16px 0}.workspace-heading{margin:26px 0 20px;display:block}.workspace-heading h1{font-size:24px}.status-box{margin-top:16px;display:flex;gap:8px}.status-box>span:last-child{margin-left:auto}.workspace-layout{grid-template-columns:1fr}.review-panel{position:static}.preview-wrap{padding:26px 20px}.editor{padding:20px 16px}.field-pair{grid-template-columns:1fr;gap:0}.view-tabs{padding:12px}.mobile-toggle{margin-left:0}.entry-card{padding:28px;margin:36px auto}.media-library{grid-template-columns:repeat(3,1fr)}.approve-button{padding:15px}.decision-card .check-label{font-size:14px}}
</style>
