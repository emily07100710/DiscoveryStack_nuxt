const debugEndpoint = 'http://127.0.0.1:9222/json'
const pageUrl = process.argv[2] || 'http://127.0.0.1:3001/en'
const targets = await fetch(debugEndpoint).then((response) => response.json())
const target = targets.find((candidate) => candidate.type === 'page')

if (!target?.webSocketDebuggerUrl) {
  throw new Error('No Chrome page target is available for hydration diagnostics.')
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
const findings = []
let messageId = 0

const send = (method, params = {}) => {
  messageId += 1
  socket.send(JSON.stringify({ id: messageId, method, params }))
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    findings.push({ type: 'exception', detail: message.params.exceptionDetails })
  }
  if (message.method === 'Log.entryAdded') {
    findings.push({ type: 'log', detail: message.params.entry })
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    findings.push({ type: 'console', detail: message.params })
  }
})

await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
send('Runtime.enable')
send('Log.enable')
send('Debugger.enable')
send('Page.enable')
send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.addEventListener('error', (event) => {
      console.error('HYDRATION_WINDOW_ERROR', event.message, event.error?.stack || '')
    })
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason
      console.error('HYDRATION_UNHANDLED_REJECTION', reason?.message || String(reason), reason?.stack || '')
    })
  `,
})
send('Page.navigate', { url: pageUrl })

await new Promise((resolve) => setTimeout(resolve, 5000))
console.log(JSON.stringify({ pageUrl, findings }, null, 2))
socket.close()
