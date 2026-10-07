export type EmailManualReviewClientCommand = {
  itemId: string
  expectedVersion: string
  requestId: string
  reason: 'reviewed_no_resend' | 'handled_outside_platform'
  confirmNoResend: true
}

export type EmailManualReviewClientReply = {
  itemId: string
  status: 'closed_no_resend'
  replayed: boolean
  reason: EmailManualReviewClientCommand['reason']
  closedAt: string
  outboxStatusUnchanged: true
  resendAuthorized: false
  inboxDeliveryVerified: false
}

type CloseInput = Pick<EmailManualReviewClientCommand, 'itemId' | 'expectedVersion' | 'reason'> & { confirmNoResend: boolean }
type ClientDependencies = {
  request: (command: EmailManualReviewClientCommand) => Promise<unknown>
  createRequestId: () => string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const HASH = /^[0-9a-f]{64}$/u
const REASONS = ['reviewed_no_resend', 'handled_outside_platform'] as const

function invalidCommand(): Error {
  return new Error('Invalid email manual review command.')
}

function invalidReply(): Error {
  return new Error('Invalid email manual review response.')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validCloseInput(input: unknown): input is CloseInput {
  if (!isPlainRecord(input)) return false
  const keys = Reflect.ownKeys(input)
  return keys.length === 4
    && keys.every(key => typeof key === 'string' && ['itemId', 'expectedVersion', 'reason', 'confirmNoResend'].includes(key))
    && typeof input.itemId === 'string' && UUID.test(input.itemId)
    && typeof input.expectedVersion === 'string' && HASH.test(input.expectedVersion)
    && typeof input.reason === 'string' && REASONS.includes(input.reason as CloseInput['reason'])
    && input.confirmNoResend === true
}

function validUtcIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const year = Number(value.slice(0, 4))
  if (year < 1000 || year > 9999) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function safeReply(value: unknown, command: EmailManualReviewClientCommand): EmailManualReviewClientReply {
  if (!isPlainRecord(value)
    || typeof value.itemId !== 'string' || !UUID.test(value.itemId) || value.itemId !== command.itemId
    || value.status !== 'closed_no_resend'
    || typeof value.replayed !== 'boolean'
    || typeof value.reason !== 'string' || !REASONS.includes(value.reason as CloseInput['reason']) || value.reason !== command.reason
    || !validUtcIsoDate(value.closedAt)
    || value.outboxStatusUnchanged !== true
    || value.resendAuthorized !== false
    || value.inboxDeliveryVerified !== false) {
    throw invalidReply()
  }

  return {
    itemId: value.itemId,
    status: 'closed_no_resend',
    replayed: value.replayed,
    reason: value.reason as EmailManualReviewClientReply['reason'],
    closedAt: value.closedAt,
    outboxStatusUnchanged: true,
    resendAuthorized: false,
    inboxDeliveryVerified: false,
  }
}

export function createEmailManualReviewClient(dependencies: ClientDependencies) {
  const requestIds = new Map<string, string>()
  let busy = false

  return {
    async close(input: CloseInput): Promise<EmailManualReviewClientReply> {
      if (busy) throw new Error('An email manual review request is already in progress.')
      if (!validCloseInput(input)) throw invalidCommand()

      const key = JSON.stringify([input.itemId, input.expectedVersion, input.reason])
      let requestId = requestIds.get(key)
      if (!requestId) {
        try {
          requestId = dependencies.createRequestId()
        } catch {
          throw invalidCommand()
        }
        if (typeof requestId !== 'string' || !UUID.test(requestId)) throw invalidCommand()
        requestIds.set(key, requestId)
      }

      const command: EmailManualReviewClientCommand = {
        itemId: input.itemId,
        expectedVersion: input.expectedVersion,
        requestId,
        reason: input.reason,
        confirmNoResend: true,
      }
      busy = true
      try {
        const response = await dependencies.request(command)
        return safeReply(response, command)
      } finally {
        busy = false
      }
    },
  }
}
