const debugPort = process.env.CDP_PORT || '9228'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3004/en?inspect=keyboard'
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

const active = async () => (await send('Runtime.evaluate', {
  expression: `(() => { const element = document.activeElement; const style = getComputedStyle(element); return { tag: element?.tagName, text: element?.textContent?.trim(), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth } })()`,
  returnByValue: true,
})).result.value

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 1000))
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
const firstTab = await active()
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
const beforePointer = await active()
await send('Runtime.evaluate', { expression: `(() => { const story = document.querySelector('.journey-story'); document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, story.offsetTop + innerHeight * 1.65) })()` })
await new Promise((resolve) => setTimeout(resolve, 400))
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 600, button: 'none', clickCount: 0 })
await new Promise((resolve) => setTimeout(resolve, 150))
const afterPointer = await active()
console.log(JSON.stringify({ firstTab, beforePointer, afterPointer, focusPreserved: beforePointer.text === afterPointer.text && beforePointer.tag === afterPointer.tag }, null, 2))
socket.close()
