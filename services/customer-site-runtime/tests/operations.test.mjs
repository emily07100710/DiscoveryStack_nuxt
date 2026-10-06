import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openSiteDatabase } from '../lib/store.mjs'

const root = resolve(import.meta.dirname, '..')
test('generated merchant runtime contains config and code but never the private database or credentials', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ds-generate-test-')); const input = join(folder, 'manifest.json'); const output = join(folder, 'generated')
  writeFileSync(input, JSON.stringify({ schemaVersion: 'customer-site-runtime-manifest-v1', runtime: 'discoverystack-customer-site-runtime', config: { siteId: 'test-brand', siteType: 'commerce', brandName: '合成品牌', mode: 'preview' } }))
  const command = () => spawnSync(process.execPath, [join(root, 'scripts/generate.mjs'), input, output], { encoding: 'utf8' })
  const generated = command(); assert.equal(generated.status, 0, generated.stderr)
  for (const file of ['server.mjs', 'public/site.css', 'public/site.js', 'site.config.json', 'Dockerfile']) assert.ok(existsSync(join(output, file)))
  assert.equal(existsSync(join(output, 'data')), false); assert.equal(existsSync(join(output, '.env')), false)
  assert.equal(JSON.parse(readFileSync(join(output, 'site.config.json'), 'utf8')).commerce.paymentMode, 'disabled')
  assert.notEqual(command().status, 0) // refuses replacing an existing customer artifact
})
test('operator backup preserves bound identity and media without overwriting its source', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ds-backup-test-')); const source = join(folder, 'site.sqlite'); const media = join(folder, 'uploads'); const output = join(folder, 'backup')
  const db = openSiteDatabase(source, 'test-brand', 'preview'); db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES(\'synthetic-record\')'); db.close()
  mkdirSync(media); writeFileSync(join(media, 'fixture.txt'), 'synthetic-media')
  const command = () => spawnSync(process.execPath, [join(root, 'scripts/backup.mjs'), source, media, output], { encoding: 'utf8' })
  const backup = command(); assert.equal(backup.status, 0, backup.stderr)
  const restored = openSiteDatabase(join(output, 'site.sqlite'), 'test-brand', 'preview')
  try { assert.equal(restored.prepare('SELECT value FROM fixture').get().value, 'synthetic-record') } finally { restored.close() }
  assert.equal(readFileSync(join(output, 'uploads/fixture.txt'), 'utf8'), 'synthetic-media')
  assert.equal(JSON.parse(readFileSync(join(output, 'backup.json'), 'utf8')).containsCustomerData, true)
  assert.notEqual(command().status, 0)
})
