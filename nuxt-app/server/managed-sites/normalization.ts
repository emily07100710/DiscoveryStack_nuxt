import { createError } from 'h3'
import { z } from 'zod'
import { stableFingerprint } from '../seo-geo-core/repository'
import { MANAGED_SITE_ROLES, MANAGED_SITE_TYPES, type ManagedSiteMemberInput, type ManagedSiteProjectInput, type ManagedSiteRoleUpdate } from './types'

const idempotencyKey = z.string().trim().min(8).max(128)
const email = z.string().trim().toLowerCase().email().max(320)
const identity = z.string().trim().min(1).max(2048)

const projectSchema = z.object({
  canonicalClientIdentity: z.string().trim().min(1).max(160),
  canonicalWebsiteIdentity: identity,
  siteType: z.enum(MANAGED_SITE_TYPES),
  idempotencyKey,
}).strict()

const memberSchema = z.object({
  email,
  role: z.enum(['administrator', 'editor', 'reviewer', 'analyst']),
  idempotencyKey,
}).strict()

const roleUpdateSchema = z.object({
  role: z.enum(['administrator', 'editor', 'reviewer', 'analyst']),
  idempotencyKey,
}).strict()

function parse<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw createError({ statusCode: 422, statusMessage: `${label} is invalid.` })
  return result.data
}

export function parseManagedSiteProjectInput(input: unknown): ManagedSiteProjectInput {
  const parsed = parse(projectSchema, input, 'Managed site project')
  return {
    canonicalClientIdentity: parsed.canonicalClientIdentity,
    canonicalWebsiteIdentity: parsed.canonicalWebsiteIdentity,
    siteType: parsed.siteType,
    idempotencyKey: parsed.idempotencyKey,
  }
}

export function parseManagedSiteMemberInput(input: unknown): ManagedSiteMemberInput {
  return parse(memberSchema, input, 'Managed site membership')
}

export function parseManagedSiteRoleUpdate(input: unknown): ManagedSiteRoleUpdate {
  return parse(roleUpdateSchema, input, 'Managed site role update')
}

export function normalizeRecipientEmail(value: string): string {
  const result = email.safeParse(value)
  if (!result.success) throw createError({ statusCode: 422, statusMessage: 'Invitation recipient email is invalid.' })
  return result.data
}

export function projectFingerprint(ownerUserId: number, input: ManagedSiteProjectInput): string {
  return stableFingerprint({
    ownerUserId,
    canonicalClientIdentity: input.canonicalClientIdentity,
    canonicalWebsiteIdentity: input.canonicalWebsiteIdentity,
    siteType: input.siteType,
    catalogVersion: 'managed-site-catalog-v1',
  })
}

export function versionFingerprint(projectId: number, version: number, snapshot: unknown): string {
  return stableFingerprint({ projectId, version, snapshot })
}

export function eventFingerprint(ownerUserId: number, projectId: number, action: string, idempotencyKey: string, beforeFingerprint: string | null, afterFingerprint: string | null): string {
  return stableFingerprint({ ownerUserId, projectId, action, idempotencyKey, beforeFingerprint, afterFingerprint })
}

export function tokenHash(token: string): string {
  return stableFingerprint({ token: token.trim() })
}

export function assertPositiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw createError({ statusCode: 422, statusMessage: `${label} is invalid.` })
  return value
}

export function parsePathId(value: string | undefined, label: string): number {
  const parsed = Number(value)
  return assertPositiveId(parsed, label)
}

export function assertKnownRole(value: unknown): asserts value is typeof MANAGED_SITE_ROLES[number] {
  if (typeof value !== 'string' || !(MANAGED_SITE_ROLES as readonly string[]).includes(value)) throw createError({ statusCode: 422, statusMessage: 'Managed site role is invalid.' })
}
