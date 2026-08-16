import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const inferenceRoute = readFileSync(new URL('../server/api/intelligence/inferences.post.ts', import.meta.url), 'utf8')

describe('Legacy supervised training API contract', () => {
  it('requires an approved dataset manifest identifier before supervised training can be requested', () => {
    expect(inferenceRoute).toContain("action: z.literal('run_supervised_training')")
    expect(inferenceRoute).toContain('datasetBuildId: z.number().int().positive()')
  })

  it('forwards the selected dataset manifest identifier to the controlled training service', () => {
    expect(inferenceRoute).toContain('datasetBuildId: parsed.data.datasetBuildId')
    expect(inferenceRoute).not.toContain('runSupervisedTraining({ ownerUserId, mode: parsed.data.mode })')
  })
})
