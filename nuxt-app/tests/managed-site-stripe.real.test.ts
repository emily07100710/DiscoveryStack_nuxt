import { describe, expect, it } from 'vitest'

describe.runIf(process.env.DS_RUN_REAL_STRIPE_TESTS === '1')('managed-site real Stripe read-only capability', () => {
  it('reads only the Stripe balance endpoint with an operator-exported credential', async () => {
    const credential = String(process.env.STRIPE_SECRET_KEY || '')
    expect(credential.length).toBeGreaterThan(0)
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000)
    let response: Response
    try { response = await fetch('https://api.stripe.com/v1/balance', { method: 'GET', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${credential}` } }) } finally { clearTimeout(timer) }
    expect(response.ok).toBe(true)
    const value = await response.json() as { object?: unknown }
    expect(value.object).toBe('balance')
  }, 15_000)
})
