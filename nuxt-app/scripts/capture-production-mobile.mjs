import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const debugPort = process.env.CDP_PORT || '9226'
const pageUrl = process.argv[2]
const outputPath = process.argv[3]

if (!pageUrl || !outputPath) throw new Error('Usage: node scripts/capture-production-mobile.mjs <url> <output.png>')

const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json())
const target = targets.find((candidate) => candidate.type === 'page')
if (!target?.webSocketDebuggerUrl) throw new Error('No Chrome page target is available.')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const requests = new Map()
let id = 0

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !requests.has(message.id)) return
  const { resolve, reject } = requests.get(message.id)
  requests.delete(message.id)
  message.error ? reject(new Error(message.error.message)) : resolve(message.result)
})

await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1
  requests.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 1800))
const dimensions = await send('Runtime.evaluate', { expression: '({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })', returnByValue: true })
const { width, height } = dimensions.result.value
if (width > 375) throw new Error(`Unexpected horizontal overflow: ${width}px`) 
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 375, height, scale: 1 } })
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, Buffer.from(shot.data, 'base64'))
console.log(JSON.stringify({ outputPath, width, height }))
socket.close()
