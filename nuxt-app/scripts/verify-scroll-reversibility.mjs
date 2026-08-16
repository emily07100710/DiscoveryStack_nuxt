import { writeFile } from 'node:fs/promises'

const debugPort = process.env.CDP_PORT || '9226'
const pageUrl = process.argv[2] || 'https://disco-nuxt-jcrxrcab.manus.space/en'
const outputPath = process.argv[3] || '/home/ubuntu/screenshots/discoverystack-scroll-reversibility.json'

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

const snapshot = () => send('Runtime.evaluate', {
  expression: `(() => {
    const story = document.querySelector('.journey-story')
    const active = [...(story?.querySelectorAll('.story-step') || [])].findIndex((step) => step.classList.contains('is-active'))
    return {
      progress: story?.style.getPropertyValue('--story-progress') || '',
      sceneTurn: story?.style.getPropertyValue('--scene-turn') || '',
      active,
      storyTop: story?.getBoundingClientRect().top ?? null,
      scrollY: window.scrollY,
      travel: story ? Math.max(story.offsetHeight - window.innerHeight, 1) : null,
    }
  })()`,
  returnByValue: true,
}).then((result) => result.result.value)

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 3000))

await send('Runtime.evaluate', { expression: `(() => { const story = document.querySelector('.journey-story'); const travel = Math.max(story.offsetHeight - window.innerHeight, 1); const target = story.offsetTop + travel * .65; document.documentElement.style.scrollBehavior = 'auto'; document.scrollingElement.scrollTop = target; window.scrollTo({ top: target, behavior: 'instant' }); window.dispatchEvent(new Event('scroll')) })()`, awaitPromise: true })
await new Promise((resolve) => setTimeout(resolve, 800))
const forward = await snapshot()

await send('Runtime.evaluate', { expression: `(() => { const story = document.querySelector('.journey-story'); const travel = Math.max(story.offsetHeight - window.innerHeight, 1); const target = story.offsetTop + travel * .04; document.scrollingElement.scrollTop = target; window.scrollTo({ top: target, behavior: 'instant' }); window.dispatchEvent(new Event('scroll')) })()`, awaitPromise: true })
await new Promise((resolve) => setTimeout(resolve, 800))
const reversed = await snapshot()

const result = { forward, reversed, reversible: forward.active > reversed.active && Number(forward.progress) > Number(reversed.progress) }
if (!result.reversible) throw new Error(`Scroll state did not reverse: ${JSON.stringify(result)}`)
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result))
socket.close()
