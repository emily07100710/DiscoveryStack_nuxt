import { writeFile } from 'node:fs/promises'

const debugPort = process.env.CDP_PORT || '9225'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3004/en?capture=story'
const outputPath = process.argv[3] || '/home/ubuntu/screenshots/discoverystack-scroll-story-scene-2.png'
const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json())
const target = targets.find((candidate) => candidate.type === 'page')

if (!target?.webSocketDebuggerUrl) throw new Error('No Chrome page target is available.')

const socket = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const requests = new Map()

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && requests.has(message.id)) {
    const { resolve, reject } = requests.get(message.id)
    requests.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})

await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1
  requests.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 1200))
await send('Runtime.evaluate', {
  expression: `(() => { const story = document.querySelector('.journey-story'); if (story) { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, story.offsetTop + window.innerHeight * 1.65); } })()`,
  awaitPromise: true,
})
await new Promise((resolve) => setTimeout(resolve, 900))
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
await writeFile(outputPath, Buffer.from(shot.data, 'base64'))
console.log(outputPath)
socket.close()
