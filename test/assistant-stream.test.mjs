import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DeltaThrottler,
  accumulateAssistantMessages,
} from '../src/lab/assistant-stream.mjs'

function bytes(parts) {
  return (async function* () {
    for (const part of parts) yield Buffer.from(part, 'utf8')
  })()
}

test('accumulates reasoning, content and tool calls from an SSE stream', async () => {
  const deltas = []
  const result = await accumulateAssistantMessages(bytes([
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"We need resp"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"ect the work."}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"Reading now."}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{\\"command\\":"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"git status\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200}}\n\n',
    'data: [DONE]\n\n',
  ]), { onDelta: (phase, text) => deltas.push([phase, text]) })

  assert.equal(result.message.role, 'assistant')
  assert.equal(result.message.reasoning_content, 'We need respect the work.')
  assert.equal(result.message.content, 'Reading now.')
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.usage.prompt_tokens, 1000)
  assert.equal(result.usage.completion_tokens, 200)
  assert.equal(result.reasoningChars, 'We need respect the work.'.length)
  assert.equal(result.contentChars, 'Reading now.'.length)
  assert.equal(result.message.tool_calls.length, 1)
  assert.equal(result.message.tool_calls[0].function.arguments, '{"command":"git status"}')
  assert.equal(result.message.tool_calls[0].function.name, 'bash')
  assert.deepEqual(deltas.filter(([phase]) => phase === 'reasoning').map(([, text]) => text),
    ['We need resp', 'ect the work.'])
})

test('handles a stream split across odd chunk overlaps without losing data', async () => {
  const source = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me inspect the repository."}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const result = await accumulateAssistantMessages(bytes([source.slice(0, 20), source.slice(20)]))
  assert.equal(result.message.reasoning_content, 'Let me inspect the repository.')
  assert.equal(result.message.content, 'ok')
})

test('DeltaThrottler coalesces bursts and flushes on demand', () => {
  const emitted = []
  const throttler = new DeltaThrottler((phase, text) => emitted.push([phase, text]), {
    maxChars: 200,
    intervalMs: 10_000,
  })
  throttler.push('reasoning', 'aa'.repeat(60))
  throttler.push('reasoning', 'bb'.repeat(60))
  assert.equal(emitted.length, 1) // exceeded maxChars -> flushed once
  assert.equal(emitted[0][1], 'aa'.repeat(60) + 'bb'.repeat(60))
  throttler.push('content', 'hi')
  assert.equal(emitted.length, 1) // below thresholds, still buffered
  throttler.flush()
  assert.equal(emitted.length, 2)
  assert.deepEqual(emitted[1], ['content', 'hi'])
  throttler.flush() // idempotent
  assert.equal(emitted.length, 2)
})
