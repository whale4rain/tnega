import { createInterface } from 'node:readline'
import process from 'node:process'

const rl = createInterface({ input: process.stdin })

for await (const line of rl) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
  } catch {
    continue
  }
  if (request.id === undefined) continue
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    })
  } else if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [
        {
          name: 'echo',
          description: 'echo an object back',
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
        },
      ],
    })
  } else if (request.method === 'tools/call') {
    const name = request.params?.name
    const args = request.params?.arguments ?? {}
    if (name === 'echo') {
      respond(request.id, {
        content: [{ type: 'text', text: `echo:${String(args.value ?? '')}` }],
      })
    } else {
      respond(request.id, {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      })
    }
  } else {
    respond(request.id, {
      error: { code: -32601, message: `unknown method: ${request.method}` },
    })
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
