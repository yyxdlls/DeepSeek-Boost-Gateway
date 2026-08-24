import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { applyAnchorToChatRequest, loadAnchorArtifact } from '../src/gateway/anchor.mjs'
import { transformChatCompletionsRequest } from '../src/gateway/chat-request-transform.mjs'
import {
  BUILTIN_MICRO_ANCHOR_CONTENT,
  BUILTIN_MICRO_ANCHOR_ID,
  microAnchorContentFingerprint,
  resolveMicroAnchorSnapshot,
} from '../src/gateway/micro-anchor.mjs'

const M = BUILTIN_MICRO_ANCHOR_CONTENT
const enabled = resolveMicroAnchorSnapshot({}, { enabled: true, selectedId: BUILTIN_MICRO_ANCHOR_ID })
const disabled = resolveMicroAnchorSnapshot({}, { enabled: false, selectedId: BUILTIN_MICRO_ANCHOR_ID })

function history() {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ]
}

function request(messages = history(), extra = {}) {
  return {
    model: 'deepseek-v4-pro',
    stream: true,
    temperature: 0.2,
    reasoning_effort: 'high',
    response_format: { type: 'text' },
    tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
    messages,
    ...extra,
  }
}

function fingerprint(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

test('four-way matrix keeps Full Anchor and only mutates third-party users', async () => {
  const loaded = await loadAnchorArtifact()
  const source = request()

  const offBypass = transformChatCompletionsRequest(source, { mode: 'bypass', microAnchor: disabled })
  assert.deepEqual(offBypass.payload.messages, source.messages)

  const onBypass = transformChatCompletionsRequest(source, { mode: 'bypass', microAnchor: enabled })
  assert.equal(onBypass.payload.messages[0].content, 'sys')
  assert.equal(onBypass.payload.messages[1].content, `u1\n\n${M}`)
  assert.equal(onBypass.payload.messages[2].content, 'a1')
  assert.equal(onBypass.payload.messages[3].content, `u2\n\n${M}`)
  assert.equal(onBypass.payload.temperature, 0.2)
  assert.equal(onBypass.payload.reasoning_effort, 'high')
  assert.equal(onBypass.payload.stream, true)
  assert.deepEqual(onBypass.payload.response_format, { type: 'text' })
  assert.equal(onBypass.payload.tools[0].function.name, 'read')

  const offAnchor = transformChatCompletionsRequest(source, {
    mode: 'anchor',
    microAnchor: disabled,
    anchor: loaded,
  })
  const direct = applyAnchorToChatRequest(source, loaded)
  assert.deepEqual(offAnchor.payload.messages, direct.payload.messages)

  const onAnchor = transformChatCompletionsRequest(source, {
    mode: 'anchor',
    microAnchor: enabled,
    anchor: loaded,
  })
  const rebuiltUsers = applyAnchorToChatRequest({
    ...source,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `u1\n\n${M}` },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: `u2\n\n${M}` },
    ],
  }, loaded)
  assert.deepEqual(onAnchor.payload.messages.slice(0, loaded.artifact.trajectory.messages.length + 1),
    rebuiltUsers.payload.messages.slice(0, loaded.artifact.trajectory.messages.length + 1))
  assert.deepEqual(
    onAnchor.payload.messages.slice(0, loaded.artifact.trajectory.messages.length),
    loaded.artifact.trajectory.messages,
  )
  const bridge = onAnchor.payload.messages[loaded.artifact.trajectory.messages.length]
  const directBridge = direct.payload.messages[loaded.artifact.trajectory.messages.length]
  assert.deepEqual(bridge, directBridge)
  assert.equal(onAnchor.payload.messages.at(-1).content, `u2\n\n${M}`)
  assert.equal(onAnchor.payload.messages.at(-3).content, `u1\n\n${M}`)
})

test('header bypass only skips Full Anchor and still applies the profile micro-anchor', async () => {
  const loaded = await loadAnchorArtifact()
  const transformed = transformChatCompletionsRequest(request(), {
    mode: 'bypass',
    microAnchor: enabled,
    anchor: loaded,
  })
  assert.equal(transformed.payload.messages.length, 4)
  assert.equal(transformed.payload.messages[1].content, `u1\n\n${M}`)
  assert.equal(transformed.metrics.anchorId, undefined)
})

test('latest assistant or tool message does not invent a new user', () => {
  const messages = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'tool', content: 't1' },
  ]
  const transformed = transformChatCompletionsRequest(request(messages), {
    mode: 'bypass',
    microAnchor: enabled,
  })
  assert.equal(transformed.payload.messages.length, 3)
  assert.equal(transformed.payload.messages[0].content, `u1\n\n${M}`)
  assert.equal(transformed.payload.messages[1].role, 'assistant')
  assert.equal(transformed.payload.messages[2].role, 'tool')
})

test('outbound messages never carry origin fields', () => {
  const transformed = transformChatCompletionsRequest(request([
    { role: 'user', content: 'u1', _origin: 'secret', origin: 'nope' },
  ]), { mode: 'bypass', microAnchor: enabled })
  assert.equal(Object.hasOwn(transformed.payload.messages[0], '_origin'), false)
  assert.equal(Object.hasOwn(transformed.payload.messages[0], 'origin'), false)
  assert.ok(!JSON.stringify(transformed.payload).includes('_origin'))
})

test('metrics and third-party history fingerprint match the rebuilt messages', () => {
  const messages = [
    { role: 'user', content: 'plain' },
    { role: 'user', content: [{ type: 'text', text: 'vision' }, { type: 'image_url', image_url: { url: 'https://x' } }] },
  ]
  const transformed = transformChatCompletionsRequest(request(messages), {
    mode: 'bypass',
    microAnchor: enabled,
  })
  const expectedMessages = [
    { role: 'user', content: `plain\n\n${M}` },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'vision' },
        { type: 'image_url', image_url: { url: 'https://x' } },
        { type: 'text', text: `\n\n${M}` },
      ],
    },
  ]
  assert.equal(transformed.metrics.microAnchor.enabled, true)
  assert.equal(transformed.metrics.microAnchor.id, BUILTIN_MICRO_ANCHOR_ID)
  assert.equal(transformed.metrics.microAnchor.source, 'builtin')
  assert.equal(transformed.metrics.microAnchor.contentFingerprint, microAnchorContentFingerprint(M))
  assert.equal(transformed.metrics.microAnchor.applied, true)
  assert.equal(transformed.metrics.microAnchor.appliedUserMessageCount, 2)
  assert.equal(transformed.metrics.microAnchor.stringUserMessageCount, 1)
  assert.equal(transformed.metrics.microAnchor.multipartUserMessageCount, 1)
  assert.equal(transformed.metrics.microAnchor.reason, 'applied')
  assert.equal(JSON.stringify(transformed.metrics).includes(M), false)
  assert.equal(transformed.metrics.thirdPartyHistoryFingerprint, fingerprint(expectedMessages))
  assert.equal(JSON.stringify(transformed.metrics).includes('origin'), false)
})

test('identical state is deterministic and a longer history shares the same prefix', () => {
  const first = history()
  const second = [...first, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' }]
  const left = transformChatCompletionsRequest(request(first), { mode: 'bypass', microAnchor: enabled })
  const again = transformChatCompletionsRequest(request(first), { mode: 'bypass', microAnchor: enabled })
  const longer = transformChatCompletionsRequest(request(second), { mode: 'bypass', microAnchor: enabled })
  assert.deepEqual(left.payload.messages, again.payload.messages)
  assert.deepEqual(longer.payload.messages.slice(0, left.payload.messages.length), left.payload.messages)
})

test('changing text, selection, or the switch rebuilds every historical user', () => {
  const custom = {
    enabled: true,
    id: 'ma_11111111-1111-1111-1111-111111111111',
    source: 'custom',
    content: '先定位原因。',
    contentFingerprint: microAnchorContentFingerprint('先定位原因。'),
  }
  const original = transformChatCompletionsRequest(request(), { mode: 'bypass', microAnchor: enabled })
  const switched = transformChatCompletionsRequest(request(), { mode: 'bypass', microAnchor: custom })
  const off = transformChatCompletionsRequest(request(), { mode: 'bypass', microAnchor: disabled })
  const restored = transformChatCompletionsRequest(request(), { mode: 'bypass', microAnchor: enabled })
  assert.equal(switched.payload.messages[1].content, 'u1\n\n先定位原因。')
  assert.equal(switched.payload.messages[3].content, 'u2\n\n先定位原因。')
  assert.deepEqual(off.payload.messages, request().messages)
  assert.deepEqual(restored.payload.messages, original.payload.messages)
})

test('same effective text with a different id does not change upstream history', () => {
  const alias = {
    ...enabled,
    id: 'ma_22222222-2222-2222-2222-222222222222',
    source: 'custom',
  }
  const left = transformChatCompletionsRequest(request(), { mode: 'bypass', microAnchor: enabled })
  const right = transformChatCompletionsRequest(request(), { mode: 'bypass', microAnchor: alias })
  assert.deepEqual(left.payload.messages, right.payload.messages)
  assert.equal(left.metrics.thirdPartyHistoryFingerprint, right.metrics.thirdPartyHistoryFingerprint)
})
