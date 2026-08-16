import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const port = 4311
const baseUrl = `http://127.0.0.1:${port}`

let server: ChildProcess | undefined

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function startSsrServer() {
  if (server?.exitCode === null) return

  const entry = join(root, '.output/server/index.mjs')
  if (!existsSync(entry)) throw new Error('Run the Nuxt production build before SSR output tests.')

  server = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port) },
    stdio: 'ignore',
  })

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/en`)
      if (response.ok) return
    } catch {
      // The production server is still booting.
    }
    await delay(100)
  }

  await stopSsrServer()
  throw new Error('The Nuxt/Nitro SSR server did not become ready for output tests.')
}

export async function fetchSsrHtml(path: string) {
  const response = await fetch(`${baseUrl}${path}`)
  return { response, html: await response.text() }
}

export async function fetchSsrResponse(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, init)
}

export async function stopSsrServer() {
  if (!server || server.exitCode !== null) return
  server.kill('SIGTERM')
  await new Promise<void>((resolve) => server?.once('exit', () => resolve()))
  server = undefined
}
