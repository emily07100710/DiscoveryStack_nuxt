import { createError } from 'h3'

export type ManagedSiteQuoteLineBilling = 'one_time' | 'monthly' | 'annual'

export function managedSiteQuoteLineBilling(lineKey: string): ManagedSiteQuoteLineBilling {
  if (/^monthly-(?:plan|module)-[a-z0-9_]+$/u.test(lineKey)) return 'monthly'
  if (/^domain-[a-z0-9-]+-year1$/u.test(lineKey)) return 'annual'
  if (/^(?:build|design)-[a-z0-9_]+$/u.test(lineKey) || /^module-[a-z0-9_]+-(?:intent|setup)$/u.test(lineKey) || lineKey === 'domain-assisted-setup') return 'one_time'
  throw createError({ statusCode: 422, statusMessage: 'Managed-site quote line billing classification is unknown.' })
}
