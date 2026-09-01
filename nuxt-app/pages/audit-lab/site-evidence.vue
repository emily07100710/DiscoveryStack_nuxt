<script setup lang="ts">
type ScanStatus = 'pending' | 'running' | 'completed' | 'completed_partial' | 'failed'
type Scan = { id: number, targetOrigin: string, targetHost: string, status: ScanStatus, maxPages: number, pagesDiscovered: number, pagesFetched: number, renderedCaptured: number, errorCode: string | null, limitations: string[] | null, heartbeatAt: string | null, startedAt: string | null, finishedAt: string | null, createdAt: string }
type Finding = { id?: number, urlId: number | null, category: string, severity: 'info' | 'warning' | 'critical', status: 'detected' | 'unknown', evidence: Record<string, unknown> }
type ScanDetail = { scan: Scan, findings: { items: Finding[], total: number } }
type UrlRow = { id: number, normalizedUrl: string, httpStatus: number | null, robotsVerdict: string, canonicalUrl: string | null, redirectChain: Array<{ url: string, status: number }> | null, discoverySources: string[], errorCode: string | null }
type UrlPage = { items: UrlRow[], total: number, limit: number, offset: number }

definePageMeta({ i18n: false, layout: 'owner' })
useHead({ title: '站台證據 · DiscoveryStack', meta: [{ name: 'robots', content: 'noindex, nofollow, noarchive' }] })

const state = ref<'loading' | 'signin' | 'ready' | 'error'>('loading')
const scans = ref<Scan[]>([])
const selectedScan = ref<Scan | null>(null)
const findings = ref<Finding[]>([])
const urls = ref<UrlPage>({ items: [], total: 0, limit: 50, offset: 0 })
const submitting = ref(false)
const loadingDetail = ref(false)
const notice = ref('')
const errorMessage = ref('')
const form = reactive({ targetUrl: '', maxPages: 200 })
let pollTimer: ReturnType<typeof setInterval> | null = null

const statusLabels: Record<string, string> = { pending: '等待執行', running: '處理中', completed: '已完成', completed_partial: '部分完成', failed: '失敗' }
const severityLabels: Record<string, string> = { info: '資訊', warning: '警告', critical: '嚴重' }
const robotsLabels: Record<string, string> = { allowed: '允許', disallowed: '不允許（僅記錄）', unavailable: '無法取得', unknown: '無法判定' }
const findingLabels: Record<string, string> = {
  in_sitemap_not_crawlable: 'Sitemap 內網址無法取得', crawled_not_in_sitemap: '已抓取網址未列入 Sitemap', canonical_mismatch: 'Canonical 指向不同頁面', canonical_points_to_variant: 'Canonical 指向網址變體', redirect_chain: '多段重新導向', soft_404_suspect: '疑似 Soft 404', http_https_duplicate: 'HTTP／HTTPS 重複', www_duplicate: 'www／非 www 重複', trailing_slash_duplicate: '尾端斜線重複', query_param_duplicate: '查詢參數重複', raw_missing_main_content: '原始 HTML 缺少主要內容', js_only_links: '僅 rendered 才有的內部連結', raw_rendered_mismatch: '原始／rendered 訊號不一致', rendered_unknown: 'Rendered 證據無法判定',
}
const limitationLabels: Record<string, string> = { rendered_snapshots_unavailable: '無法取得 rendered 快照（未設定或供應商失敗）', robots_txt_unavailable: 'robots.txt 無法取得或格式不完整', page_cap_reached: '已達頁數上限', scan_deadline_reached: '已達 15 分鐘掃描期限', sitemap_entries_truncated: '單一 Sitemap 條目已截斷', sitemap_url_consideration_cap_reached: 'Sitemap 考量網址已達上限', stale_scan_detected: '背景掃描心跳逾時，狀態已標記為 stale' }

const isActive = computed(() => selectedScan.value?.status === 'pending' || selectedScan.value?.status === 'running')
const hasActiveScan = computed(() => scans.value.some(scan => scan.status === 'pending' || scan.status === 'running'))
const isStale = computed(() => selectedScan.value?.errorCode === 'stale_scan' || selectedScan.value?.limitations?.includes('stale_scan_detected'))
const canPrevious = computed(() => urls.value.offset > 0)
const canNext = computed(() => urls.value.offset + urls.value.items.length < urls.value.total)

function requestFailureMessage(error: unknown, fallback: string) {
  const failure = error as { statusCode?: number, status?: number, statusMessage?: string, data?: { statusMessage?: string, message?: string }, message?: string }
  const statusCode = failure.statusCode ?? failure.status
  const message = failure.statusMessage || failure.data?.statusMessage || failure.data?.message || failure.message || fallback
  return statusCode ? `HTTP ${statusCode}：${message}` : message
}

function failureState(error: unknown, fallback: string) {
  const status = (error as { statusCode?: number, status?: number }).statusCode ?? (error as { status?: number }).status
  if (status === 401 || status === 403) state.value = 'signin'
  else { state.value = 'error'; errorMessage.value = requestFailureMessage(error, fallback) }
}

function formatDate(value: string | null) {
  return value ? new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'
}

function label(value: string | null | undefined, labels: Record<string, string>) {
  return value ? labels[value] || value.replaceAll('_', ' ') : '—'
}

function clearPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function beginPolling() {
  clearPolling()
  if (!isActive.value || !selectedScan.value) return
  pollTimer = setInterval(() => { if (selectedScan.value) void loadScan(selectedScan.value.id, false) }, 3_000)
}

async function loadUrls(offset = 0) {
  if (!selectedScan.value) return
  try {
    const page = await $fetch<UrlPage>(`/api/site-evidence/scans/${selectedScan.value.id}/urls`, { query: { limit: 50, offset } })
    urls.value = page
  } catch (error: unknown) {
    const status = (error as { statusCode?: number, status?: number }).statusCode ?? (error as { status?: number }).status
    if (status === 401 || status === 403) state.value = 'signin'
    else errorMessage.value = requestFailureMessage(error, '無法讀取網址清單。')
  }
}

async function loadScan(id: number, resetUrls = true) {
  loadingDetail.value = true
  try {
    const detail = await $fetch<ScanDetail>(`/api/site-evidence/scans/${id}`)
    selectedScan.value = detail.scan
    scans.value = [detail.scan, ...scans.value.filter(scan => scan.id !== detail.scan.id)]
    findings.value = detail.findings.items
    if (resetUrls || !isActive.value) await loadUrls(resetUrls ? 0 : urls.value.offset)
    beginPolling()
  } catch (error: unknown) { failureState(error, '目前無法讀取站台證據掃描。') } finally { loadingDetail.value = false }
}

async function loadScans() {
  state.value = 'loading'
  try {
    const result = await $fetch<{ scans: Scan[] }>('/api/site-evidence/scans')
    scans.value = result.scans
    state.value = 'ready'
    if (scans.value[0]) await loadScan(scans.value[0].id)
  } catch (error: unknown) { failureState(error, '目前無法讀取站台證據清單。') }
}

function signIn() {
  window.location.assign(`/api/auth/login?origin=${encodeURIComponent(window.location.origin)}`)
}

async function startScan() {
  if (hasActiveScan.value) return
  submitting.value = true; notice.value = ''; errorMessage.value = ''
  try {
    const scan = await $fetch<Scan>('/api/site-evidence/scans', { method: 'POST', body: { targetUrl: form.targetUrl, maxPages: Number(form.maxPages), idempotencyKey: crypto.randomUUID() } })
    scans.value = [scan, ...scans.value.filter(item => item.id !== scan.id)]
    notice.value = '掃描已排入背景執行；本頁只會顯示已實際取得的證據與限制。'
    await loadScan(scan.id)
  } catch (error: unknown) {
    const status = (error as { statusCode?: number, status?: number }).statusCode ?? (error as { status?: number }).status
    if (status === 401 || status === 403) state.value = 'signin'
    else errorMessage.value = requestFailureMessage(error, '無法建立站台證據掃描。')
  } finally { submitting.value = false }
}

onMounted(loadScans)
onUnmounted(clearPolling)
</script>

<template>
  <main class="evidence">
    <header class="hero"><NuxtLink to="/audit-lab" class="back">← 返回 Audit Lab</NuxtLink><p class="eyebrow">OWNER-ONLY · SITE EVIDENCE V1</p><h1>站台證據</h1><p>以 sitemap、公開頁面原始 HTML 與有限 rendered 快照建立可追溯的網址清單。robots.txt 只記錄為證據，<strong>不會阻擋</strong>這個有上限的 owner 診斷掃描。</p></header>

    <section v-if="state === 'loading'" class="state">正在讀取 owner-scoped 站台證據…</section>
    <section v-else-if="state === 'signin'" class="state"><h2>需要 owner 登入。</h2><p>掃描紀錄、網址庫與診斷快照只對私有工作台開放。</p><button type="button" @click="signIn">登入後台 ↗</button></section>
    <section v-else-if="state === 'error'" class="state state--error" role="alert"><h2>目前無法讀取站台證據。</h2><p>{{ errorMessage }}</p><button type="button" @click="loadScans">重新嘗試</button></section>

    <template v-else>
      <p v-if="notice" class="notice notice--ok" role="status">{{ notice }}</p><p v-if="errorMessage" class="notice notice--error" role="alert">{{ errorMessage }}</p>
      <section class="panel"><div class="section-heading"><div><p class="eyebrow">建立有上限的掃描</p><h2>建立站台掃描</h2></div><span>最多 200 頁 · 深度 3 · 無 cron</span></div><form class="form" @submit.prevent="startScan"><label>網址<input v-model="form.targetUrl" required type="url" maxlength="2048" placeholder="https://example.com/"></label><label>頁數上限<input v-model.number="form.maxPages" required type="number" min="1" max="200"></label><button type="submit" :disabled="submitting || hasActiveScan">{{ submitting ? '建立中…' : hasActiveScan ? '現有掃描處理中…' : '開始背景掃描' }}</button></form></section>

      <section class="panel"><div class="section-heading"><div><p class="eyebrow">掃描帳本</p><h2>過往掃描</h2></div><button type="button" @click="loadScans">重新整理</button></div><div class="table-wrap"><table><thead><tr><th>狀態</th><th>目標</th><th>建立時間</th><th>已抓取</th></tr></thead><tbody><tr v-for="scan in scans" :key="scan.id" class="clickable" :aria-current="selectedScan?.id === scan.id ? 'true' : undefined" @click="loadScan(scan.id)"><td><span class="badge" :class="`badge--${scan.status}`">{{ label(scan.status, statusLabels) }}</span></td><td>{{ scan.targetOrigin }}</td><td>{{ formatDate(scan.createdAt) }}</td><td>{{ scan.pagesFetched }} / {{ scan.maxPages }}</td></tr><tr v-if="!scans.length"><td colspan="4">尚無掃描紀錄。</td></tr></tbody></table></div></section>

      <section v-if="selectedScan" class="panel"><div class="section-heading"><div><p class="eyebrow">掃描 #{{ selectedScan.id }}</p><h2>{{ selectedScan.targetOrigin }}</h2></div><span class="badge" :class="`badge--${selectedScan.status}`">{{ label(selectedScan.status, statusLabels) }}</span></div><p v-if="loadingDetail" class="muted">正在更新掃描進度…</p><p v-if="isStale" class="notice notice--warning">此掃描的最後心跳已超過三分鐘；狀態讀取已誠實標示為 stale，未宣稱完成。</p><div class="progress"><div><span>已發現</span><strong>{{ selectedScan.pagesDiscovered }}</strong></div><div><span>已抓取</span><strong>{{ selectedScan.pagesFetched }} / {{ selectedScan.maxPages }}</strong></div><div><span>Rendered 快照</span><strong>{{ selectedScan.renderedCaptured }}</strong></div><div><span>最後心跳</span><strong>{{ formatDate(selectedScan.heartbeatAt) }}</strong></div></div><p v-if="selectedScan.errorCode" class="notice notice--error">錯誤代碼：<code>{{ selectedScan.errorCode }}</code></p><div v-if="selectedScan.limitations?.length" class="limitations"><h3>限制與未驗證範圍</h3><ul><li v-for="item in selectedScan.limitations" :key="item">{{ label(item, limitationLabels) }}</li></ul></div></section>

      <section v-if="selectedScan && !isActive" class="panel"><div class="section-heading"><div><p class="eyebrow">對帳發現</p><h2>診斷發現</h2></div><span>{{ findings.length }} 筆</span></div><div class="table-wrap"><table><thead><tr><th>嚴重度</th><th>發現</th><th>狀態</th><th>證據</th></tr></thead><tbody><tr v-for="finding in findings" :key="`${finding.category}:${finding.urlId}:${JSON.stringify(finding.evidence)}`"><td>{{ label(finding.severity, severityLabels) }}</td><td>{{ label(finding.category, findingLabels) }}</td><td><span :class="finding.status === 'unknown' ? 'unknown' : ''">{{ finding.status === 'unknown' ? '無法判定' : '已偵測' }}</span></td><td><code>{{ JSON.stringify(finding.evidence) }}</code></td></tr><tr v-if="!findings.length"><td colspan="4">尚無已完成的對帳發現。</td></tr></tbody></table></div></section>

      <section v-if="selectedScan && !isActive" class="panel"><div class="section-heading"><div><p class="eyebrow">網址庫</p><h2>網址清單</h2></div><span>{{ urls.total }} 筆</span></div><div class="table-wrap"><table><thead><tr><th>正規化網址</th><th>HTTP</th><th>robots</th><th>Canonical</th><th>重新導向</th><th>來源</th><th>錯誤</th></tr></thead><tbody><tr v-for="row in urls.items" :key="row.id"><td class="url">{{ row.normalizedUrl }}</td><td>{{ row.httpStatus ?? '—' }}</td><td>{{ label(row.robotsVerdict, robotsLabels) }}</td><td class="url">{{ row.canonicalUrl || '—' }}</td><td>{{ row.redirectChain?.length || 0 }}</td><td>{{ row.discoverySources.join('、') }}</td><td><code>{{ row.errorCode || '—' }}</code></td></tr><tr v-if="!urls.items.length"><td colspan="7">尚無可列出的網址；回應不包含任何快照本文。</td></tr></tbody></table></div><div class="pager"><button type="button" :disabled="!canPrevious" @click="loadUrls(Math.max(0, urls.offset - urls.limit))">上一頁</button><span>{{ urls.offset + 1 }}–{{ Math.min(urls.offset + urls.items.length, urls.total) }} / {{ urls.total }}</span><button type="button" :disabled="!canNext" @click="loadUrls(urls.offset + urls.limit)">下一頁</button></div></section>
    </template>
  </main>
</template>

<style scoped>
.evidence{max-width:1180px;margin:0 auto;padding:clamp(1.5rem,4vw,4rem) clamp(1rem,4vw,3rem) 5rem}.hero{padding-bottom:2rem;border-bottom:1px solid #cfd7e0}.back{color:#48627d;text-decoration:none;font-size:.82rem}.eyebrow{margin:1.5rem 0 .45rem;color:#61768c;font:800 .72rem/1.2 ui-monospace,monospace;letter-spacing:.13em}.hero h1,.section-heading h2{margin:0;font:800 clamp(2rem,5vw,4.2rem)/1 Georgia,serif;letter-spacing:-.045em}.hero p{max-width:52rem;color:#53677c;line-height:1.75}.panel,.state{margin-top:1.5rem;padding:clamp(1rem,3vw,2rem);border:1px solid #d7dfe7;border-radius:1rem;background:#fff}.state--error,.notice--error{background:#fff1ef;color:#862b26}.state button,.form button,.pager button,.section-heading button{border:0;border-radius:.5rem;padding:.72rem 1rem;background:#17253d;color:#fff;font:700 .85rem inherit}.section-heading{display:flex;justify-content:space-between;gap:1rem;align-items:end}.section-heading h2{font-size:clamp(1.45rem,3vw,2.25rem)}.section-heading>span{color:#66798d;font-size:.8rem}.form{display:grid;grid-template-columns:minmax(0,1fr) 10rem auto;gap:1rem;margin-top:1.25rem}.form label{display:grid;gap:.4rem;color:#40566e;font-size:.8rem;font-weight:800}.form input{width:100%;box-sizing:border-box;border:1px solid #bfcbd7;border-radius:.45rem;padding:.72rem;font:inherit}.form button:disabled,.pager button:disabled{opacity:.45;cursor:not-allowed}.notice{margin:1rem 0;padding:.9rem 1rem;border-left:4px solid}.notice--ok{border-color:#2f735a;background:#edf8f3;color:#205c45}.notice--error{border-color:#b53c35}.notice--warning{border-color:#9a6a19;background:#fff7e7;color:#714d0d}.table-wrap{overflow:auto;margin-top:1.2rem;border:1px solid #d9e0e7}table{width:100%;border-collapse:collapse;text-align:left;font-size:.82rem}th,td{padding:.75rem;border-top:1px solid #e1e7ec;vertical-align:top}thead th{background:#f0f4f7;color:#607386;font-size:.7rem;letter-spacing:.04em}.clickable{cursor:pointer}.clickable[aria-current=true]{background:#ebf2f9}.url,code{max-width:22rem;overflow-wrap:anywhere}code{font-size:.72rem}.badge{display:inline-block;padding:.32rem .55rem;border-radius:999px;background:#e8edf2;color:#405568;font-size:.72rem;font-weight:800}.badge--running,.badge--pending{background:#fff2d7;color:#76500c}.badge--completed{background:#e1f2e8;color:#236445}.badge--completed_partial{background:#e7edf7;color:#36577d}.badge--failed{background:#fce6e2;color:#96372d}.progress{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;margin:1.4rem 0}.progress div{display:grid;gap:.35rem;padding:.85rem;background:#f1f5f8;border-radius:.6rem}.progress span{color:#66798d;font-size:.72rem}.progress strong{font-size:1rem}.limitations{padding:1rem;border-left:4px solid #7890a8;background:#eef3f7}.limitations h3{margin:0}.limitations li{margin:.55rem 0}.unknown{color:#5c7082;font-style:italic}.muted{color:#65788b}.pager{display:flex;justify-content:flex-end;align-items:center;gap:1rem;margin-top:1rem;color:#607386;font-size:.8rem}@media(max-width:720px){.form,.progress{grid-template-columns:1fr}.section-heading{align-items:flex-start;flex-direction:column}.pager{justify-content:space-between}}
</style>
