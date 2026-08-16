const debugPort = process.env.CDP_PORT || '9227'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3000/en?nuxt=1&pointer=verify'

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
await send('Emulation.setTouchEmulationEnabled', { enabled: false, configuration: 'desktop' })
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const nativeMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query) => {
      const native = nativeMatchMedia(query)
      if (query.replace(/\\s+/g, ' ').trim() !== '(pointer: fine)') return native
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener: native.addListener.bind(native),
        removeListener: native.removeListener.bind(native),
        addEventListener: native.addEventListener.bind(native),
        removeEventListener: native.removeEventListener.bind(native),
        dispatchEvent: native.dispatchEvent.bind(native),
      }
    }
  })()`,
})
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 1800))
const result = await send('Runtime.evaluate', {
  expression: `(() => {
    const canvas = document.querySelector('.story-canvas')
    if (!canvas) throw new Error('Journey story canvas was not found.')
    canvas.scrollIntoView({ block: 'center' })
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      pointerType: 'mouse',
      clientX: rect.left + rect.width * .8,
      clientY: rect.top + rect.height * .25,
    }))
    const moved = {
      x: canvas.style.getPropertyValue('--pointer-x'),
      y: canvas.style.getPropertyValue('--pointer-y'),
    }
    canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerType: 'mouse' }))
    const reset = {
      x: canvas.style.getPropertyValue('--pointer-x'),
      y: canvas.style.getPropertyValue('--pointer-y'),
    }
    return {
      pointerFine: window.matchMedia('(pointer: fine)').matches,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      moved,
      reset,
      hasStoryText: Boolean(document.querySelector('.story-step h3')),
    }
  })()`,
  returnByValue: true,
})
const state = result.result.value
if (!state.pointerFine || state.reducedMotion || state.moved.x === '0' || state.moved.y === '0' || state.reset.x !== '0' || state.reset.y !== '0' || !state.hasStoryText) {
  throw new Error(`Native pointer/parallax verification failed: ${JSON.stringify(state)}`)
}
console.log(JSON.stringify(state))
socket.close()
