import { z } from 'zod'
import { visibilityProviderTargetSchema } from './contracts'

export const benchmarkCreateInputSchema = z.object({
  projectId: z.number().int().positive(),
  queryIds: z.array(z.number().int().positive()).min(1).max(100).refine(values => new Set(values).size === values.length, 'queryIds 不可重複。'),
  providerTargets: z.array(visibilityProviderTargetSchema).min(1).max(12).refine(
    targets => new Set(targets.map(target => `${target.provider}|${target.modelLabel}`)).size === targets.length,
    'providerTargets 的 provider 與 modelLabel 組合不可重複。',
  ),
  sampleSize: z.number().int().min(1).max(10).default(5),
  label: z.string().trim().min(1).max(160).optional(),
}).strict()

export type BenchmarkCreateInput = z.infer<typeof benchmarkCreateInputSchema>
