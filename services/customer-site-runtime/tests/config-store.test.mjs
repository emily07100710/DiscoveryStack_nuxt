import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig, changeVisualSettings, mediaUrl } from '../lib/config.mjs'
import { openSiteDatabase, transaction } from '../lib/store.mjs'
import { createSiteRuntime } from '../server.mjs'
import { seedPreview } from '../lib/seed.mjs'
import { DatabaseSync } from 'node:sqlite'

const base = { siteId: 'test-brand', siteType: 'commerce', mode: 'preview', brandName: '測試品牌' }
test('data-only config rejects code and production pretend payments', () => {
  assert.throws(() => parseConfig({ ...base, scripts: ['alert(1)'] }), /不支援/)
  assert.throws(() => parseConfig({ ...base, mode: 'production', commerce: { paymentMode: 'sandbox' } }), /模擬付款/)
  assert.throws(() => changeVisualSettings(parseConfig(base), { siteId: 'other-brand' }), /只能修改/)
  assert.throws(() => mediaUrl('javascript:alert(1)'), /HTTPS/)
  assert.throws(() => mediaUrl('https://assets.example.test/image?token=private'), /HTTPS/)
  assert.equal(changeVisualSettings(parseConfig(base), { preset: 'bloom' }).preset, 'bloom')
})
test('database identity and preview/production boundaries cannot be relabelled', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ds-site-isolation-test-')), 'site.sqlite')
  const db = openSiteDatabase(path, 'test-brand', 'preview'); db.close()
  assert.throws(() => openSiteDatabase(path, 'other-brand', 'preview'), /已綁定/)
  assert.throws(() => openSiteDatabase(path, 'test-brand', 'production'), /已綁定/)
})
test('rollback and nested transaction checks preserve database state', () => {
  const db = openSiteDatabase(':memory:', 'test-brand', 'preview')
  try { db.exec('CREATE TABLE fixture(value INTEGER)'); assert.throws(() => transaction(db, () => { db.exec('INSERT INTO fixture VALUES(1)'); throw new Error('fixture rollback') }), /rollback/); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixture').get().n, 0); assert.throws(() => transaction(db, () => transaction(db, () => true)), /尚未完成/); } finally { db.close() }
})
test('a foreign SQLite database is refused without altering its schema or customer records', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ds-foreign-database-test-')), 'source.sqlite')
  const source = new DatabaseSync(path); source.exec('CREATE TABLE source_customers(name TEXT); INSERT INTO source_customers VALUES(\'synthetic-customer\')'); source.close()
  assert.throws(() => openSiteDatabase(path, 'test-brand', 'preview'), error => error.code === 'FOREIGN_DATABASE_REJECTED')
  const verify = new DatabaseSync(path, { readOnly: true })
  try { assert.equal(verify.prepare('SELECT name FROM source_customers').get().name, 'synthetic-customer'); assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name='site_identity'").get(), undefined) } finally { verify.close() }
})
test('all three synthetic presets seed independently and never seed production', () => {
  assert.throws(() => seedPreview({ config: { mode: 'production' } }), /正式網站不可/)
  for (const preset of ['atelier', 'bloom', 'alignment']) {
    const runtime = createSiteRuntime({ config: { ...base, preset, siteType: preset === 'alignment' ? 'booking_blog' : 'commerce' }, origin: 'http://127.0.0.1:3002' })
    try { seedPreview(runtime); assert.equal(runtime.blog.list().length, 2); assert.ok(preset === 'alignment' ? runtime.booking.listSlots().length === 7 : runtime.commerce.listProducts().length === 3); seedPreview(runtime); assert.equal(runtime.blog.list().length, 2) } finally { runtime.close() }
  }
})
