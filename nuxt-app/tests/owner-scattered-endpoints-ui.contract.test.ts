import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const seoGeo = readFileSync(new URL('../pages/audit-lab/seo-geo.vue', import.meta.url), 'utf8')
const llmVisibility = readFileSync(new URL('../pages/audit-lab/llm-visibility.vue', import.meta.url), 'utf8')
const knowledge = readFileSync(new URL('../pages/audit-lab/knowledge.vue', import.meta.url), 'utf8')
const trainingPipeline = readFileSync(new URL('../pages/training-pipeline.vue', import.meta.url), 'utf8')
const auditLab = readFileSync(new URL('../pages/audit-lab.vue', import.meta.url), 'utf8')

const scopedPages = [
  'pages/audit-lab/seo-geo.vue',
  'pages/audit-lab/llm-visibility.vue',
  'pages/audit-lab/knowledge.vue',
  'pages/training-pipeline.vue',
  'pages/audit-lab.vue',
]
const allowedNewApiLiterals = new Set([
  '/api/seo-geo/strategies',
  '/api/llm-visibility/observations/${row.id}/review',
  '/api/llm-visibility/provider-observations',
  '/api/intelligence/training-snapshot',
  '/api/intelligence/colab-training-results',
  '/api/audit/runs',
  '/api/knowledge/merge-events',
])

function assertCommonOwnerContract(page: string) {
  expect(page).toContain("layout: 'owner'")
  // knowledge.vue pins the unspaced form in tests/knowledge-routes.contract.test.ts; both spellings are valid robots directives.
  expect(page).toMatch(/content: 'noindex, ?nofollow, ?noarchive'/u)
  expect(page).not.toContain('v-html')
  expect(page).not.toContain("credentials: 'include'")
  expect(page).not.toContain("from '../../server/")
  expect(page).not.toContain('TODO')
}

describe('owner scattered endpoint UI contract', () => {
  it('keeps the established owner-page metadata and safety boundaries', () => {
    for (const page of [seoGeo, llmVisibility, knowledge, trainingPipeline, auditLab]) assertCommonOwnerContract(page)
  })

  it('wires the SEO/GEO strategy list, creation flow, filtering, detail, and paging', () => {
    expect(seoGeo).toContain("'/api/seo-geo/strategies'")
    expect(seoGeo).toContain('OwnerAsyncState')
    expect(seoGeo).toContain('OwnerPager')
    expect(seoGeo).toContain('strategyStatusFilter')
    expect(seoGeo).toContain('filteredStrategyRows')
    expect(seoGeo).toContain('selectedStrategy')
    expect(seoGeo).toContain('Strategy recommendations')
    expect(seoGeo).toContain('三步把公開訊號變成可治理的內容計畫')
  })

  it('wires provider observation and only permits legal manual review transitions', () => {
    expect(llmVisibility).toContain('`/api/llm-visibility/observations/${row.id}/review`')
    expect(llmVisibility).toContain("'/api/llm-visibility/provider-observations'")
    expect(llmVisibility).toContain('OwnerAsyncState')
    expect(llmVisibility).toContain('OwnerPager')
    expect(llmVisibility).toContain('observationModeFilter')
    expect(llmVisibility).toContain("row.observationMode === 'manual_verified'")
    expect(llmVisibility).toContain("row.reviewStatus === 'approved'")
    expect(llmVisibility).toContain('secondary-only evidence')
    expect(llmVisibility).toContain('consumer-surface truth')
    expect(llmVisibility).toContain('LLM Visibility Monitor')
  })

  it('drives the review table from the workspace ledger, which is the only source carrying reviewStatus', () => {
    expect(llmVisibility).toContain('const projectObservations = computed(() => workspace.value.recentObservations.filter(row => selectedProjectId.value !== null && row.projectId === selectedProjectId.value))')
    expect(llmVisibility).toContain('observationModes = computed(() => [...new Set(projectObservations.value')
    expect(llmVisibility).toContain('filteredObservationRows = computed(() => projectObservations.value')
    expect(llmVisibility).not.toContain('summary.value?.recentObservations')
    expect(llmVisibility).toContain('observationLedgerLimitation')
    expect(llmVisibility).toContain('跨專案最近 50 筆，含 pending／approved／revoked 審核狀態')
    // buildSummaryProjection uses currentStart = now - 30 days and keeps only manual_verified rows;
    // the repository fetches 60 days in total, and the older 30 exist only for the previous-period comparison.
    expect(llmVisibility).toContain('最近 30 天、已核准且 observationMode 為 manual_verified 的 observation')
    expect(llmVisibility).toContain('server 總共取最近 60 天的資料，其中較早的 30 天只用來算往前一期的對照值')
    expect(llmVisibility).not.toContain('60 天內已核准的 observation')
    expect(llmVisibility).not.toContain('另外多取 60 天')
    expect(llmVisibility).toContain(':total="filteredObservationRows.length" :disabled="saving" @update:page="observationPageChanged" /></OwnerAsyncState>')
    expect(llmVisibility).toContain('empty-label="尚無符合條件的 observation。" @retry="refresh"')
    // The ledger envelope reflects its own source (the workspace fetch), never an unrelated write failure.
    expect(llmVisibility).toContain('<OwnerAsyncState :loading="pending" :error="observationLedgerError" :empty="filteredObservationRows.length === 0"')
    expect(llmVisibility).toContain('const observationLedgerError = computed(() => workspaceError.value ?')
  })

  it('puts the terminal observation revoke behind a typed-name confirmation that says it cannot be undone', () => {
    // llm-visibility/repository.ts answers 409 once a review is revoked, and metrics count only approved, non-revoked rows.
    expect(llmVisibility).toContain('@click="beginObservationRevoke(row)">撤銷 observation（無法恢復）</button>')
    expect(llmVisibility).not.toContain(`@click="reviewObservation(row, 'revoke')"`)
    expect(llmVisibility).toContain('OwnerConfirmAction')
    expect(llmVisibility).toContain(":target=\"revokeObservationRow ? `observation #${revokeObservationRow.id}` : ''\"")
    expect(llmVisibility).toContain('<td><small>observation #{{ row.id }}</small>')
    expect(llmVisibility).toContain('consequence="撤銷後是終止狀態，無法恢復：這筆 observation 之後不能再核准，也不會再計入這個頁面的可追溯 observation 指標。"')
    expect(llmVisibility).toContain('@confirm="confirmObservationRevoke" @cancel="closeObservationRevoke"')
  })

  it('says a provider observation is a real billed call gated only by that provider API key', () => {
    // server-adapters.ts only checks OPENAI/GEMINI/PERPLEXITY_API_KEY; there is no feature flag or capability gate.
    expect(llmVisibility).toContain('<p class="limitation">{{ providerCallLimitation }}</p>')
    for (const text of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY', '沒有 feature flag 或其他開關', '真實、會計費的 API 呼叫', '用同一個 window key 重送也會再呼叫一次', '整批會被拒絕，一次都不會呼叫', 'CREDENTIAL_NOT_CONFIGURED', '缺少該 provider 的 API 金鑰時不會對外呼叫（沒有另外的 feature flag 開關）。']) expect(llmVisibility).toContain(text)
    for (const removed of ['若 capability、feature flag 或 credential 不可用，server 會 fail-closed', '未接真實對端或 capability 不可用時不會假裝完成', '依 server capability fail-closed', '缺少明確 feature flag 或 credential 時會 fail-closed']) expect(llmVisibility).not.toContain(removed)
  })

  it('wires paged, filtered knowledge merge-event history without gutting knowledge tabs', () => {
    expect(knowledge).toContain("'/api/knowledge/merge-events'")
    expect(knowledge).toContain('OwnerAsyncState')
    expect(knowledge).toContain('OwnerPager')
    expect(knowledge).toContain('mergeEventFilter')
    expect(knowledge).toContain('selectedMergeEvent')
    expect(knowledge).toContain("activeTab === '合併待審'")
    expect(knowledge).toContain('可追溯的')
  })

  it('wires the Colab snapshot and result receipt with explicit local-only boundaries', () => {
    expect(trainingPipeline).toContain("'/api/intelligence/training-snapshot'")
    expect(trainingPipeline).toContain("'/api/intelligence/colab-training-results'")
    expect(trainingPipeline).toContain('OwnerAsyncState')
    expect(trainingPipeline).toContain('OwnerPager')
    expect(trainingPipeline).toContain('snapshotSplitFilter')
    expect(trainingPipeline).toContain('owner-controlled Google Colab')
    expect(trainingPipeline).toContain('未接真實對端')
    expect(trainingPipeline).toContain('每天自動整理')
    expect(trainingPipeline).toContain("const colabError = ref('')")
    expect(trainingPipeline).toContain("colabError.value = ''; notice.value = ''")
    expect(trainingPipeline).toContain('<p v-if="colabError" class="error" role="alert">{{ colabError }}</p>')
    expect(trainingPipeline).not.toContain('snapshotError.value = error?.data?.message || error?.statusMessage || error?.message')
  })

  it('reads the NDJSON training snapshot as text, including its error body', () => {
    // The handler answers application/x-ndjson, which ofetch would otherwise hand back as a Blob.
    expect(trainingPipeline).toContain("{ query: { datasetBuildId: snapshotDatasetBuildId.value }, responseType: 'text' }")
    expect(trainingPipeline).toContain("if (typeof error?.data === 'string')")
    expect(trainingPipeline).toContain("snapshotError.value = textResponseErrorMessage(error, '訓練快照目前無法載入。')")
  })

  it('sends only the Colab base model and smoke test the owner entered, and blocks submission until they qualify', () => {
    // colab-training-results only accepts that base model and a passed 5-example smoke test over all
    // nine task heads, so the page must not attest to any of it on the owner's behalf.
    expect(trainingPipeline).toContain("baseModelId: '', modelVersion: ''")
    expect(trainingPipeline).toContain("smokeExampleCount: '' as number | '', smokeResult: '' as '' | 'passed' | 'failed', smokeTaskHeads: [] as string[]")
    expect(trainingPipeline).toContain('baseModelId: colabForm.baseModelId')
    expect(trainingPipeline).toContain("smokeTest: { nonTrainingExampleCount: colabForm.smokeExampleCount, passed: colabForm.smokeResult === 'passed', taskHeads: taskHeads.filter(head => colabForm.smokeTaskHeads.includes(head)) }")
    expect(trainingPipeline).not.toContain("baseModelId: 'distilbert-base-multilingual-cased'")
    expect(trainingPipeline).not.toContain('passed: true')
    expect(trainingPipeline).not.toContain('nonTrainingExampleCount: 5')
    expect(trainingPipeline).not.toContain('<input value="distilbert-base-multilingual-cased" readonly>')
    expect(trainingPipeline).toContain('<input v-model.trim="colabForm.baseModelId" required')
    expect(trainingPipeline).toContain('<input v-model.number="colabForm.smokeExampleCount" type="number"')
    expect(trainingPipeline).toContain('<select v-model="colabForm.smokeResult" required><option value="" disabled>請選擇</option>')
    expect(trainingPipeline).toContain('<input v-model="colabForm.smokeTaskHeads" type="checkbox" :value="head">')
    expect(trainingPipeline).toContain('const colabBlockers = computed(() => {')
    expect(trainingPipeline).toContain('if (colabBlockers.value.length) { colabError.value = `尚未符合提交條件：${colabBlockers.value.join(\' \')}`; return }')
    expect(trainingPipeline).toContain(':disabled="colabSubmitting || colabBlockers.length > 0"')
    expect(trainingPipeline).toContain('<li v-for="blocker in colabBlockers" :key="blocker">{{ blocker }}</li>')
  })

  it('describes the Colab receipt as one local development run, never an audit-trail entry', () => {
    // registerGoogleColabLocalRun inserts a single development training run with productionGate.passed = false and writes no audit event.
    expect(trainingPipeline).not.toContain('稽核軌跡')
    expect(trainingPipeline).not.toContain('固定使用 distilbert-base-multilingual-cased')
    expect(trainingPipeline).toContain('提交成功只會在本地新增一筆 development 訓練紀錄（production gate 標記為未通過）')
    expect(trainingPipeline).toContain('server 不會回頭檢查 Colab 或 checkpoint 檔案本身')
    expect(trainingPipeline).toContain('未接真實對端，不會真的開通')
  })

  it('guards the audit-run record and preserves nested-route rendering', () => {
    expect(auditLab).toContain("'/api/audit/runs'")
    expect(auditLab).toContain('OwnerConfirmAction')
    expect(auditLab).toContain(':target="auditRunTarget"')
    expect(auditLab).toContain('authorizationConfirmed: true')
    expect(auditLab).toContain('<NuxtPage')
    expect(auditLab).toContain('isNestedAuditRoute')
    expect(auditLab).toContain('私有／旅程洞察')
    expect(auditLab).toContain('登錄稽核工作')
  })

  it('never claims the queued audit record starts real work, and marks the action as simulated', () => {
    expect(auditLab).not.toContain('開始後會建立真正的稽核工作')
    expect(auditLab).not.toContain('開始稽核')
    expect(auditLab).toContain('此動作只會在資料庫寫入一筆狀態為 queued 的稽核紀錄')
    expect(auditLab).toContain('目前沒有排程或 worker 會消費這個佇列')
    expect(auditLab).toContain('已建立一筆 queued 稽核紀錄。目前沒有任何 worker 會消費這個佇列')
    expect(auditLab).toContain('並理解此動作只會記錄一筆待處理的稽核意圖。')
    expect(auditLab).toContain('這條佇列目前沒有消費者，紀錄會停在 queued，不會自行對外連線。')
    expect(auditLab).toContain(':simulated="true" @confirm="startAuditRun"')
  })

  it('introduces no runtime API destination beyond the baseline and assigned endpoints', () => {
    const literals = (source: string): string[] => {
      const script = /<script[^>]*>([\s\S]*?)<\/script>/u.exec(source)?.[1] || ''
      const ast = ts.createSourceFile('owner-page.ts', script, ts.ScriptTarget.Latest, true)
      const values: string[] = []
      const visit = (node: ts.Node) => {
        // Request type arguments cannot perform a network call. Keep runtime strings exact.
        if (ts.isTypeNode(node)) return
        if (ts.isStringLiteralLike(node) && node.text.includes('/api/')) values.push(node.text)
        if (ts.isTemplateExpression(node) && node.getText(ast).includes('/api/')) values.push(node.getText(ast).slice(1, -1))
        ts.forEachChild(node, visit)
      }
      visit(ast)
      return values
    }
    for (const page of scopedPages) {
      const baseline = execFileSync('git', ['show', `a786d76:./${page}`], { encoding: 'utf8' })
      const existing = new Set(literals(baseline))
      const current = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8')
      for (const literal of literals(current)) expect(existing.has(literal) || allowedNewApiLiterals.has(literal), `unexpected introduced runtime API literal in ${page}: ${literal}`).toBe(true)
    }
  })
})
