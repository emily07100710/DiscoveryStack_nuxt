const debugPort = process.env.CDP_PORT || '9227'
const pageUrl = process.argv[2] || 'https://disco-nuxt-jcrxrcab.manus.space/en?motion=reduce'

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
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 2200))
const result = await send('Runtime.evaluate', {
  expression: `(() => {
    const story = document.querySelector('.journey-story')
    const sticky = document.querySelector('.story-sticky')
    const core = document.querySelector('.story-core')
    const steps = [...document.querySelectorAll('.story-step')]
    if (!story || !sticky || !core || steps.length !== 4) throw new Error('Story elements were not found.')
    const stepStates = steps.map((step) => {
      const style = getComputedStyle(step)
      return { position: style.position, opacity: style.opacity, pointerEvents: style.pointerEvents }
    })
    const coreStyle = getComputedStyle(core)
    return {
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      stickyPosition: getComputedStyle(sticky).position,
      coreTransitionDuration: coreStyle.transitionDuration,
      steps: stepStates,
      semanticStoryHeading: Boolean(document.querySelector('.story-step h3')),
    }
  })()`,
  returnByValue: true,
})
const state = result.result.value
if (!state.reducedMotion || state.stickyPosition !== 'relative' || state.coreTransitionDuration !== '0s' || !state.steps.every((step) => step.position === 'relative' && step.opacity === '1' && step.pointerEvents === 'auto') || !state.semanticStoryHeading) {
  throw new Error(`Reduced-motion story fallback failed: ${JSON.stringify(state)}`)
}
console.log(JSON.stringify(state))
socket.close()
