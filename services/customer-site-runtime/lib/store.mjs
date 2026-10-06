import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, statSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { fail } from './errors.mjs'

const active = new WeakSet()
export function transaction(db, work) {
  if (active.has(db)) fail(409, '資料操作尚未完成，請稍後再試', 'NESTED_TRANSACTION')
  db.exec('BEGIN IMMEDIATE')
  active.add(db)
  try {
    const value = work()
    if (value && typeof value.then === 'function') fail(500, '資料交易不可等待外部服務', 'ASYNC_TRANSACTION')
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally { active.delete(db) }
}

/** Dedicated customer data only. Never point this file at the private DS database. */
export function openSiteDatabase(filename, siteId, mode) {
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/u.test(siteId)) fail(422, '網站識別不正確')
  if (!['preview', 'production'].includes(mode)) fail(422, '網站模式不正確')
  if (filename !== ':memory:' && existsSync(filename) && statSync(filename).size > 0) {
    const probe = new DatabaseSync(filename, { readOnly: true })
    try {
      if (!probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='site_identity'").get()) fail(409, '不能接管其他系統的資料庫，請使用新的獨立資料空間', 'FOREIGN_DATABASE_REJECTED')
      const binding = probe.prepare('SELECT * FROM site_identity WHERE id=1').get()
      if (!binding || binding.site_id !== siteId || binding.mode !== mode) fail(409, '此資料庫已綁定其他網站或模式，請使用獨立資料空間', 'SITE_DATABASE_MISMATCH')
    } finally { probe.close() }
  }
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(filename)
  if (filename !== ':memory:') chmodSync(filename, 0o600)
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;')
  db.exec('CREATE TABLE IF NOT EXISTS site_identity (id INTEGER PRIMARY KEY CHECK(id=1), site_id TEXT NOT NULL, mode TEXT NOT NULL)')
  try {
    transaction(db, () => {
      const binding = db.prepare('SELECT * FROM site_identity WHERE id=1').get()
      if (binding && (binding.site_id !== siteId || binding.mode !== mode)) fail(409, '此資料庫已綁定其他網站或模式，請使用獨立資料空間', 'SITE_DATABASE_MISMATCH')
      if (!binding) db.prepare('INSERT INTO site_identity VALUES(1,?,?)').run(siteId, mode)
    })
    return db
  } catch (error) { db.close(); throw error }
}
