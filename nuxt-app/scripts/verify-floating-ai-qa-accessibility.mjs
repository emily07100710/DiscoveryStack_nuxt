const debugPort = process.env.CDP_PORT || '9231'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3000/en'
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
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value
const tab = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 750))

let tabs = 0
let active = ''
while (tabs < 12 && active !== 'qa-launcher') {
  await tab()
  active = await evaluate(`document.activeElement?.id || ''`)
  tabs += 1
}
const desktopFocus = await evaluate(`(() => { const e = document.querySelector('#qa-launcher'); const s = getComputedStyle(e); return { active: document.activeElement?.id, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth } })()`)
await evaluate(`document.querySelector('#qa-launcher')?.click()`)
await new Promise((resolve) => setTimeout(resolve, 120))
const opened = await evaluate(`document.querySelector('.qa-panel')?.getAttribute('aria-hidden') === 'false'`)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
const escaped = await evaluate(`(() => ({ active: document.activeElement?.id, hidden: document.querySelector('.qa-panel')?.getAttribute('aria-hidden') }))()`)

await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
await send('Page.navigate', { url: `${pageUrl}?qa=open` })
await new Promise((resolve) => setTimeout(resolve, 750))
const mobileBounds = await evaluate(`(() => { const p = document.querySelector('.qa-panel')?.getBoundingClientRect(); const i = document.querySelector('.qa-form input')?.getBoundingClientRect(); return { panel: p && { left:p.left,right:p.right,top:p.top,bottom:p.bottom,height:p.height }, input: i && { left:i.left,right:i.right,top:i.top,bottom:i.bottom }, innerWidth, innerHeight } })()`)

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Page.navigate', { url: `${pageUrl}?qa=open` })
await new Promise((resolve) => setTimeout(resolve, 750))
const reducedMotion = await evaluate(`(() => { const p = document.querySelector('.qa-panel'); return { visible: p?.getAttribute('aria-hidden') === 'false', animationName: getComputedStyle(p).animationName } })()`)

const result = { desktop: { tabs, desktopFocus, opened, escaped }, mobileBounds, reducedMotion }
console.log(JSON.stringify(result, null, 2))
socket.close()
