import { createHash } from 'node:crypto'
import { z } from 'zod'

const MAX_MESSAGE_LENGTH = 2_000

export const leadInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(320).transform(value => value.toLowerCase()),
  company: z.string().trim().min(2).max(160),
  website: z.string().trim().max(2048).optional().or(z.literal('')),
  packageInterest: z.enum(['discover', 'clarify', 'grow', 'unsure']),
  language: z.enum(['en', 'zh-hant']),
  message: z.string().trim().max(MAX_MESSAGE_LENGTH).optional().or(z.literal('')),
  privacyConsent: z.literal(true),
  recontactConsent: z.boolean().default(false),
  companyFax: z.string().max(200).optional().default(''),
})

export type LeadInput = z.infer<typeof leadInputSchema>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export function leadDedupeKey(input: Pick<LeadInput, 'email' | 'company'>) {
  return sha256(`${input.email.trim().toLowerCase()}\n${input.company.trim().toLowerCase()}`)
}
