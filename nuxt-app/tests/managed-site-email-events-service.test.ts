import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { processResendEmailProviderEvent } from '../server/managed-sites/email-events/service'
import { RESEND_EVENT_TYPES } from '../server/managed-sites/email-events/protocol'
import type { EmailProviderEventRecord, EmailProviderEventsRepository } from '../server/managed-sites/email-events/types'

const NOW = new Date('2026-10-06T12:30:00.000Z')
const SIGNING_KEY = Buffer.alloc(32, 0x46)
const SIGNING_SECRET = `whsec_${SIGNING_KEY.toString('base64')}`
const ROTATED_KEY = Buffer.alloc(32, 0x47)
const ROTATED_SECRET = `whsec_${ROTATED_KEY.toString('base64')}`
const ENCRYPTION_SECRET = 'synthetic-email-events-encryption-key-32-bytes'
const PROVIDER_CONFIGURATION_FINGERPRINT = 'a'.repeat(64)
const EMAIL_ID = '12345678-90ab-cdef-1234-567890abcdef'
const SENSITIVE_VALUES = ['person@example.test', 'sender@example.test', 'secret subject', 'secret body', 'private bounce reason', 'ownerUserId']

function rawEvent(type: string, emailId = EMAIL_ID, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    type,
    created_at: '2026-10-06T12:29:59.125Z',
    data: {
      email_id: emailId,
      to: ['person@example.test'],
      from: 'sender@example.test',
      subject: 'secret subject',
      text: 'secret body',
      bounce: { message: 'private bounce reason' },
      tags: [{ name: 'ownerUserId', value: '777' }],
      ownerUserId: 777,
      ...extra,
    },
  }))
}

function sign(rawBody: Uint8Array, svixId: string, svixTimestamp: string, key = SIGNING_KEY): string {
  return createHmac('sha256', key).update(`${svixId}.${svixTimestamp}.`).update(rawBody).digest('base64')
}

function request(rawBody: Uint8Array, overrides: Partial<{ svixId: unknown; svixTimestamp: unknown; svixSignature: unknown }> = {}) {
  const svixId = overrides.svixId ?? 'msg_synthetic-event-01'
  const svixTimestamp = overrides.svixTimestamp ?? String(Math.floor(NOW.getTime() / 1000))
  return {
    rawBody,
    svixId,
    svixTimestamp,
    svixSignature: overrides.svixSignature ?? `v1,${sign(rawBody, svixId as string, svixTimestamp as string)}`,
  }
}

function repository(record: EmailProviderEventsRepository['record'] = vi.fn(async () => 'recorded' as const)) {
  return { record, listOwnerFacts: vi.fn(async () => []) } satisfies EmailProviderEventsRepository
}

function dependencies(repo: EmailProviderEventsRepository, overrides: Partial<Parameters<typeof processResendEmailProviderEvent>[1]> = {}) {
  return {
    enabled: true,
    configured: true,
    signingSecret: SIGNING_SECRET,
    encryptionSecret: ENCRYPTION_SECRET,
    providerConfigurationFingerprint: PROVIDER_CONFIGURATION_FINGERPRINT,
    getRepository: vi.fn(() => repo),
    clock: () => NOW,
    ...overrides,
  }
}

describe('passive Resend email event service', () => {
  it('keeps default-off processing before any repository resolution', async () => {
    const getRepository = vi.fn(() => repository())
    await expect(processResendEmailProviderEvent({ rawBody: Buffer.alloc(0), svixId: '', svixTimestamp: '', svixSignature: '' }, {
      enabled: false,
      configured: false,
      signingSecret: undefined,
      encryptionSecret: undefined,
      providerConfigurationFingerprint: '',
      getRepository,
      clock: () => NOW,
    })).resolves.toEqual({ status: 'disabled', recorded: false })
    expect(getRepository).not.toHaveBeenCalled()
  })

  it.each([
    ['outbox not configured', { configured: false }],
    ['missing signing secret', { signingSecret: undefined }],
    ['short encryption key', { encryptionSecret: 'too-short' }],
    ['invalid provider fingerprint', { providerConfigurationFingerprint: 'bad' }],
  ])('does not resolve repository when configuration is incomplete: %s', async (_name, override) => {
    const repo = repository()
    const deps = dependencies(repo, override)
    const getRepository = vi.fn(deps.getRepository)
    await expect(processResendEmailProviderEvent(request(rawEvent('email.sent')), { ...deps, getRepository })).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件事件驗證尚未開通。' })
    expect(getRepository).not.toHaveBeenCalled()
    expect(repo.record).not.toHaveBeenCalled()
  })

  it('rejects an invalid raw-byte signature before repository resolution', async () => {
    const repo = repository()
    const getRepository = vi.fn(() => repo)
    const rawBody = rawEvent('email.delivered')
    const signed = request(rawBody)
    const firstByte = rawBody[0]!
    rawBody[0] = firstByte ^ 1
    await expect(processResendEmailProviderEvent(signed, dependencies(repo, { getRepository }))).rejects.toMatchObject({ statusCode: 401, statusMessage: '郵件事件簽章無效。' })
    expect(getRepository).not.toHaveBeenCalled()
    expect(repo.record).not.toHaveBeenCalled()
  })

  it('acknowledges a correctly signed unsupported event without repository access', async () => {
    const repo = repository()
    const getRepository = vi.fn(() => repo)
    const rawBody = Buffer.from('{ "type" : "email.opened", "extra": "ignored" }')
    await expect(processResendEmailProviderEvent(request(rawBody), dependencies(repo, { getRepository }))).resolves.toEqual({ status: 'ignored', recorded: false, providerObservationOnly: true, inboxDeliveryVerified: false })
    expect(getRepository).not.toHaveBeenCalled()
    expect(repo.record).not.toHaveBeenCalled()
  })

  it('records only reduced metadata for all seven event types using the exact original signed bytes', async () => {
    const records: EmailProviderEventRecord[] = []
    const repo = repository(vi.fn(async (record: EmailProviderEventRecord) => { records.push(record); return 'recorded' as const }))
    const deps = dependencies(repo)

    for (const [index, eventType] of RESEND_EVENT_TYPES.entries()) {
      // Whitespace/order are deliberately part of the signed byte sequence; no JSON reserialization is used.
      const rawBody = Buffer.from(` {\n  "type" : "${eventType}", "created_at":"2026-10-06T12:29:59.125Z", "data" : {"email_id":"${EMAIL_ID.toUpperCase()}","to":["person@example.test"],"from":"sender@example.test","subject":"secret subject","text":"secret body","bounce":{"message":"private bounce reason"},"tags":[{"name":"ownerUserId","value":"777"}],"ownerUserId":777} }\n`)
      const svixId = `msg_seven-events-${index}`
      const req = request(rawBody, { svixId })
      await expect(processResendEmailProviderEvent(req, deps)).resolves.toMatchObject({ status: 'recorded', recorded: true, providerObservationOnly: true, inboxDeliveryVerified: false })
      expect(repo.record).toHaveBeenLastCalledWith(expect.objectContaining({
        providerReceiptId: EMAIL_ID,
        eventType,
        occurredAt: new Date('2026-10-06T12:29:59.125Z'),
        receivedAt: NOW,
        providerConfigurationFingerprint: PROVIDER_CONFIGURATION_FINGERPRINT,
      }))
      expect(records[index]!.id).toBe(createHash('sha256').update(`resend-message-v1:${svixId}`).digest('hex'))
      expect(records[index]!.payloadFingerprint).toBe(createHmac('sha256', ENCRYPTION_SECRET).update('resend-private-payload-v1:').update(rawBody).digest('hex'))
      expect(records[index]!.verificationFingerprint).toBe(createHmac('sha256', ENCRYPTION_SECRET).update('resend-verification-v1:').update(SIGNING_SECRET).digest('hex'))
      const serialized = JSON.stringify({ record: records[index], result: await Promise.resolve({ providerObservationOnly: true, inboxDeliveryVerified: false }) })
      for (const sensitive of SENSITIVE_VALUES) expect(serialized).not.toContain(sensitive)
    }
    expect(records).toHaveLength(7)
  })

  it('accepts rotation signatures while preserving replay identity and delegates same-ID collisions to storage', async () => {
    const repo = repository(vi.fn()
      .mockResolvedValueOnce('recorded')
      .mockResolvedValueOnce('replayed')
      .mockResolvedValueOnce('collision'))
    const rawBody = rawEvent('email.delivered')
    const svixId = 'msg_rotation-replay-collision'
    const timestamp = String(Math.floor(NOW.getTime() / 1000))
    const oldSignature = sign(rawBody, svixId, timestamp, SIGNING_KEY)
    const newSignature = sign(rawBody, svixId, timestamp, ROTATED_KEY)

    const first = await processResendEmailProviderEvent({ rawBody, svixId, svixTimestamp: timestamp, svixSignature: `v1,${oldSignature}` }, dependencies(repo))
    const second = await processResendEmailProviderEvent({ rawBody, svixId, svixTimestamp: timestamp, svixSignature: `v1,${oldSignature} v1,${newSignature}` }, dependencies(repo, { signingSecret: ROTATED_SECRET }))
    expect(first.status).toBe('recorded')
    expect(second.status).toBe('replayed')
    expect(repo.record).toHaveBeenCalledTimes(2)
    const firstRecord = vi.mocked(repo.record).mock.calls[0]![0]
    const rotatedRecord = vi.mocked(repo.record).mock.calls[1]![0]
    expect(rotatedRecord.id).toBe(firstRecord.id)
    expect(rotatedRecord.payloadFingerprint).toBe(firstRecord.payloadFingerprint)
    expect(rotatedRecord.verificationFingerprint).not.toBe(firstRecord.verificationFingerprint)

    const changedPayload = rawEvent('email.bounced', EMAIL_ID, { subject: 'other text' })
    const changedSignature = sign(changedPayload, svixId, timestamp, ROTATED_KEY)
    await expect(processResendEmailProviderEvent({ rawBody: changedPayload, svixId, svixTimestamp: timestamp, svixSignature: `v1,${changedSignature}` }, dependencies(repo, { signingSecret: ROTATED_SECRET }))).rejects.toMatchObject({ statusCode: 409, statusMessage: '郵件事件識別不一致，請由管理員核對。' })
    expect(vi.mocked(repo.record).mock.calls[2]![0].id).toBe(firstRecord.id)
    expect(vi.mocked(repo.record).mock.calls[2]![0].payloadFingerprint).not.toBe(firstRecord.payloadFingerprint)
  })

  it.each([
    ['repository resolution throws synchronously', () => { throw new Error('private database location') }],
    ['repository resolution rejects asynchronously', async () => { throw new Error('private database location') }],
  ])('maps %s to a generic retryable 503', async (_name, getRepository) => {
    const rawBody = rawEvent('email.sent')
    const error = await processResendEmailProviderEvent(request(rawBody), dependencies(repository(), { getRepository })).catch(cause => cause)
    expect(error).toMatchObject({ statusCode: 503, statusMessage: '郵件事件暫時無法保存，請稍後重送事件。' })
    expect(JSON.stringify(error)).not.toContain('private database location')
  })

  it.each([
    ['record throws synchronously', vi.fn(() => { throw new Error('private database location') })],
    ['record rejects asynchronously', vi.fn(async () => { throw new Error('private database location') })],
  ])('maps when %s to a generic retryable 503', async (_name, record) => {
    const repo = repository(record as EmailProviderEventsRepository['record'])
    const getRepository = vi.fn(() => repo)
    await expect(processResendEmailProviderEvent(request(rawEvent('email.failed')), dependencies(repo, { getRepository }))).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件事件暫時無法保存，請稍後重送事件。' })
    expect(getRepository).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(record.mock.calls)).not.toContain('private database location')
  })
})
