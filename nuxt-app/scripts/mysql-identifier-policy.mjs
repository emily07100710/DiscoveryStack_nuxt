import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const migrationDirectory = new URL('../server/database/migrations/', import.meta.url)
const metadataDirectory = new URL('../server/database/migrations/meta/', import.meta.url)
const schemaPath = new URL('../server/database/schema.ts', import.meta.url)
const mappingPath = new URL('../server/database/migrations/mysql-identifier-map.json', import.meta.url)
const write = process.argv.includes('--write')
const sqlNames = readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort()
const snapshotNames = readdirSync(metadataDirectory).filter(name => /^\d{4}_snapshot\.json$/u.test(name)).sort()
const currentSnapshotName = snapshotNames.at(-1)
if (!currentSnapshotName) throw new Error('At least one Drizzle snapshot is required.')

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function snake(value) { return value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replace(/[^a-zA-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toLowerCase() }
function boundedForeignKeyName(table, column, original) { return `fk_${snake(table).slice(0, 24)}_${snake(column).slice(0, 18)}_${sha256(original).slice(0, 10)}` }

function discoverCorrections() {
  const corrections = []
  const pattern = /ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)`\(`([^`]+)`\)/gu
  for (const migration of sqlNames) {
    const sql = readFileSync(new URL(migration, migrationDirectory), 'utf8')
    for (const match of sql.matchAll(pattern)) {
      const [, table, original, column, targetTable, targetColumn] = match
      if (Buffer.byteLength(original, 'utf8') <= 64) continue
      const corrected = boundedForeignKeyName(table, column, original)
      corrections.push({ migration, table, column, targetTable, targetColumn, original, originalBytes: Buffer.byteLength(original, 'utf8'), corrected, correctedBytes: Buffer.byteLength(corrected, 'utf8') })
    }
  }
  return corrections
}

function discoverSnapshotCorrections() {
  const relationToSql = new Map()
  const pattern = /ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)`\(`([^`]+)`\)/gu
  for (const migration of sqlNames) {
    const sql = readFileSync(new URL(migration, migrationDirectory), 'utf8')
    for (const match of sql.matchAll(pattern)) relationToSql.set(`${match[1]}:${match[3]}:${match[4]}:${match[5]}`, { migration, corrected: Buffer.byteLength(match[2], 'utf8') > 64 ? boundedForeignKeyName(match[1], match[3], match[2]) : match[2] })
  }
  const snapshot = JSON.parse(readFileSync(new URL(currentSnapshotName, metadataDirectory), 'utf8'))
  const corrections = []
  for (const table of Object.values(snapshot.tables)) {
    for (const foreignKey of Object.values(table.foreignKeys || {})) {
      if (Buffer.byteLength(foreignKey.name, 'utf8') <= 64) continue
      const identity = `${foreignKey.tableFrom}:${foreignKey.columnsFrom[0]}:${foreignKey.tableTo}:${foreignKey.columnsTo[0]}`
      const sqlAuthority = relationToSql.get(identity)
      if (!sqlAuthority) throw new Error(`No migration SQL authority found for snapshot foreign key ${foreignKey.name}.`)
      corrections.push({ migration: sqlAuthority.migration, table: foreignKey.tableFrom, column: foreignKey.columnsFrom[0], targetTable: foreignKey.tableTo, targetColumn: foreignKey.columnsTo[0], original: foreignKey.name, originalBytes: Buffer.byteLength(foreignKey.name, 'utf8'), corrected: sqlAuthority.corrected, correctedBytes: Buffer.byteLength(sqlAuthority.corrected, 'utf8') })
    }
  }
  return corrections
}

function replaceObjectKeysAndValues(value, replacements) {
  if (Array.isArray(value)) return value.map(item => replaceObjectKeysAndValues(item, replacements))
  if (!value || typeof value !== 'object') return typeof value === 'string' ? replacements.get(value) || value : value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [replacements.get(key) || key, replaceObjectKeysAndValues(child, replacements)]))
}

function tableMetadata(source) {
  const starts = [...source.matchAll(/export const (\w+) = mysqlTable\('([^']+)'/gu)]
  return starts.map((match, index) => {
    const start = match.index
    const end = starts[index + 1]?.index ?? source.length
    const body = source.slice(start, end)
    const columns = new Map([...body.matchAll(/(?:^|[,\n]\s*)(\w+):\s*\w+\('([^']+)'/gu)].map(column => [column[1], column[2]]))
    return { variable: match[1], table: match[2], start, end, body, columns }
  })
}

function rewriteSchema(source, corrections) {
  const correctionByIdentity = new Map(corrections.map(item => [`${item.table}:${item.column}:${item.targetTable}:${item.targetColumn}`, item]))
  const metadata = tableMetadata(source)
  const tableByVariable = new Map(metadata.map(item => [item.variable, item]))
  let output = ''
  for (const table of metadata) {
    let body = table.body
    const additions = []
    const referencePattern = /(\w+):([^\n]*?)\.references\(\(\) => (\w+)\.(\w+)\)/gu
    body = body.replace(referencePattern, (full, property, prefix, foreignVariable, foreignProperty) => {
      const foreign = tableByVariable.get(foreignVariable)
      const column = table.columns.get(property)
      const targetColumn = foreign?.columns.get(foreignProperty)
      const correction = foreign && column && targetColumn ? correctionByIdentity.get(`${table.table}:${column}:${foreign.table}:${targetColumn}`) : undefined
      if (!correction) return full
      additions.push(`foreignKey({ name: '${correction.corrected}', columns: [table.${property}], foreignColumns: [${foreignVariable}.${foreignProperty}] })`)
      return `${property}:${prefix}`
    })
    if (additions.length) {
      const declarations = additions.map(item => `  ${item},`).join('\n')
      if (body.includes('}, table => [')) body = body.replace('}, table => [', `}, table => [\n${declarations}\n`)
      else {
        const close = body.lastIndexOf('})')
        if (close < 0) throw new Error(`Could not add explicit foreign keys for ${table.table}.`)
        body = `${body.slice(0, close)}}, table => [\n${declarations}\n]${body.slice(close + 1)}`
      }
    }
    output += source.slice(output.length ? table.start : 0, table.start) + body
  }
  if (!metadata.length) throw new Error('No Drizzle tables found in schema.')
  return output
}

function implicitForeignKeyIdentities(source) {
  const metadata = tableMetadata(source)
  const tableByVariable = new Map(metadata.map(item => [item.variable, item]))
  const identities = []
  for (const table of metadata) {
    for (const match of table.body.matchAll(/(\w+):([^\n]*?)\.references\(\(\) => (\w+)\.(\w+)\)/gu)) {
      const foreign = tableByVariable.get(match[3])
      const column = table.columns.get(match[1])
      const targetColumn = foreign?.columns.get(match[4])
      if (!foreign || !column || !targetColumn) throw new Error(`Could not resolve implicit foreign key ${table.table}.${match[1]}.`)
      identities.push(`${table.table}.${column}->${foreign.table}.${targetColumn}`)
    }
  }
  return identities.sort()
}

let mapping = existsSync(mappingPath) ? JSON.parse(readFileSync(mappingPath, 'utf8')) : null
const discovered = discoverCorrections()
const snapshotCorrections = discoverSnapshotCorrections()
if (!mapping && !write) throw new Error('mysql-identifier-map.json is required. Run this script once with --write.')
if (!mapping) mapping = { version: 1, policy: 'Preserve an existing bounded SQL name; otherwise fk_<table-prefix-24>_<column-prefix-18>_<sha256-original-prefix-10>.', corrections: [...discovered, ...snapshotCorrections], schemaPolicy: {} }
if (write) {
  const byOriginal = new Map(mapping.corrections.map(item => [item.original, item]))
  for (const correction of [...discovered, ...snapshotCorrections]) byOriginal.set(correction.original, correction)
  mapping.corrections = [...byOriginal.values()].map(item => {
    const corrected = Buffer.byteLength(item.corrected, 'utf8') > 64 ? boundedForeignKeyName(item.table, item.column, item.original) : item.corrected
    return { ...item, corrected, correctedBytes: Buffer.byteLength(corrected, 'utf8') }
  }).sort((left, right) => left.migration.localeCompare(right.migration) || left.original.localeCompare(right.original))
}

const replacements = new Map(mapping.corrections.map(item => [item.original, item.corrected]))
if (write) {
  mapping.corrections = mapping.corrections.map(item => ({ ...item, originalBytes: Buffer.byteLength(item.original, 'utf8'), correctedBytes: Buffer.byteLength(item.corrected, 'utf8') }))
  for (const migration of sqlNames) {
    const path = new URL(migration, migrationDirectory)
    let sql = readFileSync(path, 'utf8')
    for (const [original, corrected] of replacements) sql = sql.replaceAll(`\`${original}\``, `\`${corrected}\``)
    writeFileSync(path, sql)
  }
  for (const snapshot of readdirSync(metadataDirectory).filter(name => /^\d{4}_snapshot\.json$/u.test(name)).sort()) {
    const path = new URL(snapshot, metadataDirectory)
    const normalized = replaceObjectKeysAndValues(JSON.parse(readFileSync(path, 'utf8')), replacements)
    writeFileSync(path, JSON.stringify(normalized, null, 2))
  }
  let schema = rewriteSchema(readFileSync(schemaPath, 'utf8'), mapping.corrections)
  for (const [original, corrected] of replacements) schema = schema.replaceAll(`name: '${original}'`, `name: '${corrected}'`)
  const legacy = implicitForeignKeyIdentities(schema)
  mapping.schemaPolicy = { newForeignKeysRequireExplicitBoundedNames: true, legacyImplicitForeignKeyCount: legacy.length, legacyImplicitForeignKeysSha256: sha256(legacy.join('\n')) }
  writeFileSync(schemaPath, schema)
  writeFileSync(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`)
}

mapping = JSON.parse(readFileSync(mappingPath, 'utf8'))
const errors = []
const globalForeignKeys = new Map()
for (const migration of sqlNames) {
  const sql = readFileSync(new URL(migration, migrationDirectory), 'utf8')
  for (const identifier of sql.matchAll(/`([^`]+)`/gu)) if (Buffer.byteLength(identifier[1], 'utf8') > 64) errors.push(`${migration}: identifier exceeds 64 bytes: ${identifier[1]}`)
  const scoped = new Set()
  for (const statement of sql.split('--> statement-breakpoint')) {
    const table = statement.match(/(?:CREATE TABLE|ALTER TABLE) `([^`]+)`/u)?.[1] || statement.match(/(?:CREATE|CREATE UNIQUE) INDEX `[^`]+` ON `([^`]+)`/u)?.[1]
    if (!table) continue
    for (const match of statement.matchAll(/CONSTRAINT `([^`]+)`/gu)) {
      const key = `${table}:constraint:${match[1]}`
      if (scoped.has(key)) errors.push(`${migration}: duplicate constraint in ${table}: ${match[1]}`)
      scoped.add(key)
      if (/FOREIGN KEY/u.test(statement)) {
        const previous = globalForeignKeys.get(match[1])
        if (previous && previous !== table) errors.push(`${migration}: duplicate foreign key name across schema: ${match[1]}`)
        globalForeignKeys.set(match[1], table)
      }
    }
    for (const match of statement.matchAll(/(?:CREATE|CREATE UNIQUE) INDEX `([^`]+)`/gu)) {
      const key = `${table}:index:${match[1]}`
      if (scoped.has(key)) errors.push(`${migration}: duplicate index in ${table}: ${match[1]}`)
      scoped.add(key)
    }
  }
  for (const correction of mapping.corrections.filter(item => item.migration === migration)) {
    if (sql.includes(`\`${correction.original}\``)) errors.push(`${migration}: legacy oversized name remains: ${correction.original}`)
    if (!sql.includes(`\`${correction.corrected}\``)) errors.push(`${migration}: corrected name missing: ${correction.corrected}`)
  }
}

const schema = readFileSync(schemaPath, 'utf8')
for (const name of schema.matchAll(/foreignKey\(\{\s*name:\s*'([^']+)'/gu)) if (Buffer.byteLength(name[1], 'utf8') > 64) errors.push(`schema.ts: explicit foreign key exceeds 64 bytes: ${name[1]}`)
for (const correction of mapping.corrections) if (!schema.includes(`name: '${correction.corrected}'`)) errors.push(`schema.ts: corrected explicit foreign key missing: ${correction.corrected}`)
const legacy = implicitForeignKeyIdentities(schema)
if (legacy.length !== mapping.schemaPolicy.legacyImplicitForeignKeyCount || sha256(legacy.join('\n')) !== mapping.schemaPolicy.legacyImplicitForeignKeysSha256) errors.push('schema.ts: legacy implicit foreign key baseline changed; new foreign keys must use foreignKey({ name }) with a bounded explicit name.')

const currentSnapshot = readFileSync(new URL(currentSnapshotName, metadataDirectory), 'utf8')
const currentSnapshotValue = JSON.parse(currentSnapshot)
const currentForeignKeys = new Map()
for (const [tableName, table] of Object.entries(currentSnapshotValue.tables)) {
  const tableIdentifiers = new Set()
  for (const [key, index] of Object.entries(table.indexes || {})) {
    if (key !== index.name) errors.push(`${currentSnapshotName} index key/name mismatch in ${tableName}: ${key}`)
    if (Buffer.byteLength(index.name, 'utf8') > 64) errors.push(`${currentSnapshotName} index exceeds 64 bytes in ${tableName}: ${index.name}`)
    if (tableIdentifiers.has(index.name)) errors.push(`${currentSnapshotName} duplicate table identifier in ${tableName}: ${index.name}`)
    tableIdentifiers.add(index.name)
  }
  for (const [key, foreignKey] of Object.entries(table.foreignKeys || {})) {
    if (key !== foreignKey.name) errors.push(`${currentSnapshotName} foreign key key/name mismatch in ${tableName}: ${key}`)
    if (Buffer.byteLength(foreignKey.name, 'utf8') > 64) errors.push(`${currentSnapshotName} foreign key exceeds 64 bytes in ${tableName}: ${foreignKey.name}`)
    if (tableIdentifiers.has(foreignKey.name)) errors.push(`${currentSnapshotName} duplicate table identifier in ${tableName}: ${foreignKey.name}`)
    tableIdentifiers.add(foreignKey.name)
    const prior = currentForeignKeys.get(foreignKey.name)
    if (prior && prior !== tableName) errors.push(`${currentSnapshotName} duplicate schema foreign key: ${foreignKey.name}`)
    currentForeignKeys.set(foreignKey.name, tableName)
  }
}
for (const correction of mapping.corrections) {
  if (currentSnapshot.includes(correction.original)) errors.push(`${currentSnapshotName} retains legacy name: ${correction.original}`)
  if (!currentSnapshot.includes(correction.corrected)) errors.push(`${currentSnapshotName} is missing corrected name: ${correction.corrected}`)
  const foreignKey = currentSnapshotValue.tables?.[correction.table]?.foreignKeys?.[correction.corrected]
  if (!foreignKey || foreignKey.tableTo !== correction.targetTable || foreignKey.columnsFrom?.[0] !== correction.column || foreignKey.columnsTo?.[0] !== correction.targetColumn) errors.push(`${currentSnapshotName} corrected foreign key semantics mismatch: ${correction.corrected}`)
}

if (errors.length) throw new Error(errors.join('\n'))
console.log(JSON.stringify({ ok: true, migrations: sqlNames.length, corrections: mapping.corrections.length, legacyImplicitForeignKeys: legacy.length, mapping: basename(mappingPath.pathname) }))
