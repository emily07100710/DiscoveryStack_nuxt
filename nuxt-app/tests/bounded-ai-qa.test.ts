import { describe, expect, it } from 'vitest'
import { answerBoundedQa, humanHandoff } from '../utils/boundedAiQa'

describe('bounded public AI QA', () => {
  it('returns approved Audit and SEO/GEO answers without ranking guarantees', () => {
    const audit = answerBoundedQa('What does an audit review?', 'en')
    const seo = answerBoundedQa('你們能協助 SEO／GEO 嗎？', 'zh-hant')
    expect(audit).toMatchObject({ topic: 'audit', isFallback: false })
    expect(seo).toMatchObject({ topic: 'seo_geo', isFallback: false })
    expect(seo.answer).toContain('不是排名保證')
  })

  it('hands off unrelated legal or account-specific requests without fabricating an answer', () => {
    const result = answerBoundedQa('Can you give legal advice about my contract?', 'en')
    expect(result).toEqual({ topic: 'handoff', isFallback: true, answer: humanHandoff.en })
  })

  it('keeps the Traditional Chinese handoff explicit', () => {
    const result = answerBoundedQa('明天天氣如何？', 'zh-hant')
    expect(result.isFallback).toBe(true)
    expect(result.answer).toContain('策略師')
    expect(result.answer).toContain('一起釐清')
  })
})
