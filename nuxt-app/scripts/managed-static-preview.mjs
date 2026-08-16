import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || '3000')
const root = '/tmp/discoverystack-visual-preview'
const nuxtHydrationRoot = join(process.cwd(), '.output', 'public')
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

function candidatePaths(pathname) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  if (safePath.includes('..')) return []
  if (!safePath || safePath === '.') return ['index.html']
  if (extname(safePath)) return [safePath]
  return [join(safePath, 'index.html'), `${safePath}.html`]
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const pathname = url.pathname
  if (pathname === '/') {
    response.writeHead(302, { Location: '/en' })
    response.end()
    return
  }
  for (const relativePath of candidatePaths(pathname)) {
    const filePath = join(url.searchParams.has('nuxt') ? nuxtHydrationRoot : root, relativePath)
    try {
      if (!(await stat(filePath)).isFile()) continue
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(await readFile(filePath))
      return
    } catch {
      // Try the next safe route candidate.
    }
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Preview route not found')
})

server.listen(port, host, () => {
  console.log(`[managed-static-preview] Serving visual preview at http://${host}:${port}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
