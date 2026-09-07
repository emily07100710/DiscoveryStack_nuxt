import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const storageKey = 'discoverystack.managed-site-funnel'
const page = readFileSync(new URL('../pages/managed-sites/checkout/success.vue', import.meta.url), 'utf8')
const setup = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)![1]!

// Execute the page's actual status loader with isolated browser and lifecycle APIs.
function harness(fetchStatus: () => Promise<unknown>, grantAccess: () => Promise<unknown> = async () => ({ granted: true })) {
  const values = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
  }
  const fetch = vi.fn((url: string) => url.endsWith('/customer-access') ? grantAccess() : fetchStatus())
  const vue = {
    ref: (value: unknown) => ({ value }),
    computed: (get: () => unknown) => ({ get value() { return get() } }),
    onMounted: vi.fn(),
    onUnmounted: vi.fn(),
  }
  const script = ts.transpileModule(`${setup}\nexport { loadStatus, claimCustomerAccess, shouldPoll, pollCustomerStatus };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} as { loadStatus: (session: { sessionId: number; sessionToken: string }) => Promise<void>; claimCustomerAccess: () => Promise<void>; shouldPoll: () => boolean; pollCustomerStatus: () => Promise<void> } }
  new Function('require', 'module', 'exports', '$fetch', 'localStorage', 'useHead', script)(() => vue, module, module.exports, fetch, storage, vi.fn())
  return { values, storage, fetch, ...module.exports }
}

const first = { sessionId: 1, sessionToken: 'first-session-token' }
const second = { sessionId: 2, sessionToken: 'second-session-token' }
const response = (orderStatus: string) => ({ status: 'checkout_pending', order: { status: orderStatus }, release: null, fulfilments: [], checkoutUrl: null })

describe('checkout success token cleanup', () => {
  it.each(['payment_verified', 'refunded', 'disputed'])('clears the matching token after the server confirms %s', async status => {
    const line = harness(async () => response(status))
    line.values.set(storageKey, JSON.stringify(first))
    await line.loadStatus(first)
    expect(line.values.has(storageKey)).toBe(false)
    expect(line.fetch).toHaveBeenCalledWith('/api/managed-sites/funnel/sessions/1/status', expect.objectContaining({ credentials: 'omit', headers: { 'x-managed-site-funnel-token': first.sessionToken } }))
  })

  it('preserves a new application created while an older payment status request is in flight', async () => {
    let resolve!: (value: unknown) => void
    const line = harness(() => new Promise(done => { resolve = done }))
    line.values.set(storageKey, JSON.stringify(first))
    const loading = line.loadStatus(first)
    line.values.set(storageKey, JSON.stringify(second))
    resolve(response('payment_verified'))
    await loading
    expect(line.values.get(storageKey)).toBe(JSON.stringify(second))
    expect(line.storage.removeItem).not.toHaveBeenCalled()
  })

  it('preserves a replacement token even if its session ID matches', async () => {
    const line = harness(async () => response('payment_verified'))
    const replacement = { ...first, sessionToken: second.sessionToken }
    line.values.set(storageKey, JSON.stringify(replacement))
    await line.loadStatus(first)
    expect(line.values.get(storageKey)).toBe(JSON.stringify(replacement))
  })

  it.each(['payment_pending', 'cancelled', 'expired'])('preserves the token for %s', async status => {
    const line = harness(async () => response(status))
    line.values.set(storageKey, JSON.stringify(first))
    await line.loadStatus(first)
    expect(line.values.get(storageKey)).toBe(JSON.stringify(first))
  })

  it('preserves the token after a failed status request', async () => {
    const line = harness(async () => { throw new Error('temporarily unavailable') })
    line.values.set(storageKey, JSON.stringify(first))
    await line.loadStatus(first)
    expect(line.values.get(storageKey)).toBe(JSON.stringify(first))
  })

  it('retains recovery authority until the paid customer access exchange succeeds', async () => {
    let canGrant = false
    const line = harness(async () => response('payment_verified'), async () => {
      if (!canGrant) throw new Error('grant unavailable')
      return { granted: true }
    })
    line.values.set(storageKey, JSON.stringify(first))
    await line.loadStatus(first)
    expect(line.values.get(storageKey)).toBe(JSON.stringify(first))
    canGrant = true
    await line.claimCustomerAccess()
    expect(line.values.has(storageKey)).toBe(false)
  })
  it('continues observing a paid release while domain registration waits for the durable task', async () => {
    const line = harness(async () => ({ ...response('payment_verified'), release: { status: 'payment_verified', previewUrl: 'https://preview.example' } }))
    await line.loadStatus(first)
    expect(line.shouldPoll()).toBe(true)
  })

  it('restores launch tracking through the HttpOnly customer session after token cleanup and reload', async () => {
    const line = harness(async () => ({ launch: { ...response('payment_verified'), release: { status: 'retry_wait', previewUrl: null, liveUrl: null } } }))
    await line.pollCustomerStatus()
    expect(line.fetch).toHaveBeenCalledWith('/api/managed-sites/customer/session', { credentials: 'same-origin' })
    expect(line.shouldPoll()).toBe(true)
    expect(line.storage.removeItem).not.toHaveBeenCalled()
  })

})
