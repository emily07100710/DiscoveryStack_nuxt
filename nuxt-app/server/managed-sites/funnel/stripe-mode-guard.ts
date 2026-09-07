import { createError } from 'h3'
import type { ManagedSiteCredentialResolver } from '../live-connectors/types'

export const MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE_ENV = 'MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE'

export function managedSiteFunnelStripeLiveModeEnabled(raw = process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE): boolean {
  return raw === 'true'
}

export function isStripeTestModeSecret(value: string): boolean {
  return /^(sk|rk)_test_/u.test(value)
}

export function assertFunnelStripeCredentialMode(value: string, liveModeEnabled = managedSiteFunnelStripeLiveModeEnabled()): void {
  if (isStripeTestModeSecret(value) || liveModeEnabled) return
  console.warn('[managed-site-funnel] Stripe credential is not a test-mode key; set MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE=true to allow live charges')
  throw createError({ statusCode: 503, statusMessage: '自助下單目前僅開放 Stripe 測試模式，請聯絡客服。' })
}

export function assertFunnelStripeVerifiedCredentialMode(value: string, capabilityIdentity: string): void {
  const mode = isStripeTestModeSecret(value) ? 'test' : /^(sk|rk)_live_/u.test(value) ? 'live' : null
  // The verified mode is already part of the persisted checkout attempt fingerprint.
  // Rotating a reference into another mode must not reuse a pending attempt in a
  // different Stripe namespace while an earlier payment request is unresolved.
  if (mode && capabilityIdentity === `stripe-balance:${mode}`) return
  throw createError({ statusCode: 409, statusMessage: 'Stripe credential mode no longer matches the verified payment configuration.' })
}

export function assertFunnelStripeCheckoutMode(receipt: { providerKey: string; externalReference: string | null; metadata: unknown }): void {
  if (receipt.providerKey !== 'stripe' || managedSiteFunnelStripeLiveModeEnabled()) return
  const metadata = receipt.metadata && typeof receipt.metadata === 'object' && !Array.isArray(receipt.metadata) ? receipt.metadata as Record<string, unknown> : {}
  // Inspect the persisted session, not today's credential: rotating to a test key
  // cannot make an already-created live checkout safe to return to the customer.
  if (/^cs_test_[A-Za-z0-9_]+$/u.test(receipt.externalReference || '') && metadata.capabilityIdentity === 'stripe-balance:test') return
  throw createError({ statusCode: 503, statusMessage: '自助下單目前僅開放 Stripe 測試模式，請聯絡客服。' })
}

/** Adds a funnel-only mode check without exposing credential material. */
export function guardedManagedSiteCredentialResolver<T extends ManagedSiteCredentialResolver>(resolver: T, guard: (value: string) => void): T {
  return ((reference: string) => {
    const resolution = resolver(reference)
    if (resolution instanceof Promise) return resolution.then((value) => {
      if (value.ok) guard(value.value)
      return value
    })
    if (resolution.ok) guard(resolution.value)
    return resolution
  }) as T
}
