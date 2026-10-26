import { parentPort } from 'node:worker_threads'

if (!parentPort) throw new Error('PTC worker requires a worker thread')
const send = parentPort.postMessage.bind(parentPort)
let characters = 0
let items = 0
let calls = 0
parentPort.postMessage = (message, ...rest) => {
  if (message && message.type === 'output') {
    characters += JSON.stringify(message.item).length
    if (++items > 1024 || characters > 64_000) throw new Error('PTC output limit exceeded')
  }
  if (message && message.type === 'call') {
    if (++calls > 100 || (typeof message.args === 'string' && message.args.length > 64_000)) {
      throw new Error('PTC call or argument limit exceeded')
    }
  }
  return send(message, ...rest)
}
await import('@earendil-works/pi-codemode/worker')
