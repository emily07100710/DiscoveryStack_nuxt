import { describe, expect, it, vi } from 'vitest'
import { createLearningCitationFallback, reviewLearningCitationFallback } from '../server/learning-loop/training'
import { createMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'

describe('owner closed-loop fallback input boundary', () => {
  it('rejects client-authored roles, approvals, weights and training config before repository access', async () => {
    const repository = createMemoryGeoOutcomeRepository(), read = vi.spyOn(repository, 'getDataset')
    for (const extra of [{ ownerApproved: true }, { fallbackOnly: true }, { productionActivation: true }, { coefficients: [0] }, { config: { epochs: 1 } }, { modelFamily: 'unverified-model' }]) {
      await expect(createLearningCitationFallback(1, { datasetManifestId: `geo-dataset-${'a'.repeat(20)}`, modelFamily: 'regularized_logistic_baseline_v1', ...extra }, repository)).rejects.toMatchObject({ statusCode: 422, data: { code: 'INVALID_FALLBACK_INPUT' } })
    }
    expect(read).not.toHaveBeenCalled()
    expect(repository.exportState().artifacts).toEqual([])
  })
  it('only accepts the server-derived reviewer and a bounded explicit review reason', async () => {
    const repository = createMemoryGeoOutcomeRepository(), read = vi.spyOn(repository, 'getArtifact')
    for (const extra of [{ ownerUserId: 2 }, { reviewerUserId: 2 }, { gatePassed: true }, { productionActivation: true }, { reason: 'short' }, { reason: 'x'.repeat(501) }]) {
      await expect(reviewLearningCitationFallback(1, { artifactId: `geo-model-${'a'.repeat(20)}`, reason: 'Independent owner evidence review.', ...extra }, repository)).rejects.toMatchObject({ statusCode: 422, data: { code: 'INVALID_FALLBACK_REVIEW' } })
    }
    expect(read).not.toHaveBeenCalled()
    expect(repository.exportState().decisions).toEqual([])
  })
})
