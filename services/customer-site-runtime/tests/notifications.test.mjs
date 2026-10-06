import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createNotifications } from '../lib/notifications.mjs'

const databases = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function database() {
  const result = new DatabaseSync(':memory:')
  databases.push(result)
  return result
}

const message = {
  key: 'order:notification-test',
  to: 'shopper@example.test',
  subject: '訂單已建立',
  body: '這是測試通知，不代表已完成扣款。',
}

function fakeResponse(ok = true) {
  let cancelled = false
  return {
    ok,
    body: { async cancel() { cancelled = true } },
    get cancelled() { return cancelled },
  }
}

test('unconfigured notifications stay durable without any provider call', async () => {
  const db = database()
  let fetches = 0
  const notifications = createNotifications(db, { enabled: false, fetchImpl: async () => { fetches += 1; return fakeResponse() } })
  assert.deepEqual(notifications.queue(message), { configured: false, queued: true })
  assert.deepEqual(await notifications.flush(), { status: 'not_configured', sent: 0, failed: 0 })
  assert.equal(fetches, 0)
  assert.deepEqual(notifications.status(), { configured: false, pending: 1, failed: 0 })
  assert.equal(db.prepare('SELECT count(*) AS count FROM notification_outbox').get().count, 1)
})

test('queue deduplicates pending messages before delivery', () => {
  const db = database()
  const notifications = createNotifications(db)
  notifications.queue(message)
  notifications.queue({ ...message, subject: '不可覆寫原通知', body: '不可覆寫原通知內容' })
  const rows = db.prepare('SELECT dedupe_key,subject,body,status,attempts FROM notification_outbox').all()
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0] }, {
    dedupe_key: message.key,
    subject: message.subject,
    body: message.body,
    status: 'pending',
    attempts: 0,
  })
})

test('configured delivery uses the fixed provider contract and a stable idempotency key', async () => {
  const db = database()
  const calls = []
  const response = fakeResponse()
  const notifications = createNotifications(db, {
    enabled: true,
    apiKey: 'synthetic-provider-key',
    from: 'Example Store <notifications@example.test>',
    fetchImpl: async (...args) => { calls.push(args); return response },
  })
  notifications.queue(message)
  assert.deepEqual(await notifications.flush(), { status: 'processed', sent: 1, failed: 0 })
  assert.equal(calls.length, 1)
  const [url, options] = calls[0]
  assert.equal(url, 'https://api.resend.com/emails')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers['Content-Type'], 'application/json')
  assert.match(options.headers['Idempotency-Key'], /^[a-f0-9]{64}$/u)
  assert.ok(options.signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(options.body), {
    from: 'Example Store <notifications@example.test>',
    to: [message.to],
    subject: message.subject,
    text: message.body,
  })
  assert.equal(response.cancelled, true)
  assert.deepEqual(notifications.status(), { configured: true, pending: 0, failed: 0 })
})

test('delivery passes an eight-second abort signal and returns failed without leaking provider errors', async () => {
  const db = database()
  let requestedTimeout
  const originalTimeout = AbortSignal.timeout
  AbortSignal.timeout = milliseconds => {
    requestedTimeout = milliseconds
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('synthetic abort')), 1)
    return controller.signal
  }
  try {
    const notifications = createNotifications(db, {
      enabled: true,
      apiKey: 'synthetic-provider-key',
      from: 'notifications@example.test',
      fetchImpl: (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('synthetic timeout detail')), { once: true })
      }),
    })
    notifications.queue(message)
    assert.deepEqual(await notifications.flush(), { status: 'processed', sent: 0, failed: 1 })
    assert.equal(requestedTimeout, 8_000)
    const row = db.prepare('SELECT status,attempts,lease_until FROM notification_outbox').get()
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 1)
    assert.equal(row.lease_until, 0)
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

test('failed delivery retries three times, then stays failed and never duplicates the outbox item', async () => {
  const db = database()
  let fetches = 0
  const notifications = createNotifications(db, {
    enabled: true,
    apiKey: 'synthetic-provider-key',
    from: 'notifications@example.test',
    fetchImpl: async () => { fetches += 1; return fakeResponse(false) },
  })
  notifications.queue(message)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    db.prepare('UPDATE notification_outbox SET next_at=0').run()
    assert.deepEqual(await notifications.flush(), { status: 'processed', sent: 0, failed: 1 })
    assert.equal(db.prepare('SELECT attempts FROM notification_outbox').get().attempts, attempt)
  }
  assert.deepEqual(notifications.status(), { configured: true, pending: 0, failed: 1 })
  assert.equal(fetches, 3)

  notifications.queue({ ...message, subject: 'duplicate' })
  assert.equal(db.prepare('SELECT count(*) AS count FROM notification_outbox').get().count, 1)
  assert.deepEqual(await notifications.flush(), { status: 'processed', sent: 0, failed: 0 })
  assert.equal(fetches, 3)
})
