import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const lock = JSON.parse(readFileSync(join(root, 'infrastructure/frappe/UPSTREAM.lock.json'), 'utf8'))
const failures = []
const sha = value => createHash('sha256').update(value).digest('hex')
const treeHash = directory => { const hash = createHash('sha256'); for (const file of walk(directory).sort()) { const path = relative(directory, file); if (path.endsWith('.pyc') || path.split('/').includes('__pycache__')) continue; hash.update(path); hash.update('\0'); hash.update(readFileSync(file)); hash.update('\0') } return hash.digest('hex') }
const recipeHash = directory => { const hash = createHash('sha256'); for (const name of ['Dockerfile.system-factory', 'build-immutable-image.sh']) { hash.update(name); hash.update('\0'); hash.update(readFileSync(join(directory, name))); hash.update('\0') } return hash.digest('hex') }
const walk = directory => readdirSync(directory).flatMap(entry => { const path = join(directory, entry); const stat = lstatSync(path); if (stat.isSymbolicLink()) { failures.push(`SYMLINK:${relative(root, path)}`); return [] } return stat.isDirectory() ? walk(path) : [path] })
const scoped = [join(root, 'infrastructure/frappe'), join(root, 'services/frappe/discovery_stack'), join(root, 'nuxt-app/server/system-factory')].flatMap(walk)
for (const file of scoped) {
  const path = relative(root, file); const bytes = readFileSync(file)
  if (/\.(?:zip|tar|tgz|gz|sqlitedb|sqlite|db|pyc|so|dylib|exe)$/iu.test(path)) failures.push(`ARTIFACT:${path}`)
  if (bytes.includes(Buffer.from([0]))) failures.push(`BINARY:${path}`)
  const text = bytes.toString('utf8')
  const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)
  const assignedSecret = text.match(/(?:api[_-]?key|secret|password)\s*[:=]\s*["']([^"'\n]{12,})["']/iu)?.[1]
  const literalSecret = assignedSecret && !assignedSecret.includes('$')
  if ((privateKey || literalSecret) && !path.endsWith('.env.example')) failures.push(`SECRET_PATTERN:${path}`)
}
const compose = readFileSync(join(root, 'infrastructure/frappe/compose.yaml'), 'utf8')
for (const image of [lock.runtimeImages.mariadb.split('@')[1], lock.runtimeImages.redis.split('@')[1]]) if (!compose.includes(image)) failures.push(`DIGEST_MISSING:${image}`)
const manifest = JSON.parse(readFileSync(join(root, 'infrastructure/frappe/build-manifest.json'), 'utf8'))
if (lock.projectImage.customAppSha256 !== manifest.customAppSha256 || lock.projectImage.buildRecipeFingerprint !== manifest.buildRecipeFingerprint || lock.projectImage.productionApproved !== false || manifest.productionApproved !== false) failures.push('PROJECT_IMAGE_AUTHORITY_MISMATCH')
if (manifest.customAppSha256 !== treeHash(join(root, 'services/frappe/discovery_stack'))) failures.push('CUSTOM_APP_HASH_DRIFT')
if (manifest.buildRecipeFingerprint !== recipeHash(join(root, 'infrastructure/frappe'))) failures.push('BUILD_RECIPE_HASH_DRIFT')
if (!compose.includes('FRAPPE_FACTORY_IMAGE') || compose.includes(lock.legacyOfficialImage.indexDigest)) failures.push('COMPOSE_RUNTIME_AUTHORITY')
if (lock.frappe.repository !== 'https://github.com/frappe/frappe.git' || lock.erpnext.repository !== 'https://github.com/frappe/erpnext.git') failures.push('UNOFFICIAL_REPOSITORY')
if (!/^[a-f0-9]{40}$/u.test(lock.frappe.commit) || !/^[a-f0-9]{40}$/u.test(lock.erpnext.commit)) failures.push('INVALID_COMMIT')
if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exit(1) }
process.stdout.write(JSON.stringify({ ok: true, schemaVersion: lock.schemaVersion, filesScanned: scoped.length, lockFingerprint: sha(JSON.stringify(lock)), symlinks: 0, binaries: 0, secretPatterns: 0 }) + '\n')
