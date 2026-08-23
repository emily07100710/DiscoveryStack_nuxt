import type { GeoDocumentEvaluation, GeoDocumentInput, GeoMetric, GeoMetricId } from './contracts'

type EvaluationOptions = { sourceContent?: string }

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)))
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim()
const headings = (value: string) => (value.match(/^#{1,3}\s+.+$/gm) || []).length
const bullets = (value: string) => (value.match(/^[-*]\s+.+$/gm) || []).length
const evidenceMarkers = (value: string) => (value.match(/https?:\/\/|\[[0-9]+\]|來源|依據|研究|source|evidence|according to/gi) || []).length

function scoreMetric(id: GeoMetricId, score: number, explanation: string): GeoMetric {
  const labels: Record<GeoMetricId, string> = { answerability: '可回答性', structure: '語意結構', context: '主題語境', evidence: '證據訊號', scannability: '可掃讀性', sourcePreservation: '原文保留度' }
  return { id, label: labels[id], score: clamp(score), explanation }
}

function extractAnchorPhrases(value: string) {
  return Array.from(new Set((normalized(value).match(/[\p{L}\p{N}]{4,}/gu) || []).filter(token => !/^(this|that|with|from|以及|內容|本文|說明)$/.test(token.toLowerCase())))).slice(0, 12)
}

export function evaluateDocument(document: GeoDocumentInput, options: EvaluationOptions = {}): GeoDocumentEvaluation {
  const content = normalized(document.content)
  const title = normalized(document.title)
  const firstWindow = content.slice(0, 300)
  const sectionCount = headings(document.content)
  const bulletCount = bullets(document.content)
  const markers = evidenceMarkers(document.content)
  const titleTerms = extractAnchorPhrases(title)
  const matchingTitleTerms = titleTerms.filter(term => content.toLowerCase().includes(term.toLowerCase())).length
  const sourceAnchors = options.sourceContent ? extractAnchorPhrases(options.sourceContent) : []
  const preservedAnchors = sourceAnchors.filter(term => content.toLowerCase().includes(term.toLowerCase())).length
  const firstSentence = firstWindow.split(/[。！？.!?]/u)[0] || ''

  const metrics: GeoMetric[] = [
    scoreMetric('answerability', 25 + Math.min(45, firstSentence.length / 2) + (sectionCount > 0 ? 20 : 0), sectionCount > 0 ? '開頭具摘要與段落結構，可作為可比較的回答入口。' : '缺少明確摘要或段落入口。'),
    scoreMetric('structure', 15 + Math.min(60, sectionCount * 20) + Math.min(20, bulletCount * 4), `偵測到 ${sectionCount} 個標題與 ${bulletCount} 個條列項目。`),
    scoreMetric('context', 20 + Math.min(70, matchingTitleTerms * 25), matchingTitleTerms ? `標題關鍵詞有 ${matchingTitleTerms} 個出現在正文。` : '正文沒有清楚重述標題主題。'),
    scoreMetric('evidence', Math.min(100, markers * 25), markers ? `偵測到 ${markers} 個來源或證據訊號。` : '未偵測到可驗證來源訊號；格式優化不能取代證據。'),
    scoreMetric('scannability', 20 + Math.min(50, sectionCount * 15) + Math.min(30, bulletCount * 5), '以標題與條列估算可掃讀性；這不是閱讀理解品質測量。'),
    scoreMetric('sourcePreservation', options.sourceContent ? (sourceAnchors.length ? (preservedAnchors / sourceAnchors.length) * 100 : 100) : 100, options.sourceContent ? `保留 ${preservedAnchors}/${sourceAnchors.length || 0} 個原文錨點詞。` : 'Baseline 不適用原文保留度比較。'),
  ]

  return { totalScore: clamp(metrics.reduce((total, metric) => total + metric.score, 0) / metrics.length), metrics, method: 'deterministic-heuristic-v1', limitations: ['分數只反映已記錄的 heuristic，並非生成式搜尋曝光、排名、流量或轉換成效。', '來源與事實仍需由內容擁有者人工查證。'] }
}
