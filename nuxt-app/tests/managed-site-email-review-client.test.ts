import { describe, expect, it, vi } from 'vitest'
import { createEmailManualReviewClient, type EmailManualReviewClientCommand, type EmailManualReviewClientReply } from '../utils/emailManualReviewClient'

const ITEM_ID = '12345678-90ab-cdef-1234-567890abcdef'
const REQUEST_ID = 'abcdefab-cdef-abcd-efab-cdefabcdefab'
const OTHER_REQUEST_ID = '22222222-2222-2222-2222-222222222222'
const THIRD_REQUEST_ID = '33333333-3333-3333-3333-333333333333'
const VERSION = 'a'.repeat(64)
const OTHER_VERSION = 'b'.repeat(64)
const CLOSED_AT = '2026-10-07T03:04:05.006Z'
const closeInput = (overrides: Partial<{ itemId: string; expectedVersion: string; reason: 'reviewed_no_resend' | 'handled_outside_platform'; confirmNoResend: boolean }> = {}) => ({ itemId: ITEM_ID, expectedVersion: VERSION, reason: 'reviewed_no_resend' as const, confirmNoResend: true, ...overrides })
const reply = (command: EmailManualReviewClientCommand): EmailManualReviewClientReply => ({ itemId: command.itemId, status: 'closed_no_resend', replayed: false, reason: command.reason, closedAt: CLOSED_AT, outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false })

describe('browser-safe email manual review client', () => {
  it('sends only the exact five-field command with an explicit no-resend confirmation', async () => {
    const request = vi.fn(async (command: EmailManualReviewClientCommand) => reply(command))
    const client = createEmailManualReviewClient({ request, createRequestId: () => REQUEST_ID })
    await client.close(closeInput())
    expect(request).toHaveBeenCalledExactlyOnceWith({ itemId: ITEM_ID, expectedVersion: VERSION, requestId: REQUEST_ID, reason: 'reviewed_no_resend', confirmNoResend: true })
  })

  it('reuses the same request UUID for retry/replay after an uncertain network failure', async () => {
    const request = vi.fn<(_: EmailManualReviewClientCommand) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockImplementationOnce(async command => ({ ...reply(command), replayed: true }))
    const createRequestId = vi.fn(() => REQUEST_ID)
    const client = createEmailManualReviewClient({ request, createRequestId })
    await expect(client.close(closeInput())).rejects.toThrow('network unavailable')
    expect(await client.close(closeInput())).toMatchObject({ replayed: true })
    expect(request.mock.calls[0]![0].requestId).toBe(REQUEST_ID)
    expect(request.mock.calls[1]![0].requestId).toBe(REQUEST_ID)
    expect(createRequestId).toHaveBeenCalledOnce()
  })

  it('creates a fresh request UUID when reason or snapshot version changes', async () => {
    const request = vi.fn(async (command: EmailManualReviewClientCommand) => reply(command))
    const ids = [REQUEST_ID, OTHER_REQUEST_ID, THIRD_REQUEST_ID]
    const createRequestId = vi.fn(() => ids.shift()!)
    const client = createEmailManualReviewClient({ request, createRequestId })
    await client.close(closeInput())
    await client.close(closeInput({ reason: 'handled_outside_platform' }))
    await client.close(closeInput({ expectedVersion: OTHER_VERSION }))
    expect(request.mock.calls.map(([command]) => command.requestId)).toEqual([REQUEST_ID, OTHER_REQUEST_ID, THIRD_REQUEST_ID])
    expect(createRequestId).toHaveBeenCalledTimes(3)
  })

  it('allows only one in-flight close and releases busy after resolution', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    let callCount = 0
    const request = vi.fn((command: EmailManualReviewClientCommand) => {
      callCount += 1
      return callCount === 1
        ? new Promise<unknown>(resolve => { resolveRequest = resolve })
        : Promise.resolve(reply(command))
    })
    const client = createEmailManualReviewClient({ request, createRequestId: () => REQUEST_ID })
    const first = client.close(closeInput())
    await expect(client.close(closeInput())).rejects.toThrow('An email manual review request is already in progress.')
    expect(request).toHaveBeenCalledOnce()
    resolveRequest!(reply(request.mock.calls[0]![0]))
    await first
    await expect(client.close(closeInput())).resolves.toMatchObject({ status: 'closed_no_resend' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid commands and invalid generated UUIDs locally without calling request', async () => {
    const request = vi.fn(async (command: EmailManualReviewClientCommand) => reply(command))
    const client = createEmailManualReviewClient({ request, createRequestId: () => 'bad-id' })
    for (const value of [
      closeInput({ itemId: ITEM_ID.toUpperCase() }),
      closeInput({ expectedVersion: 'not-a-hash' }),
      closeInput({ confirmNoResend: false }),
      closeInput({ reason: 'unapproved' as 'reviewed_no_resend' }),
      { ...closeInput(), extra: true },
      { ...closeInput(), [Symbol('extra')]: true },
      Object.assign(Object.create({ inherited: true }) as object, closeInput()),
    ]) {
      await expect(client.close(value)).rejects.toThrow('Invalid email manual review command.')
    }
    await expect(client.close(closeInput())).rejects.toThrow('Invalid email manual review command.')
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects forged reply status, booleans, identity, reason and invalid UTC dates', async () => {
    const forgedReplies: unknown[] = [
      { status: 'accepted' },
      { itemId: ITEM_ID, status: 'closed_no_resend', replayed: 'false', reason: 'reviewed_no_resend', closedAt: CLOSED_AT, outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false },
      { itemId: '11111111-1111-1111-1111-111111111111', status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: CLOSED_AT, outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false },
      { itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'handled_outside_platform', closedAt: CLOSED_AT, outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false },
      { itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: '2026-02-30T03:04:05.006Z', outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false },
      { itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: '0999-12-31T23:59:59.999Z', outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false },
      { itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: CLOSED_AT, outboxStatusUnchanged: false, resendAuthorized: false, inboxDeliveryVerified: false },
      { itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: CLOSED_AT, outboxStatusUnchanged: true, resendAuthorized: true, inboxDeliveryVerified: false },
      { itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: CLOSED_AT, outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: true },
    ]
    for (const forged of forgedReplies) {
      const client = createEmailManualReviewClient({ request: async () => forged, createRequestId: () => REQUEST_ID })
      await expect(client.close(closeInput())).rejects.toThrow('Invalid email manual review response.')
    }
  })

  it('reduces extra private response fields to the exact safe reply and never invokes mail/ML work', async () => {
    let received: EmailManualReviewClientCommand | undefined
    const client = createEmailManualReviewClient({
      createRequestId: () => REQUEST_ID,
      request: async command => {
        received = command
        return { ...reply(command), recipient: 'private@example.test', receipt: 'private-receipt', trainingConsent: true, providerAccepted: true }
      },
    })
    const result = await client.close(closeInput())
    expect(result).toEqual({ itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: CLOSED_AT, outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false })
    expect(Object.keys(result)).toHaveLength(8)
    expect(JSON.stringify(result)).not.toMatch(/private@example\.test|private-receipt|trainingConsent|providerAccepted/u)
    expect(received).toEqual({ itemId: ITEM_ID, expectedVersion: VERSION, requestId: REQUEST_ID, reason: 'reviewed_no_resend', confirmNoResend: true })
    expect(JSON.stringify(received)).not.toMatch(/recipient|receipt|training|transport|provider|token/u)
  })
})
