import { spawn } from 'node:child_process'

const host = process.env.HOST || '0.0.0.0'
const port = process.env.PORT || '3000'
let child
let stopping = false
let restartTimer

function start() {
  child = spawn('pnpm', ['exec', 'nuxt', 'dev', '--host', host, '--port', port], {
    stdio: 'inherit',
    shell: false,
  })

  child.on('exit', (code, signal) => {
    if (stopping) process.exit(code ?? 0)
    console.warn(`[managed-nuxt-dev] Nuxt dev exited (${signal ?? code ?? 'unknown'}); restarting in 1000ms.`)
    restartTimer = setTimeout(start, 1000)
  })
}

function stop(signal) {
  stopping = true
  clearTimeout(restartTimer)
  if (child && !child.killed) child.kill(signal)
  else process.exit(0)
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
start()
