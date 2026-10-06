import test from 'node:test'
import assert from 'node:assert/strict'
import { openSiteDatabase } from '../lib/store.mjs'
import { createNotifications } from '../lib/notifications.mjs'

test('account links stay encrypted in the durable outbox and are cleared after delivery', async () => {
  const db = openSiteDatabase(':memory:', 'mail-test', 'preview'); const text = 'reset-link-fixture-token'; let received
  try {
    const notifications = createNotifications(db, { enabled: true, apiKey: 'synthetic-test-key', from: 'studio@example.invalid', encryptionKey: 'synthetic-test-encryption-secret', fetchImpl: async (_url, options) => { received = JSON.parse(options.body); return { ok: true } } })
    notifications.queue({ key: 'reset-fixture', to: 'member@example.invalid', subject: '測試', body: text })
    const row = db.prepare('SELECT body FROM notification_outbox').get(); assert.match(row.body, /^sealed:v1:/); assert.ok(!row.body.includes(text))
    await notifications.flush(); assert.equal(received.text, text); assert.equal(db.prepare('SELECT body FROM notification_outbox').get().body, '[delivered]')
  } finally { db.close() }
})
test('wrong encryption key cannot accidentally send ciphertext or a recovered account link', async () => {
  const db = openSiteDatabase(':memory:', 'mail-test', 'preview'); let calls = 0
  try {
    createNotifications(db, { encryptionKey: 'one-fixture-secret' }).queue({ key: 'reset-fixture', to: 'member@example.invalid', subject: '測試', body: 'private-link-fixture' })
    const notifications = createNotifications(db, { enabled: true, apiKey: 'test-key', from: 'studio@example.invalid', encryptionKey: 'other-fixture-secret', fetchImpl: async () => { calls++; return { ok: true } } })
    assert.equal((await notifications.flush()).failed, 1); assert.equal(calls, 0)
  } finally { db.close() }
})
