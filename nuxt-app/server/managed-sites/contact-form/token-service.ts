import { createHash, createHmac } from 'node:crypto'
import { createError } from 'h3'
import type { ManagedSiteRepository } from '../types'
import { getManagedSiteRepository } from '../repository'
import { normalizePublicSiteOrigin } from '../../utils/publicCors'

const TOKEN_CONTEXT = 'managed-site-contact-form'

export type ManagedSiteContactFormTokenProjection = {
  token: string | null
  tokenHash: string | null
  endpoint: string | null
}

export function managedSiteFormIngestOrigin(): string {
  return normalizePublicSiteOrigin(process.env.DISCOVERYSTACK_MANAGED_SITE_FORM_INGEST_ORIGIN, process.env.NODE_ENV || 'production')
}

export function deriveManagedSiteContactFormToken(projectId: number, tokenVersion: number, pepper = process.env.NUXT_MANAGED_SITE_FORM_TOKEN_PEPPER || ''): string | null {
  if (!pepper) return null
  if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(tokenVersion) || tokenVersion < 1) {
    throw createError({ statusCode: 422, statusMessage: 'Managed-site contact form token identity is invalid.' })
  }
  return createHmac('sha256', pepper).update(`${TOKEN_CONTEXT}:${projectId}:${tokenVersion}`).digest('hex')
}

export function resolveManagedSiteContactFormToken(projectId: number, tokenVersion: number): ManagedSiteContactFormTokenProjection {
  const token = deriveManagedSiteContactFormToken(projectId, tokenVersion)
  const tokenHash = token ? createHash('sha256').update(token).digest('hex') : null
  const origin = managedSiteFormIngestOrigin()
  return { token, tokenHash, endpoint: token && origin ? `${origin}/api/managed-sites/site-forms/${token}/submit` : null }
}

/** Rotation invalidates the previous public identifier immediately; no owner UI is exposed in F2b. */
export async function rotateManagedSiteContactFormToken(
  ownerUserId: number,
  projectId: number,
  repository: ManagedSiteRepository = getManagedSiteRepository(),
) {
  const project = await repository.findProject(ownerUserId, projectId)
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Managed site project was not found.' })
  const nextVersion = project.contactFormTokenVersion + 1
  const token = deriveManagedSiteContactFormToken(project.id, nextVersion)
  if (!token) throw createError({ statusCode: 503, statusMessage: 'Managed-site contact form token derivation is not configured.' })
  const contactFormTokenHash = createHash('sha256').update(token).digest('hex')
  const updated = await repository.updateProject(ownerUserId, projectId, { contactFormTokenVersion: nextVersion, contactFormTokenHash })
  if (!updated) throw createError({ statusCode: 409, statusMessage: 'Managed-site contact form token rotation could not be persisted.' })
  return { projectId, tokenVersion: nextVersion, contactFormTokenHash }
}
