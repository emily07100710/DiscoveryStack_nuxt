import { assertSameOriginMutation, privateSystemFactoryHeaders, strictSystemFactoryBody } from '../../../system-factory/http'
import { getDatabase } from '../../../database'
import { setManagedSiteSessionCookie } from '../../../managed-sites/auth'
import { createTenantAppAdapter, type TenantAppPort } from '../../../system-factory/frappe-adapter'
import { activateSystemInvitation, type InvitationActivationRepositoryPort } from '../../../system-factory/invitation-activation'
import { DrizzleInvitationActivationRepository } from '../../../system-factory/invitation-repository-drizzle'
import { runtimeAuthorityFromEnvironment } from '../../../system-factory/runtime-authority'
import type { SystemFactoryRuntimeAuthority } from '../../../system-factory/runtime-authority'

export async function acceptInvitationRouteRequest(body: Record<string, unknown>, dependencies: { repository?: InvitationActivationRepositoryPort; tenantApp?: TenantAppPort; authority?: SystemFactoryRuntimeAuthority } = {}) {
  const authority = dependencies.authority || runtimeAuthorityFromEnvironment(); const database = getDatabase(); if (!dependencies.repository && !database) throw createError({ statusCode: 503, statusMessage: 'System invitation activation is temporarily unavailable.' })
  const endpointOrigin = process.env.SYSTEM_FACTORY_FRAPPE_ORIGIN || 'https://unconfigured.invalid'; const allowedOrigins = (process.env.SYSTEM_FACTORY_FRAPPE_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  const tenantApp = dependencies.tenantApp || createTenantAppAdapter({ endpointOrigin, allowedOrigins, sender: 'discoverystack-nuxt', receiver: 'discovery-stack-frappe-app', keyId: process.env.SYSTEM_FACTORY_HMAC_KEY_ID || 'unconfigured', liveEnabled: process.env.SYSTEM_FACTORY_TENANT_APP_LIVE_ENABLED === 'true', expectedAuthorityFingerprint: process.env.SYSTEM_FACTORY_RUNTIME_AUTHORITY_FINGERPRINT, credentialResolver: async reference => reference === process.env.SYSTEM_FACTORY_HMAC_CREDENTIAL_REF && process.env.SYSTEM_FACTORY_HMAC_SECRET && process.env.SYSTEM_FACTORY_FRAPPE_AUTHORIZATION ? { ok: true, value: { hmacKey: process.env.SYSTEM_FACTORY_HMAC_SECRET, authorizationHeader: process.env.SYSTEM_FACTORY_FRAPPE_AUTHORIZATION } } : { ok: false, reason: 'missing' } })
  return activateSystemInvitation({ token: body.token, email: body.email, password: body.password, idempotencyKey: body.idempotencyKey, repository: dependencies.repository || new DrizzleInvitationActivationRepository(database!), tenantApp, authority, executionMode: dependencies.tenantApp ? 'mocked' : 'live', workerId: `invite-${process.pid}-${Date.now()}` })
}

export function createInvitationAcceptHandler(dependencies: { repository?: InvitationActivationRepositoryPort; tenantApp?: TenantAppPort; authority?: SystemFactoryRuntimeAuthority } = {}) { return defineEventHandler(async event => {
  privateSystemFactoryHeaders(event); assertSameOriginMutation(event); const body = await strictSystemFactoryBody(event, ['token', 'email', 'password', 'idempotencyKey'])
  const result = await acceptInvitationRouteRequest(body, dependencies); setManagedSiteSessionCookie(event, result.sessionToken); return { accepted: true, invitationId: result.invitationId, systemTenantId: result.systemTenantId, replayed: result.replayed }
}) }

export default createInvitationAcceptHandler()
import { createError, defineEventHandler } from 'h3'
