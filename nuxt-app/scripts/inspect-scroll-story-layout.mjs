const debugPort = process.env.CDP_PORT || '9226'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3004/en?inspect=story'
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
await send('Runtime.evaluate', {
  expression: `(() => {
    const story = document.querySelector('.journey-story')
    document.documentElement.style.scrollBehavior = 'auto'
    window.scrollTo(0, story.offsetTop + innerHeight * 1.65)
  })()`,
  awaitPromise: true,
})
await new Promise((resolve) => setTimeout(resolve, 500))
const result = await send('Runtime.evaluate', {
  expression: `(() => {
    const story = document.querySelector('.journey-story')
    const sticky = document.querySelector('.story-sticky')
    const canvas = document.querySelector('.story-canvas')
    const copy = document.querySelector('.story-copybook')
    const step = document.querySelector('.story-step.is-active')
    const ancestors = []
    for (let element = sticky.parentElement; element && ancestors.length < 8; element = element.parentElement) {
      const style = getComputedStyle(element)
      ancestors.push({ tag: element.tagName, className: element.className, overflow: style.overflow, overflowY: style.overflowY, transform: style.transform, contain: style.contain, filter: style.filter })
    }
    const dimensions = (element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height, display: style.display, position: style.position, opacity: style.opacity, visibility: style.visibility }
    }
    return { scrollY, story: dimensions(story), sticky: dimensions(sticky), canvas: dimensions(canvas), copy: dimensions(copy), step: dimensions(step), ancestors }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log(JSON.stringify(result.result.value, null, 2))
socket.close()
