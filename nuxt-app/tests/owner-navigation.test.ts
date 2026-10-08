import { describe, expect, it } from 'vitest'
import { OWNER_NAVIGATION_GROUPS, resolveOwnerNavigation } from '../utils/owner-navigation'

describe('owner navigation data and route resolution', () => {
  it('preserves every existing destination and includes the missing daily destinations', () => {
    const destinations = OWNER_NAVIGATION_GROUPS.flatMap(group => group.items.map(item => item.to))
    expect(destinations).toEqual(expect.arrayContaining([
      '/leads',
      '/audit-lab/content-operations',
      '/audit-lab/content-operations/strategy',
      '/audit-lab/weekly-content',
      '/audit-lab/measurement-operations',
      '/audit-lab/interventions',
      '/audit-lab/llm-visibility',
      '/audit-lab/knowledge',
      '/audit-lab/site-evidence',
      '/audit-lab/email-delivery',
      '/audit-lab/geo',
      '/audit-lab/seo-geo',
      '/audit-lab/geo-outcome-model',
      '/audit-lab/learning-loop',
      '/audit-lab/managed-sites',
      '/audit-lab/system-factory',
      '/training-pipeline',
      '/ml-lab-preview',
    ]))
    expect(OWNER_NAVIGATION_GROUPS.find(group => group.advanced)?.items.map(item => item.to)).toEqual([
      '/audit-lab/geo',
      '/audit-lab/seo-geo',
      '/audit-lab/geo-outcome-model',
      '/audit-lab/learning-loop',
      '/audit-lab/managed-sites',
      '/audit-lab/system-factory',
      '/training-pipeline',
      '/ml-lab-preview',
    ])
    expect(destinations).toHaveLength(new Set(destinations).size)
    for (const group of OWNER_NAVIGATION_GROUPS) {
      expect(group).toEqual(expect.objectContaining({ id: expect.any(String), label: expect.any(String), advanced: expect.any(Boolean) }))
      for (const item of group.items) expect(item).toEqual(expect.objectContaining({ id: expect.any(String), label: expect.any(String), description: expect.any(String), to: expect.any(String) }))
    }
  })

  it('selects the longest matching destination at a segment boundary', () => {
    const strategy = resolveOwnerNavigation('/audit-lab/content-operations/strategy/draft/42?view=latest')
    expect(strategy.activeItem?.to).toBe('/audit-lab/content-operations/strategy')
    expect(strategy.activeGroup?.id).toBe('customers-content')

    const content = resolveOwnerNavigation('/audit-lab/content-operations/jobs/42')
    expect(content.activeItem?.to).toBe('/audit-lab/content-operations')
  })

  it('matches the overview only at its exact route and leaves unknown routes inactive', () => {
    expect(resolveOwnerNavigation('/audit-lab')).toEqual({
      activeItem: expect.objectContaining({ id: 'overview', to: '/audit-lab' }),
      activeGroup: null,
    })
    expect(resolveOwnerNavigation('/audit-lab/geo-preview')).toEqual({ activeItem: null, activeGroup: null })
    expect(resolveOwnerNavigation('/audit-lab/unmapped')).toEqual({ activeItem: null, activeGroup: null })
    expect(resolveOwnerNavigation('/unknown')).toEqual({ activeItem: null, activeGroup: null })
  })

  it('resolves exact destinations and ignores a trailing slash', () => {
    const knowledge = resolveOwnerNavigation('/audit-lab/knowledge/')
    expect(knowledge.activeItem?.id).toBe('knowledge')
    expect(knowledge.activeGroup?.id).toBe('knowledge-data')
    expect(resolveOwnerNavigation('/leads').activeItem?.to).toBe('/leads')
  })

  it('uses labels that describe the customer-facing work accurately', () => {
    const items = OWNER_NAVIGATION_GROUPS.flatMap(group => group.items)
    expect(items.find(item => item.id === 'weekly-content')).toMatchObject({ label: '文章送審與 LINE', description: expect.stringContaining('LINE') })
    expect(items.find(item => item.id === 'geo-outcome-model')).toMatchObject({ label: 'AI 引用模型' })
    expect(items.find(item => item.id === 'learning-loop')).toMatchObject({ label: '資料授權與模型學習', description: expect.stringContaining('授權') })
  })
})
