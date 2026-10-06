import { readFileSync, mkdirSync, cpSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../lib/config.mjs'

/** Operator-only local artifact generation. Input is DS's data-only runtime manifest. */
const [manifestPath, outputPath] = process.argv.slice(2)
if (!manifestPath || !outputPath) throw new Error('Usage: node scripts/generate.mjs <manifest.json> <new-output-directory>')
const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
if (manifest.schemaVersion !== 'customer-site-runtime-manifest-v1' || manifest.runtime !== 'discoverystack-customer-site-runtime') throw new Error('A DS-owned customer runtime manifest is required.')
const config = parseConfig(manifest.config)
const target = resolve(outputPath)
const source = dirname(dirname(fileURLToPath(import.meta.url)))
if (target === source || target.startsWith(`${source}/`) || existsSync(target)) throw new Error('Use a new output directory outside the runtime source; existing files will not be overwritten.')
mkdirSync(target, { mode: 0o700 })
for (const path of ['server.mjs', 'package.json', 'lib', 'public', 'scripts', 'tests', 'Dockerfile', '.env.example', 'README.md']) cpSync(join(source, path), join(target, path), { recursive: true, errorOnExist: true, force: false })
writeFileSync(join(target, 'site.config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 })
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
console.log('Customer site generated with its own runtime. No secrets, database, payment, or deployment were copied.')
