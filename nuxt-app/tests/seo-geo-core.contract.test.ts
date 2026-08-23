import { describe, expect, it } from 'vitest'
import { createDeterministicDiagnosis, createModelNotReadyDiagnosis } from '../server/seo-geo-core/diagnosis'
import { canTransitionContentJob } from '../server/seo-geo-core/contracts'
import { evaluateContentRisk } from '../server/seo-geo-core/riskGate'
import type { PublicSiteAnalysisResult } from '../server/utils/publicSiteAnalysis'

const analysis: PublicSiteAnalysisResult = {
  requestedUrl: 'https://example.com/',
  finalUrl: 'https://example.com/',
  hostname: 'example.com',
  analysedAt: '2026-08-24T00:00:00.000Z',
  analysisVersion: 'public-homepage-structural-v2',
  snapshotFingerprint: 'fixture-snapshot-hash',
  scope: 'public_homepage_only',
  scores: { overall: 40, seo: 35, geo: 45, brandContent: 50, ux: 30 },
  checks: { hasH1: false },
  recommendationKeys: ['clarify_page_topic', 'add_answer_content'],
}

describe('SEO/GEO Core V1 contract', () => {
  it('creates a homepage-scoped deterministic diagnosis with provenance and no ranking claim', () => {
    const result = createDeterministicDiagnosis(analysis, 81, [{ sourceId: 81, artifactId: 901, locator: 'https://example.com/evidence', artifactHash: 'approved-artifact-hash', reason: 'approved for diagnosis' }])
    expect(result.engine).toBe('deterministic-diagnosis-v1')
    expect(result.status).toBe('needs_human_review')
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 81, locator: 'https://example.com/', artifactHash: 'fixture-snapshot-hash' }),
      expect.objectContaining({ sourceId: 81, artifactId: 901, artifactHash: 'approved-artifact-hash', reason: 'approved for diagnosis' }),
    ]))
    expect(result.limitations.join(' ')).toContain('不代表完整網站診斷')
    expect(result.limitations.join(' ')).toContain('排名、曝光、流量、轉換、營收或 ROI')
  })

  it('uses an explicit not-ready state rather than inventing a model prediction', () => {
    const result = createModelNotReadyDiagnosis('no-model-fixture')
    expect(result).toMatchObject({ engine: 'approved-model-not-ready', status: 'not_ready', findings: [] })
    expect(result.summary).toContain('尚未有')
    expect(result.measurementNotice).toContain('不代表外部搜尋')
  })

  it('blocks unsupported ranking and commercial-outcome language before any review or delivery', () => {
    const result = evaluateContentRisk({
      source: { title: '服務介紹', content: '我們提供服務內容與流程說明。', language: 'zh-hant' },
      candidateTitle: '服務說明',
      candidateBody: '保證排名第一，三個月帶來 200% 流量與營收成長。',
      evidenceCount: 1,
    })
    expect(result.status).toBe('blocked')
    expect(result.findings.some(finding => finding.severity === 'blocking')).toBe(true)
    expect(result.publicationNotice).toContain('人工 review')
    expect(result.publicationNotice).toContain('明確核准')
  })

  it('requires human review between candidate generation and approved delivery', () => {
    expect(canTransitionContentJob('queued', 'processing')).toBe(true)
    expect(canTransitionContentJob('processing', 'needs_human_review')).toBe(true)
    expect(canTransitionContentJob('needs_human_review', 'approved')).toBe(true)
    expect(canTransitionContentJob('candidate_ready', 'delivered')).toBe(false)
    expect(canTransitionContentJob('queued', 'delivered')).toBe(false)
    expect(canTransitionContentJob('approved', 'delivered')).toBe(true)
  })
})
