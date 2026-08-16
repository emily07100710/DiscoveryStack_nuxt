import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const projectRoot = process.cwd()
const source = join(projectRoot, '.output/public')
const destination = '/tmp/discoverystack-visual-preview'
const recoverySnapshots = {
  en: '/home/ubuntu/upload/3000-i8etdt8lpuw7k9rehsv9g-6f06f3f4.us3.manus.computer_en_recovery_wrapper_1786865974549.html',
  'zh-hant': '/tmp/ds-zh-recovered.html',
}
const fallbackSource = process.env.DISCOVERYSTACK_FALLBACK_SOURCE_URL || 'https://disco-nuxt-jcrxrcab.manus.space'
const coreFallbackRoutes = [
  '/en', '/zh-hant',
  '/en/services/seo-geo-growth-system', '/zh-hant/services/seo-geo-growth-system',
]
const additionalFallbackRoutes = [
  '/en/methodology/journey-intelligence', '/zh-hant/methodology/journey-intelligence',
  '/en/methodology/bounded-ai-assistant', '/zh-hant/methodology/bounded-ai-assistant',
  '/en/glossary/seo', '/zh-hant/glossary/seo',
  '/en/glossary/geo', '/zh-hant/glossary/geo',
  '/en/glossary/journey-intelligence', '/zh-hant/glossary/journey-intelligence',
  '/en/publications/what-a-public-website-can-tell-you', '/zh-hant/publications/what-a-public-website-can-tell-you',
]
const fallbackRoutes = process.env.DISCOVERYSTACK_FALLBACK_FULL === '1'
  ? [...coreFallbackRoutes, ...additionalFallbackRoutes]
  : coreFallbackRoutes

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? findHtmlFiles(path) : path.endsWith('.html') ? [path] : []
  }))
  return nested.flat()
}

const stripHydration = (html) => html
  .replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/\sdata-src="[^"]*"/g, '')

const withFallbackStyles = (html) => html.replace('</head>', [
  '<link rel="stylesheet" href="/_nuxt/assets/css/main.css">',
  '<link rel="stylesheet" href="/_nuxt/assets/css/immersive.css">',
  '</head>',
].join(''))

async function fetchFallbackRoute(route) {
  const response = await fetch(`${fallbackSource}${route}`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`)
  return response.text()
}

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
const hasGeneratedOutput = await stat(source).then(() => true).catch(() => false)

if (hasGeneratedOutput) {
  await cp(source, destination, { recursive: true })
  await cp(source, join(destination, '__raw'), { recursive: true })
} else {
  await Promise.all([
    mkdir(join(destination, 'en'), { recursive: true }),
    mkdir(join(destination, 'zh-hant'), { recursive: true }),
    mkdir(join(destination, '_nuxt/assets/css'), { recursive: true }),
    cp(join(projectRoot, 'assets/css/main.css'), join(destination, '_nuxt/assets/css/main.css')),
    cp(join(projectRoot, 'assets/css/immersive.css'), join(destination, '_nuxt/assets/css/immersive.css')),
  ])
  const captured = await Promise.allSettled(fallbackRoutes.map(async (route) => {
    const filePath = join(destination, route.replace(/^\//, ''), 'index.html')
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, withFallbackStyles(stripHydration(await fetchFallbackRoute(route))))
  }))
  const failedRoutes = captured
    .map((result, index) => result.status === 'rejected' ? fallbackRoutes[index] : null)
    .filter(Boolean)

  if (failedRoutes.length === fallbackRoutes.length) {
    const [enHtml, zhHtml] = await Promise.all([
      readFile(recoverySnapshots.en, 'utf8'),
      readFile(recoverySnapshots['zh-hant'], 'utf8'),
    ])
    await Promise.all([
      writeFile(join(destination, 'en/index.html'), withFallbackStyles(stripHydration(enHtml))),
      writeFile(join(destination, 'zh-hant/index.html'), withFallbackStyles(stripHydration(zhHtml).replace('<html  lang="en-US"', '<html lang="zh-Hant"'))),
    ])
    console.warn('[visual-preview] Production fallback was unavailable; using verified homepage recovery snapshots.')
  } else {
    console.warn(`[visual-preview] .output/public is unavailable; captured ${fallbackRoutes.length - failedRoutes.length}/${fallbackRoutes.length} public fallback routes from production.`)
  }
}

await mkdir(join(destination, '__preview'), { recursive: true })
await cp(join(projectRoot, 'scripts/visual-preview-runtime.js'), join(destination, '__preview/scroll-story.js'))

for (const locale of ['en', 'zh-hant']) {
  const pagePaths = await findHtmlFiles(join(destination, locale))
  for (const pagePath of pagePaths) {
  const html = await readFile(pagePath, 'utf8')
  await writeFile(pagePath, stripHydration(html).replace('</body>', '<script src="/__preview/scroll-story.js" defer></script></body>'))
  }
}

console.log(destination)
