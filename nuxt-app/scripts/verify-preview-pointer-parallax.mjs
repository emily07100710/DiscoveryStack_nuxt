const debugPort = process.env.CDP_PORT || '9227'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3004/en?inspect=pointer'
const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json())
const target = targets.find((candidate) => candidate.type === 'page')
if (!target?.webSocketDebuggerUrl) throw new Error('No Chrome page target is available.')

const socket = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const requests = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && requests.has(message.id)) {
    const request = requests.get(message.id)
    requests.delete(message.id)
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
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
await send('Runtime.evaluate', { expression: `(() => { const story = document.querySelector('.journey-story'); document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, story.offsetTop + innerHeight * 1.65) })()` })
await new Promise((resolve) => setTimeout(resolve, 500))
const capability = await send('Runtime.evaluate', { expression: `matchMedia('(pointer: fine)').matches`, returnByValue: true })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 610, y: 620, button: 'none', clickCount: 0 })
await new Promise((resolve) => setTimeout(resolve, 200))
const state = await send('Runtime.evaluate', {
  expression: `(() => { const canvas = document.querySelector('.story-canvas'); const style = getComputedStyle(canvas); return { x: style.getPropertyValue('--pointer-x').trim(), y: style.getPropertyValue('--pointer-y').trim(), scene: document.querySelector('.story-step.is-active .journey-number')?.textContent?.trim() } })()`,
  returnByValue: true,
})
console.log(JSON.stringify({ finePointer: capability.result.value, ...state.result.value }, null, 2))
socket.close()
