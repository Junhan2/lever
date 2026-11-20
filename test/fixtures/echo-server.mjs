// A tiny stdio MCP server for tests: say (text), shot (an image), fail (isError), slow (waits for cancel).
import readline from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const TOOLS = [
  { name: 'say', description: 'Says the text back. Second sentence.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, loud: { type: 'boolean' } }, required: ['text'] } },
  { name: 'shot', description: 'Returns a 1x1 PNG.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers until cancelled.', inputSchema: { type: 'object', properties: {} } },
  { name: 'json', description: 'Returns JSON text.', inputSchema: { type: 'object', properties: {} } },
]
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } })
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'notifications/cancelled') return send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: `cancelled ${params.requestId}` } })
  if (method !== 'tools/call') return id === undefined ? null : send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } })
  const { name, arguments: args } = params
  if (name === 'say') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: args.loud ? args.text.toUpperCase() : args.text }] } })
  if (name === 'shot') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } })
  if (name === 'fail') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } })
  if (name === 'json') return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{"items":[1,2,3]}' }] } })
})
