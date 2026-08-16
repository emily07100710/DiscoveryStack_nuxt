import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const projectRoot = process.cwd()
const destination = '/tmp/discoverystack-visual-preview'
const snapshot = '/home/ubuntu/upload/3000-i8etdt8lpuw7k9rehsv9g-6f06f3f4.us3.manus.computer_en_recovery_wrapper_1786865974549.html'
const zhSnapshot = '/tmp/ds-zh-recovered.html'

await stat(snapshot)
await stat(zhSnapshot)
await rm(destination, { recursive: true, force: true })
await Promise.all([
  mkdir(join(destination, 'en'), { recursive: true }),
  mkdir(join(destination, 'zh-hant'), { recursive: true }),
  mkdir(join(destination, '_nuxt/assets/css'), { recursive: true }),
  mkdir(join(destination, '__preview'), { recursive: true }),
])

const rawHtml = await readFile(snapshot, 'utf8')
const toStaticHtml = (html) => html
  .replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/\sdata-src="[^"]*"/g, '')
  .replace('</body>', '<script src="/__preview/scroll-story.js" defer></script></body>')
const staticHtml = toStaticHtml(rawHtml)
const zhStaticHtml = toStaticHtml(await readFile(zhSnapshot, 'utf8'))
  .replace('<html  lang="en-US"', '<html lang="zh-Hant"')

await Promise.all([
  writeFile(join(destination, 'en/index.html'), staticHtml),
  writeFile(join(destination, 'zh-hant/index.html'), zhStaticHtml),
  cp(join(projectRoot, 'assets/css/main.css'), join(destination, '_nuxt/assets/css/main.css')),
  cp(join(projectRoot, 'assets/css/immersive.css'), join(destination, '_nuxt/assets/css/immersive.css')),
  cp(join(projectRoot, 'scripts/visual-preview-runtime.js'), join(destination, '__preview/scroll-story.js')),
])

console.log('[preview-recovery] Restored the verified English homepage snapshot.')
await import('./managed-static-preview.mjs')
