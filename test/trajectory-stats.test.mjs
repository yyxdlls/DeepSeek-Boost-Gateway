import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OpenAiResponseObserver,
  TRAJECTORY_MARKER_PROFILE,
  summarizeMessageTrajectory,
  summarizeResponseBody,
  summarizeTextBlocks,
} from '../src/gateway/trajectory-stats.mjs'

test('counts only exact diagnostic phrases and keeps variants separate', () => {
  const summary = summarizeTextBlocks([
    "We need inspect. Let me verify. I am ready. I'm checking. I'am observed. We let variables remain.",
  ])

  assert.equal(summary.markers.weNeed, 1)
  assert.equal(summary.markers.letMe, 1)
  assert.equal(summary.markers.iAm, 1)
  assert.equal(summary.markers.im, 1)
  assert.equal(summary.markers.iApostropheAm, 1)
  assert.equal(summary.openingStyle, 'we-need')
  assert.equal(TRAJECTORY_MARKER_PROFILE.diagnosticOnly, true)
})

test('summarizes historical assistant messages without mixing tool results', () => {
  const summary = summarizeMessageTrajectory([
    { role: 'user', content: 'Task' },
    {
      role: 'assistant',
      reasoning_content: 'We need inspect.',
      content: '',
      tool_calls: [{ id: 'one', function: { name: 'bash', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'one', content: 'Let me appear in a result.' },
  ], 'anchor_history')

  assert.equal(summary.scope, 'anchor_history')
  assert.equal(summary.reasoning.markers.weNeed, 1)
  assert.equal(summary.reasoning.markers.letMe, 0)
  assert.deepEqual(summary.tools.names, ['bash'])
})

test('summarizes a JSON response with current-response scope', () => {
  const summary = summarizeResponseBody(JSON.stringify({
    choices: [{
      index: 0,
      message: {
        reasoning_content: 'Let me inspect.',
        content: 'done',
        tool_calls: [{ id: 'one', function: { name: 'read', arguments: '{"path":"x"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { total_tokens: 12 },
  }), 'application/json')

  assert.equal(summary.scope, 'current_response')
  assert.equal(summary.complete, true)
  assert.equal(summary.reasoning.markers.letMe, 1)
  assert.equal(summary.reasoning.openingStyle, 'let-me')
  assert.equal(summary.content.chars, 4)
  assert.deepEqual(summary.tools.names, ['read'])
  assert.equal(summary.usage.total_tokens, 12)
})

test('reassembles phrases and tool calls split across SSE network chunks', () => {
  const observer = new OpenAiResponseObserver('text/event-stream')
  const source = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"We need inspect. Le"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"t me verify."}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"one","function":{"name":"bash","arguments":"{\\"command\\":"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"pwd\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"two","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":20}}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  for (let index = 0; index < source.length; index += 7) {
    observer.push(Buffer.from(source.slice(index, index + 7)))
  }
  const summary = observer.finish()

  assert.equal(summary.complete, true)
  assert.equal(summary.reasoning.markers.weNeed, 1)
  assert.equal(summary.reasoning.markers.letMe, 1)
  assert.equal(summary.tools.callCount, 2)
  assert.deepEqual(summary.tools.names, ['bash', 'read'])
  assert.equal(summary.tools.fragments, 3)
  assert.equal(summary.usage.total_tokens, 20)
})

test('reports observation truncation independently from client aborts', () => {
  const observer = new OpenAiResponseObserver('application/json', { maxJsonBytes: 8 })
  observer.push(Buffer.from('{"choices":[{"message":{"content":"long"}}]}'))
  const summary = observer.finish({ abortedByClient: true })

  assert.equal(summary.observationTruncated, true)
  assert.equal(summary.abortedByClient, true)
  assert.equal(summary.complete, false)
})
