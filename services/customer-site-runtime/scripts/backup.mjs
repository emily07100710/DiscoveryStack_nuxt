import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Operator-invoked snapshot to a new directory. Never overwrites a live database. */
const [databasePath, mediaPath, outputPath] = process.argv.slice(2)
if (!databasePath || !mediaPath || !outputPath) throw new Error('Usage: node scripts/backup.mjs <site.sqlite> <uploads> <new-backup-directory>')
const source = resolve(databasePath); const media = resolve(mediaPath); const target = resolve(outputPath)
if (!existsSync(source) || existsSync(target) || target === media || target.startsWith(`${media}/`)) throw new Error('Source must exist and backup destination must be a new independent directory.')
const db = new DatabaseSync(source, { readOnly: true })
try {
  const identity = db.prepare('SELECT site_id,mode FROM site_identity WHERE id=1').get()
  if (!identity) throw new Error('Only a bound customer-site database can be backed up.')
  mkdirSync(target, { mode: 0o700 })
  db.prepare('VACUUM INTO ?').run(join(target, 'site.sqlite'))
  if (existsSync(media)) cpSync(media, join(target, 'uploads'), { recursive: true, force: false, errorOnExist: true })
  const digest = createHash('sha256').update(readFileSync(join(target, 'site.sqlite'))).digest('hex')
  writeFileSync(join(target, 'backup.json'), JSON.stringify({ schemaVersion: 'customer-site-backup-v1', siteId: identity.site_id, mode: identity.mode, createdAt: new Date().toISOString(), databaseHash: digest, encryptedOutboxNeedsOriginalSecret: true, containsCustomerData: true }, null, 2), { flag: 'wx', mode: 0o600 })
  console.log('Isolated customer-site backup created. Keep it private and preserve its original encryption secret securely.')
} finally { db.close() }
