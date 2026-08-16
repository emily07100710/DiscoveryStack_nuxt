import { writeFile } from 'node:fs/promises'

const debugPort = process.env.CDP_PORT || '9227'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3000/en?nuxt=1#fit-review'
const screenshotPath = '/home/ubuntu/DiscoveryStack_nuxt/artifacts/fit-review-invalid-state.png'

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
await send('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 1800))
await send('Runtime.evaluate', {
  expression: `(() => {
    const form = document.querySelector('.fit-review-form')
    const input = form?.querySelector('input[name="name"]')
    const submit = form?.querySelector('button[type="submit"]')
    if (!form || !input || !submit) throw new Error('Fit review form was not found.')
    form.scrollIntoView({ block: 'center' })
    submit.click()
  })()`,
})
await new Promise((resolve) => setTimeout(resolve, 260))
const result = await send('Runtime.evaluate', {
  expression: `(() => {
    const form = document.querySelector('.fit-review-form')
    const input = form?.querySelector('input[name="name"]')
    if (!form || !input) throw new Error('Fit review form was not found.')
    const style = getComputedStyle(input)
    return {
      submitted: false,
      valid: input.validity.valid,
      userInvalid: input.matches(':user-invalid'),
      borderBottomColor: style.borderBottomColor,
      boxShadow: style.boxShadow,
      scrollY: window.scrollY,
    }
  })()`,
  returnByValue: true,
})
const state = result.result.value
if (state.valid || !state.userInvalid || !state.boxShadow.includes('141, 60, 71')) {
  throw new Error(`Fit-review invalid state did not render as expected: ${JSON.stringify(state)}`)
}
const screenshot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
console.log(JSON.stringify({ ...state, screenshotPath }))
socket.close()
