<script setup lang="ts">
import ArticlePreview from './ArticlePreview.vue'
import { articleStatus, blockText, cloneDocument, documentSignature, plainArticleDocument, safeArticleUrl } from './types'
import type { ArticleDocument, ArticleWorkspace } from './types'
const props = defineProps<{ clientId: number; clientName: string; lineBound: boolean; clientActive: boolean }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const fetchOwner = $fetch as <T>(path: string, options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }) => Promise<T>
const title = ref(''), body = ref(''), slug = ref(''), summary = ref(''), category = ref('練習日常'), confirmed = ref(false)
const busy = ref(false), loading = ref(false), loaded = ref(false), failed = ref(false), notice = ref(''), workspaces = ref<ArticleWorkspace[]>([])
const state = ref<'idle' | 'uncertain' | 'retryable' | 'submitted'>('idle'), reloadedAfterUncertain = ref(false)
type Attempt = { idempotencyKey: string; document: ArticleDocument; state: typeof state.value; workspaceId: string | null; reloaded: boolean }
const attempts = new Map<string, Attempt>(); let loadVersion = 0
const revision = ref<ArticleWorkspace | null>(null), revisionDraft = ref<ArticleDocument | null>(null), revisionConfirmed = ref(false), revisionPreview = ref(false)
const revisionDirty = computed(() => !!revision.value && !!revisionDraft.value && documentSignature(revisionDraft.value) !== documentSignature(revision.value.document))
const revisionKeys = new Map<string, string>()
const revisionUnknown = ref(false)
const retryConfirmations = ref<Record<string, boolean>>({})
watch(revisionDraft, () => { revisionConfirmed.value = false }, { deep: true })
const signature = () => JSON.stringify([title.value.trim(), body.value.trim(), slug.value.trim(), summary.value.trim(), category.value.trim()])
const valid = computed(() => !!title.value.trim() && title.value.trim().length <= 160 && !!body.value.trim() && [title.value,body.value,summary.value,category.value].reduce((total,value)=>total+value.trim().length,0) <= 24000 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.value.trim()) && slug.value.trim().length >= 3 && slug.value.trim() !== 'media' && !!summary.value.trim() && !!category.value.trim() && category.value.trim().length <= 40)
watch([title, body, slug, summary, category], () => { confirmed.value = false; const attempt = attempts.get(signature()); state.value = attempt?.state || 'idle'; reloadedAfterUncertain.value = attempt?.reloaded || false; notice.value = ''; failed.value = false })
watch(busy, value => emit('busy', value))
watch(() => props.clientId, () => { loadVersion += 1; title.value = ''; body.value = ''; slug.value = ''; summary.value = ''; category.value = '練習日常'; confirmed.value = false; attempts.clear(); workspaces.value = []; loaded.value = false; state.value = 'idle'; reloadedAfterUncertain.value = false; notice.value = ''; if (props.lineBound) void refreshProgress() }, { immediate: true })
const date = (value: string) => new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
const notify = (value: string | null) => value === 'sent' ? 'LINE 已接受通知' : value === 'failed' ? 'LINE 通知失敗' : value === 'retry_wait' ? 'LINE 通知待重試' : value === 'cancelled' ? 'LINE 通知已取消' : '等待 LINE 通知'
const retryNeeded = (item: ArticleWorkspace) => item.status === 'retry_wait' || item.preparationStatus === 'retry_wait' || item.notificationStatus === 'retry_wait'
async function retryWorkspace(item: ArticleWorkspace) {
  if (busy.value || !retryNeeded(item) || !retryConfirmations.value[item.workspaceId]) return
  busy.value = true; failed.value = false; notice.value = ''
  try { const result = await fetchOwner<{ workspace: ArticleWorkspace }>('/api/article-workbench/owner/retry', { method: 'POST', body: { workspaceId: item.workspaceId, confirmation: 'RETRY_FORMAL_ARTICLE' } }); workspaces.value = workspaces.value.map(row => row.workspaceId === result.workspace.workspaceId ? result.workspace : row); retryConfirmations.value[item.workspaceId] = false; notice.value = result.workspace.status === 'published' ? '已核對網站公開收據，這一篇已發布。' : '已核對同一篇文章的重試狀態；若仍顯示等待，可能尚未到重試時間或仍在處理。系統不會更換已核准的內容。' }
  catch { failed.value = true; notice.value = '目前無法確認重試結果。請更新正式文章進度；不要另建同一篇稿件，也不要把同意套到其他版本。' }
  finally { busy.value = false }
}
function openRevision(item: ArticleWorkspace) { if (busy.value || !item.canEdit) return; revision.value = item; revisionDraft.value = cloneDocument(item.document); revisionConfirmed.value = false; revisionPreview.value = false; revisionUnknown.value = false }
function closeRevision() { if (busy.value) return; revision.value = null; revisionDraft.value = null; revisionConfirmed.value = false; revisionUnknown.value = false }
function reviseText(index: number, event: Event) { const item = revisionDraft.value?.blocks[index]; if (item && item.type !== 'image' && !busy.value) item.runs = [{ text: (event.target as HTMLTextAreaElement).value }] }
async function saveRevision() {
  if (!revision.value?.canEdit || !revisionDraft.value || !revisionDirty.value || busy.value || revisionUnknown.value) return
  const payload = { workspaceId: revision.value.workspaceId, expectedVersion: revision.value.version, document: cloneDocument(revisionDraft.value) }, signature = JSON.stringify(payload)
  let idempotencyKey = revisionKeys.get(signature); if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); revisionKeys.set(signature, idempotencyKey) }
  busy.value = true; failed.value = false; notice.value = ''
  try { const result = await fetchOwner<{ workspace: ArticleWorkspace; replayed: boolean }>('/api/article-workbench/owner/save', { method: 'POST', body: { ...payload, idempotencyKey } }); revision.value = result.workspace; revisionDraft.value = cloneDocument(result.workspace.document); workspaces.value = workspaces.value.map(item => item.workspaceId === result.workspace.workspaceId ? result.workspace : item); revisionConfirmed.value = false; revisionPreview.value = true; notice.value = '新版已儲存，但尚未重新通知客戶。請核對後勾選確認，再傳送新版審稿通知。' }
  catch { revisionUnknown.value = true; failed.value = true; notice.value = '無法確認新版是否已儲存。你的草稿仍保留，請先更新正式文章進度，核對後再重新開啟此篇編輯。' }
  finally { busy.value = false }
}
async function sendRevision() {
  if (!revision.value?.canEdit || revisionDirty.value || !revisionConfirmed.value || busy.value || revisionUnknown.value) return
  busy.value = true; failed.value = false; notice.value = ''
  try { const result = await fetchOwner<{ workspace: ArticleWorkspace; replayed: boolean }>('/api/article-workbench/owner/send-revision', { method: 'POST', body: { workspaceId: revision.value.workspaceId, expectedVersion: revision.value.version, confirmation: 'SEND_REVISED_FORMAL_ARTICLE' } }); revision.value = result.workspace; workspaces.value = workspaces.value.map(item => item.workspaceId === result.workspace.workspaceId ? result.workspace : item); revisionConfirmed.value = false; notice.value = result.workspace.notificationStatus === 'sent' ? 'LINE 已接受新版審稿通知；仍需要客戶在工作台核准最新版，才會發布。' : '新版審稿通知已建立，請更新進度確認 LINE 傳送結果。' }
  catch { failed.value = true; notice.value = '新版通知結果無法確認。請更新正式文章進度；同版本通知會由伺服器核對，避免重複傳送。' }
  finally { busy.value = false }
}
async function refreshProgress() {
  if (busy.value) return
  const version = ++loadVersion, clientId = props.clientId; loading.value = true; failed.value = false
  try {
    const result = await fetchOwner<{ workspaces: ArticleWorkspace[] }>(`/api/article-workbench/clients/${clientId}`)
    if (version !== loadVersion || props.clientId !== clientId) return
    workspaces.value = result.workspaces; loaded.value = true
    if (revision.value && !result.workspaces.find(item => item.workspaceId === revision.value?.workspaceId)?.canEdit) closeRevision()
    const attempt = attempts.get(signature()), known = attempt?.workspaceId ? result.workspaces.find(item => item.workspaceId === attempt.workspaceId) : undefined
    if (attempt && known) { attempt.state = known.preparationStatus === 'retry_wait' || known.notificationStatus === 'retry_wait' ? 'retryable' : 'submitted'; attempt.reloaded = false; state.value = attempt.state; reloadedAfterUncertain.value = false }
    else if (attempt?.state === 'uncertain') { attempt.reloaded = true; reloadedAfterUncertain.value = true }
    notice.value = '正式文章進度已更新。'
  } catch { if (version === loadVersion) { loaded.value = false; failed.value = true; notice.value = '目前無法讀取正式文章進度。請先重新整理，不要重複送稿。' } }
  finally { if (version === loadVersion) loading.value = false }
}
async function send() {
  if (busy.value || loading.value || !loaded.value || !props.lineBound || !props.clientActive || !valid.value || !confirmed.value || state.value === 'submitted' || (state.value === 'uncertain' && !reloadedAfterUncertain.value)) return
  const key = signature(), clientId = props.clientId
  const attempt: Attempt = attempts.get(key) || { idempotencyKey: crypto.randomUUID(), document: plainArticleDocument({ title: title.value, body: body.value, slug: slug.value, summary: summary.value, category: category.value }, () => crypto.randomUUID()), state: 'idle', workspaceId: null, reloaded: false }
  attempts.set(key, attempt); busy.value = true; failed.value = false; notice.value = ''
  try {
    const result = await fetchOwner<{ workspace: ArticleWorkspace; replayed: boolean }>(`/api/article-workbench/clients/${clientId}`, { method: 'POST', body: { document: attempt.document, idempotencyKey: attempt.idempotencyKey, confirmation: 'SEND_FORMAL_ARTICLE' } })
    if (props.clientId !== clientId) return
    attempt.workspaceId = result.workspace.workspaceId; attempt.state = result.workspace.preparationStatus === 'retry_wait' || result.workspace.notificationStatus === 'retry_wait' ? 'retryable' : 'submitted'; attempt.reloaded = false; state.value = attempt.state; confirmed.value = false; reloadedAfterUncertain.value = false
    workspaces.value = [result.workspace, ...workspaces.value.filter(item => item.workspaceId !== result.workspace.workspaceId)]
    notice.value = result.workspace.notificationStatus === 'sent' ? 'LINE 已接受正式審稿通知；不代表客戶已收到或已閱讀。客戶核准這一版後，系統才會嘗試發布。' : result.workspace.status === 'preparing' ? '正式文章已建立，正在準備網站草稿。尚未完成送審；請更新進度確認結果。' : '正式審稿已建立。請更新進度確認 LINE 傳送結果，不要另建相同稿件。'
  } catch { if (props.clientId === clientId) { attempt.state = 'uncertain'; attempt.reloaded = false; state.value = 'uncertain'; reloadedAfterUncertain.value = false; confirmed.value = false; failed.value = true; notice.value = '送稿結果目前無法確認，識別碼已保留。請先更新進度，再使用同一識別碼安全重試，不要重複建立文章。' } }
  finally { busy.value = false }
}
onBeforeUnmount(() => { attempts.clear(); revisionKeys.clear(); revision.value = null; revisionDraft.value = null; title.value = ''; body.value = ''; workspaces.value = []; emit('busy', false) })
</script>
<template>
  <section class="formal-workbench-card" aria-labelledby="formal-workbench-title">
    <div class="section-heading"><div><p class="eyebrow">正式文章 · 一篇一篇確認</p><h2 id="formal-workbench-title">{{ clientName }} 的正式審稿與發布</h2></div><span class="formal-badge">正式流程</span></div>
    <p class="intro">這裡不是測試稿。客戶可以在私人審稿工作台改文字、配圖、提出修改意見；確認最終版本後，才會正式發布到公司部落格。不會開啟全站排程。</p>
    <p v-if="!lineBound" class="notice">請先綁定客戶 LINE，再建立正式送審。</p>
    <template v-else>
      <details class="compose-panel"><summary>準備一篇正式文章並送給客戶</summary><form @submit.prevent="send"><fieldset :disabled="busy"><label>正式文章標題<input v-model="title" maxlength="160" required autocomplete="off"></label><div class="form-pair"><label>網址代稱<input v-model="slug" maxlength="100" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="first-private-class" required autocomplete="off"><small>英文小寫、數字與連字號，不能與既有文章重複。</small></label><label>分類<input v-model="category" maxlength="40" required></label></div><label>文章摘要<textarea v-model="summary" maxlength="500" rows="3"></textarea></label><label>正式文章正文<textarea v-model="body" maxlength="24000" rows="14" required placeholder="段落間留一個空白行。客戶可在工作台調整段落與配圖。"></textarea><small>{{ body.length }}／24,000 字；來源：管理者手動準備，不代表模型已自動生成。</small></label><label class="confirm-line"><input v-model="confirmed" type="checkbox">我確認這是正式文章，送給目前綁定的客戶 LINE 審核；客戶核准後將發布到公司網站。</label></fieldset><button v-if="state === 'idle'" :disabled="busy || loading || !loaded || !confirmed || !valid || !clientActive" type="submit">傳送正式文章審稿通知</button><button v-else-if="state === 'retryable' || (state === 'uncertain' && reloadedAfterUncertain)" :disabled="busy || loading || !loaded || !confirmed || !valid || !clientActive" type="submit">使用同一識別碼安全重試</button><p v-else-if="state === 'submitted'" class="subtle">這份文章已建立，請從下方查看進度。不要重複建立同一篇。</p><p v-else class="subtle">請先更新進度，確認後才會開放重試。</p></form></details>
      <p v-if="notice" class="notice" :class="{ error: failed }" role="status">{{ notice }}</p>
      <div class="progress-heading"><h3>正式文章進度</h3><button class="secondary" :disabled="busy || loading" @click="refreshProgress">{{ loading ? '更新中…' : '更新正式文章進度' }}</button></div><p v-if="!workspaces.length" class="subtle">目前沒有正式送審文章。先前測試稿的同意不會轉成正式發文授權。</p>
      <ul class="workspace-list"><li v-for="item in workspaces" :key="item.workspaceId"><div class="article-row"><strong>{{ item.document.title }}</strong><span class="status-chip">{{ articleStatus(item.status) }}</span></div><p>第 {{ item.version }} 版 · {{ notify(item.notificationStatus) }}</p><small>審稿期限 {{ date(item.expiresAt) }}（台灣時間）</small><a v-if="safeArticleUrl(item.publicationUrl)" :href="safeArticleUrl(item.publicationUrl)!" target="_blank" rel="noopener noreferrer">開啟已發布文章 ↗</a><div v-if="item.feedback.length" class="feedback"><h4>客戶修改意見</h4><p v-for="(feedback, index) in item.feedback" :key="index">第 {{ feedback.version }} 版：{{ feedback.note }}</p><small>請依意見整理新版；新的文字與圖片仍需客戶重新核准。</small></div><button v-if="item.canEdit" class="secondary" :disabled="busy" @click="openRevision(item)">編輯這篇／整理修改意見</button><div v-if="retryNeeded(item)" class="retry-panel"><label class="confirm-line"><input v-model="retryConfirmations[item.workspaceId]" type="checkbox" :disabled="busy">我確認重試同一篇文章；只重試原稿或已核准版本，不新增稿件或更換內容。</label><button class="secondary" :disabled="busy || !retryConfirmations[item.workspaceId]" @click="retryWorkspace(item)">安全重試這篇的待完成步驟</button></div></li></ul>
      <section v-if="revision && revisionDraft" class="revision-panel" aria-labelledby="owner-revision-title"><h3 id="owner-revision-title">整理第 {{ revision.version }} 版 · {{ revision.document.title }}</h3><p class="subtle">核准前可修改同一篇文章。儲存新版不等於發文，也不會沿用舊版同意。</p><div class="revision-tabs"><button class="secondary" :disabled="busy" @click="revisionPreview=false">編輯新版</button><button class="secondary" :disabled="busy" @click="revisionPreview=true">預覽文字</button><button class="secondary" :disabled="busy" @click="closeRevision">關閉編輯</button></div><ArticlePreview v-if="revisionPreview" :document="revisionDraft" :media="[]"/><form v-else @submit.prevent="saveRevision"><fieldset :disabled="busy || revisionUnknown"><label>新版標題<input v-model="revisionDraft.title" maxlength="160"></label><label>新版摘要<textarea v-model="revisionDraft.summary" maxlength="500" rows="3"></textarea></label><div class="form-pair"><label>新版分類<input v-model="revisionDraft.category" maxlength="40"></label><label>新版網址代稱<input v-model="revisionDraft.slug" maxlength="100"></label></div><div v-for="(block,index) in revisionDraft.blocks" :key="block.id"><template v-if="block.type==='image'"><p class="subtle">內文圖片（原圖維持不變；私人圖片請由客戶工作台預覽）</p><label>圖片描述<input v-model="block.alt" maxlength="240"></label><label>圖片圖說<input v-model="block.caption" maxlength="500"></label></template><label v-else>第 {{ index+1 }} 段 · {{ block.type==='heading'?'小標題':block.type==='quote'?'引言':'段落' }}<textarea :value="blockText(block)" maxlength="24000" rows="5" @input="reviseText(index,$event)"></textarea></label></div></fieldset><button :disabled="busy || revisionUnknown || !revisionDirty" type="submit">儲存修改後的新版本</button></form><label class="confirm-line"><input v-model="revisionConfirmed" type="checkbox" :disabled="busy || revisionUnknown || revisionDirty">我已核對這一版，確認重新傳送正式審稿通知；仍須客戶核准才能發布。</label><button :disabled="busy || revisionUnknown || revisionDirty || !revisionConfirmed" @click="sendRevision">傳送新版審稿通知</button><p v-if="revisionUnknown" class="notice error">操作結果待核對，請保留草稿並更新進度；目前不接受重複儲存或送審。</p></section>
    </template>
  </section>
</template>
<style scoped>
.formal-workbench-card{margin:24px 0;padding:28px;border:1px solid #cfdcc8;border-radius:16px;background:#fcfdf9;color:#35492f}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:15px}.eyebrow{font-size:12px;color:#748967;font-weight:700;letter-spacing:.1em;margin:0 0 8px}.section-heading h2{font-size:24px;line-height:1.45;margin:0}.formal-badge{flex-shrink:0;border:1px solid #c5d8bb;color:#678256;background:#edf4e7;border-radius:30px;padding:5px 10px;font-size:12px}.intro{font-size:15px;color:#76846b;line-height:1.9}.compose-panel{border:1px solid #dfe7d6;border-radius:12px;background:#fff;margin:22px 0}.compose-panel summary{padding:18px;font-size:16px;font-weight:650;cursor:pointer}.compose-panel form{padding:0 20px 20px}fieldset{border:0;padding:0;margin:0;min-width:0}label{display:grid;gap:7px;margin:16px 0;font-size:14px;font-weight:600}input:not([type=checkbox]),textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #c7d7be;border-radius:8px;background:#fff;font:inherit;line-height:1.7;color:#344e2b}textarea{resize:vertical}.form-pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.confirm-line{display:flex;align-items:flex-start;gap:10px;line-height:1.8;font-weight:400}.confirm-line input{width:18px;height:18px;margin-top:5px;accent-color:#50703e;flex-shrink:0}.notice{padding:14px 18px;background:#edf4e6;color:#526e42;border-radius:9px;font-size:14px}.notice.error{background:#fff0e8;color:#965b40}.progress-heading{display:flex;align-items:center;justify-content:space-between;gap:15px}.progress-heading h3{font-size:18px}.workspace-list{padding:0;list-style:none;margin:0}.workspace-list li{padding:20px 0;border-top:1px solid #dce7d2}.article-row{display:flex;justify-content:space-between;align-items:flex-start;gap:15px}.article-row strong{font-size:16px}.status-chip{font-size:12px;background:#edf3e7;color:#6a8259;border-radius:6px;padding:4px 8px;flex-shrink:0}.workspace-list p{font-size:14px;line-height:1.7;margin:8px 0;color:#6a7b60}.workspace-list a{display:block;font-size:14px;color:#466c33;margin:10px 0;text-decoration:underline;text-underline-offset:4px}.feedback{padding:14px;background:#f4f5ec;border-radius:9px;margin-top:12px}.feedback h4{font-size:14px;margin:0}.feedback p{white-space:pre-wrap;overflow-wrap:anywhere}.subtle,small{font-size:12px;color:#89947e;line-height:1.8}button{font:inherit;font-size:14px;font-weight:600;background:#527343;color:white;border:0;border-radius:8px;padding:11px 15px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.secondary{background:#edf2e8;color:#6a7b5c}input:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #9fb995;outline-offset:3px}@media(max-width:650px){.formal-workbench-card{padding:20px 16px}.section-heading h2{font-size:21px}.section-heading{align-items:flex-start}.form-pair{grid-template-columns:1fr;gap:0}.compose-panel form{padding:0 14px 16px}.progress-heading{align-items:flex-start}.article-row{display:block}.status-chip{display:inline-block;margin-top:8px}.progress-heading h3{font-size:16px}}
</style>
