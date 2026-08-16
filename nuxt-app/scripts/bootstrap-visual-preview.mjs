import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const projectRoot = process.cwd()
const destination = '/tmp/discoverystack-visual-preview'
const sourcePort = 3333
const sourceBase = process.env.DISCOVERYSTACK_PREVIEW_SOURCE_URL || 'https://3333-i8etdt8lpuw7k9rehsv9g-6f06f3f4.us3.manus.computer'
const routes = [
  '/en', '/zh-hant',
  '/en/services/seo-geo-growth-system', '/zh-hant/services/seo-geo-growth-system',
  '/en/methodology/journey-intelligence', '/zh-hant/methodology/journey-intelligence',
  '/en/methodology/bounded-ai-assistant', '/zh-hant/methodology/bounded-ai-assistant',
  '/en/glossary/seo', '/zh-hant/glossary/seo',
  '/en/glossary/geo', '/zh-hant/glossary/geo',
  '/en/glossary/journey-intelligence', '/zh-hant/glossary/journey-intelligence',
  '/en/publications/what-a-public-website-can-tell-you', '/zh-hant/publications/what-a-public-website-can-tell-you',
]

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSource() {
  let lastError
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      const response = await fetch(`${sourceBase}/en`)
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await wait(250)
  }
  throw new Error(`Nuxt preview source did not start: ${lastError?.message || 'unknown error'}`)
}

function visualHtml(html) {
  const noHydrationHtml = html
    .replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\sdata-src="[^"]*"/g, '')
  return noHydrationHtml.replace('</body>', '<script src="/__preview/scroll-story.js" defer></script></body>')
}

async function writeRoute(route) {
  const response = await fetch(`${sourceBase}${route}`)
  if (!response.ok) throw new Error(`Could not render ${route}: HTTP ${response.status}`)
  const filePath = join(destination, route.replace(/^\//, ''), 'index.html')
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, visualHtml(await response.text()))
}

const nuxt = spawn('pnpm', ['exec', 'nuxt', 'dev', '--host', '0.0.0.0', '--port', String(sourcePort)], {
  cwd: projectRoot,
  stdio: 'inherit',
})
nuxt.once('exit', (code, signal) => console.warn(`[visual-preview-bootstrap] Nuxt source exited (${signal || code || 'unknown'}).`))

try {
  await waitForSource()
  await rm(destination, { recursive: true, force: true })
  await Promise.all([
    mkdir(join(destination, '_nuxt/assets/css'), { recursive: true }),
    mkdir(join(destination, '__preview'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(destination, '_nuxt/assets/css/main.css'), await readFile(join(projectRoot, 'assets/css/main.css'))),
    writeFile(join(destination, '_nuxt/assets/css/immersive.css'), await readFile(join(projectRoot, 'assets/css/immersive.css'))),
    writeFile(join(destination, '__preview/scroll-story.js'), await readFile(join(projectRoot, 'scripts/visual-preview-runtime.js'))),
  ])
  await Promise.all(routes.map(writeRoute))
  console.log(`[visual-preview-bootstrap] Captured ${routes.length} SSR public routes.`)
} finally {
  nuxt.kill('SIGTERM')
}

await new Promise((resolve) => nuxt.once('exit', resolve))
await import('./managed-static-preview.mjs')
