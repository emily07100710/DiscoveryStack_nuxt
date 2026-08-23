import { describe, expect, it } from 'vitest'
import { deriveProductionPlanStatus } from '../server/seo-geo-core/repository'

describe('Production Plan status aggregation', () => {
  it('keeps generating while foreground generation is active', () => {
    expect(deriveProductionPlanStatus(['planned'], 'generating')).toBe('generating')
  })

  it('keeps a plan in progress while deliverables await review or are partially blocked', () => {
    expect(deriveProductionPlanStatus(['needs_human_review'])).toBe('in_progress')
    expect(deriveProductionPlanStatus(['blocked', 'needs_human_review'])).toBe('in_progress')
    expect(deriveProductionPlanStatus(['planned', 'blocked'])).toBe('in_progress')
  })

  it('completes only when every deliverable is approved or exported', () => {
    expect(deriveProductionPlanStatus(['approved', 'exported'])).toBe('completed')
  })

  it('marks a plan blocked only when every deliverable is blocked', () => {
    expect(deriveProductionPlanStatus(['blocked', 'blocked'])).toBe('blocked')
    expect(deriveProductionPlanStatus([])).toBe('ready')
  })
})
