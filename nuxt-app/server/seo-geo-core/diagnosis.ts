import { createHash } from 'node:crypto'
import { createError } from 'h3'
import type { PublicSiteAnalysisResult } from '../utils/publicSiteAnalysis'
import { DIAGNOSIS_BASELINE_VERSION, type DiagnosisArea, type DiagnosisFinding, type DiagnosisPriority, type DiagnosisResult, type EvidenceRef } from './contracts'

const diagnosisCatalog: Record<string, { issueCode: string, area: DiagnosisArea, severity: 'critical' | 'high' | 'medium' | 'low', priority: DiagnosisPriority, title: string, explanation: string }> = {
  remove_noindex: { issueCode: 'technical.noindex', area: 'technical_seo', severity: 'high', priority: 'high', title: '確認公開頁面的索引設定', explanation: '結構檢查發現頁面可能帶有 noindex。請先由網站擁有者確認此頁是否應公開被搜尋引擎收錄。' },
  clarify_page_topic: { issueCode: 'content.topic_clarity', area: 'geo_structure', severity: 'high', priority: 'high', title: '明確化頁面主題與主要標題', explanation: '結構檢查缺少可辨識的 title 或 H1。請以具體問題、受眾與服務範圍定義一個可驗證的主題。' },
  add_primary_action: { issueCode: 'journey.primary_action', area: 'journey', severity: 'medium', priority: 'medium', title: '提供清楚的下一步行動', explanation: '頁面結構未辨識到主要 CTA。請設計與內容承諾一致、可由使用者自主選擇的下一步。' },
  improve_service_routing: { issueCode: 'journey.service_routing', area: 'journey', severity: 'medium', priority: 'medium', title: '補足服務與內容路徑', explanation: '頁面結構缺少服務導向訊號。請以可理解的內部連結和頁面層級說明相關服務或資源。' },
  add_canonical: { issueCode: 'technical.canonical', area: 'technical_seo', severity: 'medium', priority: 'medium', title: '設定 canonical', explanation: '結構檢查未辨識到 canonical。請由網站管理者確認正式網址與多語版本對應。' },
  add_structured_data: { issueCode: 'technical.structured_data', area: 'geo_structure', severity: 'medium', priority: 'medium', title: '評估適用的結構化資料', explanation: '頁面沒有可辨識的 schema。僅在頁面內容確實支持時，使用符合規範的結構化資料。' },
  add_trust_evidence: { issueCode: 'evidence.trust_readiness', area: 'trust_evidence', severity: 'high', priority: 'high', title: '補足可驗證的信任證據', explanation: '結構訊號不足以支持信任敘事。請提供可核對的來源、作者、方法或明確限制，不要捏造成效案例。' },
  add_answer_content: { issueCode: 'content.answer_readiness', area: 'answer_content', severity: 'medium', priority: 'medium', title: '加入可直接回答問題的內容', explanation: '頁面缺少 FAQ 或引導主題訊號。請先選擇真實使用者問題，再以來源支持的簡短回答與延伸內容回應。' },
  add_human_contact: { issueCode: 'journey.human_contact', area: 'journey', severity: 'low', priority: 'low', title: '說明何時可聯絡真人', explanation: '結構檢查未辨識到專家或聯絡路徑。請提供清楚的責任範圍與聯絡方式。' },
  review_deeper_pages: { issueCode: 'scope.deeper_pages', area: 'technical_seo', severity: 'low', priority: 'low', title: '延伸檢查深層頁面', explanation: '首頁的基礎結構訊號沒有明顯缺口；仍應以經授權的頁面清單逐頁檢查內容、內部連結與證據。' },
}

function buildEvidence(analysis: PublicSiteAnalysisResult, sourceId?: number): EvidenceRef[] {
  return [{
    sourceId,
    locator: analysis.finalUrl,
    artifactHash: analysis.snapshotFingerprint,
    reason: `結構分析 ${analysis.analysisVersion}，範圍僅限公開首頁`,
  }]
}

export function createDeterministicDiagnosis(analysis: PublicSiteAnalysisResult, sourceId?: number, approvedEvidence: EvidenceRef[] = []): DiagnosisResult {
  const evidence = [...buildEvidence(analysis, sourceId), ...approvedEvidence]
  const findings: DiagnosisFinding[] = analysis.recommendationKeys.map(key => {
    const item = diagnosisCatalog[key]
    if (!item) throw createError({ statusCode: 500, statusMessage: `Unknown deterministic diagnosis recommendation key: ${key}` })
    return {
      id: key,
      ...item,
      affectedUrls: [analysis.finalUrl],
      evidence,
      recommendationKey: key,
      engine: DIAGNOSIS_BASELINE_VERSION,
      limitations: ['此 finding 僅根據公開首頁的 deterministic structural signal，不代表完整網站診斷。', '此 finding 不代表搜尋排名、曝光、流量、轉換、營收或 ROI。'],
    }
  })
  const inputFingerprint = createHash('sha256').update(JSON.stringify({ analysis: analysis.snapshotFingerprint, keys: analysis.recommendationKeys })).digest('hex')
  return {
    engine: 'deterministic-diagnosis-v1',
    status: 'needs_human_review',
    inputFingerprint,
    findings,
    summary: `依 ${analysis.analysisVersion} 的公開首頁結構檢查，整理出 ${findings.length} 項待人工確認的改善方向。`,
    limitations: [
      '此結果僅根據單一公開首頁的結構訊號與允許範圍內的資料；不代表完整網站診斷。',
      '此結果不是 Google、ChatGPT 或其他平台的排名、曝光、流量、轉換、營收或 ROI 測量。',
      '未有已核准且可用的模型 artifact 時，不會將結果標示為模型預測。',
    ],
    measurementNotice: '任何成效衡量必須在發布後，以人工核准的資料來源、期間、基準與版本另行記錄。',
  }
}

export function createModelNotReadyDiagnosis(inputFingerprint: string): DiagnosisResult {
  return {
    engine: 'approved-model-not-ready',
    status: 'not_ready',
    inputFingerprint,
    findings: [],
    summary: '尚未有符合此用途且已核准可用的模型 artifact，因此沒有執行模型推論。',
    limitations: ['模型訓練紀錄、離線指標或 development run 不等於可供此產品路徑使用的 production model。'],
    measurementNotice: '未產出模型預測，亦不代表外部搜尋或商業成效。',
  }
}
