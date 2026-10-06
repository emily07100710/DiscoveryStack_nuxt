import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { fail, text } from './errors.mjs'
import { transaction } from './store.mjs'

/** Durable, per-site outbox. Provider transport is never inside a business transaction. */
export function createNotifications(db, { enabled = false, apiKey = '', from = '', fetchImpl = fetch, encryptionKey = '' } = {}) {
  const key = encryptionKey ? createHash('sha256').update(`customer-site-outbox:${encryptionKey}`).digest() : null
  function seal(value) {
    if (!key) return value
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `sealed:v1:${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`
  }
  function unseal(value) {
    if (!value.startsWith('sealed:v1:')) return value
    if (!key) throw new Error('OUTBOX_KEY_REQUIRED')
    const [, , nonce, tag, encrypted] = value.split(':'); const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64')); decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8')
  }
  db.exec(`CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE NOT NULL,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);`)
  function queue({ key, to, subject, body }) {
    const email = text(to, '通知 Email', 320).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(422, '通知 Email 不正確')
    const dedupeKey = text(key, '通知識別', 200)
    db.prepare('INSERT OR IGNORE INTO notification_outbox(id,dedupe_key,recipient,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), dedupeKey, email, text(subject, '通知標題', 240), seal(text(body, '通知內容', 8000)), new Date().toISOString())
    return { configured: enabled && Boolean(apiKey && from), queued: true }
  }
  let flushing = false
  const idleWaiters = []
  async function flush() {
    if (!enabled || !apiKey || !from) return { status: 'not_configured', sent: 0, failed: 0 }
    if (flushing) return { status: 'busy', sent: 0, failed: 0 }
    flushing = true
    let sent = 0; let failed = 0
    try {
      const rows = transaction(db, () => {
        const batch = db.prepare("SELECT * FROM notification_outbox WHERE attempts<3 AND ((status='pending' AND next_at<=?) OR (status='sending' AND lease_until<=?)) ORDER BY created_at LIMIT 20").all(Date.now(), Date.now())
        for (const row of batch) db.prepare("UPDATE notification_outbox SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?").run(Date.now() + 60000, row.id)
        return batch
      })
      for (const row of rows) {
        try {
          const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': createHash('sha256').update(row.dedupe_key).digest('hex') }, body: JSON.stringify({ from, to: [row.recipient], subject: row.subject, text: unseal(row.body) }) })
          await response.body?.cancel()
          if (!response.ok) throw new Error('DELIVERY_FAILED')
          db.prepare("UPDATE notification_outbox SET status='sent',body='[delivered]',lease_until=0 WHERE id=?").run(row.id); sent++
        } catch {
          db.prepare("UPDATE notification_outbox SET status=?,next_at=?,lease_until=0 WHERE id=?").run(row.attempts + 1 >= 3 ? 'failed' : 'pending', Date.now() + (row.attempts + 1) * 60000, row.id); failed++
        }
      }
      return { status: 'processed', sent, failed }
    } finally { flushing = false; for (const resolveIdle of idleWaiters.splice(0)) resolveIdle() }
  }
  return { queue, flush, whenIdle: () => flushing ? new Promise(resolveIdle => idleWaiters.push(resolveIdle)) : Promise.resolve(), status: () => ({ configured: enabled && Boolean(apiKey && from), pending: db.prepare("SELECT count(*) AS count FROM notification_outbox WHERE status IN ('pending','sending')").get().count, failed: db.prepare("SELECT count(*) AS count FROM notification_outbox WHERE status='failed'").get().count }) }
}
