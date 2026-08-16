import { createHash } from 'node:crypto'
import { z } from 'zod'

export const permittedObservationKeys = [
  'seo.title_present', 'content.h1_present', 'content.service_language', 'content.faq_present',
  'journey.contact_route', 'journey.booking_route', 'journey.cta_present',
] as const

export const manualObservationSchema = z.object({
  key: z.enum(permittedObservationKeys),
  value: z.boolean(),
  evidenceNote: z.string().trim().max(360).optional().default(''),
})

export const manualAuditInput = z.object({
  workspaceId: z.number().int().positive(),
  targetUrl: z.string().trim().min(8).max(2048),
  authorizationConfirmed: z.literal(true),
  observations: z.array(manualObservationSchema).min(1).max(permittedObservationKeys.length),
}).superRefine((input, ctx) => {
  const unique = new Set(input.observations.map(item => item.key))
  if (unique.size !== input.observations.length) ctx.addIssue({ code: 'custom', message: 'Each structural signal can be recorded only once.' })
})

export const manualContentHash = (observations: Array<{ key: string, value: boolean }>) => createHash('sha256').update(JSON.stringify([...observations].sort((left, right) => left.key.localeCompare(right.key)))).digest('hex')
