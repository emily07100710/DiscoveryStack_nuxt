import { describe, expect, it, vi } from 'vitest'
import { closeEmailManualReview } from '../server/managed-sites/email-review/service'
import type { EmailManualReviewRecord, EmailManualReviewRepository } from '../server/managed-sites/email-review/types'

const ITEM_ID = '12345678-90ab-cdef-1234-567890abcdef'
const REQUEST_ID = 'abcdefab-cdef-abcd-efab-cdefabcdefab'
const VERSION = 'a'.repeat(64)
const NOW = new Date('2026-10-07T03:04:05.006Z')
const input = () => ({ itemId: ITEM_ID, expectedVersion: VERSION, requestId: REQUEST_ID, reason: 'reviewed_no_resend', confirmNoResend: true })
const record: EmailManualReviewRecord = { outboxId: ITEM_ID, ownerUserId: 7, requestId: REQUEST_ID, outboxVersion: VERSION, reason: 'reviewed_no_resend', closedAt: NOW }
const recordedClose: EmailManualReviewRepository['close'] = async () => ({ status: 'recorded', record })
function dependencies(close: EmailManualReviewRepository['close'] = vi.fn(recordedClose)) {
  const repository: EmailManualReviewRepository = { close, listOwnerReviews: vi.fn(async () => []) }
  const getRepository = vi.fn(() => repository)
  return { repository, getRepository, dependencies: { enabled: true, getRepository, clock: () => NOW } }
}

describe('email manual review service', () => {
  it('fails default-off before parsing input or resolving storage', async () => {
    const getRepository = vi.fn(() => { throw new Error('must not resolve') })
    await expect(closeEmailManualReview(7, { unsafe: true }, { enabled: false, getRepository })).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件人工結案功能尚未開通。' })
    expect(getRepository).not.toHaveBeenCalled()
  })

  it('requires a positive integer server-side actor without resolving storage', async () => {
    const getRepository = vi.fn(() => { throw new Error('must not resolve') })
    for (const ownerUserId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(closeEmailManualReview(ownerUserId, input(), { enabled: true, getRepository })).rejects.toMatchObject({ statusCode: 403 })
    }
    expect(getRepository).not.toHaveBeenCalled()
  })

  it('rejects invalid, incomplete, symbolic, inherited and noncanonical commands before storage', async () => {
    const deps = dependencies()
    const missing = { itemId: ITEM_ID, expectedVersion: VERSION, requestId: REQUEST_ID, reason: 'reviewed_no_resend' }
    const symbolic = { ...input(), [Symbol('hidden-field')]: 'ignored' }
    const inherited = Object.assign(Object.create({ inherited: true }) as object, input())
    const invalidCommands: unknown[] = [
      missing,
      { ...input(), itemId: ITEM_ID.toUpperCase() },
      { ...input(), requestId: REQUEST_ID.toUpperCase() },
      symbolic,
      inherited,
      { ...input(), reason: 'unknown' },
    ]
    for (const command of invalidCommands) {
      await expect(closeEmailManualReview(7, command, deps.dependencies)).rejects.toMatchObject({ statusCode: 422, statusMessage: '郵件人工結案資料格式不正確。' })
    }
    expect(deps.getRepository).not.toHaveBeenCalled()
    expect(deps.repository.close).not.toHaveBeenCalled()
  })

  it('calls only repository.close and returns a reduced no-resend result for recorded and replayed closures', async () => {
    const first = dependencies()
    const saved = await closeEmailManualReview(7, input(), first.dependencies)
    expect(first.getRepository).toHaveBeenCalledTimes(1)
    expect(first.repository.close).toHaveBeenCalledExactlyOnceWith({ ownerUserId: 7, command: input(), closedAt: NOW })
    expect(first.repository.listOwnerReviews).not.toHaveBeenCalled()
    expect(saved).toEqual({ itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: NOW.toISOString(), outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false })

    const replayClose: EmailManualReviewRepository['close'] = async () => ({ status: 'replayed', record: { ...record, closedAt: new Date('2026-10-06T00:00:00.000Z') } })
    const replay = dependencies(vi.fn(replayClose))
    expect(await closeEmailManualReview(7, input(), replay.dependencies)).toMatchObject({ replayed: true, closedAt: '2026-10-06T00:00:00.000Z', resendAuthorized: false, inboxDeliveryVerified: false })
  })

  it('maps repository domain results to safe HTTP errors and storage failures to generic 503', async () => {
    for (const [status, expected] of [['not_found', 404], ['not_eligible', 409], ['conflict', 409]] as const) {
      const close: EmailManualReviewRepository['close'] = async () => ({ status })
      const deps = dependencies(vi.fn(close))
      await expect(closeEmailManualReview(7, input(), deps.dependencies)).rejects.toMatchObject({ statusCode: expected })
    }

    const factoryFailure = dependencies()
    factoryFailure.getRepository.mockImplementationOnce(() => { throw new Error('secret DB URL') })
    await expect(closeEmailManualReview(7, input(), factoryFailure.dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件人工結案暫時無法儲存，請稍後重試。' })

    const secretFailureClose: EmailManualReviewRepository['close'] = async () => { throw new Error('secret DB URL and private@example.test') }
    const secretFailure = dependencies(vi.fn(secretFailureClose))
    await expect(closeEmailManualReview(7, input(), secretFailure.dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件人工結案暫時無法儲存，請稍後重試。' })

    for (const malformed of [null, {}, { status: 'unexpected' }]) {
      const malformedResult = dependencies()
      Reflect.set(malformedResult.repository, 'close', async () => malformed)
      await expect(closeEmailManualReview(7, input(), malformedResult.dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件人工結案暫時無法儲存，請稍後重試。' })
    }
  })

  it('rejects every mismatched or invalid repository record and never echoes its extra private fields', async () => {
    const differentItem = '11111111-1111-1111-1111-111111111111'
    const differentRequest = '22222222-2222-2222-2222-222222222222'
    const invalidRecords: unknown[] = [
      { ...record, ownerUserId: 8 },
      { ...record, outboxId: differentItem },
      { ...record, outboxVersion: 'b'.repeat(64) },
      { ...record, requestId: differentRequest },
      { ...record, reason: 'handled_outside_platform' },
      { ...record, closedAt: new Date(Number.NaN) },
      { ...record, closedAt: new Date(NOW.getTime() + 1) },
    ]
    for (const invalidRecord of invalidRecords) {
      const deps = dependencies()
      Reflect.set(deps.repository, 'close', async () => ({ status: 'recorded', record: invalidRecord }))
      await expect(closeEmailManualReview(7, input(), deps.dependencies)).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件人工結案暫時無法儲存，請稍後重試。' })
    }

    const privateRecord = { ...record, recipient: 'private@example.test', bearerToken: 'private-token' }
    const close: EmailManualReviewRepository['close'] = async () => ({ status: 'recorded', record: privateRecord })
    const deps = dependencies(close)
    const result = await closeEmailManualReview(7, input(), deps.dependencies)
    expect(result).toEqual({ itemId: ITEM_ID, status: 'closed_no_resend', replayed: false, reason: 'reviewed_no_resend', closedAt: NOW.toISOString(), outboxStatusUnchanged: true, resendAuthorized: false, inboxDeliveryVerified: false })
    expect(JSON.stringify(result)).not.toContain('private@example.test')
    expect(JSON.stringify(result)).not.toContain('private-token')
  })
})
